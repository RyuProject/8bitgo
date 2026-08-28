#!/usr/bin/env node
/**
 * 给自建的 EmulatorJS（public/emulatorjs/emulator.min.js）打「blob URL 文件名」补丁。
 * 幂等：打过了再跑直接通过。升级引擎后必须重跑（见 deploy/netplay/README.md）。
 *
 * ── 修的是什么 ─────────────────────────────────────────────
 * 街机核心（FBNeo/MAME 系）靠**压缩包文件名**识别游戏：kof97.zip → 驱动 kof97。
 * 引擎把 ROM 写进虚拟文件系统时用 `url.split("/").pop()` 当文件名 ——
 * 云端 ROM 是真实 URL，文件名碰巧对；「玩本地 ROM」页拖入的文件走 blob: URL，
 * pop() 出来是一串 UUID，FBNeo 拿到名为 UUID 的 romset，直接
 * 「Romset is unknown」。EJS_gameName 明明就是给这种场景准备的，但引擎的
 * 两个下载分支（fetch 正常路径 + handleNonHttpUrl 的 blob 路径）都没看它。
 *
 * 补丁：blob: 游戏仍用 config.gameName；http(s) 游戏从 URL 中取文件名时先去掉
 * 查询串和 hash。后者是因为云端 ROM 会带 `?romv=<ETag>` 做内容版本化，若把参数
 * 也写进虚拟文件名，FBNeo 看到 `kof97.zip?romv=…` 仍然认不出 romset。
 *
 * 验证记录（2026-08-28，无头 Chromium + 真实 kof97.zip + neogeo.zip）：
 *   打补丁前：FS 里是 /c7b668fa-…（UUID 无扩展名）→ Romset is unknown
 *   打补丁后：FS 里是 /kof97.zip → INSERT COIN，游戏正常运行
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'public', 'emulatorjs', 'emulator.min.js')

/** blob: 的游戏 URL → 用 EJS_gameName；http(s) → 去掉版本查询串再取文件名 */
const NAME_EXPR =
  't.startsWith("blob:")&&this.EJS&&this.EJS.config&&t===this.EJS.config.gameUrl&&' +
  '"string"==typeof this.EJS.config.gameName&&this.EJS.config.gameName?this.EJS.config.gameName:'
const URL_NAME_EXPR = 't.split(/[?#]/)[0].split("/").pop()'

/** [要找的原文, 替换后] —— 两个下载分支各一处 */
const PATCHES = [
  [
    'S=t.split("/").pop()||"downloaded.bin"',
    `S=(${NAME_EXPR}${URL_NAME_EXPR})||"downloaded.bin"`,
  ],
  [
    'const o=t.split("/").pop()||"downloaded.bin",r=Date.now();',
    `const o=(${NAME_EXPR}${URL_NAME_EXPR})||"downloaded.bin",r=Date.now();`,
  ],
]

let src = readFileSync(file, 'utf8')
let applied = 0
let already = 0
for (const [from, to] of PATCHES) {
  if (src.includes(to)) {
    already++
    continue
  }
  // 旧版补丁只修了 blob，没有剥查询串；升级时先把旧表达式当成候选来源。
  const oldPatched = to.replace(URL_NAME_EXPR, 't.split("/").pop()')
  const source = src.includes(oldPatched) ? oldPatched : from
  const n = src.split(source).length - 1
  if (n !== 1) {
    console.error(`✖ 在 emulator.min.js 里找到 ${n} 处「${from.slice(0, 40)}…」，预期恰好 1 处。`)
    console.error('  引擎构建变了，补丁位置对不上。别硬套：按本文件头注释里的思路，')
    console.error('  重新找到两个下载分支里 split("/").pop() 取文件名的地方，更新 PATCHES。')
    process.exit(1)
  }
  src = src.replace(source, to)
  applied++
}
if (applied) writeFileSync(file, src)
console.log(
  applied
    ? `✔ blob 文件名补丁已打上（${applied} 处新打，${already} 处已存在）`
    : '✔ blob 文件名补丁本来就在，无需改动',
)
