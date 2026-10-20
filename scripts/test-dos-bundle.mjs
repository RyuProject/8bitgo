/**
 * DOS 打包路径的回归测试。
 *
 * 盯的是这一类坑：**js-dos 在包解不开的时候不发任何 error 事件**。
 * 于是「ZIP 里少了几个文件」「条目名解成乱码」「启动程序根本不存在」这些问题
 * 全都表现成同一个样子 —— DOSBox 正常起来、遮罩正常撤掉、状态「运行中」，
 * 玩家对着一个黑屏或者 `C:\>` 提示符，没有任何提示。
 * 所以这些问题必须在 `Dos()` **之前**被抓出来抛掉（那样还能吃到一次自动重试，
 * 最后给玩家一句看得懂的话）。
 *
 * 跑：npm run test:dos-bundle
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeDosboxConfigOverride, mergeDosboxConfigOverride } from '../shared/dosbox-config.js'

const { isReadyJsdosBundleBlob, makeJsdosBundle, makeWindowsGameLayer, buildDosboxConf, mergeExtraFiles, readZipFile } = await import(
  fileURLToPath(new URL('../src/lib/jsdosBundle.ts', import.meta.url))
)
const {
  buildSockdriveWindowsGuestConfig,
  dosSockdriveProgramCommand,
  windowsGuestLaunchCommand,
  windowsSockdriveRegistryCommand,
} = await import(
  fileURLToPath(new URL('../src/lib/windowsGuest.ts', import.meta.url)),
)
const {
  windowsGameCompatibilityDosboxConfig,
  windowsGameCompatibilityExtras,
  windowsGameCompatibilityRegistryImport,
  windowsGameNeedsDirectDrawFocusRefresh,
} = await import(
  fileURLToPath(new URL('../src/emulator/windowsGameCompatibility.ts', import.meta.url))
)
const { dosGameCompatibilityExecutable, dosGameCompatibilityExtras, dosGameCompatibilityLaunchArguments, dosGameCompatibilityStartupCommands } = await import(
  fileURLToPath(new URL('../src/emulator/dosGameCompatibility.ts', import.meta.url)),
)
const {
  desktopSettled,
  desktopContentRatio,
  frameHasDesktopContent,
  frameDiffRatio,
  frameIsBlank,
  scheduleDosGuestLaunch,
  dosGuestCommandSequence,
  scheduleWindowsLaunch,
  windowsLaunchDelayMs,
  DESKTOP_SETTLE_FLOOR_MS,
  WINDOWS_CHORD_STEP_MS,
  WINDOWS_LAUNCH_VERIFY_MS,
  WINDOWS_SCREENSHOT_TIMEOUT_MS,
  WINDOWS_START_MENU_READY_MS,
} = await import(fileURLToPath(new URL('../src/emulator/windowsLaunch.ts', import.meta.url)))
const { startActiveTimeout } = await import(fileURLToPath(new URL('../src/emulator/activeTimeout.ts', import.meta.url)))
const {
  WINDOWS_GUEST_INIT_GRACE_MS,
  windowsGuestLaunchBudgetMs,
  windowsGuestStartupBudgetMs,
} = await import(fileURLToPath(new URL('../src/emulator/loadProgress.ts', import.meta.url)))

let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})
const throwsWith = async (fn, re, msg) => {
  n++
  let err = null
  try {
    await fn()
  } catch (e) {
    err = e
  }
  assert.ok(err, msg + '（应该抛，实际没抛）')
  assert.match(String(err.message), re, msg + `（错误信息对不上：${err.message}）`)
  console.log('✅ ' + msg)
}

/* ---------------- 造 ZIP ---------------- */

const te = new TextEncoder()
function crc32(data) {
  let c = ~0
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/**
 * 拼一个 store(0) 的 ZIP。
 * @param files [{ name, data?, method?, flags? }]，name 里的字节按 nameBytes 给可以模拟 GBK
 */
function makeZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = f.nameBytes ?? te.encode(f.name)
    const data = f.data ?? new Uint8Array(0)
    const method = f.method ?? 0
    const flags = f.flags ?? 0
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
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
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
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

  const all = [...parts, ...central, eocd]
  const total = all.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}

/** 从打好的包里读回条目名，用来断言重打包之后名字没被搞坏 */
function namesOf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = []
  for (let at = 0; at + 46 <= b.length; at++) {
    if (v.getUint32(at, true) !== 0x02014b50) continue
    const nameLen = v.getUint16(at + 28, true)
    out.push(new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen)))
  }
  return out
}

function centralFlagsOf(bytes, wanted) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let at = 0; at + 46 <= b.length; at++) {
    if (v.getUint32(at, true) !== 0x02014b50) continue
    const nameLen = v.getUint16(at + 28, true)
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen))
    if (name === wanted) return v.getUint16(at + 8, true)
  }
  return null
}

const EXE = te.encode('MZ')

console.log('── 打不开的包必须在 Dos() 之前抛，不能留给黑屏 ──')
{
  // deflate64 / LZMA：整段照抄进去，js-dos 解到那一条就断，而且不发 error
  await throwsWith(
    () => makeWindowsGameLayer(makeZip([{ name: 'GAME.EXE', data: EXE, method: 9 }]), 'GAME.EXE'),
    /不支持的压缩方式|method 9/,
    '⭐ deflate64(method 9) 直接抛，不打成一个解不开的盘',
  )
  await throwsWith(
    () => makeWindowsGameLayer(makeZip([{ name: 'GAME.EXE', data: EXE, method: 14 }]), 'GAME.EXE'),
    /不支持的压缩方式|method 14/,
    'LZMA(method 14) 同样抛',
  )
  // 加密条目：CRC 和长度全对得上，只有内容是密文 —— 最隐蔽的一种
  await throwsWith(
    () => makeWindowsGameLayer(makeZip([{ name: 'GAME.EXE', data: EXE, flags: 0x1 }]), 'GAME.EXE'),
    /带密码/,
    '⭐ 带密码的条目直接抛（CRC 和长度都对得上，不抛就只能靠黑屏发现）',
  )
  // store 和 deflate 是我们搬得动的，不能误伤
  const fine = makeWindowsGameLayer(makeZip([{ name: 'GAME.EXE', data: EXE, method: 0 }]), 'GAME.EXE')
  ok(fine.bytes instanceof Uint8Array, 'store(0) 正常通过')
}

console.log('\n── Daggerfall：启动参数与数据路径必须同时纠正 ──')
{
  const slug = 'the-elder-scrolls-ii-daggerfall'
  const originalCfg = 'type dfall_medium\r\npath c:\\dagger\\arena2\\\r\npathcd d:\\dagger\\arena2\\\r\nmapfile d\r\n'
  const rom = makeZip([
    { name: 'FALL.EXE', data: EXE },
    { name: 'DAGGER.EXE', data: EXE },
    { name: 'Z.CFG', data: te.encode(originalCfg) },
    { name: 'DFCD.iso', data: te.encode('fixture') },
    { name: 'ARENA2/ARCH3D.BSA', data: te.encode('data') },
  ])
  const launch = dosGameCompatibilityExecutable(slug, undefined)
  const args = dosGameCompatibilityLaunchArguments(slug, undefined)
  const startup = dosGameCompatibilityStartupCommands(slug, undefined)
  ok(launch === 'FALL.EXE' && args.join(' ') === 'Z.CFG', '未填入口时使用完整启动命令 FALL.EXE Z.CFG')
  ok(startup === 'imgmount d DFCD.iso -t iso', '挂载包内真正的原版 CD 镜像')
  ok(dosGameCompatibilityExecutable(slug, 'CUSTOM.BAT') === 'CUSTOM.BAT', '后台显式入口优先')
  ok(dosGameCompatibilityLaunchArguments(slug, 'FALL.EXE').join(' ') === 'Z.CFG', '后台若指定 FALL.EXE 仍自动补齐必需的配置参数')
  ok(dosGameCompatibilityLaunchArguments(slug, 'CUSTOM.BAT').length === 0, '后台显式入口不擅自添加参数')
  await throwsWith(
    () => buildDosboxConf('FALL.EXE', undefined, ['Z.CFG\nexit']),
    /参数必须是安全的 8\.3 文件名/,
    '启动参数不能夹带额外 DOS 命令',
  )
  ok(dosGameCompatibilityStartupCommands(slug, 'mount d own.iso -t iso') === 'mount d own.iso -t iso', '后台显式光盘命令优先')
  ok(dosGameCompatibilityExecutable('other-game', undefined) === undefined, '其它 DOS 游戏保持原启动规则')

  const extras = await dosGameCompatibilityExtras(slug, rom, [])
  ok(extras.length === 1 && extras[0].path === 'Z.CFG', '只生成一份 Z.CFG 覆盖文件')
  const bundle = await makeJsdosBundle('上古卷轴2匕首雨.zip', rom, undefined, undefined, launch, startup, extras, args)
  const final = await bundle.blob.arrayBuffer()
  const cfg = new TextDecoder().decode((await readZipFile(final, 'Z.CFG')).data)
  const conf = new TextDecoder().decode((await readZipFile(final, '.jsdos/dosbox.conf')).data)
  ok(bundle.executable === 'FALL.EXE' && /\nFALL\.EXE Z\.CFG\n/i.test(conf), '最终 bundle 的 autoexec 带配置参数启动 FALL.EXE')
  ok(/imgmount d DFCD\.iso -t iso\nFALL\.EXE Z\.CFG/i.test(conf), '真实 CD 先于游戏程序挂载')
  ok(/path c:\\arena2\\/i.test(cfg) && /pathcd d:\\dagger\\arena2\\/i.test(cfg), '最终配置分别指向 C: 安装目录与 D: 光盘数据')
  ok(cfg.includes('mapfile d') && !cfg.includes('c:\\dagger'), '其它配置保留，旧的 C: 安装路径已移除')
  ok(new TextDecoder().decode((await readZipFile(rom, 'Z.CFG')).data) === originalCfg, '玩家原始 ZIP 保持不变')

  const admin = [{ path: 'z.cfg', data: te.encode('custom') }]
  ok(await dosGameCompatibilityExtras(slug, rom, admin) === admin, '后台已提供 Z.CFG 时尊重它，不重复覆盖')
  await throwsWith(
    () => dosGameCompatibilityExtras(slug, makeZip([{ name: 'DAGGER.EXE', data: EXE }]), []),
    /缺少 DFCD\.iso/,
    '缺光盘镜像时在 Dos() 前明确报错',
  )
}

