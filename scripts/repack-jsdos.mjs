#!/usr/bin/env node
/**
 * 把 .jsdos 包里未压缩（store）的条目重新打成 deflate。
 *
 *   node scripts/repack-jsdos.mjs <输入.jsdos> [输出.jsdos]
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 * 2026-09-11 查 system-win95-v1.jsdos：整包 97,651,653 字节，zip 的压缩方式是
 * **store** —— 里面那份 97,648,640 字节的 qcow2 是**裸存**的。而线上是这么发的：
 *
 *   GET https://assets.8bitgo.com/systems/dos/system-win95-v1.jsdos
 *   content-length: 97651653
 *   content-type: application/octet-stream     ← 没有 content-encoding
 *
 * 也就是说每个第一次开 Win95 游戏的人，都要下 93.1 MiB 完全没压缩的数据。
 * 重新打成 deflate 之后是 40,208,558 字节（41.2%），**内容一个字节不差**。
 * 加 `--zopfli` 再省 3.5%（38,271,964 字节）—— 产出仍是标准 deflate，js-dos 照常读，零代码改动。
 *
 * 2026-09-11 又往前走了一步：那份 qcow2 里有 8.0 MiB 是 **FAT 空闲簇里的残留垃圾**
 * （装完系统删掉的临时文件，扇区还留着旧内容）。把空闲簇抹零之后，qcow2 本身从 93.1 MiB
 * 掉到 84.1 MiB（qemu-img 会把全零的簇整个丢掉不分配），再 zopfli 是 35,701,926 字节 ——
 * 93.13 MiB → 34.05 MiB，**文件系统里 1283 个文件的 sha256 逐个一致**。
 * 抹零那一步需要 qemu-img，不在这个脚本里；要再做一次（比如 win98 那个 235 MB 的包）找 Claude。
 *
 * CDN 不会替我们压：`application/octet-stream` 不在 Cloudflare 的可压缩类型里，
 * 而且它对「看起来已经压过的」内容本来就跳过 —— 对 zip 这个判断通常是对的，
 * 只有这个包是个例外（它是 store 的）。
 *
 * ── 为什么不用 zstd / xz ──────────────────────────────────
 * 实测 zstd -19 是 30.8 MiB、xz -6 是 29.0 MiB，比 deflate 只多省 7~9 MiB，
 * 代价却是要引一个 wasm 解压器、多花客户端 CPU、还要改 loadGameBytes 和 IndexedDB 缓存那一路。
 * deflate 是**零代码改动**：js-dos 的 zip 读取器本来就认它（正常的 bundle 就是 deflate 的，
 * 这个包反而是异常）。不划算的优化不做。
 *
 * ── 为什么可以原地换掉，不用改代码 ────────────────────────
 * `src/lib/jsdosBundle.ts` 的 hideJsdosConfigForLayer 会把 `.jsdos/dosbox.conf` 原地改名成
 * 同样 18 字节的 `.jsdos/dosbox.orig`，只动本地头和中央目录里的文件名那 36 个字节。
 * 那件事和**数据用什么压缩方式无关**，所以 deflate 之后照旧成立 —— 下面的 verify() 每次都验一遍。
 * （顺带：那个函数的注释写着「不碰 96MB 的 qcow2 压缩数据」，在这次重打之前那句话是不成立的。）
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
/**
 * `--zopfli`：用 zopfli 代替 zlib 压。
 *
 * zopfli 产出的是**标准 deflate**，任何 zip 解包器（包括 js-dos 的）照常读 —— 零代码改动。
 * 代价只在打包这一侧：它穷举块划分和霍夫曼树，93 MiB 要跑三四分钟，而 zlib 只要十秒。
 * 换来大约 3.5%，这个包上是 1.4 MiB —— 对一个**每个第一次玩 Win95 游戏的人都要下一遍**
 * 的文件，一次性多花三分钟是划算的。
 *
 * 装不上 zopfli（没有 python3 或没装这个包）就自动退回 zlib：少省一点，但绝不因此打不出包。
 */
