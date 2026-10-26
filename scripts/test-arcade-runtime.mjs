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
import {
  emulatorJsDownloadPhase,
  isCriticalEmulatorJsDownload,
} from '../src/emulator/emulatorjsDownload.ts'
import { writeFsInjections } from '../src/emulator/fsInjection.ts'
import { arcadeArchiveLayoutProblem } from '../src/lib/arcadeArchive.ts'
import { REQUIRED_SELF_BUILT_CORES } from '../src/config/emulators.ts'
import { readdir } from 'node:fs/promises'
import { EJS_WEBGL2_DEFAULT_CORES, emulatorJsCoreDataFile } from '../src/emulator/paths.ts'
import { ejsCachedUrls, warmEmulatorJsStart } from '../src/emulator/ejsStartWarm.ts'
import { dipNameOf } from '../src/emulator/dipPlan.ts'
import { matchRomset } from '../src/lib/arcadeRomset.ts'
import { canonicalMameRomset } from '../src/emulator/mameRomset.ts'

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

await check('RomData 游戏预热最终的 FBNeo，不白下错误的 MAME 大核心', async () => {
  const source = await readFile(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
  assert.match(source, /arcadeCoreForRomData\(requestedPrewarmCore, arcadeRomDataRef\.current\)/)
})

await check('自托管核心下载失败会立即终止，不回落到已知损坏的 CDN', () => {
  const game = 'blob:https://8bitgo.com/rom'
  const bios = 'https://assets.8bitgo.com/bios/neogeo.zip'
  const core = '/emulatorjs/cores/mame-current-wasm.data'
  assert.equal(emulatorJsDownloadPhase(core, game), 'engine')
  assert.equal(isCriticalEmulatorJsDownload(core, game, bios), true)
  assert.equal(isCriticalEmulatorJsDownload(game, game, bios), true)
  assert.equal(isCriticalEmulatorJsDownload(bios, game, bios), true)
  assert.equal(isCriticalEmulatorJsDownload('/socket.io/socket.io.js', game, bios), false)
})

await check('MAME 路径解析失败不会被误判为成功启动', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  for (const phrase of ['error parsing system name', 'error parsing parent path', 'no driver loaded']) {
    assert.match(source, new RegExp(`['\"]${phrase}['\"]`), `致命短语缺失：${phrase}`)
  }
})

await check('同一根因的多条核心错误只会上报一次终止事件', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(source, /let loadFailed = false/)
  assert.match(source, /destroyed \|\| started \|\| loadFailed/)
  assert.match(source, /loadFailed = true/)
  assert.match(source, /failLoad\(fmt\(rt\.ejsEngineError/)
})

await check('退出等 BIOS 的会话后不再启动已移除 iframe 里的 WASM', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const guardAt = source.indexOf('if (!shouldContinue()) return')
  const startAt = source.indexOf('return original.call(this)', guardAt)
  assert.ok(guardAt >= 0 && startAt > guardAt, '会话销毁判定没有守在真正启动核心之前')
  assert.match(source, /\(\) => !destroyed(?:,|\))/)
})

await check('ROM、额外 BIOS、缓存清理与联机辅助资源并行启动', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const loadAt = source.indexOf("iframe.addEventListener('load'")
  const parallelAt = source.indexOf('const biosDownloads = new Map', loadAt)
  const arcadeAt = source.indexOf('await prepareRemoteArcadeRom(', loadAt)
  const joinAt = source.indexOf('const socketIoError = await socketIoTask', loadAt)
  assert.ok(loadAt >= 0 && parallelAt > loadAt && parallelAt < arcadeAt, 'BIOS 仍在 ROM 下载后才开始')
  assert.match(source.slice(parallelAt, arcadeAt), /if \(!biosDownloads\.has\(file\.url\)\)/, '相同 BIOS URL 会被重复下载')
  assert.ok(source.indexOf('const cachePurgeTask = purgePoisonedEngineCache()', loadAt) < arcadeAt, '缓存清理没有与 ROM 并行')
  assert.ok(source.indexOf('const socketIoTask:', loadAt) < arcadeAt && joinAt > arcadeAt, '联机脚本没有提前发起、稍后收口')
})

