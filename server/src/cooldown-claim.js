/**
 * 跨进程的告警冷却锁。
 *
 * 不直接相信 mysql2 的 affectedRows：连接启用 CLIENT_FOUND_ROWS 时，即使条件更新保留了旧值，
 * 驱动也可能报「找到一行」。2026-11 的聚集报警因此在冷却期内反复发消息。候选值附带随机令牌，
 * UPSERT 后再读回；只有库中正好是自己的候选值才算真的抢到锁。
 */
import { randomUUID } from 'node:crypto'

export async function claimCooldown(run, namespace, key, now, cooldownMs) {
  const name = `${namespace}.${key}`
  const stamp = Math.trunc(Number(now))
  const value = `${stamp}:${randomUUID()}`
  await run(
    `INSERT INTO site_settings (name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = IF(CAST(value AS UNSIGNED) <= ?, VALUES(value), value)`,
    [name, value, stamp - Math.trunc(Number(cooldownMs))],
  )
  const rows = await run('SELECT value FROM site_settings WHERE name = ? LIMIT 1', [name])
  return rows?.[0]?.value === value ? { name, value } : null
}

/** 发送失败或全局限额挡住时，只删除本次自己写入的锁，不碰并发请求的新锁。 */
export async function releaseCooldownClaim(run, claim) {
  if (!claim) return
  await run('DELETE FROM site_settings WHERE name = ? AND value = ?', [claim.name, claim.value])
}
