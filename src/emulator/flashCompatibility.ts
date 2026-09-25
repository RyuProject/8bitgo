/**
 * 已知不能在本站运行的 Flash 发行包。
 *
 * Flash 游戏偶尔会把“站点授权”写进 ActionScript：片头可以正常播放，但随后读取
 * `loaderInfo.loaderURL`，发现当前域名不是发行商域名就主动停在纯黑帧。Ruffle 没有报错，
 * 所以仅靠运行时异常或黑帧检测都分不清“故意停机”和“游戏本来就是黑色画面”。
 *
 * 这里按**完整文件摘要**认已实机取证的坏发行包，不按 `currentDomain` 等字符串猜：正常游戏
 * 也可能读取这些字段，宽泛匹配会误杀。以后换成无站点锁的版本，即使对象 key 没变，摘要
 * 变化后也会自然放行。
 */

export interface FlashCompatibilityIssue {
  kind: 'site-lock'
  message: string
}

interface LockedFlashFingerprint {
  bytes: number
  sha256: string
  issue: FlashCompatibilityIssue
}

const SITE_LOCKED_SWFS: readonly LockedFlashFingerprint[] = [
  {
    bytes: 4_443_526,
    sha256: '2a37d48da5ee69b787c0d255a75c06e4edea6ea41acb2925d016a8a2574a3763',
    issue: {
      kind: 'site-lock',
      message: 'Flash 站点锁：这份 Armor Games 版本只允许在授权域名运行，片头后会主动黑屏；请换用无站点锁的版本',
    },
  },
]

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 纯函数单独导出，回归测试不需要携带 4.2MB 的第三方 SWF。 */
export function flashCompatibilityIssueForFingerprint(bytes: number, sha256: string): FlashCompatibilityIssue | null {
  return SITE_LOCKED_SWFS.find((entry) => entry.bytes === bytes && entry.sha256 === sha256.toLowerCase())?.issue ?? null
}

/**
 * 只在字节数命中已知样本时才算 SHA-256；普通 Flash 不多做一次全文件扫描。
 * Web Crypto 不可用时安静放行：老浏览器仍可玩其它游戏，真正的站点锁版本会维持原行为，
 * 不能为了兼容性检查把整个 Flash 平台挡住。
 */
export async function flashCompatibilityIssue(data: ArrayBuffer): Promise<FlashCompatibilityIssue | null> {
  if (!SITE_LOCKED_SWFS.some((entry) => entry.bytes === data.byteLength)) return null
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = hex(await subtle.digest('SHA-256', data))
  return flashCompatibilityIssueForFingerprint(data.byteLength, digest)
}
