/**
 * 「附加文件」（资料片 / 补丁）整条链路的回归测试。
 *
 * 站长 2026-09-11 要给已经上线的《命令与征服》加隐秘行动资料片（SC-002.MIX），
 * 而且要求**在后台就能解决** —— 上传的常常是运维，不会 cd / curl / unzip。
 * 于是做法是：库里存一份清单，播放器加载时把这些文件**并进**游戏 ZIP，仓库里的 ROM 不动。
 *
 * 这条链路的危险在于它和 js-dos 那个老毛病挨着：**包解不开时 js-dos 不发任何 error 事件**。
 * 合并出来的 ZIP 要是有一丁点不对（父目录没补、同名条目留了两份、本体被改坏），
 * 表现都是同一个样子 —— DOSBox 起来了、遮罩撤了、玩家对着黑屏，日志里干干净净。
 * 所以这里逐条钉死：
 *   1. 本体条目一个不少、内容一个字节不差
 *   2. 同名 = 替换（打补丁靠这个），绝不留两条让顺序决定胜负
 *   3. 子目录里的附加文件，父目录条目必须被补出来
 *   4. 后台那份清单的解析 / 校验（前端 lib/dosExtras.ts 与服务端 mappers.js 两边）
 *   5. 播放器真的用的是**合并后**的 buffer，而不是原始 rom.buf
 *
 * 跑：npm run test:dos-extras
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { mergeExtraFiles } = await import(fileURLToPath(new URL('../src/lib/jsdosBundle.ts', import.meta.url)))
const { parseDosExtra, parseDosExtras, formatDosExtra, defaultExtraPath, normalizeExtraPath, extraObjectName, skipExtraEntry, extraPathProblem } =
  await import(fileURLToPath(new URL('../src/lib/dosExtras.ts', import.meta.url)))
const { extractZipEntry, listZipEntries } = await import(fileURLToPath(new URL('../src/lib/unzip.ts', import.meta.url)))
const { dosExtrasName } = await import(fileURLToPath(new URL('../src/services/i18nData.ts', import.meta.url)))
const { dosExtrasOf, dosExtrasLabelOf } = await import(fileURLToPath(new URL('../server/src/mappers.js', import.meta.url)))

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
const throwsWith = (fn, re, msg) => {
  let err = null
  try {
    fn()
  } catch (e) {
    err = e
  }
  ok(err && re.test(String(err.message)), msg + (err ? `（信息：${err.message}）` : '（应该抛，实际没抛）'))
}
process.on('exit', () => {
  if (failed) {
    console.log(`\n❌ ${failed} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

/* ---------------- 造 / 读 ZIP ---------------- */

