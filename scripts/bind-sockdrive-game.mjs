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
  publicBase = 'https://assets.8bitgo.com',
  apiBase = 'https://8bitgo.com',
  token = '',
  dryRun = false,
  fetchImpl = fetch,
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error('游戏 slug 不合法')
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
  if (current.platform !== 'dos' || current.dosBackend !== 'dosboxX' || !current.dosSystem) {
    throw new Error('目标游戏不是已配置共享 Windows 系统镜像的 DOSBox-X 游戏')
  }
  if (!current.dosExecutable && !Object.keys(current.dosExecutables ?? {}).length) {
    throw new Error('目标游戏没有配置流式盘内的启动 EXE')
  }
  if (current.dosSockdrive === cleanPrefix || current.dosSockdrive === publicRoot) {
    return { changed: false, publicRoot, game: current }
  }
  if (dryRun) return { changed: false, dryRun: true, publicRoot, game: current }
  if (!token) throw new Error('绑定需要环境变量 EIGHTBITGO_ADMIN_JWT；不要把令牌写进命令行历史')

  const saved = await jsonOrError(
    await fetchImpl(gameUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dosSockdrive: cleanPrefix }),
    }),
    '绑定游戏 Sockdrive',
  )
  if (saved.dosSockdrive !== cleanPrefix) throw new Error('服务端返回成功，但 dosSockdrive 没有保存成目标目录')
  return { changed: true, publicRoot, game: saved }
}

async function main(argv = process.argv.slice(2)) {
  const slug = argFrom(argv, 'slug')
  const prefix = argFrom(argv, 'prefix')
  if (!slug || !prefix) {
    console.error(
      '用法：npm run sockdrive:bind -- --slug starcraft --prefix sockdrives/starcraft-v1 ' +
        '[--api-base https://8bitgo.com] [--public-base https://assets.8bitgo.com] [--dry-run]',
    )
    process.exit(2)
  }
  const result = await bindSockdriveGame({
    slug,
    prefix,
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
