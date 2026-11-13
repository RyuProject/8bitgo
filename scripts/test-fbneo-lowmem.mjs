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

console.log('test:fbneo-lowmem 通过')
