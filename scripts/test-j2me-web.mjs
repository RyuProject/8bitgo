/**
 * j2me-web 备用运行时（vendor/j2me-web）的 8BitGo 补丁回归。
 * 运行：node scripts/test-j2me-web.mjs（上游代码用了 TS 参数属性，node 去类型跑不了，先用 esbuild 打包）
 *
 * 2026-11-15 把站内全部 J2ME 游戏放进备用运行时实测后补的：Nokia UI API、MIDP 2.0 图层、GIF 同步解码、
 * startApp 独立线程、Player 状态常量 / 监听器 / 默认循环、RecordStore.getRecord(int,byte[],int)、
 * AlertType 对象常量、屏幕尺寸判断。见 vendor/j2me-web/NOTICE.md。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = mkdtempSync(path.join(tmpdir(), 'j2me-web-nokia-'))
const entry = path.join(dir, 'entry.ts')
const root = new URL('../vendor/j2me-web/src/jvm/natives/', import.meta.url).pathname
writeFileSync(entry, `export * from '${root}nokia.ts'; export { allNatives } from '${root}index.ts'; export { decodeGif } from '${root}../../gfx/gif.ts'; export { detectScreenSize } from '${root}../../player/detect.ts';`)
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'out.mjs'), logLevel: 'error', loader: { '.css': 'empty' } })
// 模块加载时会建一块画布；这里只测纯逻辑，给个什么都不做的替身
globalThis.OffscreenCanvas ??= class {
  constructor(w, h) { this.width = w; this.height = h }
  getContext() { return new Proxy({}, { get: () => () => ({ data: new Uint8ClampedArray(4) }) }) }
}
const { FLIP_HORIZONTAL, FLIP_VERTICAL, nokiaNatives, nokiaToMidpTransform, allNatives, decodeGif, detectScreenSize } = await import(pathToFileURL(path.join(dir, 'out.mjs')).href)
rmSync(dir, { recursive: true, force: true })

let failed = 0
/** 测试用最小 LZW 编码：每个像素一个码，开头 clear、结尾 end，码宽随表增长（与 GIF 规范一致） */
function lzwPack(indices, minCodeSize) {
  const clear = 1 << minCodeSize
  const codes = [clear, ...indices, clear + 1]
  let size = minCodeSize + 1
  let next = clear + 2
  let acc = 0, bits = 0
  const out = []
  codes.forEach((code, i) => {
    acc |= code << bits
    bits += size
    while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8 }
    // 解码器在第二个数据码之后才开始加表项
    if (i >= 2 && code !== clear + 1 && next < 4096) { next++; if (next === 1 << size && size < 12) size++ }
  })
  if (bits) out.push(acc & 0xff)
  return [out.length, ...out]
}
const check = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`) } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`) }
}
// MIDP 2.0 Sprite 常量
const T = { NONE: 0, MIRROR_ROT180: 1, MIRROR: 2, ROT180: 3, MIRROR_ROT270: 4, ROT90: 5, ROT270: 6, MIRROR_ROT90: 7 }