console.log('\n── Arena：光盘镜像与写入目录必须同时纠正 ──')
{
  const slug = 'the-elder-scrolls-arena'
  const originalBat = '@SET ARENADATA=C:\\ESARENA\r\n@D:\r\n@ACD -Ssbpdig.adv -IOS220\r\n'
  const cue = 'FILE "Arena.img" BINARY\r\n   TRACK 1 MODE1/2352\r\n   INDEX 1 00:00:00\r\n'
  const rom = makeZip([
    { name: 'ARENA.BAT', data: te.encode(originalBat) },
    { name: 'Arena.cue', data: te.encode(cue) },
    { name: 'Arena.img', data: te.encode('disc image fixture') },
    { name: 'CITYDATA.64', data: te.encode('save data') },
  ])
  const launch = dosGameCompatibilityExecutable(slug, undefined)
  const startup = dosGameCompatibilityStartupCommands(slug, undefined)
  ok(launch === 'ARENA.BAT', '未填入口时启动原版 ARENA.BAT')
  ok(startup === 'imgmount d Arena.cue -t iso', '运行 BAT 前先挂载包内 CUE / IMG 光盘')
  ok(dosGameCompatibilityExecutable(slug, 'CUSTOM.BAT') === 'CUSTOM.BAT', '后台显式 Arena 入口优先')
  ok(dosGameCompatibilityStartupCommands(slug, 'imgmount d other.cue -t iso') === 'imgmount d other.cue -t iso', '后台显式 Arena 挂盘命令优先')
  ok(dosGameCompatibilityLaunchArguments(slug, undefined).length === 0, 'Arena 不误继承 Daggerfall 的 Z.CFG 参数')

  const extras = await dosGameCompatibilityExtras(slug, rom, [])
  ok(extras.length === 1 && extras[0].path === 'ARENA.BAT', '只覆盖原版 BAT，不改光盘镜像')
  const bundle = await makeJsdosBundle('上古卷轴1豪华版.zip', rom, undefined, undefined, launch, startup, extras)
  const final = await bundle.blob.arrayBuffer()
  const conf = new TextDecoder().decode((await readZipFile(final, '.jsdos/dosbox.conf')).data)
  const bat = new TextDecoder().decode((await readZipFile(final, 'ARENA.BAT')).data)
  ok(bundle.executable === 'ARENA.BAT' && /imgmount d Arena\.cue -t iso\nARENA\.BAT/i.test(conf), '最终 autoexec 先挂光盘再执行 BAT')
  ok(bat.startsWith('@SET ARENADATA=C:\\\r\n@D:\r\n') && bat.includes('@ACD -Ssbpdig.adv -IOS220'), '最终 BAT 指向 C: 根并保留原版声卡参数')
  ok(new TextDecoder().decode((await readZipFile(rom, 'ARENA.BAT')).data) === originalBat, '玩家原始 ZIP 没有被修改')

  const admin = [{ path: 'arena.bat', data: te.encode('custom') }]
  ok(await dosGameCompatibilityExtras(slug, rom, admin) === admin, '后台已提供 BAT 时尊重它，不重复覆盖')
  const corrected = makeZip([
    { name: 'ARENA.BAT', data: te.encode(originalBat.replace('C:\\ESARENA', 'C:\\')) },
    { name: 'Arena.cue', data: te.encode(cue) },
    { name: 'Arena.img', data: te.encode('disc image fixture') },
  ])
  ok((await dosGameCompatibilityExtras(slug, corrected, [])).length === 0, '源包本来就修正了目录时不重打包')
  await throwsWith(
    () => dosGameCompatibilityExtras(slug, makeZip([{ name: 'ARENA.BAT', data: te.encode(originalBat) }]), []),
    /缺少 Arena\.cue 或 Arena\.img/,
    '缺光盘文件时在 Dos() 前明确报错',
  )
  await throwsWith(
    () => dosGameCompatibilityExtras(slug, makeZip([
      { name: 'ARENA.BAT', data: te.encode('@SET ARENADATA=C:\\UNKNOWN\r\n') },
      { name: 'Arena.cue', data: te.encode(cue) },
      { name: 'Arena.img', data: te.encode('disc image fixture') },
    ]), []),
    /不能安全修补/,
    '陌生的 BAT 路径不按猜测改写',
  )
}

console.log('\n── Caesar III：游戏分辨率必须与 Win95 的 800×600 对齐 ──')
{
  const c3Inf = (resolution, size = 560) => {
    const data = new Uint8Array(size)
    if (size >= 20) {
      const view = new DataView(data.buffer)
      view.setInt32(0, 16, true)
      view.setInt32(16, resolution, true)
    }
    return data
  }
  const rom = makeZip([
    { name: 'CAESAR3/c3.exe', data: EXE },
    { name: 'CAESAR3/c3.inf', data: c3Inf(3) },
  ])
  const extras = await windowsGameCompatibilityExtras('caesar-3', 'CAESAR3/c3.exe', rom, [])
  ok(extras.length === 1 && extras[0].path === 'CAESAR3/c3.inf', '1024×768 的 c3.inf 会生成一份同路径覆盖文件')
  ok(new DataView(extras[0].data.buffer, extras[0].data.byteOffset).getInt32(16, true) === 2, '⭐ resolutionId 从 3 改成 2（800×600）')

  const merged = mergeExtraFiles(rom, extras)
  const patched = await readZipFile(merged, 'caesar3/C3.INF')
  ok(Boolean(patched) && new DataView(patched.data.buffer, patched.data.byteOffset).getInt32(16, true) === 2, '补丁真正覆盖 ZIP 内的设置档，且查找不受路径大小写影响')
  const fusedLayer = makeWindowsGameLayer(rom, 'CAESAR3/c3.exe', 'd', undefined, extras)
  const oldLayer = makeWindowsGameLayer(merged, 'CAESAR3/c3.exe')
  ok(
    Buffer.from(fusedLayer.bytes).equals(Buffer.from(oldLayer.bytes)),
    '兼容补丁直接并入最终游戏层，产物与旧的两次整包复制逐字节相同',
  )

  const already800 = makeZip([
    { name: 'CAESAR3/c3.exe', data: EXE },
    { name: 'CAESAR3/c3.inf', data: c3Inf(2) },
  ])
  const noPatch = await windowsGameCompatibilityExtras('caesar-3', 'CAESAR3/c3.exe', already800, [])
  ok(noPatch.length === 0, '本来就是 800×600 时不重打八十多 MB 的 ROM')

  const unrelatedExtras = [{ path: 'PATCH.DAT', data: te.encode('keep') }]
  const untouched = await windowsGameCompatibilityExtras('theme-hospital', 'HOSPITAL.EXE', rom, unrelatedExtras)
  ok(untouched === unrelatedExtras, '主题医院是原生 DOS 640×480，不套用 Win95/Caesar 的补丁')

  const adminInf = { path: 'CAESAR3/C3.INF', data: c3Inf(1) }
  const replaced = await windowsGameCompatibilityExtras('caesar-3', 'CAESAR3/c3.exe', rom, [adminInf])
  ok(replaced.length === 1 && replaced[0].path === adminInf.path, '后台已有同路径附加文件时原位替换，不产生 ZIP 重名条目')
  ok(new DataView(replaced[0].data.buffer, replaced[0].data.byteOffset).getInt32(16, true) === 2, '后台附加的 640×480 设置同样纠正到 800×600')

  const malformed = makeZip([
    { name: 'CAESAR3/c3.exe', data: EXE },
    { name: 'CAESAR3/c3.inf', data: c3Inf(3, 32) },
  ])
  await throwsWith(
    () => windowsGameCompatibilityExtras('caesar-3', 'CAESAR3/c3.exe', malformed, []),
    /c3\.inf 长度异常/,
    '设置档格式不对时明确报错，不按猜测去改未知文件',
  )
}

console.log('\n── StarCraft：启动前静默导入安装路径 ──')
{
  ok(
    windowsGameCompatibilityRegistryImport('starcraft', 'StarCraft.exe') === 'STAR.REG',
    'StarCraft 自动选择同包的 STAR.REG',
  )
  ok(
    windowsGameCompatibilityRegistryImport('theme-hospital', 'HOSPITAL.EXE') === undefined,
    '其它 Windows 游戏不误导入 StarCraft 注册表',
  )
  ok(
    windowsGameNeedsDirectDrawFocusRefresh('starcraft', 'StarCraft.exe'),
    'StarCraft 启用老 DirectDraw 黑屏后的焦点刷新',
  )
  ok(
    windowsGameNeedsDirectDrawFocusRefresh('xuan-yuan-sword-scar-of-sky', 'Swd3e/swd3e.exe'),
    '⭐《天之痕》启用已在线复现的 DirectDraw 黑屏焦点刷新',
  )
  ok(
    !windowsGameNeedsDirectDrawFocusRefresh('xuan-yuan-sword-scar-of-sky', 'setup.exe'),
    '《天之痕》的第三方启动器不会误触发焦点刷新',
  )
  ok(
    !windowsGameNeedsDirectDrawFocusRefresh('theme-hospital', 'HOSPITAL.EXE'),
    '其它 Windows 游戏不误触发 DirectDraw 焦点刷新',
  )
  ok(
    /core=normal/.test(windowsGameCompatibilityDosboxConfig('starcraft', 'StarCraft.exe', undefined)),
    'StarCraft 默认使用已完成 Win95 实机验证的 normal core',
  )
  const explicitCore = windowsGameCompatibilityDosboxConfig(
    'starcraft',
    'StarCraft.exe',
    '[cpu]\ncore=dynamic\ncycles=max',
  )
  ok(
    /core=dynamic/.test(explicitCore) && /cycles=max/.test(explicitCore) && !/core=normal/.test(explicitCore),
    '后台显式 CPU 配置仍可覆盖兼容默认值',
  )
  ok(
    windowsGameCompatibilityDosboxConfig('theme-hospital', 'HOSPITAL.EXE', '[cpu]\ncycles=max') === '[cpu]\ncycles=max',
    '其它 Windows 游戏的 DOSBox 配置不被 StarCraft 规则改写',
  )
  await throwsWith(
    () => Promise.resolve(windowsGameCompatibilityRegistryImport('starcraft', 'Brood.exe')),
    /必须是 StarCraft\.exe/,
    '第三方 StarCraft 启动器不会被兼容分支放行',
  )
  ok(
    windowsSockdriveRegistryCommand('setup/STAR.REG', 'd') === 'regedit /s "D:\\setup\\STAR.REG"',
    '⭐ 流式盘从 Win95 运行框导入远程游戏盘里的注册表文件',
  )
  await throwsWith(
    () => Promise.resolve(windowsSockdriveRegistryCommand('../STAR.REG', 'd')),
    /安全的 \.reg/,
    '流式盘注册表命令拒绝目录穿越',
  )

  const layer = makeWindowsGameLayer(
    makeZip([
      { name: 'StarCraft.exe', data: EXE },
      { name: 'STAR.REG', data: te.encode('REGEDIT4') },
    ]),
    'StarCraft.exe',
    'd',
    'STAR.REG',
  )
  const layerBuffer = layer.bytes.buffer.slice(layer.bytes.byteOffset, layer.bytes.byteOffset + layer.bytes.byteLength)
  const launcher = await readZipFile(layerBuffer, 'GAME/8BITGO/RUN.BAT')
  const batch = new TextDecoder().decode(launcher.data)
  ok(
    batch.indexOf('regedit /s D:\\STAR.REG') < batch.indexOf('d:\r\n'),
    '⭐ 整包模式在启动 EXE 前同步导入注册表',
  )
  await throwsWith(
    () => Promise.resolve(makeWindowsGameLayer(makeZip([{ name: 'StarCraft.exe', data: EXE }]), 'StarCraft.exe', 'd', 'STAR.REG')),
    /找不到注册表兼容文件/,
    '缺少 STAR.REG 时开机前明确报错，不把失败留给 Win95 黑屏',
  )
  await throwsWith(
    () => Promise.resolve(makeWindowsGameLayer(makeZip([{ name: 'StarCraft.exe', data: EXE }]), 'StarCraft.exe', 'd', '../STAR.REG')),
    /安全的 \.reg/,
    '注册表路径拒绝目录穿越',
  )
}