await check('预热的核心文件就是引擎真正下载的那个变体（legacy / WebGL2）', async () => {
  const metaDir = new URL('../public/emulatorjs/cores/metadata/', import.meta.url)
  const engine = await readFile(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
  const required = /requiresWebGL2\(t\)\{return (\w+)\.includes\(t\)\}/.exec(engine)
  assert.ok(required, '引擎里找不到 requiresWebGL2：选核逻辑变了，重新取证')
  const list = new RegExp(`\\b${required[1]}=(\\[[^\\]]*\\])`).exec(engine)
  assert.ok(list, '找不到 requiresWebGL2 名单')
  for (const core of JSON.parse(list[1])) assert.ok(EJS_WEBGL2_DEFAULT_CORES.has(core), `${core} 在引擎强制 WebGL2 名单里`)
  assert.match(engine, /webgl2Enabled=!!i\.options&&i\.options\.defaultWebGL2/, '引擎不再按核心报告的 defaultWebGL2 选核，重新取证')
  for (const name of await readdir(metaDir)) {
    if (!name.endsWith('.json')) continue
    const meta = JSON.parse(await readFile(new URL(name, metaDir), 'utf8'))
    const core = name.replace(/\.json$/, '')
    const webgl2 = Boolean(meta.options?.defaultWebGL2)
    if (webgl2) assert.ok(EJS_WEBGL2_DEFAULT_CORES.has(core), `${core} 报告 defaultWebGL2，但预热会去拉 legacy`)
    else if (!JSON.parse(list[1]).includes(core)) assert.ok(!EJS_WEBGL2_DEFAULT_CORES.has(core), `${core} 实际走 legacy，预热表却当成 WebGL2`)
    const file = emulatorJsCoreDataFile(core)
    await readFile(new URL(`../public/emulatorjs/cores/${file}`, import.meta.url)).catch(() => {
      throw new Error(`${core} 预热的 ${file} 没有发布`)
    })
  }
  assert.equal(emulatorJsCoreDataFile('arcade'), 'fbneo-legacy-wasm.data')
  assert.equal(emulatorJsCoreDataFile('fbneo'), 'fbneo-legacy-wasm.data')
  assert.equal(emulatorJsCoreDataFile('nds'), 'melondsds-wasm.data')
})

/** 只实现 ejsCachedUrls 用到的那点 IndexedDB：open / onupgradeneeded / index('url').count */
function fakeIdb({ exists, urls = [] }) {
  const state = { aborted: false, created: false }
  return {
    state,
    open() {
      const request = { result: null, transaction: { abort: () => { state.aborted = true } } }
      setTimeout(() => {
        if (!exists) {
          request.onupgradeneeded?.()
          if (state.aborted) return request.onerror?.()
          state.created = true
        }
        request.result = {
          objectStoreNames: { contains: (n) => exists && n === 'cache' },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              indexNames: { contains: (n) => n === 'url' },
              index: () => ({
                count(url) {
                  const q = {}
                  setTimeout(() => { q.result = urls.includes(url) ? 1 : 0; q.onsuccess?.() }, 0)
                  return q
                },
              }),
            }),
          }),
        }
        request.onsuccess?.()
      }, 0)
      return request
    },
  }
}