check('Nokia 旋转是逆时针：ROTATE_90 = MIDP ROT270，ROTATE_270 = MIDP ROT90', () => {
  assert.equal(nokiaToMidpTransform(0), T.NONE)
  assert.equal(nokiaToMidpTransform(90), T.ROT270)
  assert.equal(nokiaToMidpTransform(180), T.ROT180)
  assert.equal(nokiaToMidpTransform(270), T.ROT90)
})
check('翻转：水平 = MIRROR，垂直 = MIRROR_ROT180，两个都翻 = ROT180', () => {
  assert.equal(nokiaToMidpTransform(FLIP_HORIZONTAL), T.MIRROR)
  assert.equal(nokiaToMidpTransform(FLIP_VERTICAL), T.MIRROR_ROT180)
  assert.equal(nokiaToMidpTransform(FLIP_HORIZONTAL | FLIP_VERTICAL), T.ROT180)
})
check('组合先翻转后旋转，八种结果都落在 MIDP 的八个变换里', () => {
  assert.equal(nokiaToMidpTransform(FLIP_HORIZONTAL | 90), T.MIRROR_ROT270)
  assert.equal(nokiaToMidpTransform(FLIP_HORIZONTAL | 270), T.MIRROR_ROT90)
  const seen = new Set()
  for (const flip of [0, FLIP_HORIZONTAL]) for (const rot of [0, 90, 180, 270]) seen.add(nokiaToMidpTransform(flip | rot))
  assert.equal(seen.size, 8)
})
check('游戏用到的 Nokia 类都已注册进 JVM', () => {
  const names = new Set(allNatives.map((d) => d.name))
  for (const n of ['com/nokia/mid/ui/FullCanvas', 'com/nokia/mid/ui/DirectUtils', 'com/nokia/mid/ui/DirectGraphics',
    'com/nokia/mid/ui/DeviceControl', 'com/nokia/mid/sound/Sound']) assert.ok(names.has(n), `缺 ${n}`)
  assert.ok(nokiaNatives.length >= 5)
  const full = nokiaNatives.find((d) => d.name === 'com/nokia/mid/ui/FullCanvas')
  assert.equal(full.super, 'javax/microedition/lcdui/Canvas')
})
check('GIF 同步解码（资源包里运行时才读的 GIF 也要能出图）', () => {
  const lcdui = readFileSync(new URL('../vendor/j2me-web/src/jvm/natives/lcdui.ts', import.meta.url), 'utf8')
  assert.match(lcdui, /const img = decodeGif\(bytes\);/)
  // 2x2 GIF：左上红、右上透明、下排蓝，交给解码器逐像素核对
  const gif = Uint8Array.from([
    0x47,0x49,0x46,0x38,0x39,0x61, 2,0, 2,0, 0x81,0,0, // 头：2x2，全局调色板 4 色
    0xff,0,0, 0,0,0xff, 0,0,0, 0,0,0,                    // 调色板：0 红 1 蓝 2 黑（透明） 3 黑
    0x21,0xf9,4, 1,0,0, 2, 0,                            // GCE：透明色 2
    0x2c, 0,0,0,0, 2,0,2,0, 0,                           // 图像描述
    2, ...lzwPack([0,2,1,1], 2), 0, 0x3b,
  ])
  const img = decodeGif(gif)
  assert.equal(img.width, 2)
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [255, 0, 0, 255], '左上应为红')
  assert.equal(img.data[7], 0, '右上是透明色，alpha 应为 0')
  assert.deepEqual(Array.from(img.data.slice(8, 12)), [0, 0, 255, 255], '左下应为蓝')
})
check('开局未捕获异常不能报 ready（否则玩家对着黑屏等不到报错）', () => {
  const embed = readFileSync(new URL('../vendor/j2me-web/src/embed.ts', import.meta.url), 'utf8')
  assert.match(embed, /STARTUP_GRACE_MS = 2_000/)
  const at = embed.indexOf('if (startupError !== null)')
  assert.ok(at > 0 && at < embed.indexOf("type: 'ready' });\n  } catch"), '要先判开局异常再发 ready')
})

const src = (rel) => readFileSync(new URL('../vendor/j2me-web/src/' + rel, import.meta.url), 'utf8')
const def = (name) => allNatives.find((d) => d.name === name)

check('⭐ startApp 在独立线程跑，不占事件线程（主循环写在 startApp 里的游戏要能收到按键）', () => {
  const jvm = src('jvm/jvm.ts')
  assert.match(jvm, /this\.startThread\('MIDlet', \(mt\) => this\.pushCall\(mt, startApp, \[midlet\]\)\)/)
  assert.doesNotMatch(jvm, /if \(startApp\) this\.pushCall\(t, startApp, \[midlet\]\);/, '不能再把 startApp 压在事件线程上')
})

