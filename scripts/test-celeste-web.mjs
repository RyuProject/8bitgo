#!/usr/bin/env node

/**
 * `/web/celeste/_framework/*` 代理的回归测试（不联网）。
 *
 * 代理本身是共享代码（server/src/r2-runtime-proxy.js，「上游请求长什么样、响应头怎么给」
 * 已由 test-terraria-web.mjs 用真 HTTP + stub fetch 钉死），这里只钉 celeste 自己的差异面：
 *
 *  1. `celesteFrameworkAsset()` 的类型与缓存策略 —— 上传器直接 import 这个函数，
 *     脚本和线上不可能分叉，所以它错了两处一起错（.wasm0 分片落错类型 → 浏览器拒收）。
 *  2. 路径穿越与非法文件名必须返回 null（唯一防线，`..` 是合法的 `:file` 取值）。
 *  3. 注册表：celeste 必须 isolated（pthread 要 SharedArrayBuffer）。
 */
import assert from 'node:assert/strict'
import { celesteFrameworkAsset } from '../server/src/celeste.js'
import { builtinWebGameFor, BUILTIN_WEB_GAMES } from '../shared/builtin-web-games.js'
import { isolatedEmbedFor } from '../shared/isolated-embeds.js'

const LONG = 'public, max-age=31536000, s-maxage=31536000, immutable'

/* ---------------- 注册表 ---------------- */

assert.equal(builtinWebGameFor('celeste')?.entry, '/web/celeste')
assert.equal(builtinWebGameFor('celeste')?.isolated, true, 'celeste 必须 isolated（.NET WASM pthread 依赖 SharedArrayBuffer）')
assert.equal(isolatedEmbedFor('celeste')?.embed, '/web/celeste', '隔离薄壳必须自动派生出 /play/celeste')
assert.ok(BUILTIN_WEB_GAMES.celeste, 'celeste 必须登记在 BUILTIN_WEB_GAMES')

/* ---------------- celesteFrameworkAsset：类型 ---------------- */

// 唯一的运行时入口（不带内容哈希）走短缓存；改一版就换名，长缓存会让玩家拿到旧清单
const entry = celesteFrameworkAsset('dotnet.js')
assert.equal(entry.contentType, 'text/javascript; charset=utf-8')
assert.match(entry.cacheControl, /max-age=300/, 'dotnet.js 是入口，必须短缓存')
assert.match(entry.url, /web\/celeste\/_framework\/dotnet\.js$/)

// 哈希产物按内容寻址，长缓存
for (const [name, type] of [
  ['System.Private.CoreLib.e845euk8da.dll', 'application/octet-stream'],
  // 分片按 .wasm 归一后拿到 application/wasm：普通 fetch 不校验 MIME，前端拿到的是
  // 原始字节自行拼接，这个类型留着无妨且与整片 wasm 的处理一致
  ['dotnet.native.vwx8rc7ccu.wasm0', 'application/wasm'],
  ['dotnet.native.worker.ratb5i3t1q.mjs', 'text/javascript; charset=utf-8'],
  ['icudt_CJK.tjcz0u77k5.dat', 'application/octet-stream'],
  ['dotnet.native.sadgvw1639.js', 'text/javascript; charset=utf-8'],
]) {
  const asset = celesteFrameworkAsset(name)
  assert.equal(asset.contentType, type, `${name} 的 Content-Type`)
  assert.equal(asset.cacheControl, LONG, `${name} 必须长期缓存`)
  assert.ok(asset.url.endsWith(`/${encodeURIComponent(name)}`), `${name} 的 URL 拼接`)
}

/* ---------------- celesteFrameworkAsset：防线 ---------------- */

for (const bad of ['..', '../dotnet.js', 'a/b', '', '.hidden', '/abs', 'a b', 'x'.repeat(129)]) {
  assert.equal(celesteFrameworkAsset(bad), null, `非法文件名必须被拒：${JSON.stringify(bad)}`)
}
// 正常名字的边界：128 字符可以，带点开头的 ICU 数据名不涉及
assert.ok(celesteFrameworkAsset('a'.repeat(128)), '128 字符以内的正常文件名要放行')

console.log('✔ celeste-web 回归测试通过')