console.log('\n── 后台填的启动程序，包里必须真有 ──')
{
  await throwsWith(
    () => makeJsdosBundle('game.zip', makeZip([{ name: 'PARANOID.COM', data: EXE }]), buildDosboxConf('MAKEEVAL.COM'), undefined, 'MAKEEVAL.COM'),
    /找不到后台配置的启动程序/,
    '⭐ 填错名字当场抛，而不是让玩家对着 C:\\> 提示符',
  )
  const good = await makeJsdosBundle('game.zip', makeZip([{ name: 'PARANOID.COM', data: EXE }]), buildDosboxConf('PARANOID.COM'), undefined, 'PARANOID.COM')
  ok(good.passthrough === false, '名字对得上就正常打包')
}

console.log('\n── 同一游戏中文先挂 CUE，免 CD 英文直接启动 ──')
{
  const archive = makeZip([
    { name: 'HEROES2.EXE', data: EXE },
    { name: 'CD/HEROES2_fixed.cue', data: te.encode('FILE "TRACK01.BIN" BINARY\n') },
    { name: 'CD/TRACK01.BIN', data: EXE },
  ])
  const commands = 'imgmount d "./CD/HEROES2_fixed.cue" -t cdrom'
  const chinese = await makeJsdosBundle('heroes.zip', archive, undefined, undefined, 'HEROES2.EXE', commands)
  const chineseBytes = new TextDecoder().decode(await chinese.blob.arrayBuffer())
  ok(chineseBytes.includes('mount c .\nc:\n' + commands + '\nHEROES2.EXE'), '⭐ 中文 autoexec 在启动程序前挂光盘，使用 ZIP 内相对路径')
  const english = await makeJsdosBundle('heroes.zip', archive, undefined, undefined, 'HEROES2.EXE')
  const englishBytes = new TextDecoder().decode(await english.blob.arrayBuffer())
  ok(englishBytes.includes('mount c .\nc:\nHEROES2.EXE') && !englishBytes.includes('imgmount d'), '⭐ 英文槽没有挂盘命令，直接运行程序')
  await throwsWith(
    () => makeJsdosBundle('heroes.zip', makeZip([{ name: 'HEROES2.EXE', data: EXE }]), undefined, undefined, 'HEROES2.EXE', commands),
    /找不到挂载命令指定的 CUE/,
    '⭐ CUE 不在 ZIP 时开机前指出缺镜像，不让游戏进无盘菜单',
  )
  await throwsWith(
    () => makeJsdosBundle('heroes.zip', archive, undefined, undefined, 'HEROES2.EXE', 'imgmount d "./CD/heroes2_fixed.cue" -t cdrom'),
    /大小写须一致/,
    '⭐ Web 宿主路径大小写敏感，填错 CUE 文件名不能假装挂载成功',
  )
  await throwsWith(
    () => makeJsdosBundle('heroes.zip', makeZip([
      { name: 'HEROES2.EXE', data: EXE },
      { name: 'CD/HEROES2_fixed.cue', data: te.encode('FILE "TRACK01.BIN" BINARY\n') },
    ]), undefined, undefined, 'HEROES2.EXE', commands),
    /找不到 CUE 引用的音轨文件/,
    '⭐ CUE 引用的 BIN 不在 ZIP 时提前报出文件名',
  )
}

console.log('\n── 自带 dosbox.conf 的 .jsdos 包不能吞掉后台配置 ──')
{
  const bundled = makeZip([
    { name: '.jsdos/' },
    { name: '.jsdos/dosbox.conf', data: te.encode('[autoexec]\nmount c .\nc:\nINSTALL.EXE\n') },
    { name: 'INSTALL.EXE', data: EXE },
    { name: 'PARANOID.COM', data: EXE },
  ])
  // 没填启动程序：照旧零拷贝透传，别为了几 KB 配置复制整块镜像
  const pass = await makeJsdosBundle('game.zip', bundled)
  ok(pass.passthrough === true, '没填启动程序时仍然零拷贝透传')

  // 填了启动程序：必须以我们生成的 conf 为准
  const overridden = await makeJsdosBundle(
    'game.zip',
    bundled,
    buildDosboxConf('PARANOID.COM'),
    undefined,
    'PARANOID.COM',
  )
  ok(overridden.passthrough === false, '⭐ 填了启动程序就不能再透传（否则那一栏对这类包完全无效）')
  const names = namesOf(new Uint8Array(await overridden.blob.arrayBuffer()))
  ok(names.includes('.jsdos/dosbox.conf'), '重打的包里仍然有 dosbox.conf')

  class TailOnlyBlob extends Blob {
    async arrayBuffer() {
      throw new Error('不该读取整份 Blob')
    }
  }
  const largePath = new TailOnlyBlob([bundled])
  ok(await isReadyJsdosBundleBlob(largePath), '⭐ 大型现成 bundle 只读 ZIP 尾部即可判定为可直接启动')
  ok(
    !(await isReadyJsdosBundleBlob(new Blob([makeZip([{ name: 'GAME.EXE', data: EXE }])]))),
    '安全的普通 ZIP 返回“需要补配置”，不会被误当成现成 bundle',
  )
  ok(
    !(await isReadyJsdosBundleBlob(new Blob([makeZip([
      { name: '.jsdos/dosbox.conf/' },
      { name: 'GAME.EXE', data: EXE },
    ])]))),
    '同名目录不能冒充 .jsdos/dosbox.conf 文件',
  )
  await throwsWith(
    () => isReadyJsdosBundleBlob(new Blob([makeZip([
      { name: '.jsdos/dosbox.conf', data: te.encode('[autoexec]\nGAME.EXE\n') },
      { name: '../GAME.EXE', data: EXE },
    ])])),
    /不安全/,
    '⭐ Blob 快路径同样拒绝目录穿越，不能因为不重打包就绕过安全边界',
  )
  await throwsWith(
    () => isReadyJsdosBundleBlob(new Blob([makeZip([
      { name: '.jsdos/dosbox.conf', data: te.encode('[autoexec]\nGAME.EXE\n') },
      { name: 'GAME.EXE', data: EXE, flags: 1 },
    ])])),
    /带密码/,
    '⭐ Blob 快路径提前拒绝带密码成员，避免 js-dos 静默黑屏',
  )
}

console.log('\n── 条目名：GBK / 反斜杠 / __MACOSX ──')
{
  // 「游戏」的 GBK 字节，不打 UTF-8 标志位 —— 中文 Windows 打的包就长这样
  const gbk = new Uint8Array([0xd3, 0xce, 0xcf, 0xb7, 0x2f, 0x47, 0x41, 0x4d, 0x45, 0x2e, 0x45, 0x58, 0x45]) // 游戏/GAME.EXE
  const layer = makeWindowsGameLayer(makeZip([{ nameBytes: gbk, data: EXE }]), '游戏/GAME.EXE')
  const names = namesOf(layer.bytes)
  ok(
    names.some((x) => x.includes('游戏')),
    '⭐ GBK 条目名解得出来（硬按 UTF-8 解会变成 U+FFFD，写回去就是另一个名字）',
  )
  ok(!names.some((x) => x.includes('\ufffd')), '包里不该出现替换符')
  ok((centralFlagsOf(layer.bytes, 'GAME/游戏/GAME.EXE') & 0x0800) !== 0, '⭐ 重打后的中文条目明确标成 UTF-8，解包器不会按本地代码页再解一次')

  // 反斜杠分隔：推不出父目录的话 js-dos 写文件 ENOENT，DOSBox 直接退出且不报错
  const back = makeZip([{ nameBytes: te.encode('SUB\\GAME.EXE'), data: EXE }])
  const layer2 = makeWindowsGameLayer(back, 'SUB/GAME.EXE')
  const names2 = namesOf(layer2.bytes)
  ok(names2.includes('GAME/SUB/'), '⭐ 反斜杠归一化之后父目录条目补得出来')
  ok(names2.includes('GAME/SUB/GAME.EXE'), '文件也落在正确的目录下')

  // macOS 归档的垃圾不该进游戏盘
  const mac = makeZip([
    { name: 'GAME.EXE', data: EXE },
    { name: '__MACOSX/._GAME.EXE', data: EXE },
    { name: '._GAME.EXE', data: EXE },
  ])
  const names3 = namesOf(makeWindowsGameLayer(mac, 'GAME.EXE').bytes)
  ok(!names3.some((x) => x.includes('__MACOSX') || x.includes('/._')), '__MACOSX / ._* 被滤掉')

  for (const unsafe of ['../GAME.EXE', '/GAME.EXE', 'C:/GAME.EXE']) {
    await throwsWith(
      () => makeJsdosBundle('unsafe.zip', makeZip([{ name: unsafe, data: EXE }])),
      /不安全/,
      `⭐ 普通 DOS 包拒绝越界路径 ${unsafe}`,
    )
    await throwsWith(
      () => Promise.resolve(makeWindowsGameLayer(makeZip([{ name: unsafe, data: EXE }]), unsafe)),
      /不安全/,
      `⭐ Windows 游戏层也拒绝越界路径 ${unsafe}`,
    )
  }

  await throwsWith(
    () => makeJsdosBundle('duplicate.zip', makeZip([
      { name: 'GAME.EXE', data: EXE },
      { name: 'game.exe', data: EXE },
    ])),
    /路径冲突/,
    '⭐ DOS 大小写不敏感：同路径不同大小写不能再靠解包顺序碰运气',
  )
  await throwsWith(
    () => makeJsdosBundle('parent-file.zip', makeZip([
      { name: 'GAME.EXE', data: EXE },
      { name: 'DATA', data: te.encode('file') },
      { name: 'DATA/LEVEL.DAT', data: te.encode('level') },
    ])),
    /不能同时作为.*目录|路径冲突/,
    '⭐ 父路径是文件时开机前报错，不留给 js-dos 解包 ENOENT 后黑屏',
  )
}

