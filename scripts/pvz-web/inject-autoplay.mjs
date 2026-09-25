/*
  把自动加载片段同步进 PvZ 的语言入口页（public/web/PvZ/cn|en/index.html）。

  为什么要有这一层：snippet（autoplay-snippet.html）是**唯一来源**，cn / en 只是它的
  产物（两个文件除了第 7 行的 PVZ_LOCALE / PVZ_MANIFEST_URL 之外完全一致）。
  改了 snippet 就必须重跑本脚本，否则线上跑的还是旧片段 —— 2026-09-23 的版本就是
  因为直接手改了 cn/en 而 snippet 留在旧版，两边悄悄分叉。

  可重入：已有 START/END 哨兵就整体替换，没有就插到 </body> 前。

  用法：
    node scripts/pvz-web/inject-autoplay.mjs            # 同步 cn + en
    node scripts/pvz-web/inject-autoplay.mjs cn         # 只同步指定语言
*/
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SNIPPET = resolve(__dirname, 'autoplay-snippet.html')

const START = '<!-- PvZ_AUTOPLAY_START -->'
const END = '<!-- PvZ_AUTOPLAY_INJECTED -->'
const SHELL_VERSION = '20260924-resume1'

const wanted = process.argv.slice(2)
const LOCALES = wanted.length ? wanted : ['cn', 'en']

const snippet = readFileSync(SNIPPET, 'utf8')
// 哨兵必须成对出现，否则下游（以及下次同步）会剥错位置
if (!snippet.includes(START) || !snippet.includes(END)) {
  console.error('autoplay-snippet.html 缺少 PvZ_AUTOPLAY 哨兵，拒绝注入')
  process.exit(1)
}

function syncRuntimeShell(html) {
  let out = html
  // 原生 preload 会和 Range 下载器并行拉一份完整 wasm，弱网下反而把带宽和流量翻倍。
  out = out.replace('<link rel=preload href=pvz-portable.wasm as=fetch crossorigin>', '')
  if (!out.includes('src=pvz-wasm-loader.js')) {
    out = out.replace(
      '<script>window.moduleReadyPromise=',
      `<script src=pvz-wasm-loader.js?v=${SHELL_VERSION}></script><script>window.moduleReadyPromise=`,
    )
  }
  if (!out.includes('instantiateWasm:window.__pvzInstantiateWasm')) {
    out = out.replace('var Module={canvas:', 'var Module={instantiateWasm:window.__pvzInstantiateWasm,canvas:')
  }
  if (!out.includes('window.moduleReadyPromise.catch(function(){})')) {
    // async 引擎可能在 autoplay 片段挂上错误处理前就失败；先挂空 catch，避免浏览器抛 unhandledrejection。
    out = out.replace('));var Module={', '));window.moduleReadyPromise.catch(function(){});var Module={')
  }
  out = out.replace(/<script src=pvz-page\.js\?v=[^>]+><\/script>/, `<script src=pvz-page.js?v=${SHELL_VERSION}></script>`)
  if (!out.includes(`src=pvz-wasm-loader.js?v=${SHELL_VERSION}`) ||
      !out.includes(`src=pvz-page.js?v=${SHELL_VERSION}`) ||
      !out.includes('instantiateWasm:window.__pvzInstantiateWasm') ||
      !out.includes('window.moduleReadyPromise.catch(function(){})')) {
    throw new Error('PvZ 运行时外壳缺少断点下载器挂载点')
  }
  return out
}

let changed = 0
for (const locale of LOCALES) {
  const target = resolve(ROOT, 'public/web/PvZ', locale, 'index.html')
  let html
  try {
    html = readFileSync(target, 'utf8')
  } catch (e) {
    console.error('读不到 ' + target + '：' + e.message)
    process.exit(1)
  }

  let out
  if (html.includes(START) && html.includes(END)) {
    const i = html.indexOf(START)
    const j = html.indexOf(END)
    out = html.slice(0, i) + snippet + html.slice(j + END.length)
  } else if (html.includes('</body>')) {
    out = html.replace('</body>', snippet + '\n</body>')
  } else {
    console.error('找不到 </body> 也没有哨兵，无法注入：' + target)
    process.exit(1)
  }

  out = syncRuntimeShell(out)

  if (out !== html) {
    writeFileSync(target, out)
    changed++
    console.log('已同步自动加载片段 ->', target)
  } else {
    console.log('无变化 ->', target)
  }
}

if (changed) console.log('\n提示：改完片段后记得重新构建（npm run build），dist/client 里才是线上那份。')