const useZopfli = argv.includes('--zopfli')
const [inPath, outPathArg] = argv.filter((a) => !a.startsWith('--'))
if (!inPath) {
  console.error('用法：node scripts/repack-jsdos.mjs [--zopfli] <输入.jsdos> [输出.jsdos]')
  process.exit(2)
}
const outPath = outPathArg || inPath.replace(/\.jsdos$/, '') + '.packed.jsdos'

const SIG_LOCAL = 0x04034b50
const SIG_CEN = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 读出全部条目。**刻意只认最朴素的 zip**：没有 zip64、没有数据描述符、没有加密 */
function readEntries(buf) {
  let eocd = -1
  for (let at = buf.length - 22; at >= 0 && at > buf.length - 22 - 65536; at--) {
    if (buf.readUInt32LE(at) === SIG_EOCD) { eocd = at; break }
  }
  if (eocd < 0) throw new Error('找不到 EOCD —— 这不是一个 zip')
  const count = buf.readUInt16LE(eocd + 10)
  const cenSize = buf.readUInt32LE(eocd + 12)
  const cenOff = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cenOff === 0xffffffff) throw new Error('zip64，本脚本不处理')

  const out = []
  let at = cenOff
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== SIG_CEN) throw new Error('中央目录签名不对')
    const flags = buf.readUInt16LE(at + 8)
    // 位 3 = 大小写在数据描述符里。那种包改名要连带挪偏移，这里直接不收
    if (flags & 0x08) throw new Error('条目用了数据描述符，本脚本不处理')
    if (flags & 0x01) throw new Error('条目是加密的，本脚本不处理')
    const method = buf.readUInt16LE(at + 10)
    const dosTime = buf.readUInt16LE(at + 12)
    const dosDate = buf.readUInt16LE(at + 14)
    const csize = buf.readUInt32LE(at + 20)
    const usize = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const cmtLen = buf.readUInt16LE(at + 32)
    const attr = buf.readUInt32LE(at + 38)
    const lo = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen)
    if (buf.readUInt32LE(lo) !== SIG_LOCAL) throw new Error('本地头签名不对：' + name)
    const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (data === null) throw new Error(`条目 ${name} 用了不认识的压缩方式 ${method}`)
    if (data.length !== usize) throw new Error(`条目 ${name} 解出来长度对不上`)
    out.push({ name, data, method, dosTime, dosDate, attr })
    at += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