console.log('\n── Windows 3.x：盘根只有在包里全在一层时才准收窄 ──')
{
  // EXE 在子目录，兄弟目录里还有数据 → 收窄的话那些数据在客体里根本不存在
  const spread = makeZip([
    { name: 'BIN/GAME.EXE', data: EXE },
    { name: 'DATA/LEVEL1.DAT', data: te.encode('x') },
  ])
  const l1 = makeWindowsGameLayer(spread, 'BIN/GAME.EXE')
  ok(l1.singleDir === false, '⭐ 数据在 EXE 目录之外 → singleDir=false（不准收窄盘根）')
  ok(
    windowsGuestLaunchCommand({ gameDrive: 'D', launcher: 'D:\\X' }, l1.executable, '3x', false) === 'D:\\BIN\\GAME.EXE',
    '没收窄时命令要带上子目录，否则 File > Run 在盘根上找不到它',
  )

  // 全在一层 → 可以收窄，命令只敲文件名
  const together = makeZip([
    { name: 'BIN/GAME.EXE', data: EXE },
    { name: 'BIN/LEVEL1.DAT', data: te.encode('x') },
  ])
  const l2 = makeWindowsGameLayer(together, 'BIN/GAME.EXE')
  ok(l2.singleDir === true, '全在 EXE 那一层 → singleDir=true')
  ok(
    windowsGuestLaunchCommand({ gameDrive: 'D', launcher: 'D:\\X' }, l2.executable, '3x', true) === 'D:\\GAME.EXE',
    '收窄之后只敲文件名',
  )

  // EXE 就在根上：两种写法应该一致
  const root = makeWindowsGameLayer(makeZip([{ name: 'GAME.EXE', data: EXE }]), 'GAME.EXE')
  ok(root.singleDir === true, 'EXE 在根上时 singleDir=true')

  // 9x 那条路不受影响，永远走 RUN.BAT
  ok(
    windowsGuestLaunchCommand({ gameDrive: 'D', launcher: 'D:\\8BITGO\\RUN.BAT' }, 'BIN/GAME.EXE', '9x', false) ===
      'D:\\8BITGO\\RUN.BAT',
    '9x 仍然走固定的 RUN.BAT',
  )
}

console.log('\n── autoexec：CD 不许带引号，进不去的目录改挂 D: 盘 ──')
{
  /*
    回归用例。fced184（9/6）把这一行改成了 `cd "${dir}"`，而 DOSBox 的 CD 不剥引号：
    `cd "caeser"` 去找一个连引号一起的目录名，打印 `Unable to change to: "caeser".`，
    接着在 C:\ 根上跑启动程序报 Illegal command —— 从那天起，所有「启动程序在子目录里」
    的 DOS 游戏都停在一个 `C:\>` 提示符上，而当时这里的断言正好在要求那个错误行为。
  */
  const sub = buildDosboxConf('caeser/CAESAR.BAT')
  ok(/^cd caeser$/m.test(sub), '⭐ 合法 8.3 目录直接 cd，不加引号（DOSBox 的 CD 不剥引号）')
  ok(!/cd "/.test(sub), '⭐ autoexec 里不许再出现 cd "…"')
  ok(!/mount d/.test(sub), '目录名合法时不该多挂一个盘')
  ok(sub.indexOf('cd caeser') < sub.indexOf('CAESAR.BAT'), '先切目录再跑启动程序')

  // 多级目录仍然是一条 cd，斜杠换成反斜杠
  ok(/^cd game\\bin$/m.test(buildDosboxConf('game/bin/G.EXE')), '多级合法目录拼成一条 cd，用反斜杠')

  /*
    带空格的目录：加引号进不去（上面那条），不加引号 CD 只吃到第一个词，也进不去 ——
    空格在 DOS 文件名里本来就非法。唯一稳的写法是单独挂一个盘，MOUNT 会剥引号。
  */
  const spaced = buildDosboxConf('Prince of Persia/PRINCE.EXE')
  ok(!/^cd /m.test(spaced), '⭐ 带空格的目录不能用 CD（加不加引号都进不去）')
  ok(spaced.includes('mount d "./Prince of Persia"'), '⭐ 改成挂 D: 盘（MOUNT 走 CommandLine，会剥引号）')
  ok(/^d:$/m.test(spaced), '挂完要切到 D:')
  ok(spaced.includes('mount c .'), 'C: 仍然保留，EXE 目录之外的数据还要能访问')
  ok(spaced.indexOf('mount c .') < spaced.indexOf('mount d '), 'D: 挂在 C: 之后')
  ok(spaced.indexOf('mount d ') < spaced.indexOf('PRINCE.EXE'), '挂完盘再跑启动程序')
  ok(/^PRINCE\.EXE$/m.test(spaced), '文件名本身没空格就不用加引号')

  // 超过 8 个字符同样不是合法 8.3，CD 进不去
  ok(buildDosboxConf('LONGDIRECTORY/G.EXE').includes('mount d "./LONGDIRECTORY"'), '目录名超过 8 个字符也要挂盘')
  // 多级目录里只要有一段不合法，整条路径都得走挂盘
  ok(buildDosboxConf('game/My Data/G.EXE').includes('mount d "./game/My Data"'), '多级目录里有一段不合法 → 整条挂盘')

  // 目录名里带引号的话 MOUNT 的参数无法转义，宁可报错也不能挂错目录
  let quoted = null
  try { buildDosboxConf('we"ird/G.EXE') } catch (e) { quoted = e }
  ok(quoted instanceof Error && /无法挂载/.test(quoted.message), '目录名带引号时抛一句指名道姓的错误')

  const root = buildDosboxConf('GAME.EXE')
  ok(!/^cd /m.test(root) && !/mount d/.test(root), '启动程序在根上时既不 cd 也不挂盘')

  let longNameError = null
  try { buildDosboxConf('My Game.exe') } catch (e) { longNameError = e }
  ok(/8\.3/.test(longNameError?.message || ''), '⭐ 没有 ZIP 清单时不再生成明知跑不通的带引号命令')
  const aliased = await makeJsdosBundle(
    'my-game.zip',
    makeZip([{ name: 'My Game.exe', data: EXE }]),
    undefined,
    undefined,
    'My Game.exe',
  )
  const aliasedBytes = new Uint8Array(await aliased.blob.arrayBuffer())
  const aliasedNames = namesOf(aliasedBytes)
  ok(aliasedNames.includes('My Game.exe'), '长文件名原件仍保留，游戏内部按原名引用不会断')
  ok(aliasedNames.includes('8BITGO.EXE'), '⭐ 同目录补出真实存在的 8.3 启动别名')
  const aliasedText = new TextDecoder().decode(aliasedBytes)
  ok(/\n8BITGO\.EXE\n/.test(aliasedText) && !aliasedText.includes('"My Game.exe"'), '⭐ autoexec 执行别名，不再停在 C:\\>')
  ok(/@echo .*exited\./.test(root), '末尾留一句 DOS 字符页能显示的人话，真没跑起来时不再乱码')
  const none = buildDosboxConf(null)
  ok(none.includes('No executable was found.'), '猜不出启动程序时仍有 DOS 字符页能显示的提示')
}

console.log('\n── 普通 DOS 包必须显式开启游戏需要的内存接口 ──')
{
  /*
    Heroes II 在进图形界面前会检查 6400K XMS + 480K 常规内存。
    ZIP 没有自带 dosbox.conf 时会走这份精简配置，所以不能把成败寄托在
    js-dos / DOSBox 某个版本的隐式默认值上。
  */
  const memory = buildDosboxConf('HEROES2.EXE')
  ok(/\[dosbox\]\nmemsize=16(?:\n|$)/.test(memory), '自动配置明确给普通 DOS 游戏 16 MB 内存')
  ok(/\[dos\]\nxms=true\nems=true\numb=true(?:\n|$)/.test(memory), '自动配置明确开启 XMS / EMS / UMB')
  ok(memory.indexOf('[dosbox]') < memory.indexOf('[autoexec]'), '内存配置在启动游戏前已生效')

  const tuned = await makeJsdosBundle(
    'HEROES2.zip',
    makeZip([{ name: 'HEROES2.EXE', data: EXE }]),
    undefined,
    '[dosbox]\nmemsize=32\n\n[dos]\nems=false',
  )
  const tunedText = new TextDecoder().decode(await tuned.blob.arrayBuffer())
  ok(/\[dosbox\]\nmemsize=32/.test(tunedText), '普通 DOS 的逐游戏 memsize 覆盖写进最终 bundle')
  ok(/\[dos\]\nxms=true\nems=false\numb=true/.test(tunedText), '普通 DOS 可以逐游戏关闭有兼容性冲突的 EMS')
}

console.log('\n── 大型纯 DOS 游戏：DOS 7.1 启动盘 + D: Sockdrive 边下边玩 ──')
{
  const url = 'https://assets.example.test/sockdrives/fallout-en-v1'
  const guest = buildSockdriveWindowsGuestConfig(
    '[dosbox]\nmemsize=16\n\n[autoexec]\necho off\nimgmount 2 system-fat32-2gb.qcow2\n',
    url,
    windowsGameCompatibilityDosboxConfig('fallout', 'FALLOUT.EXE', undefined),
  )
  ok(guest.dosboxConf.includes(`imgmount 3 sockdrive ${url}`), '⭐ DOS 7.1 占 C:，纯 DOS 流式游戏盘挂成 BIOS 第二盘 D:')
  ok(guest.dosboxConf.includes('\nboot c: -convertfat\n'), '挂完两块盘后启动真实 DOS，D: 才会变成可访问盘符')
  ok(dosSockdriveProgramCommand('FALLOUT.EXE', guest.gameDrive) === 'D:\\FALLOUT.EXE', '真实 DOS 提示符会启动 D:\\FALLOUT.EXE')
  ok(/\[dosbox\][\s\S]*memsize=32/.test(guest.dosboxConf), 'Fallout 流式模式保留已验证的 32MB 内存配置')
  ok(
    /\[cpu\][\s\S]*core=normal/.test(guest.dosboxConf) && /\[cpu\][\s\S]*cycles=fixed 30000/.test(guest.dosboxConf),
    'Fallout 流式模式保留已验证的 CPU 配置',
  )
  await throwsWith(
    () => Promise.resolve(dosSockdriveProgramCommand('Long Folder/FALLOUT.EXE', 'D')),
    /DOS 8\.3/,
    '真实 DOS 自动输入不能绕过长路径，开局前明确拒绝不可靠入口',
  )
}

console.log('\n── 普通 DOS 的附加文件直接并进最终 bundle ──')
{
  const bundled = await makeJsdosBundle(
    'game.zip',
    makeZip([
      { name: 'GAME.EXE', data: EXE },
      { name: 'DATA/PATCH.DAT', data: te.encode('old') },
    ]),
    undefined,
    undefined,
    undefined,
    undefined,
    [
      { path: 'DATA/PATCH.DAT', data: te.encode('new-patch') },
      { path: 'MAPS/LEVEL1.MAP', data: te.encode('new-map') },
    ],
  )
  const bytes = new Uint8Array(await bundled.blob.arrayBuffer())
  const names = namesOf(bytes)
  ok(names.filter((name) => name === 'DATA/PATCH.DAT').length === 1, '同名补丁直接替换，不留下两条顺序不明的文件')
  ok(names.includes('MAPS/') && names.includes('MAPS/LEVEL1.MAP'), '新资料片目录在文件之前补进最终 bundle')
  const text = new TextDecoder().decode(bytes)
  ok(text.includes('new-patch') && !text.includes('old'), '最终 bundle 只保留补丁后的内容')
}

/**
 * 保护表是模块私有的，这里从源码里解析出来 —— 比为了测试专门加一个导出干净，
 * 也顺带保证测试读的就是真表，不会和实现漂开。
 */
const PROTECTED_FOR_TEST = (() => {
  const src = readFileSync(new URL('../shared/dosbox-config.js', import.meta.url), 'utf8')
  const at = src.indexOf('const protectedKeys = new Map([')
  assert.ok(at > 0, '没找到 protectedKeys —— 实现改名了，这组测试要跟着改')
  const body = src.slice(at, src.indexOf('\n])', at))
  const out = []
  for (const m of body.matchAll(/\['([a-z0-9]+)',\s*new Set\(\[([^\]]*)\]\)/g)) {
    out.push([m[1], [...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1])])
  }
  assert.ok(out.length > 0, '解析 protectedKeys 失败')
  return out
})()

