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
import { fileURLToPath } from 'node:url'

const { makeJsdosBundle, makeWindowsGameLayer, buildDosboxConf } = await import(
  fileURLToPath(new URL('../src/lib/jsdosBundle.ts', import.meta.url))
)
const { windowsGuestLaunchCommand } = await import(fileURLToPath(new URL('../src/lib/windowsGuest.ts', import.meta.url)))

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

  const conf2 = buildDosboxConf('My Game.exe')
  ok(conf2.includes('"My Game.exe"'), '文件名带空格仍然加引号（DOSBox 那边同样不剥，是另一个坑，待单独处理）')
  ok(/@echo .*已退出/.test(conf2), '末尾留一句人话，真没跑起来时黑屏至少变成一行提示')
  const none = buildDosboxConf(null)
  ok(none.includes('没有找到可执行文件'), '猜不出启动程序时的提示保持不变')
}

console.log(`\n✅ DOS 打包测试通过（${n} 项）`)