const te = new TextEncoder()
function crc32(data) {
  let c = ~0
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** 拼一个 store(0) 的 ZIP。files: [{ name, data?, method?, flags? }] */
function makeZip(files) {
  return makeZipRaw(files)
}

/**
 * 同上，但 data 就是**落在流里的字节**：method 8 时要额外给原文的 rawCrc / rawSize，
 * 否则中央目录里记的就成了压缩后的长度，解包器会读过头。
 */
function makeZipRaw(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = te.encode(f.name)
    const data = f.data ?? new Uint8Array(0)
    const method = f.method ?? 0
    const flags = f.flags ?? 0
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    const rawCrc = f.rawCrc ?? crc32(data)
    const rawSize = f.rawSize ?? data.length
    lv.setUint32(14, rawCrc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, rawSize, true)
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
    cv.setUint32(16, rawCrc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, rawSize, true)
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
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}

/**
 * 从**本地文件头**逐条读回 { name, data }。
 *
 * ⚠️ 故意不走中央目录：js-dos 的解包器读的就是流里这一串本地头，
 * 「中央目录写对了、本地头写歪了」正是那种 DOSBox 黑屏而没有任何错误的形态。
 */
function readLocal(buf) {
  const b = new Uint8Array(buf)
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = []
  let at = 0
  while (at + 30 <= b.length && v.getUint32(at, true) === 0x04034b50) {
    const method = v.getUint16(at + 8, true)
    const crc = v.getUint32(at + 14, true)
    const size = v.getUint32(at + 18, true)
    const nameLen = v.getUint16(at + 26, true)
    const extraLen = v.getUint16(at + 28, true)
    const name = new TextDecoder().decode(b.subarray(at + 30, at + 30 + nameLen))
    const start = at + 30 + nameLen + extraLen
    out.push({ name, method, crc, data: b.subarray(start, start + size) })
    at = start + size
  }
  return out
}

const bytes = (s) => te.encode(s)
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/* ---------------- 一、合并本身 ---------------- */

// 就照《命令与征服》那个包的形状：本体的几块 .MIX 摊在根上
const base = makeZip([
  { name: 'C&C_.EXE', data: bytes('exe stub') },
  { name: 'GAME.DAT', data: bytes('the real executable, 1.2MB in reality') },
  { name: 'SC-000.MIX', data: bytes('base mix 000') },
  { name: 'SC-001.MIX', data: bytes('base mix 001') },
])

{
  const merged = mergeExtraFiles(base, [{ path: 'SC-002.MIX', data: bytes('covert ops') }])
  const entries = readLocal(merged)
  const names = entries.map((e) => e.name)
  ok(names.length === 5, `资料片并进去之后是 5 条（实际 ${names.length}：${names.join(', ')}）`)
  ok(names.includes('SC-002.MIX'), '资料片 SC-002.MIX 落在根目录，和本体的 SC-000/001 同一层')
  for (const keep of ['C&C_.EXE', 'GAME.DAT', 'SC-000.MIX', 'SC-001.MIX']) {
    ok(names.includes(keep), `本体的「${keep}」还在`)
  }
  const before = readLocal(base)
  const unchanged = before.every((e) => {
    const after = entries.find((x) => x.name === e.name)
    return after && same(after.data, e.data) && after.crc === e.crc && after.method === e.method
  })
  ok(unchanged, '本体每一条的内容 / CRC / 压缩方式都一个字节没动')
  const extra = entries.find((e) => e.name === 'SC-002.MIX')
  ok(same(extra.data, bytes('covert ops')), '资料片的内容原样写了进去')
  ok(extra.crc === crc32(bytes('covert ops')), '资料片的 CRC 是按真实内容算的（不是抄来的 0）')
  ok(extra.method === 0, '附加文件按 store 写入（.MIX 本来就是压好的，再压一遍没意义）')
}

{
  // 打补丁：同名就是替换。ZIP 允许重名，而 js-dos 是逐条往虚拟盘写的 ——
  // 留两条只会变成「后写的赢」，那是碰运气
  const merged = mergeExtraFiles(base, [{ path: 'SC-000.MIX', data: bytes('PATCHED') }])
  const entries = readLocal(merged)
  const hits = entries.filter((e) => e.name === 'SC-000.MIX')
  ok(hits.length === 1, `同名条目只留一条（实际 ${hits.length} 条）`)
  ok(same(hits[0].data, bytes('PATCHED')), '留下的是附加文件那一份，本体那份被顶掉了')
  ok(entries.length === 4, '替换不增加条目数')
}

{
  // 子目录：父目录条目必须补出来，否则 js-dos 的 wasm 解包器 ENOENT，
  // DOSBox 当场退出，而这条路**不发任何 error 事件** —— 玩家看到的是黑屏
  const merged = mergeExtraFiles(base, [{ path: 'CDROM/SUB/FOO.MIX', data: bytes('deep') }])
  const names = readLocal(merged).map((e) => e.name)
  ok(names.includes('CDROM/'), '补出了一级父目录条目 CDROM/')
  ok(names.includes('CDROM/SUB/'), '补出了二级父目录条目 CDROM/SUB/')
  ok(names.indexOf('CDROM/') < names.indexOf('CDROM/SUB/FOO.MIX'), '父目录排在文件前面（解包器是顺序写的）')
  ok(names.includes('CDROM/SUB/FOO.MIX'), '文件本身在')
}

{
  // 父目录已经在包里的话，别补第二条
  const withDir = makeZip([
    { name: 'DATA/' },
    { name: 'DATA/A.MIX', data: bytes('a') },
  ])
  const names = readLocal(mergeExtraFiles(withDir, [{ path: 'DATA/B.MIX', data: bytes('b') }])).map((e) => e.name)
  ok(names.filter((x) => x === 'DATA/').length === 1, '已存在的父目录条目不会被补重')
}

ok(mergeExtraFiles(base, []) === base, '没有附加文件时原样返回同一个 buffer（不白复制十几 MB）')
throwsWith(() => mergeExtraFiles(bytes('not a zip').buffer, [{ path: 'X', data: bytes('x') }]), /不是一个可读的 ZIP/, '不是 ZIP 的 ROM 明确报错，而不是产出一个坏包')
throwsWith(
  () => mergeExtraFiles(makeZip([{ name: 'A.MIX', data: bytes('a'), method: 14 }]), [{ path: 'X', data: bytes('x') }]),
  /不支持的压缩方式/,
  'LZMA / deflate64 之类的包明确报错（合并会把它重打成一个解不开的包）',
)

/* ---------------- 二、清单的解析与回写 ---------------- */

{
  const r = parseDosExtra('extras/command-conquer/SC-002.MIX')
  ok(r.key === 'extras/command-conquer/SC-002.MIX' && r.path === 'SC-002.MIX', '只填 key 时，落点默认是文件名（= 和本体同一层）')
  ok(formatDosExtra(r) === 'extras/command-conquer/SC-002.MIX', '落点等于默认值时回写不带 | 后缀（别把噪音写进库）')
}
{
  const r = parseDosExtra('extras/x/foo.mix|DATA/FOO.MIX')
  ok(r.path === 'DATA/FOO.MIX', '写了 | 后半段时按它落点')
  ok(formatDosExtra(r) === 'extras/x/foo.mix|DATA/FOO.MIX', '非默认落点会被回写出来')
}
ok(parseDosExtra('  extras/x/a.mix  ').key === 'extras/x/a.mix', '两边空白被吃掉')
ok(parseDosExtra('/extras/x/a.mix').key === 'extras/x/a.mix', '开头的 / 被去掉（key 不是绝对路径）')
ok(parseDosExtra('') === null && parseDosExtra('   ') === null, '空行不产出条目')
ok(parseDosExtra('extras/x/a.mix|../../etc/passwd') .path === 'a.mix', '落点里的 .. 被丢弃，退回默认落点，不会逃出游戏目录')
ok(parseDosExtra('extras/x/a.mix|/abs/B.MIX').path === 'abs/B.MIX', '落点开头的 / 被去掉')
ok(parseDosExtra('extras/x/a.mix|sub\\B.MIX').path === 'sub/B.MIX', '落点里的反斜杠统一成 /')
ok(defaultExtraPath('https://cdn.example.com/p/SC-002.MIX?v=3') === 'SC-002.MIX', '完整 URL 也能算出默认落点（切掉 ?query）')
ok(normalizeExtraPath('DATA/') === '', '以 / 结尾的不是文件，拒绝')
ok(parseDosExtras(['a/x.mix', '', 'b/y.mix']).length === 2, '整份清单里的空行被跳过')
ok(parseDosExtras(undefined).length === 0, '没有清单时返回空数组（不是 undefined）')

/* ---------------- 三、服务端校验（不能信前端） ---------------- */

ok(dosExtrasOf(['extras/a/x.mix']) === 'extras/a/x.mix', '数组进、一行一个的文本出')
ok(dosExtrasOf('extras/a/x.mix\nextras/a/y.mix').split('\n').length === 2, '文本进也认')
ok(dosExtrasOf([]) === null && dosExtrasOf(undefined) === null, '空清单存 NULL，不是空字符串')
ok(dosExtrasOf(['../../secret']) === null, 'key 里的 .. 被整条丢掉')
ok(dosExtrasOf(['a\\b.mix']) === null, 'key 里的反斜杠被整条丢掉')
ok(dosExtrasOf(['extras/a/x.mix|../../etc/passwd']) === null, '落点里的 .. 被整条丢掉（前端已经滤过一遍，服务端仍然不信）')
ok(dosExtrasOf(['extras/a/x.mix|DATA/X.MIX']) === 'extras/a/x.mix|DATA/X.MIX', '合法的 key|落点 原样保留')
ok(dosExtrasOf(['e/x.mix', 'e/x.mix']) === 'e/x.mix', '整行重复的去重')
ok(dosExtrasOf(['e/x.mix', 'e/x.mix|D/X.MIX']).split('\n').length === 2, '同一个 key 落两个位置是合法的，不当重复')
ok(dosExtrasOf(Array.from({ length: 30 }, (_, i) => `e/f${i}.mix`)).split('\n').length === 12, '超过 12 条被截断（每一条都会进玩家开局的加载链路）')
ok(dosExtrasOf(['e/' + 'x'.repeat(600) + '.mix']) === null, '超长 key 被丢掉')

/* ---------------- 三点五、可选资料片（行首的 ?） ---------------- */

/*
  站长 2026-09-11：《命令与征服》的隐秘行动资料片 500MB。默认全量注入 = 每个路过点开的人
  先下这 500MB，而绝大多数人只想玩本体。于是逐条可以标成「可选」，开始界面给一个开关、默认不下。
  ⚠️ 最要命的一条在最前面：**没标记的行必须还是强制注入**。这个标记是后加的，
  库里已经有的那些行一条都没有 `?`，要是默认成可选，所有已经上线的补丁当场全部停止生效。
*/
ok(parseDosExtra('extras/a/x.mix').optional === false, '⚠️ 没有 ? 的行仍然是强制注入（库里的老数据一条都不能变）')
{
  const r = parseDosExtra('?extras/cc/SC-002.MIX')
  ok(r.optional === true, '行首的 ? = 可选')
  ok(r.key === 'extras/cc/SC-002.MIX', '? 不会被当成 key 的一部分')
  ok(r.path === 'SC-002.MIX', '剥掉 ? 之后照常算默认落点')
  ok(formatDosExtra(r) === '?extras/cc/SC-002.MIX', '回写时把 ? 补回去')
}
{
  const r = parseDosExtra('?extras/cc/SC-002.MIX|DATA/SC-002.MIX')
  ok(r.optional === true && r.path === 'DATA/SC-002.MIX', '? 和 |落点 可以同时用')
  ok(formatDosExtra(r) === '?extras/cc/SC-002.MIX|DATA/SC-002.MIX', '两样都回写得出来')
}
ok(parseDosExtra('  ?extras/a/x.mix ').optional === true, '前后有空格也认得出 ?')
ok(parseDosExtra('?') === null, '光一个 ? 不算一条')
{
  const list = parseDosExtras(['patch/fix.dat', '?extras/cc/SC-002.MIX'])
  ok(list.filter((e) => e.optional).length === 1 && list.filter((e) => !e.optional).length === 1, '同一款游戏里补丁强制、资料片可选，两者能共存')
}

ok(dosExtrasOf(['?extras/cc/SC-002.MIX']) === '?extras/cc/SC-002.MIX', '服务端原样保留 ? 标记')
ok(dosExtrasOf(['?extras/cc/x.mix|D/X.MIX']) === '?extras/cc/x.mix|D/X.MIX', '? 和落点一起保留')
ok(dosExtrasOf(['?../../secret']) === null, '带 ? 的行照样过 .. 校验（剥标记不等于放行）')
ok(dosExtrasOf(['?e/x.mix', 'e/x.mix']).split('\n').length === 2, '同一个 key 可选和强制各一条不算重复（去重是整行比）')

ok(dosExtrasLabelOf('  隐秘行动  ') === '隐秘行动', '资料片名字两边空白吃掉')
ok(dosExtrasLabelOf('') === null && dosExtrasLabelOf(null) === null, '没填就是 NULL，不是空字符串')
ok(dosExtrasLabelOf('隐秘\n  行动') === '隐秘 行动', '换行和连续空格压成一个空格（这行字要显示在一行里）')
ok(dosExtrasLabelOf('名'.repeat(200)).length === 60, '超长名字截到 60 —— 开关是一行字，不是简介')

/* ---------------- 三点六、资料片名字的中英双语 ---------------- */

/*
  开关那句话（「同时加载「{name}」（额外 498 MB）」）八种语言都有译文，但 {name} 是
  后台填的专有名词。只有一份中文名的话，英文玩家看到的是
  `Also load “隐秘行动” (+498 MB)` —— 一句英文里夹一个中文名。
  所以后台中英各填一格，和 title / titleZh 一个路数：两个字段，不走按需翻译
  （机器把「隐秘行动」翻成 Secret Action，玩家反而认不出那是哪个资料片）。
*/
const both = { dosExtrasLabel: '隐秘行动', dosExtrasLabelEn: 'Covert Operations' }
ok(dosExtrasName(both, 'zh-Hans') === '隐秘行动', '简体用中文名')
ok(dosExtrasName(both, 'zh-Hant') === '隐秘行动', '繁体没有单独一份，跟简体走（和 gameTitle 缺 titleI18n 时一致）')
for (const lang of ['en', 'ja', 'es', 'fr', 'de', 'it']) {
  ok(dosExtrasName(both, lang) === 'Covert Operations', `${lang} 用英文名`)
}
ok(dosExtrasName({ dosExtrasLabel: '隐秘行动' }, 'en') === '隐秘行动', '只填了中文名时，英文界面退回中文 —— 总比什么都不显示强')
ok(dosExtrasName({ dosExtrasLabelEn: 'Covert Operations' }, 'zh-Hans') === 'Covert Operations', '只填了英文名时，中文界面退回英文')
ok(dosExtrasName({}, 'en') === '' && dosExtrasName({}, 'zh-Hans') === '', '两边都空返回空串（调用方退回各语言自己的「扩展包 / the expansion」）')
ok(dosExtrasName({ dosExtrasLabel: '  隐秘行动  ' }, 'zh-Hans') === '隐秘行动', '两边空白吃掉')
ok(dosExtrasName({ dosExtrasLabel: '   ', dosExtrasLabelEn: 'Covert Ops' }, 'zh-Hans') === 'Covert Ops', '全是空白等于没填')

/* ---------------- 四、后台那一步：整个压缩包丢进来 ---------------- */

/*
  这是站长要的那条路：「有的时候不是我上传游戏而是运维人员，他们不太会用 cd curl unzip 指令」。
  运维从 dosgamesarchive 下来一个 covtdemo.zip，直接丢进后台 —— 后台自己拆、自己传、
  自己算落点。下面按真实的包来：deflate 压过、带 __MACOSX 资源叉、带说明文件。
*/
ok(skipExtraEntry('__MACOSX/SC-002.MIX'), 'macOS 的 __MACOSX/ 目录整棵滤掉')
ok(skipExtraEntry('._SC-002.MIX') && skipExtraEntry('sub/._X.MIX'), 'macOS 的 ._ 资源叉文件滤掉（会原样落进游戏目录，DOS 那边不认）')
ok(skipExtraEntry('DATA/'), '目录条目本身不当附加文件（父目录由合并那一步自己补）')
ok(!skipExtraEntry('SC-002.MIX') && !skipExtraEntry('DATA/SC-002.MIX'), '正常文件不会被误滤')
ok(extraObjectName('SC-002.MIX') === 'SC-002.MIX', '常见的 8.3 文件名原样当对象 key')
ok(extraObjectName('DATA/Covert Ops.mix') === 'DATA/Covert-Ops.mix', '空格换成 -，子目录层级保留')
ok(extraObjectName('资料片.MIX') === '.MIX', '纯中文名被滤空只剩扩展名 —— 所以调用方必须判空（见 DosExtrasField）')
ok(extraPathProblem('资料片.MIX')?.blocking === true, '中文名在上传那一步就被拦住（硬传上去会变成「.MIX」这种一碰就撞的 key）')
ok(extraPathProblem('Covert Ops.MIX')?.blocking === true, '带空格的名字也拦住')
ok(extraPathProblem('SC-002.MIX') === null, '正常的 8.3 名一路放行')
ok(extraPathProblem('DATA/SC-002.MIX') === null, '子目录里的 8.3 名也放行')
{
  const p = extraPathProblem('CovertOperations.MIX')
  ok(p && p.blocking === false, '超过 8 个字符的名字只提醒、不拦（DOSBox 会编 8.3 别名，文件确实在盘上）')
}

{
  // 真·deflate 的 zip：运维手里的包就是这样的，不是 store
  const { deflateRawSync } = await import('node:zlib')
  const inner = bytes('covert operations mission data ' + 'x'.repeat(2000))
  const packed = new Uint8Array(deflateRawSync(Buffer.from(inner)))
  const zip = makeZipRaw([
    { name: '__MACOSX/', data: new Uint8Array(0) },
    { name: '__MACOSX/._SC-002.MIX', data: bytes('resource fork junk') },
    { name: 'SC-002.MIX', data: packed, method: 8, rawCrc: crc32(inner), rawSize: inner.length },
    { name: 'FILE_ID.DIZ', data: bytes('readme') },
  ])
  const usable = listZipEntries(zip).filter((e) => !skipExtraEntry(e.name))
  ok(usable.length === 2, `拆包后剩 2 个可用条目（实际 ${usable.length}：${usable.map((e) => e.name).join(', ')}）`)
  const got = await extractZipEntry(zip, usable.find((e) => e.name === 'SC-002.MIX'))
  ok(same(got, inner), 'deflate 压过的资料片解得开、内容对得上')
  const merged = mergeExtraFiles(base, [{ path: 'SC-002.MIX', data: got }])
  const written = readLocal(merged).find((e) => e.name === 'SC-002.MIX')
  ok(written.method === 0 && same(written.data, inner), '并进游戏包时写的是解压后的原文（store），不是那坨 deflate 字节')
  ok(!readLocal(merged).some((e) => /__MACOSX|\._/.test(e.name)), 'macOS 的垃圾没有跟着进游戏目录')
}

/* ---------------- 五、播放器真的用了合并后的包 ---------------- */

const adapter = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
{
  // 这条是整条链路里最容易被「顺手改回去」的一行：两个消费者都必须吃 gameBuf。
  // 改回 rom.buf 的话资料片照样下载、照样合并，然后被整个丢掉 —— 而且一声不吭。
  ok(/const gameBuf = extras\.length \? mergeExtraFiles\(rom\.buf, extras\) : rom\.buf/.test(adapter), '合并结果存进 gameBuf')
  ok(!/makeWindowsGameLayer\(rom\.buf/.test(adapter), 'Windows 客体那条路不再直接用 rom.buf')
  ok(/makeWindowsGameLayer\(gameBuf/.test(adapter), 'Windows 客体那条路用 gameBuf')
  const call = adapter.slice(adapter.indexOf('await makeJsdosBundle('))
  ok(/^await makeJsdosBundle\(\s*\n\s*rom\.name,\s*\n\s*gameBuf,/.test(call), '普通 DOS 那条路也用 gameBuf')
  // 取不到就抛，不静默跳过：少一条要么是 key 填错（永远不会自己好），
  // 要么这一局本来就跑不成预期的样子，而玩家只会以为「你们这个扩展包是假的」
  ok(/throw new Error\(`附加文件「\$\{path\}」下载失败/.test(adapter), '附加文件下不下来时抛错，不静默跳过')
  ok(/loadExtras\(options\.dosExtras, abort\.signal\)/.test(adapter), '下载挂在会话的 AbortSignal 上（玩家切走就别继续吞流量）')
}

/* ---------------- 六、开关：默认不下那 500MB ---------------- */

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
{
  // 这三条是整个功能的意义所在，改错任何一条都会让 500MB 重新变成人人必下
  ok(
    /const activeExtras = dosExtras\?\.filter\(\(e\) => !e\.optional \|\| wantExtras\)/.test(player),
    '交给运行时的是「强制的 + 勾了才算的可选的」，不是整份清单',
  )
  ok(/dosExtrasRef\.current = activeExtras/.test(player), '挂载时读的是过滤后的那一份（不是原始 dosExtras）')
  ok(!/dosExtrasRef\.current = dosExtras\b/.test(player), '⚠️ 没有哪条路把未过滤的清单直接塞回 ref')
  ok(/useState\(\(\) => readExtrasChoice\(gameSlug\)\)/.test(player), '开关的初值来自玩家自己上次的选择')
  ok(/localStorage\.getItem\(`\$\{EXTRAS_CHOICE_KEY\}:\$\{slug\}`\) === '1'/.test(player), '没选过 = false = 不下载（默认关）')
  // 「为了显示体积先把 500MB 下下来」是这个功能能犯的最蠢的错
  ok(/fetch\(e\.url, \{ method: 'HEAD' \}\)/.test(player), '量体积只发 HEAD')
  ok(/for \(const n of sizes\) \{\s*\n\s*if \(n === null\) return null/.test(player), '任何一份量不到就整个不显示体积 —— 写个偏小的数字比不写还糟')
  ok(/optionalExtras\.length > 0 && !online && !willWatch/.test(player), '联机 / 观战时不显示这个开关（游戏不在本机跑，勾了也没用）')
  // 开关上那句话必须整句走 i18n，一个字都不能硬编码
  ok(/t\.player\.extrasToggleSized/.test(player) && /t\.player\.extrasToggle\b/.test(player), '开关文案走 t.player.*，不是写死的中文')
  ok(/t\.player\.extrasFallbackName/.test(player), '后台没填名字时退回各语言自己的「扩展包」')
}

{
  // 详情页必须按当前语言挑名字，而不是把中文名直接递下去
  const detail = readFileSync(new URL('../src/pages/GameDetailPage.tsx', import.meta.url), 'utf8')
  ok(/dosExtrasLabel=\{dosExtrasName\(game, lang\)\}/.test(detail), '详情页按当前语言挑资料片名字')
  ok(!/dosExtrasLabel=\{game\.dosExtrasLabel\}/.test(detail), '⚠️ 没有哪条路把中文名直接递给播放器')
}

{
  // 八种语言一个都不能少：少一种的后果是那个语言的玩家看到 undefined
  const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'es', 'fr', 'de', 'it']
  const KEYS = ['extrasToggle', 'extrasToggleSized', 'extrasFallbackName']
  for (const lang of LANGS) {
    const src = readFileSync(new URL(`../src/locales/${lang}.ts`, import.meta.url), 'utf8')
    const missing = KEYS.filter((k) => !new RegExp(`\\n\\s*${k}:`).test(src))
    ok(!missing.length, `${lang} 三条开关文案齐全${missing.length ? `（缺 ${missing.join('、')}）` : ''}`)
  }
  // 占位符写错了不会报错，只会在界面上原样显示一个 {size}
  for (const lang of LANGS) {
    const src = readFileSync(new URL(`../src/locales/${lang}.ts`, import.meta.url), 'utf8')
    const sized = src.match(new RegExp(`extrasToggleSized: '([^']*)'`))?.[1] ?? ''
    ok(sized.includes('{name}') && sized.includes('{size}'), `${lang} 的带体积文案里 {name} 和 {size} 都在`)
  }
}

console.log(`\n✅ ${n} 项通过`)
