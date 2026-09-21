/**
 * 普查：「按语言切换 ROM」里，各语言槽装的到底是不是不同的 ROM。
 *
 *   node scripts/audit-rom-langs.mjs [--api https://8bitgo.com] [--rom https://assets.8bitgo.com] [--json]
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 玩家反馈（2026-09-21）：「Pokémon 几乎只有日文，虽然有切换语言的选项，但选了也没变化」。
 *
 * 查下来是**数据**问题，不是切换逻辑的问题：那些 `<slug>.<lang>.gba.8bg`
 * 其实都是**同一份 ROM 被重复打包了 8 遍**（8BG 头里的 originalName 全都写着
 * `pokemon-emerald.zh-Hans.gba`）。`romCandidates()` 老老实实按语言取了不同的 key，
 * 只是每个 key 背后的字节一模一样 —— 于是切换器给了八种语言，加载的永远是同一份。
 *
 * 这种错误**从界面上完全看不出来**（key 名、文件大小、后台「已绑定」全对），
 * 所以只能拿内容说话。
 *
 * ── 判据：8BG 头里的分块摘要 ─────────────────────────────────
 * 8BG 头带原始文件名 `originalName`，以及每块的 `sha256` —— 那个摘要是**算在明文上**的
 * （见 scripts/pack-rom.mjs：`createHash('sha256').update(source)`），
 * 所以「所有块的摘要逐一相同」＝两份文件解密后**逐字节相同**，不需要密钥。
 * （nonce 是每文件随机的，密文没法比；块摘要可以，这也是这个普查能纯前端跑的原因。）
 *
 * 只读前 1MB：头 + 分块表都在最前面，正文不用下。
 *
 * 退出码：发现「同一款游戏里多个语言槽内容相同」时为 1，否则 0。
 */
import { setTimeout as sleep } from 'node:timers/promises'

/** `--name value` 和 `--name=value` 都认 */
const arg = (name, fallback) => {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}
const API = arg('api', 'https://8bitgo.com').replace(/\/+$/, '')
const ROM = arg('rom', 'https://assets.8bitgo.com').replace(/\/+$/, '')
const AS_JSON = process.argv.includes('--json')
/** 逐份解密读语言码（每组一次整包下载，慢）—— 只有 gb/gbc/gba 读得出来 */
const DEEP = process.argv.includes('--deep')
/** 只看一款（清理时对着单款用） */
const ONLY = arg('slug', '')
/** 并发别调太高：这一趟要打几百个 GET，礼貌一点 */
const CONCURRENCY = Number(arg('concurrency', 6))

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

/** 读一个 8BG 的头（只取前 1MB） */
async function readPackHeader(key) {
  const url = `${ROM}/${key}`
  const res = await fetch(url, { headers: { Range: 'bytes=0-1048575' } })
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  const magic = new TextDecoder().decode(buf.subarray(0, 4))
  if (magic !== '8BG1') throw new Error(`不是 8BG 容器（前四字节 ${JSON.stringify(magic)}）`)
  const jsonLen = new DataView(buf.buffer, buf.byteOffset).getUint32(4, true)
  if (8 + jsonLen > buf.byteLength) throw new Error('头没读全（分块表比 1MB 还长？）')
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + jsonLen)))
  return header
}

/**
 * 内容的指纹：原文大小 + 每块明文 sha256（逐块比，不用密钥；块摘要算在明文上）。
 * 两份文件指纹相同 ⇔ 解密后逐字节相同。
 */
function contentSignature(header) {
  const chunks = Array.isArray(header.chunks) ? header.chunks : []
  return `${header.originalSize}:${chunks.map((c) => c?.sha256 ?? '?').join(',')}`
}

/* ─────────── --deep：这份 ROM 到底是什么语言 ─────────── */

/**
 * `--deep` 才有：解密**一组内容的代表文件**的第一块，读 ROM 头里的地区/语言标记。
 *
 * 为什么值得：`originalName` 只是打包时的文件名，**它经常是假的** ——
 * 实测 `pokemon-emerald.ja.gba.8bg` 里面装的是 `BPEE`（美版英文），
 * 而 `originalName` 写着 `pokemon-emerald.zh-Hans.gba`。清理时得知道真身是哪一份。
 *
 * 密钥从 `/api/rom-pack/key` 取（浏览器解包用的同一个公开接口）。
 * 只有 GB / GBC / GBA 的头里有地区码；别的平台直接说读不出来，不猜。
 * 需要 Node ≥ 22.15（zlib.zstdDecompressSync）—— 老版本会自动跳过这一段。
 */
async function readRomLanguage(key, platform) {
  if (!['gb', 'gbc', 'gba'].includes(platform)) return '(这个平台的头里没有语言标记，不猜)'
  const zstd = await import('node:zlib').then((m) => m.zstdDecompressSync).catch(() => null)
  if (!zstd) return '(当前 Node 没有 zstd，跳过)'
  const { createDecipheriv } = await import('node:crypto')
  const { romPackIv, romPackAad, parseRomPackHeader } = await import('../shared/rom-pack-format.js')
  const all = new Uint8Array(await (await fetch(`${ROM}/${key}`)).arrayBuffer())
  const { header, dataOffset } = parseRomPackHeader(all)
  const res = await fetch(`${API}/api/rom-pack/key?packageId=${header.packageId}&keyId=${header.keyId}`)
  const { key: rawKey } = await res.json()
  const size = header.chunks[0].cipherSize
  const body = all.subarray(dataOffset, dataOffset + size)
  const decipher = createDecipheriv('aes-256-gcm', base64UrlToBytes(rawKey), romPackIv(header, 0))
  decipher.setAAD(romPackAad(header, 0))
  decipher.setAuthTag(body.subarray(size - 16))
  const plain = zstd(Buffer.concat([decipher.update(body.subarray(0, size - 16)), decipher.final()]))
  if (platform === 'gba') {
    const code = plain.subarray(0xac, 0xb0).toString('latin1')
    const byRegion = { J: '日版', E: '美版（英）', F: '法版', D: '德版', S: '西版', I: '意版', P: '欧版（多语）' }
    return `游戏码 ${code} → ${byRegion[code[3]] ?? `未收录的区码 ${code[3]}`}`
  }
  const dest = plain[0x14a]
  const title = plain.subarray(0x134, 0x143).toString('latin1').replace(/\0+$/, '')
  return `标题 ${JSON.stringify(title)} → ${dest === 0 ? '日版' : dest === 1 ? '海外版' : `destination=${dest}`}`
}

