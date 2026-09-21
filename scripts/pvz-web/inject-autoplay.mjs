// 把自动加载片段注入 public/web/PvZ/index.html（官方引擎页已把 jszip 换成本地）。
// 可重入：index.html 里若已有自动加载块（带 START/END 哨兵，或旧版只带 END 哨兵），先剥离再注入。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const TARGET = resolve(ROOT, 'public/web/PvZ/index.html')
const SNIPPET = resolve(__dirname, 'autoplay-snippet.html')

const START = '<!-- PvZ_AUTOPLAY_START -->'
const END = '<!-- PvZ_AUTOPLAY_INJECTED -->'

let html = readFileSync(TARGET, 'utf8')

// 剥离任何已存在的自动加载块
if (html.includes(START)) {
  const i = html.indexOf(START)
  const j = html.indexOf(END)
  if (j >= 0) html = html.slice(0, i) + html.slice(j + END.length)
} else if (html.includes(END)) {
  // 旧版：只有 END 哨兵，块从它前面紧邻的 <script> 起到 END 为止
  const j = html.indexOf(END)
  const k = html.lastIndexOf('<script>', j)
  if (k >= 0) html = html.slice(0, k) + html.slice(j + END.length)
}

if (!html.includes('</body>')) {
  console.error('找不到 </body>，无法注入')
  process.exit(1)
}

const snippet = readFileSync(SNIPPET, 'utf8')
writeFileSync(TARGET, html.replace('</body>', snippet + '\n</body>'))
console.log('已注入自动加载脚本 ->', TARGET)
