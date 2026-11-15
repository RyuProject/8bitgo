/**
 * js-dos 产物「版本号 ↔ 字节」锁（2026-11-15 系统优化 #8）。
 *
 * 为什么不像 EmulatorJS 引擎那样直接按内容取版本：js-dos 是**目录级**换代
 * （public/jsdos/v<JSDOS_ASSET_VERSION>/，一年 immutable），版本号同时写进 DOS 存档元数据的 build 字段，
 * 好几个测试和补丁脚本按它找目录。把目录名改成哈希牵动面太大，换来的只是省掉一次手改。
 *
 * 真正要防的是另一件事：改了 copy-jsdos.mjs 的补丁、忘了换 JSDOS_ASSET_VERSION。
 * copy-jsdos --if-missing 会因为脚本哈希变化重新生成产物，但 URL 不变 —— 已经缓存了一年的浏览器
 * 和 Cloudflare 边缘继续发旧字节，新补丁对老访客静默无效（和 §2.5 引擎那次同一种事故）。
 *
 * 做法：scripts/jsdos-asset-lock.json 记「这个 assetVersion 对应的产物指纹」（提交进 git）。
 * - copy-jsdos 生成新版本号的产物时自动写锁；同一版本号产出不同字节时拒绝改锁；
 * - check-jsdos 构建前核对：同一版本号、指纹不同 → 构建失败，提示去换版本号。
 * 指纹只算带 DOSBox-X 的完整产物（构建用的就是它）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCK_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'jsdos-asset-lock.json')

/** runtime.json 的 files 数组 → 指纹（与顺序、大小、哈希都有关） */
export function filesFingerprint(files) {
  const normalized = [...files].map(({ name, size, sha256 }) => ({ name, size, sha256 })).sort((a, b) => a.name.localeCompare(b.name))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function readLock(file = LOCK_FILE) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @returns {{ ok: true, action: 'match'|'new-version' } | { ok: false, reason: string }}
 * new-version：锁里是别的版本号（刚换过版本），调用方可以写新锁。
 */
export function verifyLock(lock, assetVersion, fingerprint) {
  if (!lock || lock.assetVersion !== assetVersion) return { ok: true, action: 'new-version' }
  if (lock.fingerprint === fingerprint) return { ok: true, action: 'match' }
  return {
    ok: false,
    reason:
      `js-dos 产物变了，但 JSDOS_ASSET_VERSION 仍是 ${assetVersion}：URL 不变，浏览器和边缘会继续发旧字节（缓存一年）。` +
      '请在 src/emulator/paths.ts 把 JSDOS_ASSET_VERSION 的后缀加一，再运行 npm run jsdos（会自动更新 scripts/jsdos-asset-lock.json）',
  }
}

export function writeLock(assetVersion, fingerprint, file = LOCK_FILE) {
  writeFileSync(file, `${JSON.stringify({
    _note: '自动生成（scripts/copy-jsdos.mjs）：这个 assetVersion 对应的产物指纹。换补丁必须换 JSDOS_ASSET_VERSION，见 scripts/lib/jsdos-asset-lock.mjs',
    assetVersion,
    fingerprint,
  }, null, 2)}\n`)
}
