/**
 * iNES / NES 2.0 文件头解析的回归测试。
 *
 * 盯的是这个坑：`.nes` 默认交给 jsnes（纯 JS、启动快），可它只实现了 21 个 mapper。
 * 忍者神龟 3 是 mapper 25（Konami VRC4），jsnes 在 loadROM 里抛
 * `Unsupported mapper: 25`，玩家看到一条红字 —— 而同一份 ROM 在 EmulatorJS 的
 * FCEUmm 核心里毫无问题。现在适配器会在**构造引擎之前**读出 mapper，
 * 认不得就把这一局让给 EmulatorJS，所以这个解析必须准。
 *
 * 跑：npm run test:nes-mapper
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const { readNesMapper, jsnesCanRun, JSNES_MAPPERS } = await import(
  fileURLToPath(new URL('../src/emulator/nesMapper.ts', import.meta.url))
)

/**
 * 拼一个 16 字节的 iNES 头。
 * @param mapper 目标 mapper 编号
 * @param opts.nes20 按 NES 2.0 写（mapper 可以到 12 位）
 * @param opts.dirty 模拟上世纪工具写脏的字节 7-15（DiskDude! 那一类）
 */
function header(mapper, { nes20 = false, dirty = false } = {}) {
  const b = new Uint8Array(16)
  b.set([0x4e, 0x45, 0x53, 0x1a]) // 'NES\x1a'
  b[4] = 2 // PRG 32KB
  b[5] = 1 // CHR 8KB
  b[6] = (mapper & 0x0f) << 4
  b[7] = mapper & 0xf0
  if (nes20) {
    b[7] |= 0x08 // bit2-3 = 0b10 → NES 2.0
    b[8] = (mapper >> 8) & 0x0f
  }
  if (dirty) {
    // 'DiskDude!' 从字节 7 开始糊上去，字节 7 的高半字节就此变成 ASCII 的一部分
    const junk = 'DiskDude!'
    for (let i = 0; i < junk.length && 7 + i < 16; i++) b[7 + i] = junk.charCodeAt(i)
  }
  return b
}

/* ---------- 1. iNES 1.0：低 4 位 + 高 4 位 ---------- */
for (const m of [0, 1, 4, 7, 25, 66, 69, 118, 180, 255]) {
  assert.equal(readNesMapper(header(m)), m, `iNES 1.0 应读出 mapper ${m}`)
}

/* ---------- 2. NES 2.0：12 位 ---------- */
for (const m of [0, 25, 256, 555, 4095]) {
  assert.equal(readNesMapper(header(m, { nes20: true })), m, `NES 2.0 应读出 mapper ${m}`)
}

/* ---------- 3. 脏头（DiskDude!）：只信低 4 位 ---------- */
{
  /*
    字节 7 被 'D'(0x44) 占了，高半字节是 4 —— 直接采信的话 mapper 4 会被读成 68。
    通行判据是看字节 12-15 是否全零；这里不是，所以只取字节 6 的高半字节。
    宁可少认：猜大了会让我们误判 jsnes 跑不了、白下一个核心。
  */
  assert.equal(readNesMapper(header(4, { dirty: true })), 4, '脏头时只取低 4 位，别把 ASCII 当 mapper')
  assert.equal(readNesMapper(header(1, { dirty: true })), 1)
}

/* ---------- 3b. 判据必须和 jsnes 自己那套一致（字节 8-15，不是 12-15） ---------- */
{
  /*
    ⚠️ 这一组是真出过事的：nesMapper 以前只看字节 12-15，而 jsnes 的 rom.js 看的是 8-15
    （`for (i = 8; i < 16; i++)`，非零就 `mapperType &= 0xf`）。两边分歧的文件长这样 ——
    字节 8-11 非零（写了 PRG-RAM 大小 / TV 制式，很常见）而 12-15 为零。
    分歧的后果：我们算出 118「jsnes 支持」→ 交给 jsnes → jsnes 掩成 6 → 抛
    `Unsupported mapper` → 播放器原样重试一次 → 确定性地再失败 → 玩家拿到红字，
    而 EmulatorJS 的 FCEUmm 明明跑得动。
  */
  const h = header(118)
  h[8] = 1 // PRG-RAM 大小：iNES 1.0 的扩展字段，合法且常见
  assert.equal(readNesMapper(h), 118 & 0x0f, '字节 8-11 非零 = 脏头，只能取低 4 位（和 jsnes 一致）')

  const clean = header(118)
  assert.equal(readNesMapper(clean), 118, '字节 8-15 全零时才采信字节 7')

  // 反过来：12-15 非零的老式脏头照样只取低 4 位
  const tail = header(118)
  tail[14] = 0x21
  assert.equal(readNesMapper(tail), 118 & 0x0f)
}

