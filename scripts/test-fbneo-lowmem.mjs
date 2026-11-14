/**
 * 默认 FBNeo 分配不出 WASM 内存时换低内存核心（src/emulator/fbneoLowmem.ts）。
 * 2026-11-13 大陆 Chrome 109 / 114 三份现场：同一个核心原地重试三遍都是 Cannot allocate Wasm memory。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const m = await import('../src/emulator/fbneoLowmem.ts')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// 只有能原地重开的街机默认 FBNeo 才换；已经是低内存版、别的核心、联机都不换
assert.equal(m.fbneoMemoryFallbackCore('arcade', 'fbneo', true), 'fbneo-lowmem')
assert.equal(m.fbneoMemoryFallbackCore('arcade', 'fbneo-lowmem', true), null)
assert.equal(m.fbneoMemoryFallbackCore('arcade', 'mame-current', true), null)
assert.equal(m.fbneoMemoryFallbackCore('arcade', 'fbneo', false), null)
assert.equal(m.fbneoMemoryFallbackCore('nds', 'fbneo', true), null)

// 即时存档独立一档，个人页能拆回原游戏
assert.equal(m.fbneoLowmemSaveSlug('kof97'), 'kof97:fbneo-lowmem')
assert.equal(m.fbneoLowmemSaveSlug('kof97:fbneo-lowmem'), 'kof97:fbneo-lowmem')
assert.equal(m.parseFbneoLowmemSaveSlug('kof97~rom-ja:fbneo-lowmem'), 'kof97~rom-ja')
assert.equal(m.parseFbneoLowmemSaveSlug('local:x:fbneo-lowmem'), 'local:x:fbneo-lowmem')

// 记忆：按浏览器，30 天
const store = new Map()
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
assert.equal(m.prefersFbneoLowmem(storage, 1000), false)
m.rememberFbneoMemoryFailure(storage, 1000)
assert.equal(m.prefersFbneoLowmem(storage, 2000), true)
assert.equal(m.prefersFbneoLowmem(storage, 1000 + 31 * 86400_000), false)
assert.equal(m.prefersFbneoLowmem({ getItem() { throw new Error('denied') } }, 0), false)

// 记忆键跟着低内存核心的构建走
const report = JSON.parse(read('public/emulatorjs/cores/reports/fbneo-lowmem.json'))
assert.ok(report.sha256.startsWith(m.FBNEO_LOWMEM_BUILD), '换了 fbneo-lowmem 构建要同步 FBNEO_LOWMEM_BUILD')
assert.ok(report.memory.initialHeapBytes < 128 * 1024 * 1024, '低内存核心的起步堆必须小于默认 FBNeo 的 128 MiB')

// 接线：适配器把内存不足交给播放器，播放器换核心重开并记住；存档档位与个人页对得上
const player = read('src/emulator/EmulatorPlayer.tsx')
assert.match(player, /onOutOfMemory: \(failedCore: string, reason: string\) => \{[\s\S]{0,600}fbneoMemoryFallbackCore\([\s\S]{0,400}rememberFbneoMemoryFailure\(\)[\s\S]{0,200}coreOverride: nextCore/)
assert.match(player, /prefersFbneoLowmem\(\)\s*\?\s*FBNEO_LOWMEM_CORE/)
assert.match(player, /coreOverride === FBNEO_LOWMEM_CORE && coreSaveSlug\s*\?\s*fbneoLowmemSaveSlug\(coreSaveSlug\)/)
assert.match(read('src/components/profile/CloudSaves.tsx'), /parseFbneoLowmemSaveSlug\(s\.gameSlug\)/)
assert.match(read('src/emulator/types.ts'), /onOutOfMemory\?: \(core: string, message: string\) => boolean/)

/* ---------- 低内存核心也失败之后（src/emulator/memoryRecovery.ts） ---------- */
const r = await import('../src/emulator/memoryRecovery.ts')
// 厂商 / 应用内浏览器：UA 照样写 Chrome/xxx，要先认出来
assert.equal(r.vendorBrowserName('Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/15.0.4.312 Mobile Safari/537.36'), 'Huawei Browser')
assert.equal(r.vendorBrowserName('Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47'), 'WeChat')
assert.equal(r.vendorBrowserName('Mozilla/5.0 (Linux; U; Android 12; zh-cn) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.1'), 'Mi Browser')
assert.equal(r.vendorBrowserName('Mozilla/5.0 (Linux; Android 12; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36'), null, '正牌 Chrome 不点名')
assert.equal(r.vendorBrowserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), null)

