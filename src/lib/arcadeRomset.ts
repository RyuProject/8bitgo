/**
 * 街机 ROM 自动识别：从压缩包认出它到底是哪个 romset。
 *
 * ── 要解决的问题 ─────────────────────────────────────────────
 * 街机核心（FBNeo / MAME 系）**靠压缩包的文件名认游戏**。叫 kof97.zip 才会去跑
 * kof97 那个驱动；叫 the-king-of-fighters-97-(ngh-2320).zip，核心就一句
 * 「Romset is unknown」，和包里内容对不对毫无关系。
 *
 * 而管理员手里的文件名千奇百怪，人肉去记 8000 多个 romset 的短名不现实。
 *
 * ── 怎么认出来的 ─────────────────────────────────────────────
 * **答案就藏在包里**：zip 的中央目录里每个成员都带着 CRC-32，不用解压就能读
 *（见 lib/unzip.ts 的 crc32 字段）。拿这些 CRC 去比 FBNeo 的驱动表就行了。
 *
 * 索引是 public/arcade-romsets.bin，由 scripts/build-arcade-romsets.mjs 从
 * FBNeo 源码生成，8721 个 romset / 12 万条 CRC。**只在后台按需加载**，
 * 玩家端一个字节都不会下。
 *
 * ── 为什么要算「覆盖率」而不是命中数就完事 ───────────────────
 * 克隆集和父集共享绝大多数 ROM，kof97 和 kof97h 只差一个。光看命中数，
 * 一个只有 1 个 ROM 的杂鱼 romset 只要蒙对一发也能排到前面。所以：
 *
 *   命中数 matched  —— 主排序，谁被这个包解释得最多
 *   覆盖率 coverage —— 平手时的裁决：matched / 该 romset 的成员总数
 *
 * 真实数据实测（用户的 kof97.zip，13 个成员）：
 *   kof97    13/13 覆盖 100%   ← 赢
 *   kof97h   12/13 覆盖  92%
 *   kof97k   12/13 覆盖  92%
 *
 * 只有 coverage === 1（这个 romset 的成员在包里一个不缺）才算「完全命中」，
 * 也只有完全命中才允许自动改名 —— 差一个 ROM 的包改成父集的名字，
 * 换来的是「missing files」，比不改还糟。
 */

import { matchArcadeHack, type ArcadeHack } from '@/data/arcadeHacks'

export interface RomsetCandidate {
  /** romset 短名，也就是压缩包该叫的名字（不含 .zip） */
  name: string
  /** 父集短名；空串表示它自己就是父集 */
  parent: string
  /** 需要的 BIOS 包名（Neo Geo 系是 neogeo）；空串表示不需要 BIOS */
  bios: string
  /** 包里有多少个成员属于这个 romset */
  matched: number
  /** 这个 romset 一共有多少个成员 */
  total: number
  /** matched / total。1 表示这个 romset 的成员一个不缺 */
  coverage: number
}

export interface RomsetIdentification {
  /**
   * 命中的已知改版包（见 data/arcadeHacks.ts）。有值时它就是答案，
   * 下面的 candidates 只作参考 —— 改版包的身份由指纹确定，不由「像谁」确定。
   */
  hack: ArcadeHack | null
  /** 按可信度排序的候选，最多几条 */
  candidates: RomsetCandidate[]
  /**
   * 可以放心自动改名的那一个。满足两个条件才有值：
   * 覆盖率 100%，且没有第二个命中数一样多的候选（不存在歧义）。
   */
  confident: RomsetCandidate | null
}

interface RomsetIndex {
  sets: { name: string; parent: string; bios: string }[]
  /** 每个 romset 的成员总数 */
  totals: Uint16Array
  /** CRC -> 含有它的 romset 下标（一个 CRC 可能属于多个，克隆集就是这么来的） */
  byCrc: Map<number, number[]>
}

let cache: RomsetIndex | null = null
let inflight: Promise<RomsetIndex | null> | null = null

/** 索引文件的地址。放 public/ 下，构建时原样进 dist */
const INDEX_URL = `${import.meta.env.BASE_URL || '/'}arcade-romsets.bin`.replace(/\/{2,}/g, '/')

