/*
 * Sockdrive 的浏览器缓存键不是内容哈希，而是目录 URL。目录若没有显式代次，原地替换后
 * js-dos 会把旧 OPFS 扇区和新磁盘混在一起；这比普通缓存陈旧更严重，会直接损坏客体文件系统。
 *
 * 这里只认最后一个目录段：`game-v2`、`game-20261013`、`game-deadbeef` 都可以；
 * 父目录里碰巧出现 v1 不能替最末目录“担保”，否则 `sockdrives/v1/game` 仍能被原地覆盖。
 */
const SOCKDRIVE_VERSION_SUFFIX = /(?:^|[-_.])(?:v\d+(?:[-_.][a-z0-9]+)*|[a-f0-9]{8,64})$/i

export function isVersionedSockdriveDirectory(value) {
  const clean = String(value ?? '').trim().replace(/\/+$/, '').split(/[?#]/, 1)[0]
  const segment = clean.slice(clean.lastIndexOf('/') + 1)
  return Boolean(segment && SOCKDRIVE_VERSION_SUFFIX.test(segment))
}