// 探测：从大到小，第一次成功就停；一块都建不出来是 0；没有 WebAssembly 是 null
{
  const asked = []
  const fake = (limitMb) => class { constructor({ initial }) { const mb = initial * 64 / 1024; asked.push(mb); if (mb > limitMb) throw new RangeError('Out of memory') } }
  assert.equal(r.probeWasmMemoryCeilingMB(fake(100)), 80)
  assert.deepEqual(asked, [512, 256, 128, 80], '成功一次就停，不在吃紧的进程里多占')
  asked.length = 0
  assert.equal(r.probeWasmMemoryCeilingMB(fake(1)), 0)
  assert.equal(r.probeWasmMemoryCeilingMB(fake(4096)), 512)
  assert.equal(r.probeWasmMemoryCeilingMB(null), null)
}

// 干净页面重开：每款游戏十分钟只一次；存储不可用就不重开（没法防循环）
{
  const map = new Map()
  const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }
  assert.equal(r.takeCleanPageRetry('the-king-of-fighters-97', store, 1_000_000), true)
  assert.equal(r.takeCleanPageRetry('the-king-of-fighters-97', store, 1_000_000 + 60_000), false, '刷新后再失败就照常报错')
  assert.equal(r.takeCleanPageRetry('metal-slug-2', store, 1_000_000 + 60_000), true, '按游戏分开记')
  assert.equal(r.takeCleanPageRetry('the-king-of-fighters-97', store, 1_000_000 + 11 * 60_000), true, '十分钟后可以再来一次')
  assert.equal(r.takeCleanPageRetry('x', null), false)
  assert.equal(r.takeCleanPageRetry('', store), false)
}
assert.equal(r.cleanPageRetryUrl('https://8bitgo.com/games/the-king-of-fighters-97'), 'https://8bitgo.com/games/the-king-of-fighters-97?autoplay=1')
assert.equal(r.cleanPageRetryUrl('https://8bitgo.com/zh-Hant/games/kof97?lang=ja#x'), 'https://8bitgo.com/zh-Hant/games/kof97?lang=ja&autoplay=1')
assert.equal(r.cleanPageRetryUrl('https://8bitgo.com/tv/play/kof97'), null, '只在认 ?autoplay=1 的详情页做')
assert.equal(r.cleanPageRetryUrl('https://8bitgo.com/play-local'), null)

// 接线：适配器在低内存核心失败时实测、点名浏览器、按 config 报；播放器只做一次干净页面重开
const adapterSrc = read('src/emulator/adapters/emulatorjs.ts')
assert.match(adapterSrc, /if \(core === FBNEO_LOWMEM_CORE\) \{[\s\S]{0,600}probeWasmMemoryCeilingMB\(\)[\s\S]{0,400}failLoad\(lowmemOomMessage\(vendor\), 'config'\)/)
assert.match(player, /isLowmemOomMessage\(failureReason\)[\s\S]{0,200}cleanPageRetryUrl\(window\.location\.href\)[\s\S]{0,120}takeCleanPageRetry\(/)
assert.match(read('src/pages/GameDetailPage.tsx'), /searchParams\.get\('autoplay'\) === '1'/, '详情页仍认 ?autoplay=1')

console.log('test:fbneo-lowmem 通过')