await check('开局预热：引擎缓存里已有的核心不再下载，库不存在时不会替引擎建空库', async () => {
  const core = '/emulatorjs/cores/fbneo-legacy-wasm.data?v=1'
  const bios = 'https://assets.example/roms/bios/neogeo.zip'
  const warmed = []
  const cachedIdb = fakeIdb({ exists: true, urls: [core] })
  await warmEmulatorJsStart({ always: ['/emulatorjs/emulator.min.js?v=1'], large: [core, bios] }, { idb: cachedIdb, warm: (u) => warmed.push(u) })
  assert.deepEqual(warmed, ['/emulatorjs/emulator.min.js?v=1', bios])

  const absent = fakeIdb({ exists: false })
  const found = await ejsCachedUrls([core], absent)
  assert.equal(found.size, 0)
  assert.equal(absent.state.aborted, true, '库不存在时必须 abort 升级')
  assert.equal(absent.state.created, false, '不能留下一个没有 cache 表的空库')

  const warmed2 = []
  await warmEmulatorJsStart({ always: [], large: [core] }, { idb: undefined, warm: (u) => warmed2.push(u) })
  assert.deepEqual(warmed2, [core], '没有 IndexedDB 时照常预热')
})

await check('开局预热排在 ROM 预下载之前，且平台 BIOS 判定只算一次', async () => {
  const source = await readFile(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const loadAt = source.indexOf("iframe.addEventListener('load'")
  const warmAt = source.indexOf('void warmEmulatorJsStart(', loadAt)
  const arcadeAt = source.indexOf('await prepareRemoteArcadeRom(', loadAt)
  assert.ok(warmAt > loadAt && warmAt < arcadeAt, '核心预热没有和 ROM 下载并行')
  assert.equal(source.split('const engineBiosUrl =').length - 1, 1, 'engineBiosUrl 被算了两遍，预热和真正开局可能不一致')
  assert.ok(source.indexOf('const engineBiosUrl =', loadAt) < warmAt, '预热时还不知道要不要下平台 BIOS')
})

await check('DIP 组名带连字符时保留完整组名', () => {
  assert.equal(dipNameOf('fbneo-dipswitch-kov-Controls'), 'Controls')
  assert.equal(dipNameOf('fbneo-dipswitch-dino-Power-Up_Test'), 'Power-Up_Test')
  assert.equal(dipNameOf('something-Odd'), 'Odd')
})

await check('同 CRC 的双份 ROM 不会把完整包的覆盖率算成 200%', () => {
  const index = {
    sets: [{ name: 'dupset', parent: '', bios: '' }, { name: 'other', parent: '', bios: '' }],
    totals: new Uint16Array([2, 3]),
    byCrc: new Map([[0x11111111, [0, 0]], [0x22222222, [1]]]),
  }
  const result = matchRomset(index, [0x11111111, 0x11111111])
  assert.equal(result.candidates[0].name, 'dupset')
  assert.equal(result.candidates[0].coverage, 1)
  assert.equal(result.confident?.name, 'dupset')
})

await check('mame-current 内容名：不可能是驱动名的上传名要纠正成合法短名', () => {
  // 线上《铁拳》：对象存储里是 tekken-root-flat.zip，MAME 找不到驱动只剩 RetroArch 空菜单
  assert.equal(canonicalMameRomset('tekken-root-flat.zip'), 'tekken.zip')
  assert.equal(canonicalMameRomset('Tekken (World).zip'), 'tekken.zip')
  assert.equal(canonicalMameRomset('TEKKEN.ZIP'), 'tekken.zip')
  // 合法短名（含克隆集、带数字和下划线）原样保留，别被「纠正」成父集
  assert.equal(canonicalMameRomset('tekkenac.zip'), 'tekkenac.zip')
  assert.equal(canonicalMameRomset('sf2_ce.zip'), 'sf2_ce.zip')
  assert.equal(canonicalMameRomset('mxsqy102tw.zip'), 'mxsqy102tw.zip')
  // 别名表优先
  assert.equal(canonicalMameRomset('mxsqy.zip'), 'mxsqy102tw.zip')
  // 实在拆不出合法片段时保持原样，交给核心报错，不瞎猜
  assert.equal(canonicalMameRomset('铁拳.zip'), '铁拳.zip')
})

console.log(failed === 0 ? '\n街机启动链体检通过\n' : `\n街机启动链体检失败：${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
