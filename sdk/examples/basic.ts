/**
 * 最小用法示例（不进 SDK 包体，仅供阅读参考）。
 *
 * 跑起来：在 sdk/ 下 `npm install && npm run build`，然后：
 *   import { BitgoOpenClient } from '@8bitgo/open-sdk'
 */
import { BitgoOpenClient } from '../src/index'

async function main() {
  const client = new BitgoOpenClient({
    baseUrl: process.env.BITGO_BASE_URL ?? 'https://8bitgo.com',
    clientId: process.env.BITGO_CLIENT_ID ?? '',
    clientSecret: process.env.BITGO_CLIENT_SECRET ?? '',
    scopes: ['games.read'],
  })

  // 1) 自省：这枚令牌是谁的、有哪些 scope、何时过期
  const me = await client.token.introspect()
  console.log('app:', me.client_id, '| scopes:', me.scope)

  // 2) 列出 NES 游戏第一页
  const list = await client.games.list({ platform: 'nes', pageSize: 10 })
  console.log(`共 ${list.total} 款，本页 ${list.items.length} 款`)
  for (const g of list.items) {
    console.log(`- ${g.title} (${g.slug}) 封面: ${g.cover ?? '无'}`)
  }

  // 3) 取一款游戏的签名嵌入地址，塞进 iframe
  const embed = await client.games.embed(list.items[0]!.slug)
  console.log('embed url:', embed.url)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