function parseIndex(buf: ArrayBuffer): RomsetIndex {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)
  if (b[0] !== 0x38 || b[1] !== 0x42 || b[2] !== 0x52 || b[3] !== 0x53) throw new Error('romset 索引:魔数不对')
  if (b[4] !== 1) throw new Error(`romset 索引:不认识的格式版本 ${b[4]}`)

  const setCount = dv.getUint32(8, true)
  const namesLen = dv.getUint32(12, true)
  const pairCount = dv.getUint32(16, true)

  const sets = new TextDecoder()
    .decode(b.subarray(20, 20 + namesLen))
    .split('\n')
    .map((line) => {
      const [name, parent, bios] = line.split('\t')
      return { name, parent: parent || '', bios: bios || '' }
    })
  if (sets.length !== setCount) throw new Error('romset 索引:名字表条数对不上')

  // 主体是 (CRC 增量, romset 下标) 的 varint 对，按 CRC 升序。
  // 增量编码是为了压体积：CRC 本身是随机数，gzip 拿它没辙，排序后存增量能省一半。
  const totals = new Uint16Array(setCount)
  const byCrc = new Map<number, number[]>()
  let o = 20 + namesLen
  let prev = 0
  const readVarint = () => {
    let r = 0
    let shift = 0
    let byte = 0
    do {
      byte = b[o++]
      r |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return r >>> 0
  }
  for (let i = 0; i < pairCount; i++) {
    const crc = (prev + readVarint()) >>> 0
    prev = crc
    const id = readVarint()
    const list = byCrc.get(crc)
    if (list) list.push(id)
    else byCrc.set(crc, [id])
    totals[id]++
  }
  return { sets, totals, byCrc }
}

/**
 * 载入索引（约 600KB）。只在后台真的要识别时才拉，且只拉一次。
 * 拉不到就返回 null —— 识别只是锦上添花，不该把上传流程搞挂。
 */
export function loadRomsetIndex(): Promise<RomsetIndex | null> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = fetch(INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.arrayBuffer()
    })
    .then((buf) => {
      cache = parseIndex(buf)
      return cache
    })
    .catch((e) => {
      console.warn('[romset] 索引加载失败，跳过自动识别：', e)
      return null
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 拿一组 CRC 去比对索引，返回排好序的候选 */
export function matchRomset(index: RomsetIndex, crcs: number[]): RomsetIdentification {
  /**
   * 先查已知改版包。
   *
   * 顺序很关键：改版包换掉两三个 ROM，剩下几十个还和各个克隆集共用，覆盖率那套
   * 一定会挑一个碰巧多命中几个的克隆集报出来（吞食天地II 的中文版被判成
   * 「最接近 wofch 19/29」就是这么来的），而那个方向从一开始就是错的。
   * 指纹撞上了就没有猜的必要。
   */
  const hack = matchArcadeHack(crcs)

  const tally = new Map<number, number>()
  for (const crc of crcs) {
    for (const id of index.byCrc.get(crc >>> 0) ?? []) tally.set(id, (tally.get(id) ?? 0) + 1)
  }

  const candidates: RomsetCandidate[] = [...tally]
    .map(([id, matched]) => {
      const total = index.totals[id] || 1
      return { ...index.sets[id], matched, total, coverage: matched / total }
    })
    // 先比命中数（谁被这个包解释得最多），平手再比覆盖率（谁被填满了）
    .sort((a, b) => b.matched - a.matched || b.coverage - a.coverage || a.name.localeCompare(b.name))
    .slice(0, 5)

  const top = candidates[0]
  // 有歧义（另一个候选命中数一样多且也是满覆盖）时不给「确信」结论，交给人判断
  const ambiguous = candidates.some((c, i) => i > 0 && c.matched === top?.matched && c.coverage === 1)
  // 命中改版包时不给 confident：那条路的「自动改名」是按 romset 短名来的，
  // 而改版包要改成 hack.zipName，两回事，交给上层按 hack 处理
  const confident = !hack && top && top.coverage === 1 && !ambiguous ? top : null
  return { hack, candidates, confident }
}

/**
 * 一步到位：给一个 zip 的成员列表，认出它是哪个 romset。
 *
 * @param entries lib/unzip.ts 的 listZipEntries() 结果，只用到 crc32
 * @returns 索引加载不出来或包里一个 CRC 都对不上时返回 null
 */
export async function identifyArcadeRomset(entries: { crc32: number }[]): Promise<RomsetIdentification | null> {
  const crcs = entries.map((e) => e.crc32).filter((c) => c > 0)
  if (!crcs.length) return null

  /**
   * 指纹表是本地常量，不用等那 600KB 的索引。
   * 所以先查一遍：索引拉不下来（离线、反代挂了）也照样认得出已知改版包，
   * 而改版包恰恰是最需要认出来的那一类 —— 认不出玩家就只能对着
   * 「Romset is unknown」干瞪眼。
   */
  const hack = matchArcadeHack(crcs)

  const index = await loadRomsetIndex()
  if (!index) return hack ? { hack, candidates: [], confident: null } : null
  const result = matchRomset(index, crcs)
  return result.hack || result.candidates.length ? result : null
}