console.log('\n── 高级配置：站点托管的那几个键，换个拼法也得拦住 ──')
{
  /*
    2026-09-11 的教训。保护表里原本写的是 `mouse_emulation`，而 js-dos 的
    Win311 镜像里写的是 `mouse emulation=integration`（空格）—— 看起来像是被绕过去了。

    去 wdosbox-x.wasm 里查了才知道：DOSBox-X 认的确实是下划线那个，
    带空格的那行它根本不认识（所以镜像里那一行其实是空转）。保护没漏。

    但这件事说明按字面比太脆：DOSBox-X 自己两种风格混着用
    （`mouse_emulation` 下划线，`convert fat free space` / `integration device` 空格），
    哪天改个拼法，或者哪个版本两种都认，保护就静默失效了 —— 而失效是没有任何迹象的。
    所以现在按规范形式比（下划线/连字符/空格折叠成一个空格），两种写法一起拦。
  */
  const blocked = (text) => {
    try {
      normalizeDosboxConfigOverride(text)
      return null
    } catch (e) {
      return e.message
    }
  }

  for (const [label, text] of [
    ['下划线写法', '[sdl]\nmouse_emulation=locked'],
    ['空格写法', '[sdl]\nmouse emulation=locked'],
    ['连字符写法', '[sdl]\nmouse-emulation=locked'],
    ['大写混排', '[sdl]\nMouse_Emulation=locked'],
  ]) {
    ok(/由站点统一管理/.test(blocked(text) || ''), `⭐ 鼠标模式：${label}也拦得住`)
  }
  ok(/由站点统一管理/.test(blocked('[sdl]\nautolock=true') || ''), 'autolock 仍然拦')
  ok(/由站点统一管理/.test(blocked('[dosbox]\nconvert_fat_free_space=999') || ''), '⭐ 动态盘上限：下划线写法也拦')
  ok(/由站点统一管理/.test(blocked('[cpu]\nintegration device=false') || ''), '⭐ 集成设备不许关（Windows 客体的 dboxmpi.drv 指着它）')
  ok(/由站点统一管理/.test(blocked('[cpu]\nintegration_device=false') || ''), '⭐ 集成设备：下划线写法也拦')

  // 反向用例：只验证「拦住了」很容易写出一张把所有键都拦掉的表
  ok(blocked('[cpu]\ncycles=max') === null, 'cycles 照常可以改')
  ok(blocked('[sblaster]\nsbtype=sb16') === null, 'sbtype 照常可以改')
  ok(blocked('[mixer]\nnosound=true') === null, 'nosound 照常可以改')
  ok(blocked('[sdl]\nsensitivity=80') === null, '同一个 section 里没被点名的键不受影响')

  // 同一个键换拼法写两遍 = 重复，不是两个键
  // ⚠️ 这里必须用允许编辑的 section，否则先撞上「不允许编辑 [xxx] 配置段」，
  //    这条断言就变成在验证另一件事了（空断言）。
  ok(/重复出现/.test(blocked('[cpu]\ncore=auto\nCore=normal') || ''), '⭐ 同一个键换个大小写写两遍算重复')
  ok(/重复出现/.test(blocked('[render]\nscaler test=1\nscaler_test=2') || ''), '⭐ 空格 / 下划线写两遍也算重复')

  // 合并时也要认同一个键，否则会在 section 里追加出第二行无效项
  const spaced = 'vesa vbe put modelist in vesa information'
  const merged = mergeDosboxConfigOverride(
    `[dosbox]\n${spaced}=false\n`,
    `[dosbox]\n${spaced.replace(/ /g, '_')}=true`,
  )
  ok(
    (merged.match(/vesa[ _]vbe[ _]put[ _]modelist/gi) || []).length === 1,
    '⭐ 换拼法覆盖已有项时替换那一行，而不是在 section 里再追加一行（两行同名，DOSBox 只认一个）',
  )
  ok(/=true/.test(merged) && !/=false/.test(merged), '值确实被覆盖成新的了')

  /*
    ⚠️ 反方向也要试。上面那组里**基础配置本来就是规范形式**，所以就算只把覆盖项
    规范化、比对时拿原文比，也照样能撞上 —— 那条断言杀不掉「只规范化一半」这个变异。
    真正会漏的是「基础配置用下划线、覆盖项用空格」这一边。
  */
  const mergedBack = mergeDosboxConfigOverride(
    `[dosbox]\n${spaced.replace(/ /g, '_')}=false\n`,
    `[dosbox]\n${spaced}=true`,
  )
  ok(
    (mergedBack.match(/vesa[ _]vbe[ _]put[ _]modelist/gi) || []).length === 1,
    '⭐ 基础配置用下划线、覆盖项用空格时，同样是替换而不是追加',
  )
  ok(/=true/.test(mergedBack) && !/=false/.test(mergedBack), '反方向的值也确实覆盖上了')
}

