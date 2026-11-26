/**
 * PS1 默认核心内存不足时的低内存版与开局预检（src/emulator/psxLowmem.ts、ejsCoreMemory.ts）。
 *
 * 2026-11-16 大陆 Chrome 132 / Windows 64 位、8GB《生化危机 3》（诊断包 #780 / #783）：358MB 的 8BG CHD 在 3G 上
 * 下了 15 分钟，pcsx_rearmed 实例化时 4 次报 `Cannot allocate Wasm memory for new instance`。这里守住：
 *   1. 低内存核心包只改了 WASM 起步页数（其余逐字节一致），报告、版本表、记忆键跟着构建走；
 *   2. 预检用的「起步页数表」与 cores/ 里真实 WASM 一致，新增 / 换掉大内存核心时这里会红；
 *   3. 选核心、记偏好、换低内存版的规则，以及适配器 / 播放器 / 引擎补丁的接线位置。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cores = join(root, 'public', 'emulatorjs', 'cores')
const read = (p) => readFileSync(join(root, p), 'utf8')
const sevenZip = existsSync('/opt/homebrew/bin/7zz') || existsSync('/usr/local/bin/7zz') ? '7zz' : '7z'
const extract = (archive, member) => execFileSync(sevenZip, ['x', '-so', archive, member], { maxBuffer: 96 * 1024 * 1024 })
/**
 * 只取 WASM 开头一段：memory section 在函数表之后、代码段之前，几 MB 内一定读得到。
 * mame-current 的 WASM 解开有 242MB，整份读出来既慢又会撑爆 execFileSync 的缓冲。
 */
const extractHead = (archive, member, bytes = 16 * 1024 * 1024) => new Promise((resolve, reject) => {
  const child = spawn(sevenZip, ['x', '-so', archive, member], { stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks = []
  let size = 0
  let done = false
  const finish = () => {
    if (done) return
    done = true
    child.kill()
    resolve(Buffer.concat(chunks).subarray(0, bytes))
  }
  child.stdout.on('data', (chunk) => {
    chunks.push(chunk)
    size += chunk.length
    if (size >= bytes) finish()
  })
  child.on('close', finish)
  child.on('error', (error) => { if (!done) { done = true; reject(error) } })
})

const build = await import('./build-pcsx-lowmem-core.mjs')
const lowmem = await import('../src/emulator/psxLowmem.ts')
const memory = await import('../src/emulator/ejsCoreMemory.ts')
const chd = await import('../src/emulator/psxChd.ts')
const saveFs = await import('../src/emulator/ejsSaveFs.ts')
const paths = await import('../src/emulator/paths.ts')
const emulators = await import('../src/config/emulators.ts')
const versions = await import('../src/emulator/ejsCoreVersionsData.ts')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

/** 预先读好 cores/ 里每份核心 WASM 的内存声明（异步读头，下面的同步检查直接用） */
const coreMemory = []
for (const name of readdirSync(cores).sort()) {
  const m = /^(.+?)(-legacy)?-wasm\.data$/.exec(name)
  if (!m) continue
  const list = execFileSync(sevenZip, ['l', '-slt', join(cores, name)], { encoding: 'utf8' })
  const member = [...list.matchAll(/^Path = (.+\.wasm)$/gm)].map((x) => x[1])[0]
  if (!member) continue
  coreMemory.push({ name, core: m[1], ...build.readWasmMemoryLimits(await extractHead(join(cores, name), member)) })
}

/* ---------- 1. 低内存核心包 ---------- */
const report = JSON.parse(read('public/emulatorjs/cores/reports/pcsx_rearmed-lowmem.json'))
const MEMBERS = ['pcsx_rearmed_libretro.js', 'build.json', 'core.json', 'license.txt']
for (const variant of report.variants) {
  check(`${variant.file}：只有 memory section 的起步页数与源包不同`, () => {
    const target = join(cores, variant.file)
    const source = join(cores, variant.sourceFile)
    const targetBytes = readFileSync(target)
    assert.equal(createHash('sha256').update(targetBytes).digest('hex'), variant.sha256, '报告里的 sha256 与核心包不符：重跑 npm run build:pcsx-lowmem')
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), variant.sourceSha256,
      `源核心 ${variant.sourceFile} 换过了：低内存版必须从新的源包重新派生（npm run build:pcsx-lowmem）`)
    for (const member of MEMBERS) {
      assert.ok(extract(target, member).equals(extract(source, member)), `${member} 必须与默认 PCSX 逐字节一致`)
    }
    const lowWasm = extract(target, 'pcsx_rearmed_libretro.wasm')
    const srcWasm = extract(source, 'pcsx_rearmed_libretro.wasm')
    assert.equal(lowWasm.length, srcWasm.length, 'WASM 长度不能变（LEB128 等长改写）')
    const lowInfo = build.inspectWasm(lowWasm)
    const srcInfo = build.inspectWasm(srcWasm)
    assert.equal(srcInfo.memory.minPages, 8192, '默认 PCSX 起步 512 MiB（这次故障的取证前提）')
    assert.equal(lowInfo.memory.minPages * 65536, report.memory.initialBytes)
    assert.equal(lowInfo.memory.maxPages, 32768, '上限仍是 2 GiB')
    assert.ok(report.memory.initialBytes <= 64 * 1024 * 1024, '低内存版起步必须远小于 512 MiB')
    assert.ok(report.memory.initialBytes >= Math.max(lowInfo.dataEnd, lowInfo.stackPointer) + 16 * 1024 * 1024, '起步要装得下静态区与栈')
    const diffs = []
    for (let i = 0; i < lowWasm.length; i++) if (lowWasm[i] !== srcWasm[i]) diffs.push(i)
    const { minOffset, minLength } = srcInfo.memory
    assert.ok(diffs.length > 0 && diffs.every((i) => i >= minOffset && i < minOffset + minLength), '除起步页数外不许有任何字节不同')
    assert.ok(WebAssembly.validate(lowWasm))
    build.assertGrowableGlue(extract(target, 'pcsx_rearmed_libretro.js').toString('utf8'))
  })
}

