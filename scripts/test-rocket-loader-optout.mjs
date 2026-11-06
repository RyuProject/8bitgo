#!/usr/bin/env node
/**
 * Cloudflare Rocket Loader 退出标记（shared/rocket-loader-optout.js）。
 *
 * 2026-11-06《铁拳》详情页：区域开着 Rocket Loader，所有 <script> 被推迟到 window load 之后，
 * React 晚开跑 3 秒多。这里核对：模板 / SSR 注水 / 构建插件都带 data-cfasync="false"，
 * 并且大陆入口改写、Early Hints 这两个按标签解析 HTML 的地方没有被新属性打断。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { optOutRocketLoader, ROCKET_LOADER_OPT_OUT } from '../shared/rocket-loader-optout.js'
import { retargetStaticToCnEdge } from '../shared/cover-cdn-hint.js'
import { earlyHintLinks } from '../server/src/early-hints.js'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ❌ ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

const TEMPLATE = `<!doctype html><html><head>
<script src="/edge-route-v2.js"></script>
<script>window.a=1</script>
<script type="module" crossorigin src="/assets/index-AAAA.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-BBBB.css">
<script type="application/ld+json">{"@type":"VideoGame"}</script>
<script nomodule crossorigin id="vite-legacy-entry" data-src="/assets/index-legacy-CCCC.js">System.import(this.getAttribute('data-src'))</script>
</head><body><div id="root"></div></body></html>`

check('每个可执行脚本都带 data-cfasync="false"，JSON-LD 不碰', () => {
  const out = optOutRocketLoader(TEMPLATE)
  const scripts = [...out.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
  assert.equal(scripts.length, 5)
  for (const tag of scripts) {
    if (tag.includes('ld+json')) assert.doesNotMatch(tag, /cfasync/, tag)
    else assert.match(tag, /data-cfasync="false"/, tag)
  }
})

check('幂等：已有退出标记（包括手写的）不会重复加', () => {
  const once = optOutRocketLoader(TEMPLATE)
  assert.equal(optOutRocketLoader(once), once)
  assert.equal(optOutRocketLoader('<script data-cfasync="true">x</script>'), '<script data-cfasync="true">x</script>')
})

check('大陆入口改写仍能给入口脚本挂上回源 onerror', () => {
  const out = retargetStaticToCnEdge(optOutRocketLoader(TEMPLATE), 'https://cn.8bitgo.com')
  assert.match(out, /<script data-cfasync="false" type="module" crossorigin src="https:\/\/cn\.8bitgo\.com\/_cn\/assets\/index-AAAA\.js" onerror="/)
})

check('Early Hints 仍能认出入口模块脚本', () => {
  const links = earlyHintLinks(optOutRocketLoader(TEMPLATE))
  assert.match(links, /<\/assets\/index-AAAA\.js>; rel=preload; as=script; crossorigin/)
})

check('构建插件排在 legacy() 之后的 post 阶段；SSR 模板与注水脚本都带标记', () => {
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  const legacyAt = vite.indexOf('legacy({')
  const pluginAt = vite.indexOf("name: 'rocket-loader-optout'")
  assert.ok(legacyAt > 0 && pluginAt > legacyAt, '插件必须在 legacy() 之后，才能覆盖它注入的 nomodule 脚本')
  assert.match(vite.slice(pluginAt, pluginAt + 300), /order: 'post'[\s\S]*optOutRocketLoader\(html\)/)
  const ssr = readFileSync(new URL('../server/src/ssr.js', import.meta.url), 'utf8')
  assert.match(ssr, /<script \$\{ROCKET_LOADER_OPT_OUT\}>window\.__8BITGO__=/)
  assert.equal((ssr.match(/template = optOutRocketLoader\(readFileSync\(TEMPLATE, 'utf8'\)\)/g) || []).length, 2)
  assert.equal(ROCKET_LOADER_OPT_OUT, 'data-cfasync="false"')
})

if (failed) {
  console.log(`\n❌ ${failed} 项失败`)
  process.exit(1)
}
console.log('\nRocket Loader 退出标记回归通过')
