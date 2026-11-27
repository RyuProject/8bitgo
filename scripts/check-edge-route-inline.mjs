import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EDGE_ROUTE_INLINE_OPEN } from './lib/edge-route-inline.mjs'

const source = readFileSync(new URL('../public/edge-route-v6.js', import.meta.url), 'utf8').trimEnd()
const html = readFileSync(new URL('../dist/client/index.html', import.meta.url), 'utf8')
const closeTag = '\n</script>'
const openAt = html.indexOf(EDGE_ROUTE_INLINE_OPEN)

assert.notEqual(openAt, -1, '构建产物必须包含带 Rocket Loader 退出标记的内联选路脚本')
const bodyAt = openAt + EDGE_ROUTE_INLINE_OPEN.length
const closeAt = html.indexOf(closeTag, bodyAt)
assert.notEqual(closeAt, -1, '内联选路脚本必须有闭合标签')
assert.equal(html.slice(bodyAt, closeAt), source, '内联选路脚本必须与 public/edge-route-v6.js 逐字一致')
assert.equal((html.match(/data-8bitgo-edge-route="v6"/g) || []).length, 1, '选路脚本只能内联一次')
assert.ok(!html.includes('data-8bitgo-edge-route-placeholder'), '构建产物不能留下占位符')
assert.equal((html.match(/<!-- 8bitgo-ssr-head -->/g) || []).length, 1, '构建模板必须保留唯一 SSR head 插入点')
assert.ok(!/<script[^>]+src="\/edge-route-v6\.js"/.test(html), '当前 HTML 不应再请求独立的同步选路脚本')
assert.ok(!/<link[^>]+rel="preload"[^>]+edge-route-v6\.js/.test(html), '选路脚本内联后不应保留无效预载')
assert.ok(openAt < html.indexOf("var CODES = ['zh-Hans'"), '边缘选路必须先于语言跳转脚本')

console.log('✅ 构建产物内联选路脚本与自托管源文件一致，执行顺序正确')