check('报告 / 元数据别名 / 版本表 / 记忆键跟着构建走', () => {
  assert.equal(report.core, lowmem.PSX_LOWMEM_CORE)
  assert.equal(report.options.defaultWebGL2, true, '源报告是 defaultWebGL2，引擎才会下非 legacy 版')
  assert.ok(report.sha256.startsWith(lowmem.PSX_LOWMEM_BUILD), '换了低内存核心要同步 PSX_LOWMEM_BUILD')
  assert.equal(read('public/emulatorjs/cores/metadata/pcsx_rearmed-lowmem.json'), read('public/emulatorjs/cores/reports/pcsx_rearmed-lowmem.json'))
  for (const variant of report.variants) {
    assert.equal(versions.EJS_CORE_VERSIONS[`cores/${variant.file}`], variant.sha256.slice(0, 16), '版本表过期：node scripts/gen-ejs-core-versions.mjs')
  }
  assert.ok(paths.EJS_WEBGL2_DEFAULT_CORES.has(lowmem.PSX_LOWMEM_CORE), '预热要拉非 legacy 版，和引擎一致')
  assert.equal(paths.emulatorJsCoreDataFile(lowmem.PSX_LOWMEM_CORE), 'pcsx_rearmed-lowmem-wasm.data')
  assert.ok(emulators.SELF_BUILT_CORES.has(lowmem.PSX_LOWMEM_CORE), '不在 SELF_BUILT_CORES 里，npm run ejscores 会把它删掉')
  assert.match(read('scripts/copy-ejs-cores.mjs'), /PRESERVED_CORES = new Set\(\[\.\.\.SELF_BUILT_CORES/)
})

/* ---------- 2. 预检用的起步页数表 ---------- */
check('起步页数表与 cores/ 里每一份真实 WASM 一致', () => {
  const actual = {}
  assert.ok(coreMemory.length >= 40, `只读到 ${coreMemory.length} 份核心，读核心包的方式坏了`)
  for (const info of coreMemory) {
    if (info.minPages < memory.PREFLIGHT_MIN_INITIAL_PAGES) {
      assert.equal(memory.preflightPagesFor(info.core), null, `${info.core} 起步 ${info.minPages} 页，不该进预检表`)
      continue
    }
    assert.equal(info.maxPages, memory.EJS_CORE_MAXIMUM_PAGES, `${info.name} 的上限页数变了`)
    if (actual[info.core] !== undefined) assert.equal(actual[info.core], info.minPages, `${info.core} 两个变体起步不同`)
    actual[info.core] = info.minPages
  }
  assert.deepEqual({ ...memory.EJS_LARGE_CORE_INITIAL_PAGES }, actual, '起步 ≥256 MiB 的核心表与实际不符：改 src/emulator/ejsCoreMemory.ts')
  assert.equal(memory.preflightPagesFor('pcsx_rearmed'), 8192)
  assert.equal(memory.preflightPagesFor(lowmem.PSX_LOWMEM_CORE), null, '低内存版不预检（起步只有 64 MiB）')
  assert.equal(memory.preflightPagesFor('fbneo'), null)
})

check('canAllocateWasmMemory 用核心声明的起步 + 上限去分配', () => {
  const calls = []
  const fake = (limitPages) => function FakeMemory(desc) {
    calls.push(desc)
    if (desc.initial > limitPages) throw new RangeError('WebAssembly.Memory(): could not allocate memory')
  }
  assert.equal(memory.canAllocateWasmMemory(8192, 32768, fake(4096)), false)
  assert.deepEqual(calls.at(-1), { initial: 8192, maximum: 32768 })
  assert.equal(memory.canAllocateWasmMemory(8192, undefined, fake(8192)), true)
  assert.equal(calls.at(-1).maximum, 32768)
  assert.equal(memory.canAllocateWasmMemory(8192, 32768, null), null)
  // 真实引擎里 512 MiB 起步、2 GiB 上限的内存应能建出来（本机有足够地址空间时）
  assert.equal(memory.canAllocateWasmMemory(1024), true)
})

/* ---------- 3. 规则 ---------- */
check('只有能原地重开的默认 PCSX 才换低内存版', () => {
  assert.equal(lowmem.psxMemoryFallbackCore('psx', 'pcsx_rearmed', true), 'pcsx_rearmed-lowmem')
  assert.equal(lowmem.psxMemoryFallbackCore('psx', 'pcsx_rearmed', false), null, '联机 / 云端会话不擅自换核心')
  assert.equal(lowmem.psxMemoryFallbackCore('psx', 'pcsx_rearmed-lowmem', true), null, '低内存版也失败就不再来回切')
  assert.equal(lowmem.psxMemoryFallbackCore('psx', 'mednafen_psx', true), null, 'Beetle 的即时存档和 PCSX 不通用')
  assert.equal(lowmem.psxMemoryFallbackCore('arcade', 'pcsx_rearmed', true), null)
  assert.equal(lowmem.psxLowmemCoreFor('pcsx_rearmed', true), 'pcsx_rearmed-lowmem')
  assert.equal(lowmem.psxLowmemCoreFor('pcsx_rearmed', false), null)
  assert.equal(lowmem.psxLowmemCoreFor('mednafen_psx', true), null, '后台显式选的 Beetle 不动')
  assert.equal(paths.emulatorJsCoreForGame('psx', 'psx'), 'pcsx_rearmed', '平台别名 psx 落到默认 PCSX')
})

check('偏好按浏览器记 30 天，存储不可用时不猜', () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(lowmem.prefersPsxLowmem(storage, 1000), false)
  lowmem.rememberPsxMemoryFailure(storage, 1000)
  assert.equal(lowmem.prefersPsxLowmem(storage, 2000), true)
  assert.equal(lowmem.prefersPsxLowmem(storage, 1000 + 31 * 86400_000), false)
  assert.equal(lowmem.prefersPsxLowmem(storage, 500), false, '时间倒退时不认')
  assert.equal(lowmem.prefersPsxLowmem({ getItem() { throw new Error('denied') } }, 0), false)
  assert.doesNotThrow(() => lowmem.rememberPsxMemoryFailure({ setItem() { throw new Error('quota') } }))
  assert.ok([...store.keys()][0].endsWith(lowmem.PSX_LOWMEM_BUILD), '记忆键跟着低内存核心的构建走')
})

check('CHD / 多盘在低内存模式下仍走低内存 PCSX；Beetle 盘不混用存档', () => {
  const head = (codecs) => {
    const buf = new Uint8Array(32)
    buf.set(new TextEncoder().encode('MComprHD'), 0)
    buf[15] = 5
    codecs.forEach((codec, i) => buf.set(new TextEncoder().encode(codec), 16 + i * 4))
    return buf
  }
  const cdfl = head(['cdlz', 'cdzl', 'cdfl'])
  const beetleOnly = head(['cdzl'])
  assert.equal(chd.psxCoreForPreparedName('psx', 'pcsx_rearmed-lowmem', 'game.chd', cdfl), 'pcsx_rearmed-lowmem')
  assert.equal(chd.psxCoreForPreparedName('psx', 'pcsx_rearmed', 'game.chd', cdfl), 'pcsx_rearmed')
  assert.equal(chd.psxCoreForPreparedName('psx', 'pcsx_rearmed-lowmem', 'game.chd', beetleOnly), 'mednafen_psx')
  assert.equal(chd.psxCoreForPreparedName('psx', 'pcsx_rearmed-lowmem', 'game.chd', null), 'pcsx_rearmed-lowmem', '读不出头时按 PCSX 处理')
  assert.equal(chd.psxCoreForPreparedName('psx', 'pcsx_rearmed-lowmem', 'game.cue', cdfl), 'pcsx_rearmed-lowmem')
  assert.equal(chd.psxCoreForTransfer('psx', 'pcsx_rearmed-lowmem', 'https://x/roms/psx/a.zh-Hans.chd.8bg?romv=1'), 'pcsx_rearmed-lowmem')
  assert.equal(chd.psxCoreForTransfer('psx', 'pcsx_rearmed-lowmem', 'https://x/roms/psx/discs.m3u'), 'pcsx_rearmed-lowmem')
  assert.equal(chd.psxCoreForTransfer('psx', 'pcsx_rearmed', 'https://x/roms/psx/a.chd'), 'pcsx_rearmed')
  // 存档档位：CHD 传输的档位规则不看核心，低内存版与默认 PCSX 读写同一档（代码逐字节一致，状态互通）
  assert.equal(chd.psxChdSaveSlug('resident-evil-3-nemesis', 'https://x/a.chd.8bg'), 'resident-evil-3-nemesis:beetle-soft-chd')
})

check('换到低内存版时把引擎设置从系统 psx 复制过去（不覆盖已有的）', () => {
  const store = new Map([['ejs-7-psx-re3.chd-settings', '{"controlSettings":1}']])
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), get length() { return store.size }, key: (i) => [...store.keys()][i] ?? null }
  assert.equal(saveFs.copyEngineSettingsToSystem(storage, 7, 're3.chd', 'psx', 'pcsx_rearmed-lowmem'), true)
  assert.equal(store.get('ejs-7-pcsx_rearmed-lowmem-re3.chd-settings'), '{"controlSettings":1}')
  store.set('ejs-7-pcsx_rearmed-lowmem-re3.chd-settings', '{"mine":1}')
  assert.equal(saveFs.copyEngineSettingsToSystem(storage, 7, 're3.chd', 'psx', 'pcsx_rearmed-lowmem'), false)
  assert.equal(store.get('ejs-7-pcsx_rearmed-lowmem-re3.chd-settings'), '{"mine":1}')
  assert.equal(saveFs.copyEngineSettingsToSystem(storage, 7, 'other.chd', 'psx', 'pcsx_rearmed-lowmem'), false)
  assert.equal(store.get('ejs-7-psx-re3.chd-settings'), '{"controlSettings":1}', '旧键保留')
})