console.log('\n── 保护表里的键必须是模拟器真认识的 ──')
{
  /*
    ⚠️ 一个拼错的保护键 = 一道**什么都没保护**的保护，而且完全静默。
    上面那次就是差点在这里翻车：光看代码没法知道 `mouse_emulation` 是不是真名字。
    所以直接拿 wasm 里的字符串表对一遍 —— 名字在不在模拟器里，二进制说了算。
  */
  const pathsSource = readFileSync(new URL('../src/emulator/paths.ts', import.meta.url), 'utf8')
  const jsdosVersion = pathsSource.match(/export const JSDOS_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  if (!jsdosVersion) throw new Error('src/emulator/paths.ts 缺 JSDOS_ASSET_VERSION')
  const cores = [
    `public/jsdos/v${jsdosVersion}/emulators/wdosbox-x.wasm`,
    `public/jsdos/v${jsdosVersion}/emulators/wdosbox.wasm`,
  ]
    .map((rel) => new URL('../' + rel, import.meta.url))
    .filter((u) => existsSync(u))

  if (cores.length === 0) {
    console.log('  ⏭  跳过：public/jsdos 还没拉下来（npm run jsdos）')
  } else {
    const pools = cores.map((u) => readFileSync(u))
    /** 名字是不是以独立字符串出现在某个核心里（前后都是 NUL，避免子串误判） */
    const knownToEmulator = (name) =>
      pools.some((buf) => buf.includes(Buffer.concat([Buffer.from([0]), Buffer.from(name, 'latin1'), Buffer.from([0])])))

    for (const [section, keys] of PROTECTED_FOR_TEST) {
      for (const canonical of keys) {
        const spellings = [canonical, canonical.replace(/ /g, '_'), canonical.replace(/ /g, '-')]
        ok(
          spellings.some(knownToEmulator),
          `⭐ [${section}] ${canonical} —— 在 wdosbox-x/wdosbox 的字符串表里找得到（找不到就说明这条保护是空的）`,
        )
      }
    }
  }
}

console.log('\n── 后台那几个一键模板必须是合法配置 ──')
{
  /*
    模板是写死在 GameForm.tsx 里的字符串。写错一个字母不会有任何编译期错误，
    只会在管理员点下去的那一刻炸一句「配置第 N 行…」—— 而那时候人已经在改别的东西了。
    这里直接把它们喂给真正的校验器过一遍。
  */
  const form = readFileSync(new URL('../src/admin/GameForm.tsx', import.meta.url), 'utf8')
  const at = form.indexOf('const DOSBOX_CONFIG_TEMPLATES = [')
  assert.ok(at > 0, '没找到 DOSBOX_CONFIG_TEMPLATES —— 改名了的话这组测试要跟着改')
  const body = form.slice(at, form.indexOf('\n] as const', at))
  const templates = [...body.matchAll(/\{ label: '([^']+)', config: '((?:[^'\\]|\\.)*)' \}/g)]
    .map((m) => [m[1], m[2].replace(/\\n/g, '\n')])
  ok(templates.length >= 6, `解析出 ${templates.length} 个模板`)

  for (const [label, config] of templates) {
    let err = null
    try {
      normalizeDosboxConfigOverride(config)
    } catch (e) {
      err = e.message
    }
    ok(err === null, `模板「${label}」是合法配置${err ? ' —— ' + err : ''}`)
  }

  // 叠着点也要还是合法的：applyDosboxTemplate 是 merge 不是覆盖
  let merged = ''
  for (const [, config] of templates) merged = mergeDosboxConfigOverride(merged || '[cpu]\ncputype=auto\n', config)
  ok(/cycles=max/.test(merged) && /memsize=32/.test(merged) && /oplemu=fast/.test(merged), '六个模板叠着点之后每一项都还在')

  const perf = templates.filter(([l]) => l.includes('⚡')).map(([l]) => l)
  ok(perf.length === 3, `三个性能模板都在（${perf.join('、')}）`)
}

/* ══════════ Windows 客体的自动启动：什么时候敲键、什么时候认账 ══════════ */

/**
 * 虚拟时钟。`scheduleWindowsLaunch` 整条链都走 `window.setTimeout`，
 * 真等的话这一节要跑一分多钟；而且「第 24 秒才敲键」这种断言本来就得看虚拟时刻。
 */
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const win = {
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + Math.max(0, ms || 0), fn, seq: id })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  }
  // 截图是 Promise，定时器之间必须把微任务放干净，否则链条推不动
  const drain = async () => {
    for (let i = 0; i < 64; i++) await Promise.resolve()
  }
  return {
    win,
    get now() { return now },
    async runUntil(limit) {
      for (;;) {
        let next = null
        for (const t of timers.values()) {
          if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t
        }
        if (!next || next.at > limit) break
        timers.delete(next.seq)
        now = next.at
        next.fn()
        await drain()
      }
      now = limit
      await drain()
    },
    async fireNextLate(at) {
      let next = null
      for (const t of timers.values()) {
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t
      }
      if (!next) return
      timers.delete(next.seq)
      now = at
      next.fn()
      await drain()
    },
  }
}

console.log('\n── Windows 客体的启动超时：只累计前台、分开建盘和开机 ──')
{
  const adapterSource = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
  ok(
    /armGuestStartupTimeout\('ci', windowsGuestStartupBudgetMs\(options\.dosLaunchDelay\)\)/.test(adapterSource),
    'Win95 建盘阶段保留原有上限，不因拆段计时缩短慢设备的启动机会',
  )
  ok(
    /armGuestStartupTimeout\('boot', windowsGuestLaunchBudgetMs\(options\.dosLaunchDelay\)\)/.test(adapterSource),
    'CI 建好后自动启动独立计时，不让建盘时间挤占后续启动机会',
  )
  ok(
    WINDOWS_GUEST_INIT_GRACE_MS + windowsGuestLaunchBudgetMs(24) === windowsGuestStartupBudgetMs(24),
    '建盘与开机两段预算相加仍等于原来的总上限，不缩短慢设备的可用时间',
  )
  const clock = fakeClock()
  globalThis.window = clock.win
  let foreground = false
  let fired = 0
  const cancel = startActiveTimeout(2_000, () => foreground, () => fired++)
  await clock.runUntil(390_000)
  ok(fired === 0, '浏览器标签页在后台即使超过原总上限，也不误报客体超时')
  foreground = true
  await clock.runUntil(391_000)
  ok(fired === 0, '回到前台一秒后，启动流程仍有剩余预算')
  await clock.runUntil(392_000)
  ok(fired === 1, '真正消耗两秒前台预算后才报超时')
  cancel()

  const stalled = fakeClock()
  globalThis.window = stalled.win
  let stalledFired = 0
  startActiveTimeout(2_000, () => true, () => stalledFired++)
  await stalled.fireNextLate(390_000)
  ok(stalledFired === 0, '主线程长时间停住后首次恢复，不把整段墙上时间当成启动时间')
  await stalled.runUntil(391_000)
  ok(stalledFired === 1, '恢复后仍按剩余前台预算判定真正停滞')

  const aborted = fakeClock()
  globalThis.window = aborted.win
  let canceledFired = false
  startActiveTimeout(1_000, () => true, () => { canceledFired = true })()
  await aborted.runUntil(2_000)
  ok(!canceledFired, '会话销毁或启动成功后取消计时器，不再迟到报错')
}

const frameCache = new Map()
/** 一帧画面。同一个 (w,h,fill) 复用同一个对象：640×480×4 是 1.2MB，别在测试里反复分配 */
function mkFrame(w, h, fill) {
  const key = `${w}x${h}:${fill}`
  let f = frameCache.get(key)
  if (!f) {
    f = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(fill) }
    frameCache.set(key, f)
  }
  return f
}
/**
 * 一帧「壳已经画出来了」的桌面：纯色底 + 底部任务栏 + 几个图标方块。
 *
 * 尺寸刻意照实测来（本地复现 system-win95-v1，640×480）：任务栏 640×28 占 5.8%、
 * 四个 32×32 图标占 1.3%，合起来非主色像素约 7% —— 和真桌面量级一致。
 * 桌面判定靠的就是这个比例（见 desktopContentRatio），拿「整屏一个颜色」的假帧测不出真行为。
 */
function mkDesktop(w, h, bg, bar) {
  const f = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let i = 0; i < w * h; i++) {
    const at = i * 4
    f.data[at] = bg
    f.data[at + 1] = bg
    f.data[at + 2] = bg
    f.data[at + 3] = 255
  }
  const paint = (x0, y0, bw, bh, v) => {
    for (let y = y0; y < y0 + bh && y < h; y++) {
      for (let x = x0; x < x0 + bw && x < w; x++) {
        const at = (y * w + x) * 4
        f.data[at] = v
        f.data[at + 1] = v
        f.data[at + 2] = v
      }
    }
  }
  paint(0, h - 28, w, 28, bar)
  for (let k = 0; k < 4; k++) paint(8, 8 + k * 40, 32, 32, bar + 30)
  return f
}

const TEXT = mkFrame(720, 400, 10)
/** 壳已经画出来了（图标 + 任务栏） */
const DESKTOP = mkDesktop(640, 480, 40, 190)
/** 还在画：底色就不一样，所以两帧之间是「整屏都在变」 */
const DESKTOP_PAINTING = mkDesktop(640, 480, 90, 200)
const GAME = mkFrame(640, 480, 200)
// Win95 进桌面之前那段纯黑图形模式（本站镜像没有 LOGO.SYS，连开机画面都没有）
const BLACK = mkFrame(640, 480, 0)
/**
 * Win95 画出桌面**背景**、壳还没起来的那一段：一片纯青绿 + 一个光标。
 * 实测非主色像素只占 0.04%～0.1%（光标那几十个像素），任务栏/图标一个都没有。
 */
const WALLPAPER = mkFrame(640, 480, 40)

console.log('\n── 纯 DOS 客体：等 DOS 7.1 提示符后切盘、切目录、启动游戏 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const keys = []
  const milestones = []
  let launchedAt = null
  const cancel = scheduleDosGuestLaunch(
    { sendKeyEvent: (code, pressed) => pressed && keys.push([clock.now, code]) },
    'D:\\FALLOUT.EXE',
    3,
    () => false,
    () => (launchedAt = clock.now),
    (step) => milestones.push([clock.now, step]),
  )
  await clock.runUntil(2_999)
  ok(keys.length === 0, 'DOS 7.1 还在开机时不会提前把命令敲进 BIOS')
  await clock.runUntil(6_000)
  cancel()
  ok(keys[0]?.[0] === 3_000 && keys[0]?.[1] === 68, '等待到点后先输入 D: 切到游戏盘')
  ok(keys.filter(([, code]) => code === 257).length === 2, '根目录游戏会先切盘，再输入可执行文件')
  ok(milestones.some(([, step]) => step === 'launched'), '输入完成后推进 launched 里程碑')
  ok(launchedAt !== null && launchedAt > 4_000, '回车交给客体后留出一帧加载时间再撤遮罩')
  ok(
    JSON.stringify(dosGuestCommandSequence('D:\\FALLOUT\\FALLOUT.EXE')) ===
      JSON.stringify(['D:', 'cd \\FALLOUT', 'FALLOUT.EXE']),
    '子目录游戏先进入 EXE 目录，保证 DOS/4GW 与相对资源能从正确目录读取',
  )
}

