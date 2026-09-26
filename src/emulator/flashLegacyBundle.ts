/**
 * 少数 Flash 游戏把旧发行商 SDK 当成运行时依赖，主 SWF 并不是完整游戏。
 *
 * 《森林冰火人 4》会先向 Configar 取 XML，再加载 Spil 的 BrandSystem / ServicePack。
 * 这些十多年前的 HTTP 地址如今既不稳定，也会被 HTTPS 页面拦截；只让请求失败虽然能看到
 * 主菜单，但教程层随后会每帧调用一个未初始化的 BrandingManager，持续抛 TypeError #1010。
 *
 * 后台应上传项目产出的多 SWF zip。它保留 Flashpoint 里的域名目录结构；这里仅对这款游戏
 * 或已取证的主文件摘要，把旧绝对地址改写到主 SWF 同目录。其它 Flash 不会吃到这些规则。
 */

export type FlashUrlRewriteRule = [string | RegExp, string]

const CRYSTAL_TEMPLE_SLUG = 'fireboy-watergirl-4-in-the-crystal-temple'
const CRYSTAL_TEMPLE_BYTES = 4_485_060
const CRYSTAL_TEMPLE_SHA256 = '2c4d050191e36179fb936d49ae591f3b14821b2daf51b4621a55a67789f4bc9a'
const CONFIG_ID = 'f3eea80c7627f4ee2b907453156f4fb1'

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isKnownCrystalTemple(bytes: number, sha256: string, gameSlug?: string): boolean {
  return gameSlug === CRYSTAL_TEMPLE_SLUG
    || (bytes === CRYSTAL_TEMPLE_BYTES && sha256.toLowerCase() === CRYSTAL_TEMPLE_SHA256)
}

/** 纯函数导出给回归测试；规则里保留 RegExp，不能先序列化成字符串。 */
export function flashLegacyBundleRulesForFingerprint({
  bytes,
  sha256,
  gameSlug,
  bundleBaseUrl,
}: {
  bytes: number
  sha256: string
  gameSlug?: string
  bundleBaseUrl: string
}): FlashUrlRewriteRule[] {
  if (!isKnownCrystalTemple(bytes, sha256, gameSlug)) return []

  let base: URL
  try {
    base = new URL(bundleBaseUrl)
  } catch {
    return []
  }

  const local = (path: string) => new URL(path, base).href
  return [
    [
      new RegExp(`^https?://api\\.configar\\.org/cf/pb/1/settings/0/0/${CONFIG_ID}(?:\\?.*)?$`, 'i'),
      local(`api.configar.org/cf/pb/1/settings/0/0/${CONFIG_ID}`),
    ],
    [
      /^https?:\/\/files\.cdn\.spilcloud\.com\/flashapi_1_3_1_147\/(ServicesConnection|BrandSystem|ServicePack)\.swf(?:\?.*)?$/i,
      local('files.cdn.spilcloud.com/flashapi_1_3_1_147/$1.swf'),
    ],
    [
      /^https?:\/\/files\.cdn\.spilcloud\.com\/flashapi_assets\/logos\/(a10\.com\.swf)(?:\?.*)?$/i,
      local('files.cdn.spilcloud.com/flashapi_assets/logos/$1'),
    ],
    [
      /^https?:\/\/www8\.agame\.com\/sdk\/spilapi\/localization\/(BrandLocalization\.swf)(?:\?.*)?$/i,
      local('www8.agame.com/sdk/spilapi/localization/$1'),
    ],
    // 分数与埋点服务不参与玩法。离线包返回一个空的 200，比每局继续访问失效域名更安静可靠。
    [/^https?:\/\/api\.configar\.org\/cf\/pb\/1\/high\/.*$/i, local('_offline/empty.txt')],
    [/^https?:\/\/logs\.spilgames\.com\/.*$/i, local('_offline/empty.txt')],
  ]
}

/**
 * 只有字节数吻合时才散列本地文件；详情页有稳定 slug 时直接识别，不为每款 Flash 扫全文件。
 */
export async function flashLegacyBundleRules(
  data: ArrayBuffer,
  gameSlug: string | undefined,
  bundleBaseUrl: string | null,
): Promise<FlashUrlRewriteRule[]> {
  if (!bundleBaseUrl) return []
  if (gameSlug === CRYSTAL_TEMPLE_SLUG) {
    return flashLegacyBundleRulesForFingerprint({ bytes: data.byteLength, sha256: '', gameSlug, bundleBaseUrl })
  }
  if (data.byteLength !== CRYSTAL_TEMPLE_BYTES || !globalThis.crypto?.subtle) return []
  const sha256 = hex(await globalThis.crypto.subtle.digest('SHA-256', data))
  return flashLegacyBundleRulesForFingerprint({ bytes: data.byteLength, sha256, gameSlug, bundleBaseUrl })
}
