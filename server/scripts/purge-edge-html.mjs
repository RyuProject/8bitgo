// 部署后清一次 Cloudflare 边缘上的 SSR HTML（页面在边缘缓存一天，不清的话新版前端要等它过期）。
// 读 server/.env 的 CF_ZONE_ID / CF_PURGE_API_TOKEN；没配就什么都不做、正常退出。
import 'dotenv/config'
import { edgePurgeEnabled, purgeHtmlNow } from '../src/edge-purge.js'

if (!edgePurgeEnabled()) {
  console.log('[purge-edge-html] 没配 CF_ZONE_ID / CF_PURGE_API_TOKEN，跳过')
  process.exit(0)
}
try {
  await purgeHtmlNow()
  console.log('[purge-edge-html] 已清除 Cloudflare 边缘 HTML 缓存')
} catch (e) {
  console.error('[purge-edge-html]', e?.message || e)
  process.exit(1)
}