console.log('\n── 桌面到底画完了没有（desktopSettled）──')
{
  ok(desktopSettled(null, DESKTOP) === false, '没有上一帧时不算稳 —— 证据不足不能敲键')
  ok(desktopSettled(TEXT, TEXT) === false, '⭐ 文本模式下画面再静止也不算稳（那是 `C:\\>` 提示符，不是桌面）')
  ok(desktopSettled(DESKTOP, DESKTOP) === true, '图形模式 + 两帧一样 = Program Manager 画完了')
  ok(desktopSettled(DESKTOP_PAINTING, DESKTOP) === false, '还在画（整屏都在变）就不算稳')
  ok(frameDiffRatio(TEXT, DESKTOP) === 1, '⭐ 尺寸变了直接算「全变了」—— 开机途中模式来回切时凑不满连续次数')
  ok(frameIsBlank(BLACK) === true, '纯黑帧判为黑屏')
  ok(frameIsBlank(DESKTOP) === false, '⭐ 真桌面**不能**判成黑屏 —— 误杀会把整条链打回「等满 24 秒硬敲」')
  ok(
    desktopSettled(BLACK, BLACK) === false,
    '⭐ 静止的全黑帧不算桌面（Win95 进桌面前的那段黑屏，见下面那一节）',
  )
  ok(
    desktopSettled(WALLPAPER, WALLPAPER) === false,
    '⭐ 静止的纯壁纸也不算桌面 —— 壳（Explorer）还没起来，敲键一个都进不去',
  )
  ok(frameHasDesktopContent(DESKTOP) === true, '真桌面（图标 + 任务栏）判为「画了东西」')
  ok(frameHasDesktopContent(WALLPAPER) === false, '纯壁纸判为「没画东西」')
  const desktopRatio = desktopContentRatio(DESKTOP)
  ok(
    desktopRatio > 0.03 && desktopRatio < 0.15,
    `真桌面的非主色像素占 ${(desktopRatio * 100).toFixed(1)}%（实测 system-win95-v1 是 7.1%，壁纸 0.1%）`,
  )
}

/**
 * 跑一遍完整的 3.x 启动链。
 *
 * @param frameAt  (虚拟时刻) => 这一刻的画面
 * @param waitSeconds 后台配的 dosLaunchDelay
 */
async function runLaunch({ frameAt, waitSeconds = 24, until = 120_000 }) {
  const clock = fakeClock()
  globalThis.window = clock.win
  const keys = []
  const milestones = []
  let launchedAt = null
  let failedAt = null
  let sizeConsumer = null
  // 命令敲完的时刻（launched 里程碑）。场景里「游戏窗口什么时候出现」要挂在它后面，
  // 写成绝对时刻的话，启动时机一改测试就跟着坏
  let typedAt = null
  const ci = {
    screenshot: async () => frameAt(clock.now, typedAt),
    sendKeyEvent: (code, pressed) => {
      if (pressed) keys.push([clock.now, code])
    },
    events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
  }
  const cancel = scheduleWindowsLaunch(
    ci,
    'D:\\ZEEK1.EXE',
    waitSeconds,
    () => false,
    () => (launchedAt = clock.now),
    '3x',
    () => (failedAt = clock.now),
    (step) => {
      if (step === 'launched') typedAt = clock.now
      milestones.push([clock.now, step])
    },
  )
  // 实测到的尺寸序列：640×400 文本 → 640×480（DOSBox-X 自己的启动画面，**假信号**）
  // → 720×400 客体 DOS → 640×480 真桌面
  await clock.runUntil(800)
  sizeConsumer?.(640, 400)
  await clock.runUntil(1000)
  sizeConsumer?.(640, 480)
  await clock.runUntil(until)
  cancel()
  return { keys, milestones, launchedAt, failedAt, firstKey: keys.length ? keys[0][0] : null }
}

console.log('\n── 敲键的时机：盯画面，不再干等 24 秒 ──')
{
  // 2.4 秒之后桌面稳下来（实测值）
  const r = await runLaunch({ frameAt: (t) => (t < 1800 ? TEXT : t < 2400 ? DESKTOP_PAINTING : DESKTOP) })
  ok(r.firstKey !== null, '键敲出去了')
  ok(
    r.firstKey < 6_000,
    `⭐ 桌面一稳下来就敲（第 ${(r.firstKey / 1000).toFixed(1)} 秒），不再等满 24 秒 —— 省下约 ${((24_000 - r.firstKey) / 1000).toFixed(0)} 秒`,
  )
  ok(r.firstKey >= 1000 + DESKTOP_SETTLE_FLOOR_MS, `但也不会早于进图形模式后的 ${DESKTOP_SETTLE_FLOOR_MS / 1000} 秒下限`)
  ok(
    r.milestones.some(([, step]) => step === 'desktop'),
    '报了 desktop 里程碑（进度条据此走到 91%）',
  )
  ok(
    r.milestones.some(([, step]) => step === 'launched'),
    '也报了 launched 里程碑（→ 97%）',
  )
}

console.log('\n── 画面永远不静止时：退回老行为，绝不比以前慢 ──')
{
  /*
    动画壁纸、闪烁光标、开机自检还在滚 —— 这类画面永远凑不满「连续两次没变」。
    必须还有一条出路，而那条出路就是原来那个固定等待。
  */
  let flip = 0
  const r = await runLaunch({ frameAt: () => (flip++ % 2 ? DESKTOP : DESKTOP_PAINTING) })
  const cap = 1000 + windowsLaunchDelayMs(24)
  ok(r.firstKey !== null && Math.abs(r.firstKey - cap) < 600, `⭐ 等满上限就照敲（第 ${(r.firstKey / 1000).toFixed(1)} 秒 ≈ 图形信号 + 24 秒）`)
  ok(
    !r.milestones.some(([, step]) => step === 'desktop'),
    '⭐ 但**不报** desktop 里程碑 —— 里程碑只报确证发生过的事，硬敲那条路不算',
  )
}

console.log('\n── Windows 95 的开机黑屏：不能把黑屏当成桌面 ──')
{
  /*
    ⭐ 这一节守的是 2026-09-21 修掉的那个真 bug（windepth）。

    Win95 的启动序列是：DOS 文本 → **静态黑屏**（640×480，本站这份镜像连 LOGO.SYS
    都没有、开机画面也没有，所以那段就是纯黑，而且能持续好几秒）→ 桌面。
    而 desktopSettled 原来的判据只有「图形模式 + 画面静止」—— 静止的黑屏**两条都满足**，
    于是进图形模式刚满 2 秒就把 Ctrl+Esc / R 敲了出去，键全打在黑屏上。

    更糟的是敲完那道确认抓不住它：黑屏 → 桌面本身就是一次远超 CHANGE_RATIO 的变化，
    于是判「有反应」→ markReady → 既不自动重试也不报错。玩家看到「打开之后是回收站」，
    而手动双击 D:\WINDEPTH.EXE 明明能跑 —— 这类反馈只会以「这游戏打不开」的形式回来。
  */
  // 敲完命令之后切到 GAME：真机上「运行」框弹出、关掉、游戏窗口出现本来就是一次大变化。
  // 不给这个变化的话 finishLaunch 会正确地判失败（画面纹丝不动），那不是这一节要测的事。
  const r = await runLaunch({
    frameAt: (t, typedAt) =>
      typedAt !== null && t > typedAt
        ? GAME
        : t < 1800
          ? TEXT
          : t < 8000
            ? BLACK
            : t < 8400
              ? DESKTOP_PAINTING
              : DESKTOP,
  })
  ok(r.firstKey !== null, '键敲出去了')
  ok(
    r.firstKey >= 8000,
    `⭐ 等到真桌面出现（第 8 秒）之后才敲（实际第 ${(r.firstKey / 1000).toFixed(1)} 秒），没有敲在开机黑屏上`,
  )
  ok(r.failedAt === null, '真桌面之后再敲，按正常流程判成功（没有误报失败）')
}

console.log('\n── Win95 慢开机：图形信号的等待上限不能把按键敲进黑屏 ──')
{
  const r = await runLaunch({
    frameAt: (t, typedAt) => typedAt !== null && t > typedAt ? GAME : t < 1_800 ? TEXT : t < 50_000 ? BLACK : DESKTOP,
    until: 80_000,
  })
  ok(r.firstKey !== null && r.firstKey >= 50_000, '即使黑屏超过配置的 24 秒，仍等真正桌面再敲键')
  ok(r.failedAt === null && r.launchedAt !== null, '慢开机最终进桌面后仍能正常启动游戏')
}

console.log('\n── 截图卡死：不等整局超时，也不向未经确认的桌面输入命令 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const keys = []
  let sizeConsumer = null
  let screenshotStalled = false
  let failedAt = null
  let launched = false
  const cancel = scheduleWindowsLaunch(
    {
      screenshot: () => screenshotStalled ? new Promise(() => {}) : Promise.resolve(DESKTOP),
      sendKeyEvent: (code, pressed) => {
        if (pressed) keys.push(code)
        if (code === 341 && pressed) screenshotStalled = true
      },
      events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
    },
    'D:\\CAESAR3.EXE',
    24,
    () => false,
    () => { launched = true },
    '9x',
    () => { failedAt = clock.now },
  )
  sizeConsumer?.(720, 400)
  sizeConsumer?.(640, 480)
  await clock.runUntil(30_000)
  cancel()
  ok(failedAt !== null && failedAt < 30_000, `截图不响应时 ${WINDOWS_SCREENSHOT_TIMEOUT_MS / 1000} 秒内给出明确失败，而非等总超时`)
  ok(!keys.includes(82) && !launched, '截图未确认开始菜单时，不把 R/游戏启动命令送给桌面')
}

console.log('\n── 后端重连/退出：旧截图迟到也不能重新激活启动链 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const keys = []
  let sizeConsumer = null
  let resolveLate = null
  let screenshotStalled = false
  let failed = false
  const cancel = scheduleWindowsLaunch(
    {
      screenshot: () => screenshotStalled
        ? new Promise((resolve) => { resolveLate = resolve })
        : Promise.resolve(DESKTOP),
      sendKeyEvent: (code, pressed) => {
        if (pressed) keys.push(code)
        if (code === 341 && pressed) screenshotStalled = true
      },
      events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
    },
    'D:\\CAESAR3.EXE',
    24,
    () => false,
    () => {},
    '9x',
    () => { failed = true },
  )
  sizeConsumer?.(720, 400)
  sizeConsumer?.(640, 480)
  await clock.runUntil(6_000)
  ok(Boolean(resolveLate), '重连前确实有一张开始菜单截图还在等待')
  cancel()
  resolveLate?.(DESKTOP)
  await clock.runUntil(30_000)
  ok(!keys.includes(82) && !failed, '取消旧启动链后，迟到截图不会继续敲键或报错')
  const adapterSource = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
  ok(/previousCi !== ci[\s\S]*?cancelWindowsLaunch\(\)/.test(adapterSource), 'ci-ready 换了命令接口时先取消旧启动链')
}