check('⭐ Player 状态常量是规范值（会被 javac 内联进游戏字节码）', () => {
  const f = def('javax/microedition/media/Player').fields
  assert.deepEqual([f['UNREALIZED:I'], f['REALIZED:I'], f['PREFETCHED:I'], f['STARTED:I'], f['CLOSED:I']], [100, 200, 300, 400, 0])
})

check('⭐ Player 默认播 1 遍、监听器能收到事件、规范里的时间方法都在', () => {
  const m = def('javax/microedition/media/Player').methods
  for (const k of ['setMediaTime(J)J', 'getMediaTime()J', 'getDuration()J', 'getContentType()Ljava/lang/String;',
    'addPlayerListener(Ljavax/microedition/media/PlayerListener;)V']) assert.ok(k in m, `缺 ${k}`)
  const media = src('jvm/natives/media.ts')
  assert.match(media, /loopCount: 1,/)
  assert.doesNotMatch(media, /loopCount: -1/)
  assert.match(media, /notifyPlayer\(t\.jvm, p, 'started'\);\s*scheduleEnd\(t\.jvm, p\);/)
  assert.match(src('midi/synth.ts'), /Math\.max\(1, this\.loopCount\)/, 'setLoopCount(n) 是一共 n 遍')
})

check('RecordStore 有规范签名 getRecord(int, byte[], int)', () => {
  assert.ok('getRecord(I[BI)I' in def('javax/microedition/rms/RecordStore').methods)
})

check('AlertType 常量是对象，MIDP 2.0 图层、联网替身、RateControl 都已注册', () => {
  assert.ok('ERROR:Ljavax/microedition/lcdui/AlertType;' in def('javax/microedition/lcdui/AlertType').fields)
  for (const n of ['javax/microedition/lcdui/game/Layer', 'javax/microedition/lcdui/game/Sprite',
    'javax/microedition/lcdui/game/TiledLayer', 'javax/microedition/lcdui/game/LayerManager',
    'javax/microedition/io/Connector', 'javax/microedition/io/ConnectionNotFoundException',
    'javax/microedition/media/control/RateControl', 'javax/microedition/media/control/TempoControl']) assert.ok(def(n), `缺 ${n}`)
  assert.equal(def('javax/microedition/lcdui/game/Sprite').super, 'javax/microedition/lcdui/game/Layer')
  // media.ts 已定义 Connection / InputConnection，联网替身不能再注册一遍把它们盖掉
  assert.equal(allNatives.filter((d) => d.name === 'javax/microedition/io/Connection').length, 1)
})

const fakeJar = (manifest, entries = []) => ({ manifest: new Map(Object.entries(manifest)), entries: new Map(entries) })
const gif = (w, h) => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0])
const png = (w, h) => { const b = new Uint8Array(32); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b }

check('屏幕尺寸：GIF 整屏图算数、Glu 横屏提示生效、大 JAR 不信 128 的猜测', () => {
  assert.deepEqual(detectScreenSize(fakeJar({}, [['title.gif', gif(176, 208)], ['a.gif', gif(176, 208)], ['Game.class', new TextEncoder().encode('xx com/nokia/mid/ui/FullCanvas xx')]])), { width: 176, height: 208 })
  assert.deepEqual(detectScreenSize(fakeJar({ 'Glu-Screen-Mode': 'landscape' })), { width: 320, height: 240 })
  const big = new Uint8Array(300 * 1024)
  assert.deepEqual(detectScreenSize(fakeJar({}, [['t1.png', png(128, 128)], ['t2.png', png(128, 128)], ['data.bin', big]])), { width: 240, height: 320 })
  assert.deepEqual(detectScreenSize(fakeJar({}, [['t1.png', png(128, 128)], ['t2.png', png(128, 128)]])), { width: 128, height: 128 })
})

console.log(failed ? `\n${failed} 项失败` : '\nj2me-web 备用运行时回归通过 ✅')
process.exit(failed ? 1 : 0)
