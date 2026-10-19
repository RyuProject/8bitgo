#!/usr/bin/env node

/**
 * 只在公开 Sockdrive 的元数据与热点清单都能读取后才更新游戏。
 * 上传和绑定分开，目的不是多一步操作，而是让一次中断最多留下“没人引用的完整资源”，
 * 绝不会让玩家命中只传了一半的磁盘。
 */
import { pathToFileURL } from 'node:url'
import { isVersionedSockdriveDirectory } from '../shared/sockdrive-url.js'

const argFrom = (argv, name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : ''
}

const jsonOrError = async (response, label) => {
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`${label} 返回的不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`${label}失败：${data?.error || `HTTP ${response.status}`}`)
  return data
}

export async function bindSockdriveGame({
  slug,
  prefix,
  lang = '',
  publicBase = 'https://assets.8bitgo.com',
  apiBase = 'https://8bitgo.com',
  token = '',
  dryRun = false,
  fetchImpl = fetch,
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error('游戏 slug 不合法')
  const cleanLang = String(lang).trim()
  if (cleanLang && !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(cleanLang)) throw new Error('语言代码不合法')
  const cleanPrefix = String(prefix).trim().replace(/^\/+|\/+$/g, '')
  if (!isVersionedSockdriveDirectory(cleanPrefix)) throw new Error('Sockdrive 目录必须带版本号或内容哈希')

  const publicRoot = /^https?:\/\//i.test(cleanPrefix)
    ? cleanPrefix
    : new URL(cleanPrefix, `${publicBase.replace(/\/+$/, '')}/`).toString().replace(/\/+$/, '')
  const stamp = Date.now()
  const metadata = await jsonOrError(
    await fetchImpl(`${publicRoot}/sockdrive.metaj?bind-check=${stamp}`, { cache: 'no-store' }),
    '读取公开 sockdrive.metaj',
  )
  if (!Number.isSafeInteger(metadata.range_count) || metadata.range_count <= 0) {
    throw new Error('公开 sockdrive.metaj 的 range_count 无效')
  }
  const profile = await jsonOrError(
    await fetchImpl(`${publicRoot}/preload_ranges.metaj?bind-check=${stamp}`, { cache: 'no-store' }),
    '读取公开 preload_ranges.metaj',
  )
  if (!Array.isArray(profile) || profile.some((range) => !Number.isSafeInteger(range) || range < 0 || range >= metadata.range_count)) {
    throw new Error('公开 preload_ranges.metaj 含越界范围')
  }

  const cleanApi = apiBase.replace(/\/+$/, '')
  const gameUrl = `${cleanApi}/api/games/${encodeURIComponent(slug)}`
  const current = await jsonOrError(await fetchImpl(gameUrl, { cache: 'no-store' }), '读取游戏配置')
  if (current.platform !== 'dos' || current.dosBackend !== 'dosboxX') {
    throw new Error('目标游戏不是 DOSBox-X 游戏；普通 DOSBox 不支持 Sockdrive')
  }
  if (!current.dosExecutable && !Object.keys(current.dosExecutables ?? {}).length) {
    throw new Error('目标游戏没有配置流式盘内的启动 EXE')
  }
  if (cleanLang && !Object.prototype.hasOwnProperty.call(current.roms ?? {}, cleanLang)) {
    throw new Error(`目标游戏没有 ${cleanLang} 语言 ROM 槽`)
  }
  const currentSockdrive = cleanLang ? current.dosSockdrives?.[cleanLang] : current.dosSockdrive
  if (currentSockdrive === cleanPrefix || currentSockdrive === publicRoot) {
    return { changed: false, publicRoot, game: current }
  }
  if (dryRun) return { changed: false, dryRun: true, publicRoot, game: current }
  if (!token) throw new Error('绑定需要环境变量 EIGHTBITGO_ADMIN_JWT；不要把令牌写进命令行历史')

  // PATCH 只要带 dosSockdrives 就会重写整张语言关联表；必须把其它语言原样带回，
  // 否则修英文盘会静默清空中文/日文盘。游戏级绑定则保持旧接口形状。
  const patch = cleanLang
    ? { dosSockdrives: { ...(current.dosSockdrives ?? {}), [cleanLang]: cleanPrefix } }
    : { dosSockdrive: cleanPrefix }
  const saved = await jsonOrError(
    await fetchImpl(gameUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    }),
    '绑定游戏 Sockdrive',
  )
  const savedSockdrive = cleanLang ? saved.dosSockdrives?.[cleanLang] : saved.dosSockdrive
  if (savedSockdrive !== cleanPrefix) {
    throw new Error(`服务端返回成功，但 ${cleanLang ? `${cleanLang} 语言槽` : 'dosSockdrive'} 没有保存成目标目录`)
  }
  return { changed: true, publicRoot, game: saved }
}

async function main(argv = process.argv.slice(2)) {
  const slug = argFrom(argv, 'slug')
  const prefix = argFrom(argv, 'prefix')
  if (!slug || !prefix) {
    console.error(
      '用法：npm run sockdrive:bind -- --slug starcraft --prefix sockdrives/starcraft-v1 [--lang en] ' +
        '[--api-base https://8bitgo.com] [--public-base https://assets.8bitgo.com] [--dry-run]',
    )
    process.exit(2)
  }
  const result = await bindSockdriveGame({
    slug,
    prefix,
    lang: argFrom(argv, 'lang'),
    apiBase: argFrom(argv, 'api-base') || 'https://8bitgo.com',
    publicBase: argFrom(argv, 'public-base') || 'https://assets.8bitgo.com',
    token: process.env.EIGHTBITGO_ADMIN_JWT || '',
    dryRun: argv.includes('--dry-run'),
  })
  if (result.dryRun) console.log(`✔ 绑定预检通过：${slug} → ${prefix}`)
  else if (result.changed) console.log(`✔ 已绑定：${slug} → ${prefix}`)
  else console.log(`✔ 已经绑定，无需重复更新：${slug} → ${prefix}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