function base64UrlToBytes(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

async function mapLimit(items, limit, fn) {
  const out = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at], at)
    }
  })
  await Promise.all(workers)
  return out
}

async function main() {
  /*
    列表接口的每页上限是 MAX_PAGE_SIZE=100（参数名是 pageSize，不是 limit ——
    传 limit 会被当成「没传」而用默认的 24 条，普查就只扫到第一页）。
  */
  const slugs = []
  for (let page = 1; page <= 100; page++) {
    const chunk = await getJson(`${API}/api/games?pageSize=100&page=${page}`)
    const items = chunk.items ?? []
    slugs.push(...items.map((g) => g.slug).filter(Boolean))
    if (page >= (chunk.totalPages ?? 1) || !items.length) break
  }
  console.error(`共 ${slugs.length} 款游戏，开始拉详情…`)

  const details = await mapLimit(slugs, CONCURRENCY, async (slug) => {
    try {
      const data = await getJson(`${API}/api/games/${encodeURIComponent(slug)}`)
      return data.game ?? data
    } catch (e) {
      console.error(`  ! ${slug}: ${e.message}`)
      return null
    }
  })

  const multi = details.filter(
    (g) =>
      g &&
      Object.keys(g.roms ?? {}).filter((l) => String(g.roms[l]).trim()).length > 1 &&
      (!ONLY || g.slug === ONLY),
  )
  console.error(`${multi.length} 款游戏绑了两种以上语言的 ROM，开始查内容…\n`)

  const results = await mapLimit(multi, CONCURRENCY, async (game) => {
    const slots = Object.entries(game.roms).filter(([, key]) => String(key).trim())
    const rows = await mapLimit(slots, 3, async ([lang, key]) => {
      try {
        const header = await readPackHeader(key)
        return { lang, key, name: header.originalName, sig: contentSignature(header) }
      } catch (e) {
        return { lang, key, error: e.message }
      }
    })
    const groups = new Map()
    for (const row of rows) {
      if (row.error || !row.sig) continue
      if (!groups.has(row.sig)) groups.set(row.sig, [])
      groups.get(row.sig).push(row)
    }
    const groupList = [...groups.values()]
    /*
      --deep：每组只解**一份代表**就够了 —— 组内本来就是逐字节相同的。
      每组一次整包下载（GBA 8MB/块），所以它是按需用的，不进默认路径。
    */
    const languages = []
    if (DEEP) {
      for (const group of groupList) {
        const rep = group[0]
        let verdict
        try {
          verdict = await readRomLanguage(rep.key, game.platform)
        } catch (e) {
          verdict = `读取失败：${e.message}`
        }
        languages.push({ langs: group.map((r) => r.lang), originalName: rep.name, key: rep.key, verdict })
      }
    }
    return {
      slug: game.slug,
      title: game.title,
      platform: game.platform,
      slots: slots.length,
      // sig 很长（每块的摘要），不进输出
      rows: rows.map((row) => ({ lang: row.lang, key: row.key, name: row.name, error: row.error })),
      contentGroups: groupList.map((g) => g.map((r) => r.lang)),
      dupGroups: groupList.filter((g) => g.length > 1).map((g) => g.map((r) => r.lang)),
      languages,
    }
  })

  const bad = results.filter((r) => r.dupGroups.length)
  const failed = results.flatMap((r) => r.rows.filter((row) => row.error).map((row) => ({ ...row, slug: r.slug })))

  if (AS_JSON) {
    console.log(JSON.stringify({ total: slugs.length, multi: multi.length, broken: bad, failed }, null, 2))
  } else {
    console.log(`多语言游戏 ${results.length} 款，其中 ${bad.length} 款的多个语言槽内容相同：\n`)
    for (const r of bad) {
      console.log(`✗ ${r.title ?? r.slug}  [${r.platform}]  ${r.slug}`)
      console.log(`    ${r.slots} 个语言槽，按内容分成 ${r.contentGroups.length} 组`)
      for (const g of r.dupGroups) console.log(`      ← 内容完全相同：${g.join(' / ')}`)
      const name = r.rows.find((row) => row.name)?.name
      if (name) console.log(`      内部原名：${name}`)
      if (r.languages?.length) {
        for (const info of r.languages) {
          console.log(`      这份内容的真身（${info.langs.join('/')}）：${info.verdict}`)
        }
      }
      console.log()
    }
    if (failed.length) {
      console.log(`另有 ${failed.length} 个对象读不到头（外链 / 非 8BG / 网络失败），需要人看：`)
      for (const f of failed.slice(0, 20)) console.log(`  ? ${f.slug} ${f.lang} ${f.key} —— ${f.error}`)
    }
  }
  console.error(bad.length ? `发现 ${bad.length} 款受影响` : '没有发现受影响的多语言游戏')
  await sleep(0)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error('普查失败：', e)
  process.exit(2)
})