console.log('\n── Run 框基准截图不响应：不能猜测输入已成功 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const keys = []
  let sizeConsumer = null
  let ctrlDown = false
  let startMenu = false
  let runOpened = false
  let failed = false
  const cancel = scheduleWindowsLaunch(
    {
      screenshot: () => runOpened ? new Promise(() => {}) : Promise.resolve(startMenu ? DESKTOP_PAINTING : DESKTOP),
      sendKeyEvent: (code, pressed) => {
        if (pressed) keys.push(code)
        if (code === 341) ctrlDown = pressed
        if (code === 256 && pressed && ctrlDown) startMenu = true
        if (code === 82 && pressed) runOpened = true
      },
      events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
    },
    'D:\\CAESAR3.EXE',
    24,
    () => false,
    () => {},
    '9x',
    () => { failed = true },
  )
  sizeConsumer?.(720, 400)
  sizeConsumer?.(640, 480)
  await clock.runUntil(30_000)
  cancel()
  ok(runOpened && failed, 'Run 已打开但基准截图卡住时，明确停止启动链')
  ok(!keys.includes(68) && !keys.includes(257), '没有可靠基准帧时不盲打 D: 路径或回车')
}

console.log('\n── 后台标签页：截图与图形兜底不按墙上时间误报 ──')
{
  const previousDocument = globalThis.document
  const visibility = { visibilityState: 'visible' }
  globalThis.document = visibility
  try {
    const clock = fakeClock()
    globalThis.window = clock.win
    let sizeConsumer = null
    let screenshotStalled = false
    let failedAt = null
    const keys = []
    const cancel = scheduleWindowsLaunch(
      {
        screenshot: () => screenshotStalled ? new Promise(() => {}) : Promise.resolve(DESKTOP),
        sendKeyEvent: (code, pressed) => {
          if (pressed) keys.push(code)
          if (code === 341 && pressed) {
            screenshotStalled = true
            visibility.visibilityState = 'hidden'
          }
        },
        events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
      },
      'D:\\CAESAR3.EXE',
      24,
      () => false,
      () => {},
      '9x',
      () => { failedAt = clock.now },
    )
    sizeConsumer?.(720, 400)
    sizeConsumer?.(640, 480)
    await clock.runUntil(90_000)
    ok(failedAt === null, '标签页隐藏超过原有启动上限，也不会误报截图或图形超时')
    ok(!keys.includes(256) && !keys.includes(82), '页面在后台时不继续输入 Ctrl+Esc / R，避免客体丢键')
    visibility.visibilityState = 'visible'
    await clock.runUntil(101_000)
    ok(failedAt !== null, '恢复前台后才累计真正的截图等待预算')
    cancel()
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
}

console.log('\n── Windows 95 的组合键：必须跨过客体键盘轮询 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const events = []
  const pressedKeys = new Set()
  let sizeConsumer = null
  let startMenuVisible = false
  const startMenu = mkDesktop(640, 480, 40, 230)
  const ci = {
    screenshot: async () => (startMenuVisible ? startMenu : DESKTOP),
    sendKeyEvent: (code, pressed) => {
      events.push([clock.now, code, pressed])
      if (pressed) pressedKeys.add(code)
      else pressedKeys.delete(code)
      // 只有 Esc 按下时 Ctrl 仍处于按下状态，客体才真的打开开始菜单。
      if (code === 256 && pressed && pressedKeys.has(341)) startMenuVisible = true
    },
    events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
  }
  const cancel = scheduleWindowsLaunch(
    ci,
    'D:\\WINDEPTH.EXE',
    24,
    () => false,
    () => {},
    '9x',
    () => {},
  )
  sizeConsumer?.(720, 400)
  sizeConsumer?.(640, 480)
  await clock.runUntil(8_000)
  cancel()

  const ctrlDown = events.find(([, code, pressed]) => code === 341 && pressed)
  const escDown = events.find(([, code, pressed]) => code === 256 && pressed)
  const escUp = events.find(([, code, pressed]) => code === 256 && !pressed)
  const ctrlUp = events.find(([, code, pressed]) => code === 341 && !pressed)
  const runKey = events.find(([, code, pressed]) => code === 82 && pressed)
  ok(Boolean(ctrlDown && escDown && escUp && ctrlUp && runKey), 'Ctrl+Esc 与 Run 的 R 都送进客体')
  ok(
    escDown[0] - ctrlDown[0] === WINDOWS_CHORD_STEP_MS &&
      escUp[0] - escDown[0] === WINDOWS_CHORD_STEP_MS &&
      ctrlUp[0] - escUp[0] === WINDOWS_CHORD_STEP_MS,
    `⭐ 组合键按下/抬起各隔 ${WINDOWS_CHORD_STEP_MS}ms，不再塞进同一个输入扫描`,
  )
  ok(
    runKey[0] - ctrlUp[0] >= WINDOWS_START_MENU_READY_MS,
    '⭐ Ctrl 已经抬起且开始菜单画出来之后才按 R，不会再选中 Recycle Bin',
  )
}

console.log('\n── Windows 95 开始菜单没开：重试后必须停手 ──')
{
  const clock = fakeClock()
  globalThis.window = clock.win
  const events = []
  let sizeConsumer = null
  let failedAt = null
  const ci = {
    // 始终返回同一张桌面图，模拟 Ctrl+Esc 被客体漏掉；这正是 windepth 曾打开回收站的前提。
    screenshot: async () => DESKTOP,
    sendKeyEvent: (code, pressed) => events.push([clock.now, code, pressed]),
    events: () => ({ onFrameSize: (fn) => (sizeConsumer = fn) }),
  }
  const cancel = scheduleWindowsLaunch(
    ci,
    'D:\\WINDEPTH.EXE',
    24,
    () => false,
    () => {},
    '9x',
    () => (failedAt = clock.now),
  )
  sizeConsumer?.(720, 400)
  sizeConsumer?.(640, 480)
  await clock.runUntil(8_000)
  cancel()

  const ctrlAttempts = events.filter(([, code, pressed]) => code === 341 && pressed).length
  const runKeys = events.filter(([, code, pressed]) => code === 82 && pressed).length
  const enterKeys = events.filter(([, code, pressed]) => code === 257 && pressed).length
  ok(ctrlAttempts === 2, '开始菜单没有视觉响应时只重试一次 Ctrl+Esc')
  ok(runKeys === 0, '⭐ 两次都失败时不把 R 送给桌面，不会再选中 Recycle Bin')
  ok(enterKeys === 0, '⭐ 失败后也不发 Enter，不会误打开任何桌面图标')
  ok(failedAt !== null, '⭐ 明确上报启动失败，让播放器重试或提示，而不是假装已经运行')
}

console.log('\n── Windows 95 的壁纸静止：壳还没起来，不能当成桌面 ──')
{
  /*
    ⭐ 这一节守的是 2026-09-21 **本地复现**（真实模块 + 真实 system-win95-v1 镜像）
    抓出来的第二个真 bug，接在上面「开机黑屏」那节后面：

    Win95 的启动序列其实是四段 —— DOS 文本 → 静态黑屏 → **纯青绿壁纸**
    （屏幕上有小箭头光标，但图标和任务栏一个都没有，因为 Explorer 还没起来）→ 真桌面。

    第三段又亮又静止，`desktopSettled` 原来的两条判据（图形模式 + 画面静止）**全部满足**，
    于是 Ctrl+Esc / R 敲在一个还没有壳的系统上，一个键都进不去。更糟的是等图标和任务栏
    画出来（远超 CHANGE_RATIO）又判「有反应」→ markReady：**既不重试也不报错**，
    玩家看到的就是「打开之后停在桌面」。

    实测时间线（本地复现，640×480，非主色像素占比）：
      4.2s 壁纸（0.04%，静止）→ 5.2s 真桌面（7.1%，静止）
    这里就按这条时间线摆帧。
  */
  const r = await runLaunch({
    frameAt: (t, typedAt) =>
      typedAt !== null && t > typedAt
        ? GAME
        : t < 1800
          ? TEXT
          : t < 3600
            ? BLACK
            : t < 5200
              ? WALLPAPER
              : DESKTOP,
  })
  ok(r.firstKey !== null, '键敲出去了')
  ok(
    r.firstKey >= 5200,
    `⭐ 等真桌面（第 5.2 秒）出现之后才敲（实际第 ${(r.firstKey / 1000).toFixed(1)} 秒），没有敲在纯壁纸上`,
  )
  ok(r.failedAt === null, '真桌面之后再敲，按正常流程判成功（没有误报失败）')
}

console.log('\n── 敲完之后的确认：第一眼提前到 0.8 秒 ──')
{
  // 桌面 2.4 秒稳定；游戏窗口在敲完命令之后很快出现（Run 框一关画面就变了）
  const r = await runLaunch({
    frameAt: (t, typedAt) => (typedAt !== null && t > typedAt ? GAME : t < 2400 ? TEXT : DESKTOP),
  })
  const typedAt = r.keys[r.keys.length - 1][0]
  ok(r.launchedAt !== null && r.failedAt === null, '判成功，没有误报失败')
  const wait = r.launchedAt - typedAt
  ok(wait < 2_000, `⭐ 敲完 ${wait} 毫秒就确认完了（原来固定 5000 毫秒）`)
}

console.log('\n── 提前看不等于判得松：画面纹丝不动仍要等满 20 秒才判失败 ──')
{
  /*
    这是上一条的守卫。elapsed 以前是每轮硬加一个轮询间隔，间隔一改那个计数就不再
    等于真实时间；现在按 Date.now() 差值算，所以间隔怎么调都不影响失败门槛。
  */
  const r = await runLaunch({ frameAt: (t) => (t < 2400 ? TEXT : DESKTOP) })
  const typedAt = r.keys[r.keys.length - 1][0]
  ok(r.failedAt !== null && r.launchedAt === null, '画面一直没变 → 判失败（而不是静默算成功）')
  const waited = r.failedAt - typedAt
  ok(
    waited >= WINDOWS_LAUNCH_VERIFY_MS && waited < WINDOWS_LAUNCH_VERIFY_MS + 4_000,
    `⭐ 等满 ${(waited / 1000).toFixed(1)} 秒才判死（门槛 ${WINDOWS_LAUNCH_VERIFY_MS / 1000} 秒），没有因为看得早就判得早`,
  )
}

console.log(`\n✅ DOS 打包测试通过（${n} 项）`)
