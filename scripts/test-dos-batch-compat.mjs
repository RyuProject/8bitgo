/**
 * 启动 BAT 的 DOSBox 兼容修补（src/lib/dosBatchCompat.ts + jsdosBundle 接线）。
 *
 * 背景（2026-11-05《大富翁3》）：PLAY.BAT = `subst a: .` / `Mouse.com` / `SS` / `RICH3`。
 *   · DOSBox 没有 SUBST → 游戏读不到 A:，选人画面缺图、点下去整局卡死；
 *   · MOUSE.COM 接管 INT 33h → 绝对坐标失效，光标与真实鼠标 / 触屏鼠标板对不上。
 * 锁住：SUBST 翻译成 MOUNT、鼠标驱动改 REM、原 BAT 不动、其余字节（含 Big5 的 ECHO）逐字节保留、
 * 写不清楚的情况一律不碰。
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const { planDosBatchCompatibility, dosMountedDrives } = await import(fileURLToPath(new URL('../src/lib/dosBatchCompat.ts', import.meta.url)))
const { makeJsdosBundle, readZipFile } = await import(fileURLToPath(new URL('../src/lib/jsdosBundle.ts', import.meta.url)))
const { needsLockedAbsoluteDosMouse } = await import(fileURLToPath(new URL('../src/emulator/dosMouse.ts', import.meta.url)))

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`)
  }
}

const te = new TextEncoder()
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1')
function crc32(data) {
  let c = ~0
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function makeZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = te.encode(f.name)
    const data = f.data instanceof Uint8Array ? f.data : te.encode(f.data ?? '')
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc32(data), true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local, data)
    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc32(data), true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const joined = Buffer.concat([...parts, ...central, eocd])
  // Buffer.concat 可能落在共享池里，必须拷成独立的 ArrayBuffer
  return new Uint8Array(joined).buffer
}
const EXE = 'MZ' + '\0'.repeat(62)
const RICH3_PLAY = 'subst a: .\r\nMouse.com\r\nSS\r\nRICH3'
const exists = (names) => (path) => names.map((n) => n.toLowerCase()).includes(path.toLowerCase())

console.log('一、BAT 规则（纯函数）')

await check('⚠️ 大富翁3 原版 PLAY.BAT：SUBST → mount a .，MOUSE.COM → REM，其余行原样', () => {
  const plan = planDosBatchCompatibility(te.encode(RICH3_PLAY), { dir: '', fileExists: exists(['MOUSE.COM', 'SS.EXE', 'RICH3.EXE']) })
  assert.deepEqual(plan.mounts, ['mount a .'])
  const text = latin1(plan.bytes)
  assert.match(text, /^REM 8bitgo: SUBST A: replaced by MOUNT\r\nREM 8bitgo: MOUSE\.COM skipped/)
  assert.ok(text.endsWith('\r\nSS\r\nRICH3'), 'SS / RICH3 和 CRLF 原样保留')
})

await check('子目录里的 BAT：挂载宿主路径带目录；目录名不是 8.3 就不碰', () => {
  const plan = planDosBatchCompatibility(te.encode('subst a: .\r\nrich3\r\n'), { dir: 'RICH3/', fileExists: () => false })
  assert.deepEqual(plan.mounts, ['mount a ./RICH3'])
  assert.equal(planDosBatchCompatibility(te.encode('subst a: .\r\n'), { dir: 'Rich Man 3/', fileExists: () => false }).bytes, null)
})

await check('CD / 换盘符 / CALL 之后当前目录不可知：SUBST 不翻译（鼠标驱动仍跳过）', () => {
  const plan = planDosBatchCompatibility(te.encode('cd game\r\nsubst a: .\r\nmouse\r\ngame\r\n'), { dir: '', fileExists: exists(['MOUSE.COM']) })
  assert.deepEqual(plan.mounts, [])
  assert.match(latin1(plan.bytes), /^cd game\r\nsubst a: \.\r\nREM 8bitgo: MOUSE skipped/)
})

await check('只认包里真有的鼠标驱动；LH / @ 前缀与参数都能识别', () => {
  assert.equal(planDosBatchCompatibility(te.encode('mouse\r\ngame\r\n'), { dir: '', fileExists: () => false }).bytes, null, '包里没有 MOUSE.* 就不是本地驱动，不动')
  const plan = planDosBatchCompatibility(te.encode('@LH CTMOUSE /R2\r\ngame\r\n'), { dir: '', fileExists: exists(['ctmouse.exe']) })
  assert.match(latin1(plan.bytes), /^REM 8bitgo: CTMOUSE skipped/)
})

await check('盘符已被占用（C:、后台挂载命令）不翻译；带路径的 SUBST 不翻译', () => {
  assert.equal(planDosBatchCompatibility(te.encode('subst c: .\r\n'), { dir: '', fileExists: () => false }).bytes, null)
  assert.equal(planDosBatchCompatibility(te.encode('subst d: .\r\n'), { dir: '', fileExists: () => false, takenDrives: dosMountedDrives('imgmount d game.cue -t iso') }).bytes, null)
  assert.equal(planDosBatchCompatibility(te.encode('subst e: c:\\data\r\n'), { dir: '', fileExists: () => false }).bytes, null)
})

await check('Big5 ECHO 与 Ctrl-Z 逐字节保留（不经 UTF-8）', () => {
  const big5 = Uint8Array.from([0xa4, 0x6a, 0xb4, 0x49, 0xc1, 0xa1]) // 大富翁
  const source = Buffer.concat([Buffer.from('echo '), big5, Buffer.from('\r\nsubst a: .\r\nRICH3\r\n\x1a')])
  const plan = planDosBatchCompatibility(new Uint8Array(source), { dir: '', fileExists: () => false })
  const out = Buffer.from(plan.bytes)
  assert.deepEqual(out.subarray(0, 11), source.subarray(0, 11))
  assert.equal(out[out.length - 1], 0x1a)
})

await check('没有可修的行 / 超大 BAT：返回 null，不生成别名', () => {
  assert.equal(planDosBatchCompatibility(te.encode('@echo off\r\ngame.exe\r\n'), { dir: '', fileExists: () => true }).bytes, null)
  assert.equal(planDosBatchCompatibility(new Uint8Array(17 * 1024).fill(0x20), { dir: '', fileExists: () => true }).bytes, null)
})

console.log('二、接进 makeJsdosBundle')

await check('⚠️ 大富翁3 形状的包：autoexec 先 mount a .，再跑修补过的 8BITGO.BAT；原 PLAY.BAT 不动', async () => {
  const rom = makeZip([
    { name: 'PLAY.BAT', data: RICH3_PLAY },
    { name: 'MOUSE.COM', data: EXE },
    { name: 'SS.EXE', data: EXE },
    { name: 'RICH3.EXE', data: EXE },
  ])
  const bundle = await makeJsdosBundle('rich-man-3.zh-Hant.zip', rom, undefined, undefined, 'PLAY.BAT')
  const zip = await bundle.blob.arrayBuffer()
  const conf = new TextDecoder().decode((await readZipFile(zip, '.jsdos/dosbox.conf')).data)
  assert.match(conf, /\nmount c \.\nc:\nmount a \.\n8BITGO\.BAT\n/)
  assert.doesNotMatch(conf, /\nPLAY\.BAT\n/)
  const alias = latin1((await readZipFile(zip, '8BITGO.BAT')).data)
  assert.match(alias, /REM 8bitgo: MOUSE\.COM skipped/)
  assert.equal(latin1((await readZipFile(zip, 'PLAY.BAT')).data), RICH3_PLAY, '原 BAT 保留，游戏或玩家自己再调用时不变')
})

await check('后台已用启动命令挂了 A: → 不重复挂载，只跳过鼠标驱动', async () => {
  const rom = makeZip([{ name: 'PLAY.BAT', data: RICH3_PLAY }, { name: 'MOUSE.COM', data: EXE }, { name: 'RICH3.EXE', data: EXE }])
  const bundle = await makeJsdosBundle('g.zip', rom, undefined, undefined, 'PLAY.BAT', 'mount a .')
  const conf = new TextDecoder().decode((await readZipFile(await bundle.blob.arrayBuffer(), '.jsdos/dosbox.conf')).data)
  assert.equal(conf.match(/mount a \./g)?.length, 1)
  assert.match(conf, /8BITGO\.BAT/)
})

await check('普通 EXE / 不需要修的 BAT：配置与以前完全一样', async () => {
  const rom = makeZip([{ name: 'START.BAT', data: '@echo off\r\ngame\r\n' }, { name: 'GAME.EXE', data: EXE }])
  const bundle = await makeJsdosBundle('g.zip', rom, undefined, undefined, 'START.BAT')
  const zip = await bundle.blob.arrayBuffer()
  const conf = new TextDecoder().decode((await readZipFile(zip, '.jsdos/dosbox.conf')).data)
  assert.match(conf, /\nc:\nSTART\.BAT\n/)
  assert.equal(await readZipFile(zip, '8BITGO.BAT'), null)
})

await check('大富翁3 走绝对坐标鼠标（锁定后积分、未锁定按画面位置）', () => {
  assert.equal(needsLockedAbsoluteDosMouse('rich-man-3'), true)
  assert.equal(needsLockedAbsoluteDosMouse(' Rich-Man-3 '), true)
  assert.equal(needsLockedAbsoluteDosMouse('doom'), false)
})

console.log(failed === 0 ? '\n启动 BAT 兼容修补回归通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
