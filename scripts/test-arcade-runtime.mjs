/**
 * 街机启动链的高风险边界回归。
 *
 * 这些问题在 UI 上都是“黑屏 / Romset is unknown / 缺文件”，但原因分别是
 * 核心能力用错、某一份注入失败扩散、ZIP 目录套层和发布遗漏核心。
 * 所以把共性决策拆成纯函数后集中守住，避免只测某一款 ROM 的偶然通过。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { arcadeCoreForRomData, supportsFbneoRomData } from '../src/emulator/arcadeCore.ts'
import { writeFsInjections } from '../src/emulator/fsInjection.ts'
import { arcadeArchiveLayoutProblem } from '../src/lib/arcadeArchive.ts'
import { REQUIRED_SELF_BUILT_CORES } from '../src/config/emulators.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error instanceof Error ? error.message : error}`)
  }
}

console.log('\n街机启动链体检')

await check('RomData 只对实际包含该实现的 FBNeo 开放', () => {
  assert.equal(supportsFbneoRomData('fbneo'), true)
  for (const core of ['mame2003', 'mame2003_plus', 'mame-current', 'fbalpha2012_cps1']) {
    assert.equal(supportsFbneoRomData(core), false, `${core} 被误判为支持 RomData`)
  }
})

await check('已配 RomData 时自动纠正到 FBNeo，空值不干预选核', () => {
  assert.equal(arcadeCoreForRomData('mame2003', 'ZipName wofcn'), 'fbneo')
  assert.equal(arcadeCoreForRomData('mame-current', '  \n'), 'mame-current')
})

await check('一份注入写失败后，后面的 BIOS 仍然会写入', async () => {
  const written = []
  const failures = []
  await writeFsInjections(
    {
      mkdir: () => {},
      writeFile: (path) => {
        if (path === '/bad.dat') throw new Error('EIO')
        written.push(path)
      },
    },
    [
      { path: '/bad.dat', bytes: 'broken' },
      { path: '/pgm.zip', bytes: Promise.resolve(new Uint8Array([1])) },
    ],
    (path, message) => failures.push([path, message]),
  )
  assert.deepEqual(written, ['/pgm.zip'])
  assert.deepEqual(failures, [['/bad.dat', 'EIO']])
})

await check('一份下载 promise 失败后也不会中断后续注入', async () => {
  const written = []
  await writeFsInjections(
    { writeFile: (path) => written.push(path) },
    [
      { path: '/missing.zip', bytes: Promise.reject(new Error('network')) },
      { path: '/neogeo.zip', bytes: Promise.resolve(new Uint8Array([2])) },
      { path: '/skip.zip', bytes: Promise.resolve(null) },
    ],
    () => {},
  )
  assert.deepEqual(written, ['/neogeo.zip'])
})

await check('嵌套目录的街机 ZIP 会在上传前被拦下', () => {
  assert.equal(arcadeArchiveLayoutProblem([{ name: 'v-102tw.u39' }]), null)
  assert.match(arcadeArchiveLayoutProblem([{ name: 'mxsqy102tw/v-102tw.u39' }]) ?? '', /只读取 ZIP 根目录/)
})

await check('mame-current 产物缺失会阻断发布', () => {
  assert.equal(REQUIRED_SELF_BUILT_CORES.has('mame-current'), true)
})

await check('后台校验不再把整个大 ZIP 读成 ArrayBuffer', async () => {
  const source = await readFile(new URL('../src/admin/GameForm.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const sniffArcade =')
  const end = source.indexOf('\n  const onFile =', start)
  const body = source.slice(start, end)
  assert.match(body, /assertValidZipBlob\(file/)
  assert.doesNotMatch(body, /file\.arrayBuffer\(\)/)
  assert.match(body, /arcadeArchiveLayoutProblem/)
})

await check('本地街机包只有真需要合成 ROM 时才读全份字节', async () => {
  const source = await readFile(new URL('../src/emulator/arcadeHack.ts', import.meta.url), 'utf8')
  const inspectAt = source.indexOf('assertValidZipBlob(file')
  const deriveAt = source.indexOf('const buf = await file.arrayBuffer()', inspectAt)
  const fastReturnAt = source.indexOf('return { hack, file: renamed }', inspectAt)
  assert.ok(inspectAt >= 0, '本地包没有走 Blob 中央目录校验')
  assert.ok(fastReturnAt > inspectAt && deriveAt > fastReturnAt, '普通包仍在快速返回前读了全文件')
})

await check('大核心只在真实鼠标悬停且网络允许时预拉', async () => {
  const source = await readFile(new URL('../src/emulator/prewarm.ts', import.meta.url), 'utf8')
  assert.match(source, /core && hasHoverIntent\(\) && allowsLargeHoverPrewarm\(\)/)
})

await check('退出等 BIOS 的会话后不再启动已移除 iframe 里的 WASM', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const guardAt = source.indexOf('if (!shouldContinue()) return')
  const startAt = source.indexOf('return original.call(this)', guardAt)
  assert.ok(guardAt >= 0 && startAt > guardAt, '会话销毁判定没有守在真正启动核心之前')
  assert.match(source, /\(\) => !destroyed\)/)
})

console.log(failed === 0 ? '\n街机启动链体检通过\n' : `\n街机启动链体检失败：${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