function crc32(buf) {
  // zlib 的 crc32 没有直接导出，自己来一份（表按需生成，包不大，几十毫秒）
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 走 zopfli 压一块数据，拿回**裸 deflate**。
 *
 * python 的 zopfli 绑定只给 zlib / gzip 容器，所以剥掉 zlib 的 2 字节头和 4 字节 adler32
 * 尾巴 —— 中间那段就是裸 deflate，和 deflateRawSync 的产物同一种东西。
 *
 * numiterations 取 5：实测 15 次和 5 次在这个包上只差 0.01%，时间却多一倍。
 *
 * ⚠️ 任何一步不对就返回 null 让调用方退回 zlib，绝不把半截数据当成功 ——
 * 这个包坏了的表现是「Windows 起不来」，没有任何错误信息。
 */
function zopfliDeflate(data) {
  const py = [
    'import sys, zlib',
    'import zopfli.zopfli as z',
    'raw = sys.stdin.buffer.read()',
    'out = z.compress(raw, numiterations=5)[2:-4]',
    'assert zlib.decompress(out, -15) == raw',   // 自己先验一遍，坏的不出这个进程
    'sys.stdout.buffer.write(out)',
  ].join('\n')
  const r = spawnSync('python3', ['-c', py], { input: data, maxBuffer: 1 << 30 })
  if (r.error || r.status !== 0 || !r.stdout?.length) return null
  return r.stdout
}

let zopfliWarned = false

function build(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    // 目录项（尾部是 /）保持 store：压一个 0 字节没有意义，还会让某些解包器犯迷糊
    const isDir = e.name[e.name.length - 1] === 0x2f
    let body = isDir ? e.data : null
    if (body === null && useZopfli) {
      body = zopfliDeflate(e.data)
      if (body === null && !zopfliWarned) {
        zopfliWarned = true
        console.warn('⚠️ zopfli 跑不起来（pip install zopfli?），这一趟退回 zlib')
      }
    }
    if (body === null) body = deflateRawSync(e.data, { level: 9 })
    const method = isDir ? 0 : 8
    const crc = crc32(e.data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(SIG_LOCAL, 0)
    lh.writeUInt16LE(20, 4)          // 需要 2.0 才能解 deflate
    lh.writeUInt16LE(0, 6)           // ⚠️ flags 必须是 0：不设 UTF-8 位、不设数据描述符位
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(e.dosTime, 10)
    lh.writeUInt16LE(e.dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(e.name.length, 26)
    lh.writeUInt16LE(0, 28)          // ⚠️ extra 一律留空：hideJsdosConfigForLayer 按
                                      // localOffset+30 定位文件名，extra 在名字**后面**不影响，
                                      // 但留空能让本地头的布局和中央目录完全对称，少一类意外
    locals.push(lh, e.name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(SIG_CEN, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(e.dosTime, 12)
    ch.writeUInt16LE(e.dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(e.name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(e.attr, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, e.name)

    offset += 30 + e.name.length + body.length
  }
  const localBuf = Buffer.concat(locals)
  const cenBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, cenBuf, eocd])
}

/**
 * 验收。**每一条都是「换了包之后会静默坏掉」的那种**，所以一条都不能省：
 * 内容不一致 = 客体里的文件被改了但谁也不会报错；改名前提不成立 = 系统 conf 覆盖掉
 * 播放器生成的自动启动配置，Windows 起来了但游戏永远不启动。
 */
function verify(before, after) {
  const a = readEntries(before)
  const b = readEntries(after)
  if (a.length !== b.length) throw new Error(`条目数变了：${a.length} → ${b.length}`)
  for (let i = 0; i < a.length; i++) {
    const an = a[i].name.toString('latin1')
    const bn = b[i].name.toString('latin1')
    if (an !== bn) throw new Error(`第 ${i} 条名字或顺序变了：${an} → ${bn}`)
    const ha = createHash('sha256').update(a[i].data).digest('hex')
    const hb = createHash('sha256').update(b[i].data).digest('hex')
    if (ha !== hb) throw new Error(`${an} 内容变了`)
    console.log(`  ✅ ${an.padEnd(26)} ${(a[i].data.length / 1048576).toFixed(2).padStart(8)} MiB  sha256 一致`)
  }
  // hideJsdosConfigForLayer 的前提：名字正好 18 字节，且本地头与中央目录都这么记
  const conf = b.find((e) => e.name.toString('latin1').toLowerCase() === '.jsdos/dosbox.conf')
  if (!conf) throw new Error('包里没有 .jsdos/dosbox.conf —— 这不是一个系统包')
  if (conf.name.length !== '.jsdos/dosbox.orig'.length) {
    throw new Error('dosbox.conf 的名字长度和替换名对不上，原地改名会失败')
  }
  console.log('  ✅ hideJsdosConfigForLayer 的原地改名前提仍然成立（18 字节）')
}

const before = readFileSync(inPath)
console.log(`读入 ${inPath}（${before.length} 字节）`)
const entries = readEntries(before)
const stored = entries.filter((e) => e.method === 0 && e.name[e.name.length - 1] !== 0x2f)
console.log(`条目 ${entries.length} 个，其中未压缩的 ${stored.length} 个`)
const after = build(entries)
writeFileSync(outPath, after)
console.log('\n验收：')
verify(before, readFileSync(outPath))
const pct = (100 * after.length / before.length).toFixed(1)
const saved = ((before.length - after.length) / 1048576).toFixed(1)
console.log(`\n${outPath}`)
console.log(`${before.length} → ${after.length} 字节（${pct}%，省 ${saved} MiB）`)
if (after.length >= before.length) {
  console.log('⚠️ 没有变小 —— 这个包本来就压过了，别换。')
  process.exitCode = 1
}
