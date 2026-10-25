/**
 * 光盘平台（PS1 / PS2 / GameCube / Wii）上传守卫的回归测试。
 *
 * ── 为什么有这一套 ──────────────────────────────────────────
 * 2026-09-11 站长传《Gran Turismo》：手里是一个 zip，里面 `xxx.bin` + `xxx.cue`。
 * 整个 zip 传上去，玩家那边报 `Size is zero` —— 而进度条一路正常走到底。
 *
 * 这条链有三层，而错误信息只暴露了最后一层：
 *   1. 我们把整个 zip 当一份光盘镜像下下来，交给 EmulatorJS；
 *   2. 引擎按魔数认出 zip，交给 compression/extractzip.js —— 那是个很老的
 *      emscripten 构建，**压缩包和解出来的内容共用一块 2GB 上限的线性内存**；
 *   3. PS1 一张盘解出来几百 MB，分配失败之后它不报错，写出一个 **0 字节**的文件。
 *      核心顺着 .cue 找到 .bin，打开是 0 字节 → mednafen 报「Size is zero」。
 *
 * 错误指向「文件」，原因在「解压那一步的内存」，中间隔着三层 —— 谁也不会往那儿想。
 * 所以唯一有用的地方是**上传之前**。这套测试钉的就是那道门。
 *
 * 跑：npm run test:disc-upload
 */
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

/* window 桩：把弹窗记下来，顺便让脚本能决定用户点了什么 */
const asked = { alert: [], confirm: [] }
let confirmAnswer = true
globalThis.window = {
  alert: (text) => {
    asked.alert.push(String(text))
  },
  confirm: (text) => {
    asked.confirm.push(String(text))
    return confirmAnswer
  },
}
const reset = () => {
  asked.alert.length = 0
  asked.confirm.length = 0
  confirmAnswer = true
}

const { canReuseRomObjectKey, confirmDiscImage } = await import(fileURLToPath(new URL('../src/admin/uploadGuards.ts', import.meta.url)))
const { chdCompressors, isPsxChdTransfer, psxChdCoreForCodecs, psxChdSaveSlug, parsePsxChdSaveSlug, psxCoreForPreparedName, psxCoreForTransfer, PSX_CHD_AUDIO_LATENCY_MS, PSX_CHD_COMPAT_CORE, PSX_CHD_CORE } = await import(fileURLToPath(new URL('../src/emulator/psxChd.ts', import.meta.url)))
const { raiseAudioLatency } = await import(fileURLToPath(new URL('../src/emulator/mameAudio.ts', import.meta.url)))