/* ---------- 4. 接线 ---------- */
check('适配器：下载 ROM 前预检，定下最终核心后、写引擎全局前再预检', () => {
  const src = read('src/emulator/adapters/emulatorjs.ts')
  const mountAt = src.indexOf('export function mount(')
  const body = src.slice(mountAt)
  const first = body.indexOf("if (!preflightCoreMemory('before-rom')) return")
  assert.ok(first > 0)
  for (const later of ['planBiosFiles(options.biosUrl', 'prepareRemoteDiscRom(', 'prepareRemoteArcadeRom(', 'preparePsxRangeDisc(']) {
    assert.ok(body.indexOf(later) > first, `${later} 必须排在预检之后`)
  }
  const second = body.indexOf("if (!preflightCoreMemory('before-engine')) return")
  assert.ok(second > body.indexOf('psxCoreForPreparedName(options.platform, core, engineGameName, chdHead)'), '要等 CHD 定下核心')
  assert.ok(second < body.indexOf('Object.assign(win, {'), '要在写 EJS_core、加载引擎之前')
  const helper = src.slice(src.indexOf('const preflightCoreMemory = '), src.indexOf('const preflightCoreMemory = ') + 2600)
  assert.match(helper, /stage === 'before-engine' && core === preflightPassedCore\) return true/, '同一个核心只预检一次，免得探针内存叠在核心之上')
  const order = ['canAllocateWasmMemory(pages)','options.inPlaceMemoryFallback?.(core)', 'options.onOutOfMemory?.(core, reason)', "rt.ejsOutOfMemory, 'config')"]
  order.reduce((at, needle) => {
    const next = helper.indexOf(needle)
    assert.ok(next > at, `预检里「${needle}」的顺序不对`)
    return next
  }, -1)
  assert.match(src, /if \(core === PSX_LOWMEM_CORE\) \{\s*try \{\s*copyEngineSettingsToSystem\(window\.localStorage, gameId, engineGameName, 'psx', PSX_LOWMEM_CORE\)/)
  assert.match(src, /preparedPsxRange\?\.multiDisc\s*\/\/[^\n]*\n\s*\? \(core === PSX_LOWMEM_CORE \? PSX_LOWMEM_CORE : PSX_CHD_COMPAT_CORE\)/)
})

check('播放器：开局读偏好、实例化失败重挂换核心、预检失败原地换；存档档位不变', () => {
  const player = read('src/emulator/EmulatorPlayer.tsx')
  assert.match(player, /rememberedPsxCore = [\s\S]{0,300}psxLowmemCoreFor\(emulatorJsCoreForGame\('psx', coreRef\.current\), prefersPsxLowmem\(\)\)/)
  assert.match(player, /rememberedArcadeCore \?\? rememberedPsxCore \?\? undefined/)
  assert.match(player, /onOutOfMemory: \(failedCore: string, reason: string\) => \{[\s\S]{0,1200}psxMemoryFallbackCore\([\s\S]{0,400}rememberPsxMemoryFailure\(\)[\s\S]{0,200}coreOverride: nextCore/)
  const inPlaceFallback = player.match(/inPlaceMemoryFallback: \(failedCore: string\) => \{([\s\S]{0,1400}?)\n      \},\n      onError:/)?.[1] ?? ''
  assert.match(inPlaceFallback, /psxMemoryFallbackCore\(/, '预检失败必须选择低内存 PCSX')
  assert.match(inPlaceFallback, /rememberPsxMemoryFailure\(\)/, '预检回退必须记住低内存偏好')
  assert.match(inPlaceFallback, /return nextCore/, '预检回退必须把新核心交给适配器')
  assert.doesNotMatch(player, /PSX_LOWMEM_CORE && coreSaveSlug/, '低内存 PCSX 与默认 PCSX 共用档位，不能另开')
  assert.match(read('src/emulator/types.ts'), /inPlaceMemoryFallback\?: \(core: string\) => string \| null/)
})

check('引擎：CUE 处理名单含低内存版，psx 别名组不含（否则存过的 retroarch_core 会把它换回 512 MiB）', () => {
  const js = read('public/emulatorjs/emulator.min.js')
  assert.ok(js.includes('["pcsx_rearmed","pcsx_rearmed-lowmem","genesis_plus_gx"'))
  assert.ok(js.includes('psx:["pcsx_rearmed","mednafen_psx_hw"]'))
})

console.log(`test:psx-lowmem 通过（${passed} 项）`)