/* ---------- 3c. 脏头不能被误认成 NES 2.0 ---------- */
{
  /*
    NES 2.0 的判据是「字节 7 的 bit2-3 == 0b10」。光看那两位不够：把工具名写进字节 7 的
    老文件，只要那个 ASCII 满足 `c & 0x0c === 0x08`（'H' 'I' 'X' 'Y' '8' '(' … 一大把）
    就会被误认，然后拿另一个 ASCII 字节当 mapper 高位，算出上千的荒唐编号 ——
    本来 jsnes 秒开的游戏被赶去下载一个 RetroArch 核心。
    所以再要求 ROM 大小自洽（头里写的 PRG + CHR 不能超过文件本身）。
  */
  const body = 16 + 2 * 16384 + 1 * 8192
  const rom = new Uint8Array(body)
  rom.set(header(4))
  // 'HACK' 从字节 7 糊上去：'H' = 0x48，低两位组恰好是 0b10 → 会被当成 NES 2.0
  const junk = 'HACK'
  for (let i = 0; i < junk.length; i++) rom[7 + i] = junk.charCodeAt(i)
  assert.equal((rom[7] & 0x0c) === 0x08, true, '前提：这个字节确实会被误认成 NES 2.0')
  assert.equal(readNesMapper(rom), 4, '⭐ 大小对不上就不是 NES 2.0，退回只取低 4 位')

  // 真的 NES 2.0（大小自洽）不能被误伤
  const real = new Uint8Array(body)
  real.set(header(256, { nes20: true }))
  assert.equal(readNesMapper(real), 256, '真 NES 2.0 且大小自洽 → 照常读 12 位')

  // 指数记法（字节 9 的半字节 == 0xF）算不出确切大小，一律放行
  const expo = new Uint8Array(64)
  expo.set(header(300, { nes20: true }))
  expo[9] = 0x0f
  assert.equal(readNesMapper(expo), 300, '指数记法不参与大小校验')
}

/* ---------- 4. 不是 iNES → null（交给 jsnes 自己试） ---------- */
{
  assert.equal(readNesMapper(new Uint8Array(16)), null, '魔数不对就不是 iNES')
  assert.equal(readNesMapper(new Uint8Array(8)), null, '头都不够长')
  const unif = new Uint8Array(16)
  unif.set([0x55, 0x4e, 0x49, 0x46]) // 'UNIF'
  assert.equal(readNesMapper(unif), null)
}

/* ---------- 5. jsnesCanRun：拦下必然失败的，别误伤 ---------- */
{
  // 真实案例：忍者神龟 3
  assert.equal(jsnesCanRun(header(25)), false, 'mapper 25（VRC4）jsnes 跑不了，要让给 EmulatorJS')
  // Konami VRC 一族 + 另外几个常见的大件，jsnes 都没实现
  for (const m of [19, 21, 22, 23, 24, 25, 26, 69, 85]) {
    assert.equal(jsnesCanRun(header(m)), false, `mapper ${m} jsnes 没实现`)
  }
  // jsnes 实现了的一律放行（超级玛丽 = 0，魂斗罗 = 2，忍者龙剑传 = 4…）
  for (const m of JSNES_MAPPERS) {
    assert.equal(jsnesCanRun(header(m)), true, `mapper ${m} jsnes 实现了，不该被拦`)
  }
  // 读不出格式的不拦 —— 这个函数只负责「提前拦下必然失败的」，不替 jsnes 做校验
  assert.equal(jsnesCanRun(new Uint8Array(4)), true, '认不出格式时要放行')
}

/* ---------- 6. ArrayBuffer 和 Uint8Array 都要吃 ---------- */
{
  const u8 = header(25)
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
  assert.equal(readNesMapper(ab), 25, 'ArrayBuffer 也要能读')
}

/* ---------- 7. jsnes 的实现清单没漂移 ---------- */
{
  /*
    这张表是抄 node_modules/jsnes/src/mappers/index.js 的。升级 jsnes 之后如果那边多了
    实现而这边没跟，只是白下核心；反过来（那边删了、这边还留着）玩家会撞回红字。
    所以直接拿它的注册表对一遍。
  */
  // 直接读它的源码：jsnes 的 package exports 没把 src/ 放出来，import 不进去
  const { readFileSync, existsSync } = await import('node:fs')
  const registry = fileURLToPath(new URL('../node_modules/jsnes/src/mappers/index.js', import.meta.url))
  if (!existsSync(registry)) {
    console.log('  ℹ️ 没找到 jsnes 的 mapper 注册表源码，跳过对齐检查')
  } else {
  const src = readFileSync(registry, 'utf8')
  const actual = new Set([...src.matchAll(/^\s*(\d+):\s*Mapper/gm)].map((m) => Number(m[1])))
  assert.ok(actual.size > 10, `没从 jsnes 源码里解析出 mapper 注册表（只拿到 ${actual.size} 个），正则该跟着它的写法调`)
  const missing = [...actual].filter((m) => !JSNES_MAPPERS.has(m))
  const extra = [...JSNES_MAPPERS].filter((m) => !actual.has(m))
  assert.deepEqual(extra, [], `JSNES_MAPPERS 多写了 ${extra.join(',')} —— jsnes 其实没实现，玩家会撞回红字`)
  if (missing.length) console.log(`  ℹ️ jsnes 还实现了 ${missing.join(',')}，我们没列（只是白下核心，不影响正确性）`)
  }
}

console.log('✅ NES mapper 解析测试通过：iNES 1.0 / NES 2.0 / 脏头 / 非 iNES / jsnes 清单对齐')