let n = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failed++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failed) {
    console.log(`\n❌ ${failed} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

ok(canReuseRomObjectKey('roms/psp/game.iso', 'replacement.ISO', false), '同格式 ISO 可以安全原地覆盖')
ok(!canReuseRomObjectKey('roms/psp/game.chd', 'replacement.iso', false), 'ISO 不能写进旧 CHD key')
ok(!canReuseRomObjectKey('roms/psp/game.cso', 'replacement.iso', false), 'ISO 不能写进旧 CSO key')
ok(canReuseRomObjectKey('roms/nds/game.8bg', 'replacement.nds', true), '8BG 外层统一，内部格式变化不影响对象扩展名')

/* ---------------- PS1 CHD：下载外层与实际内层不能混淆 ---------------- */
ok(isPsxChdTransfer('https://assets.example/roms/psx/theme.chd.8bg?romv=abc'), 'CHD 的 8BG 外层可启用带版本的断点续传')
ok(isPsxChdTransfer('roms/psx/theme.CHD?romv=abc'), '原始 CHD 也可启用断点续传')
ok(!isPsxChdTransfer('roms/psx/theme.iso.8bg'), 'ISO 不误判为 CHD')
/** 只造一个 CHD v5 头的前 32 字节：魔数、版本、四个压缩器槽 */
const chdHead = (...codecs) => {
  const head = new Uint8Array(32)
  head.set([...'MComprHD'].map((c) => c.charCodeAt(0)), 0)
  head.set([0, 0, 0, 124, 0, 0, 0, 5], 8)
  codecs.forEach((codec, i) => head.set([...codec].map((c) => c.charCodeAt(0)), 16 + i * 4))
  return head
}
ok(JSON.stringify(chdCompressors(chdHead('cdlz', 'cdzl', 'cdfl'))) === '["cdlz","cdzl","cdfl"]', '读出 chdman 默认的三个 CD 压缩器')
ok(chdCompressors(new Uint8Array(32)) === null && chdCompressors(chdHead('cdzl').subarray(0, 20)) === null, '不是 CHD v5 或字节不够时返回未知')
ok(psxChdCoreForCodecs(['cdzl']) === PSX_CHD_CORE && psxChdCoreForCodecs(['cdlz', 'cdzl']) === PSX_CHD_CORE, '纯 zlib/LZMA 的 CHD 仍走实机验证过的 Beetle')
ok(psxChdCoreForCodecs(['cdlz', 'cdzl', 'cdfl']) === PSX_CHD_COMPAT_CORE, '带 cdfl（Beetle 没编进 FLAC）的 CHD 改走 PCSX，否则只剩 RetroArch 空菜单')
ok(psxChdCoreForCodecs(['cdzs']) === PSX_CHD_COMPAT_CORE && psxChdCoreForCodecs(null) === PSX_CHD_COMPAT_CORE, 'Zstandard 或读不出头时走编解码器齐全的 PCSX')
ok(psxCoreForTransfer('psx', 'pcsx_rearmed', 'theme.chd.8bg?romv=abc') === PSX_CHD_COMPAT_CORE, 'CHD 悬停预热按站内实际落点预拉 PCSX')
ok(psxCoreForTransfer('psx', 'pcsx_rearmed', 'theme.iso.8bg') === 'pcsx_rearmed', 'ISO 悬停预热仍走默认核心')
ok(psxCoreForPreparedName('psx', 'pcsx_rearmed', 'Theme Hospital.chd', chdHead('cdzl')) === PSX_CHD_CORE, '解包后纯 cdzl CHD 改用 Beetle')
ok(psxCoreForPreparedName('psx', 'mednafen_psx', 'Theme Hospital.chd', chdHead('cdlz', 'cdzl', 'cdfl')) === PSX_CHD_COMPAT_CORE, '解包后带 cdfl 的 CHD 改用 PCSX')
ok(psxCoreForPreparedName('psx', 'pcsx_rearmed', 'game.iso') === 'pcsx_rearmed', '普通 PS1 ISO 仍保留原核心')
ok(psxCoreForPreparedName('psx', 'pcsx_rearmed', 'game.chd.8bg') === 'pcsx_rearmed', '外层 8BG 不能冒充已解包的 CHD')
ok(psxCoreForPreparedName('pcEngine', 'mednafen_pce', 'game.chd') === 'mednafen_pce', '其它平台不受 PS1 核心切换影响')
ok(psxChdSaveSlug('theme-hospital', 'theme.chd.8bg?romv=abc') === 'theme-hospital:beetle-soft-chd', 'CHD 软件版快照与旧 PCSX/HW 档位隔离')
ok(psxChdSaveSlug('theme-hospital', 'theme.iso') === 'theme-hospital', 'ISO 保留原存档档位')
ok(psxChdSaveSlug('local:theme.chd', 'theme.chd') === 'local:theme.chd', '本地 CHD 已按文件名隔离，不额外加后缀')
ok(parsePsxChdSaveSlug('theme-hospital:beetle-chd') === 'theme-hospital', '云存档列表能链接回原游戏')
ok(parsePsxChdSaveSlug('theme-hospital:beetle-soft-chd') === 'theme-hospital', '软件版云存档列表能链接回原游戏')
ok(PSX_CHD_AUDIO_LATENCY_MS === 128 && raiseAudioLatency('audio_latency = 64\n', PSX_CHD_AUDIO_LATENCY_MS) === 'audio_latency = 128\n', 'Beetle 用 128ms 队列缓冲短时主线程抖动')
ok(existsSync(fileURLToPath(new URL(`../public/emulatorjs/cores/${PSX_CHD_CORE}-wasm.data`, import.meta.url))), 'CHD 核心已随站点发布')
const ejsSource = readFileSync(fileURLToPath(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url)), 'utf8')
const adminSource = readFileSync(fileURLToPath(new URL('../src/admin/GameForm.tsx', import.meta.url)), 'utf8')
const biosPanelSource = readFileSync(fileURLToPath(new URL('../src/admin/PlatformBiosPanel.tsx', import.meta.url)), 'utf8')
const ejsRuntimeSource = readFileSync(fileURLToPath(new URL('../public/emulatorjs/emulator.min.js', import.meta.url)), 'utf8')
ok(/const shouldPack = !isStreamingDisc && !isHtml5 && platform !== 'psx'/.test(adminSource), 'PS1 新上传裸 CHD 不再包装成阻断 Range 的 8BG')
ok(/const key = shouldPack \|\| alreadyPacked \? romPackKey\(plainKey\) : plainKey/.test(adminSource), '旧 PS1 8BG 容器仍保留正确外层扩展名')
ok(/if \(!psxIsoToChd && !window\.confirm\(/.test(adminSource), 'PS1 自动转换不可用时可确认上传可玩的原始 ISO')
ok(/psxCoreForPreparedName\(options\.platform, core, engineGameName, chdHead\)/.test(ejsSource), '播放器在实际内层文件名与 CHD 头都确定后才切核心')
ok(/preparedPsxRange\?\.head \?\? await readDiscHead\(/.test(ejsSource), 'Range 与完整下载两条路都读得到 CHD 头')
ok(/'track numbers bad'/.test(ejsSource), 'Beetle 打不开光盘时直接报错，不停在 RetroArch 空菜单')
ok(existsSync(fileURLToPath(new URL(`../public/emulatorjs/cores/${PSX_CHD_COMPAT_CORE}-wasm.data`, import.meta.url))), '兼容 CHD 的 PCSX 核心已随站点发布')
{
  // 取证：核心选择表依赖「Beetle 没有 cdfl、PCSX 有」这个事实；换核心包后要重新核对。
  const { execFileSync } = await import('node:child_process')
  const wasmOf = (archive, member) => execFileSync('7z', ['x', '-so', fileURLToPath(new URL(`../public/emulatorjs/cores/${archive}`, import.meta.url)), member], { maxBuffer: 64 * 1024 * 1024 })
  const beetle = wasmOf('mednafen_psx-legacy-wasm.data', 'mednafen_psx_libretro.wasm')
  const pcsx = wasmOf('pcsx_rearmed-wasm.data', 'pcsx_rearmed_libretro.wasm')
  ok(beetle.includes(Buffer.from('cdzl (CD Deflate)')) && !beetle.includes(Buffer.from('cdfl (CD FLAC)')), 'Beetle 核心只有 zlib/LZMA 的 CD 解码器（重编进 FLAC 后要放宽 BEETLE_CHD_CODECS）')
  ok(['cdzl (CD Deflate)', 'cdlz (CD LZMA)', 'cdfl (CD FLAC)', 'cdzs (CD ZStandard)'].every((name) => pcsx.includes(Buffer.from(name))), 'PCSX 核心带全部四种 CD 解码器')
}
ok(/psxRange\.install\(fs, window\.XMLHttpRequest\)/.test(ejsSource), 'sandbox iframe 的同步读盘沿用主页面 XHR 源，避免 R2 拒绝 Origin: null')
ok(/scph5500\.bin[\s\S]{0,320}多区域 ZIP/.test(biosPanelSource), 'PS1 BIOS 设置指导管理员配置多区域 BIOS，兼容日版 CHD 与 PCSX')
const biosExtract = /bios:\{name:"BIOS",dontCache:!1,dontExtractIfCore:\[([^\]]+)\]\}/.exec(ejsRuntimeSource)
ok(Boolean(biosExtract && !biosExtract[1].includes('mednafen_psx')), 'Beetle PS1 会解开多区域 BIOS ZIP，核心能按原文件名查找')
ok(/options\.platform === 'psx' && core === PSX_CHD_CORE[\s\S]{0,140}PSX_CHD_AUDIO_LATENCY_MS/.test(ejsSource), 'Beetle 音频缓冲计划确实接入开局钩子')
ok(/get saveMetadata\(\)\s*\{\s*return \{ core, build: EJS_RUNTIME_GENERATION/.test(ejsSource), '异步切换后存档元数据读取最终核心，不能固化旧 PCSX')
ok(/resumeAcrossRefresh: Boolean\(romCacheKey\(remoteGameUrl\)\)/.test(ejsSource), '打包 CHD 走已有的版本化 Range 续传')

/* ---------------- 造 zip ---------------- */

const te = new TextEncoder()

/**
 * 造一个「虚拟的大 zip」：只真的生成中央目录和 EOCD，前面那几百 MB 数据区不分配。
 *
 * 守卫（zipDirectorySummary）只读文件**末尾**的目录，所以这么造出来的东西
 * 在它眼里和一份真的 600MB 压缩包完全一样 —— 而测试进程不用真的吃掉 600MB。
 * 用的接口就三个：name / size / slice().arrayBuffer()。
 */
function hugeZipFile(name, virtualSize, entries) {
  const central = []
  for (const e of entries) {
    const nameBytes = te.encode(e.name)
    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint32(20, e.compressed ?? 0, true)
    cv.setUint32(24, e.uncompressed ?? 0, true)
    cv.setUint16(28, nameBytes.length, true)
    cen.set(nameBytes, 46)
    central.push(cen)
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const tailLen = centralSize + 22
  // 中央目录就从「文件末尾往前 tailLen」这个位置开始
  const centralOffset = virtualSize - tailLen
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)

  const tail = new Uint8Array(tailLen)
  let at = 0
  for (const c of central) {
    tail.set(c, at)
    at += c.length
  }
  tail.set(eocd, at)

  return {
    name,
    size: virtualSize,
    /** 虚拟坐标 → 真实字节。落在 tail 之前的一律当全 0（数据区，守卫不看） */
    slice(a, b = virtualSize) {
      const from = a < 0 ? Math.max(0, virtualSize + a) : a
      const to = Math.min(b, virtualSize)
      const out = new Uint8Array(Math.max(0, to - from))
      for (let i = 0; i < out.length; i++) {
        const v = from + i
        if (v >= centralOffset) out[i] = tail[v - centralOffset]
      }
      return { arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
    },
  }
}

/** 一份只有 name / size 的文件：裸镜像那几条守卫压根不读内容 */
function fakeFile(name, size) {
  return { name, size, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }
}

/* ---------------- 一、不是光盘平台就别多嘴 ---------------- */

reset()
ok(
  (await confirmDiscImage('nes', fakeFile('mario.zip', 40 * 1024))) === true &&
    !asked.alert.length &&
    !asked.confirm.length,
  '卡带平台（NES）的 zip 一个字都不问 —— 那本来就是正确的上传方式',
)

/* ---------------- 二、.chd：唯一推荐的形态 ---------------- */

reset()
ok(
  (await confirmDiscImage('psx', fakeFile('gran-turismo.chd', 380 * 1024 * 1024))) === true &&
    !asked.alert.length &&
    !asked.confirm.length,
  '正常大小的 .chd 直接放行，不打扰管理员',
)

reset()
ok(await confirmDiscImage('psx', fakeFile('big.chd', 900 * 1024 * 1024)), '超大的 .chd 仍然放行（点了「仍要上传」）')
ok(asked.confirm.length === 1 && /玩家每次开局都要下/.test(asked.confirm[0]), '但会提醒体积 —— 这是玩家要等多久的问题，不是存储费')

/* ---------------- 三、压缩包：站长踩的那个坑 ---------------- */

{
  // 真实形状：Gran Turismo (USA) (Rev 1) —— zip 本体约 600MB，里面的 .bin 解出来约 700MB
  reset()
  const file = hugeZipFile('gran-turismo.zip', 600 * 1024 * 1024, [
    { name: 'Gran Turismo (USA) (Rev 1).cue', compressed: 120, uncompressed: 140 },
    { name: 'Gran Turismo (USA) (Rev 1).bin', compressed: 600 * 1024 * 1024, uncompressed: 700 * 1024 * 1024 },
  ])

  const allowed = await confirmDiscImage('psx', file)
  ok(allowed === false, 'PS1 的 bin+cue 压缩包被**硬拦**（600MB 包 + 700MB 解出来，超过 2GB 内存的安全线）')
  ok(asked.confirm.length === 0, '这一档不给「仍要上传」的选项 —— 它不是质量取舍，是一定跑不起来')
  ok(asked.alert.length === 1, '弹一次说明')
  const text = asked.alert[0]
  ok(/Size is zero/.test(text), '说明里点名了玩家会看到的那句报错，这样下次搜到这句话能对上')
  ok(/chdman createcd -i "Gran Turismo \(USA\) \(Rev 1\).cue" -o "gran-turismo.chd"/.test(text), '直接给出可以复制粘贴的 chdman 命令，cue 名字从包里读出来（带空格和括号也不怕）')
  ok(/Gran Turismo \(USA\) \(Rev 1\).bin/.test(text), '列出包里到底是什么，省掉管理员再解一遍确认')
  ok(/2GB/.test(text), '讲清楚是解压那一步的内存上限，不是「文件坏了」')
}

{
  // 小 homebrew 盘：确实能解开，所以只提醒、留一条路
  reset()
  const file = hugeZipFile('demo.zip', 12 * 1024 * 1024, [
    { name: 'demo.cue', compressed: 60, uncompressed: 70 },
    { name: 'demo.bin', compressed: 12 * 1024 * 1024, uncompressed: 20 * 1024 * 1024 },
  ])

  confirmAnswer = true
  ok((await confirmDiscImage('psx', file)) === true, '小体积的压缩包只提醒，管理员坚持就放行（它确实解得开）')
  ok(asked.alert.length === 0 && asked.confirm.length === 1, '走的是 confirm 不是 alert')
  ok(/chdman/.test(asked.confirm[0]), '照样把 .chd 的做法说一遍')

  reset()
  confirmAnswer = false
  ok((await confirmDiscImage('psx', file)) === false, '管理员点「取消」就不传')
}

{
  // .7z / .rar 读不出中央目录 —— 按「解出来大约是压缩包两倍」保守估
  reset()
  ok((await confirmDiscImage('psx', fakeFile('gt.7z', 600 * 1024 * 1024))) === false, '大的 .7z 同样硬拦（读不出目录时按两倍保守估）')
  reset()
  ok((await confirmDiscImage('psx', fakeFile('gt.rar', 600 * 1024 * 1024))) === false, '.rar 同理')
  reset()
  confirmAnswer = true
  ok((await confirmDiscImage('psx', fakeFile('tiny.7z', 10 * 1024 * 1024))) === true, '小的 .7z 只提醒')
}

/* ---------------- 四、裸镜像：原来就有的三条提醒不能丢 ---------------- */

reset()
confirmAnswer = true
await confirmDiscImage('psx', fakeFile('gt.cue', 200))
ok(/找不到轨道/.test(asked.confirm[0] ?? ''), '单传 .cue：说清楚数据在 .bin 里')

reset()
await confirmDiscImage('psx', fakeFile('gt.bin', 500 * 1024 * 1024))
ok(/分轨信息/.test(asked.confirm[0] ?? ''), '单传 .bin：说清楚丢了分轨信息')

reset()
await confirmDiscImage('psx', fakeFile('gt.iso', 400 * 1024 * 1024))
ok(/CDDA|BGM/.test(asked.confirm[0] ?? ''), 'PS1 的 .iso：说清楚会没有 BGM')

reset()
ok((await confirmDiscImage('ps2', fakeFile('game.iso', 400 * 1024 * 1024))) === true && !asked.confirm.length, 'PS2 的 .iso 是正常形态，不提醒')

reset()
ok((await confirmDiscImage('psp', fakeFile('monster-hunter.cso', 650 * 1024 * 1024))) === true && !asked.confirm.length, 'PSP 的正常大小 CSO 直接放行')

reset()
ok((await confirmDiscImage('psp', fakeFile('monster-hunter.zip', 650 * 1024 * 1024))) === false, 'PSP 光盘套 ZIP 会被硬拦')
ok(asked.alert.length === 1 && /PPSSPP/.test(asked.alert[0]) && /\.cso/.test(asked.alert[0]), '提示改传可随机读取的 ISO / CSO / CHD')

reset()
ok((await confirmDiscImage('gamecube', fakeFile('wind-waker.rvz', 400 * 1024 * 1024))) === true && !asked.confirm.length, 'GameCube 的正常大小 RVZ 直接放行')

reset()
ok((await confirmDiscImage('wii', fakeFile('wii-sports.zip', 200 * 1024 * 1024))) === false, 'Wii 光盘套 ZIP 会被硬拦')
ok(asked.alert.length === 1 && /Dolphin|dolphin/.test(asked.alert[0]) && /\.rvz/.test(asked.alert[0]), '提示改传可随机读取的 ISO / RVZ')

reset()
confirmAnswer = true
ok((await confirmDiscImage('gamecube', fakeFile('large.iso', 1400 * 1024 * 1024))) === true, 'GameCube 大 ISO 可以确认后继续上传')
ok(asked.confirm.length === 1 && /RVZ|\.rvz/.test(asked.confirm[0]), '大镜像建议转成 RVZ，而不是 PS1 的 CHD')

console.log(`\n✅ ${n} 项通过`)
