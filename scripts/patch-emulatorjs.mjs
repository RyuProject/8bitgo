#!/usr/bin/env node
/**
 * 给自建的 EmulatorJS（public/emulatorjs/emulator.min.js）打补丁。
 * 幂等：打过了再跑直接通过。升级引擎后必须重跑（见 deploy/netplay/README.md）。
 *
 * 目前两组补丁，互不相干，各自独立幂等。
 *
 * ── 一、blob URL 文件名（只影响街机）─────────────────────────
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
 *
 * ── 二、存档 ABI 回退（影响全平台）───────────────────────────
 * 症状：任何平台按下保存进度，红字「FAILED TO SAVE STATE」。
 *
 * 病因是引擎和核心不同代。`public/emulatorjs/` 是从 main 自建的（自称
 * 4.3.0-pre），取存档走新 ABI：
 *     getState(){return this.Module.EmulatorJSGetState()}
 * 而 `public/emulatorjs/cores/` 里的核心来自 npm 发布版 @emulatorjs/core-*
 * （core build 2.0.2，minimumEJSVersion 4.2.2）。把 mgba-wasm.data（7z）解开看
 * glue，`EmulatorJSGetState` 出现 **0 次**，导出的仍是老 ABI 的
 * `_save_state_info / _cmd_save_state / _load_state / _supports_states`。
 * 官方至今没发布配套 4.3.0-pre 的核心（核对到 @emulatorjs/core-mgba@4.2.3，
 * 同样没有），所以**升级核心解决不了**。
 *
 * 于是 gameManager.getState() 抛 TypeError，被三处 catch 吞掉，玩家看到的都是
 * 同一句红字：工具栏 Save State、菜单里的 Quick Save、快捷键快存。联机时房主的
 * 进度托管（adapters/emulatorjs.ts 的 startStateUpload）也一起静默失效。
 * 读档不受影响 —— 它走 cwrap("load_state")，老核心有这个导出。
 *
 * 补丁：把 4.2.3 的老 ABI 实现接回来，但**新 ABI 优先** —— 将来核心跟上
 * 4.3.0-pre，这段代码不用再动，也不会退化。老 ABI 的协议照抄 4.2.3 的
 * GameManager.js：`save_state_info()` 返回 "size|ptr|ok" 三段，ok 必须是 "1"，
 * 然后从 HEAPU8 的 [ptr, ptr+size) 切出存档字节。
 *
 * 注意 supportsStates 那处 cwrap 是**追加**而不是替换：4.3.0-pre 把
 * saveStateInfo 整个删了，得先把它加回 functions 表，getState 才有东西可调。
 *
 * 验证记录（2026-09-02，无头 Chromium + 本仓库的 mgba 核心 + jsmolka/gba-tests 的
 * arm.gba，跑满 100+ 帧后取存档）：
 *   打补丁前：getState() 抛 TypeError: this.Module.EmulatorJSGetState is not a function
 *             gameManager.quickSave(1) === false   ← 玩家看到的就是这句红字
 *   打补丁后：getState() 返回 528472 字节，quickSave(1) === true，
 *             loadState() 回灌不报错，再取一次尺寸一致
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

/** 老 ABI 的 cwrap，4.3.0-pre 里被删掉了，追加回 functions 表 */
const STATE_CWRAP_FROM = 'supportsStates:this.Module.cwrap("supports_states","number",[]),'
const STATE_CWRAP_TO =
  STATE_CWRAP_FROM + 'saveStateInfo:this.Module.cwrap("save_state_info","string",[]),'

/** 新 ABI 优先，取不到就走 4.2.3 的 size|ptr|ok 协议 */
const STATE_GET_FROM = 'getState(){return this.Module.EmulatorJSGetState()}'
const STATE_GET_TO =
  'getState(){' +
  'if("function"==typeof this.Module.EmulatorJSGetState)return this.Module.EmulatorJSGetState();' +
  'const t=this.functions.saveStateInfo().split("|");' +
  'if("1"!==t[2]){console.error(t[0]);throw new Error(t[0])}' +
  'const e=parseInt(t[0]),i=parseInt(t[1]);' +
  'return new Uint8Array(this.Module.HEAPU8.subarray(i,i+e))}'

/**
 * 每组：name 显示用；patches 是 [要找的原文, 替换后]；
 * legacy 可选，把「替换后」映射成更早一版补丁的样子，用来在引擎升级后接管旧补丁；
 * hint 是位置对不上时打给人看的排查思路。
 */
const GROUPS = [
  {
    name: 'blob 文件名',
    patches: [
      ['S=t.split("/").pop()||"downloaded.bin"', `S=(${NAME_EXPR}${URL_NAME_EXPR})||"downloaded.bin"`],
      [
        'const o=t.split("/").pop()||"downloaded.bin",r=Date.now();',
        `const o=(${NAME_EXPR}${URL_NAME_EXPR})||"downloaded.bin",r=Date.now();`,
      ],
    ],
    // 旧版补丁只修了 blob，没有剥查询串；升级时先把旧表达式当成候选来源。
    legacy: (to) => to.replace(URL_NAME_EXPR, 't.split("/").pop()'),
    hint: [
      '重新找到两个下载分支里 split("/").pop() 取文件名的地方，更新这一组。',
    ],
  },
  {
    name: '存档 ABI 回退',
    patches: [
      [STATE_CWRAP_FROM, STATE_CWRAP_TO],
      [STATE_GET_FROM, STATE_GET_TO],
    ],
    hint: [
      '先确认引擎里 gameManager 的 getState 还是不是 EmulatorJSGetState 那一行；',
      '如果核心已经跟上（glue 里能 grep 到 EmulatorJSGetState），这一组可以整个删掉。',
    ],
  },
]

let src = readFileSync(file, 'utf8')
let changed = false
const report = []

for (const group of GROUPS) {
  let applied = 0
  let already = 0
  for (const [from, to] of group.patches) {
    if (src.includes(to)) {
      already++
      continue
    }
    const legacyPatched = group.legacy?.(to)
    const source = legacyPatched && src.includes(legacyPatched) ? legacyPatched : from
    const n = src.split(source).length - 1
    if (n !== 1) {
      console.error(`✖ [${group.name}] 在 emulator.min.js 里找到 ${n} 处「${from.slice(0, 48)}…」，预期恰好 1 处。`)
      console.error('  引擎构建变了，补丁位置对不上。别硬套，按本文件头注释里的思路重新定位：')
      for (const line of group.hint) console.error(`  ${line}`)
      process.exit(1)
    }
    src = src.replace(source, to)
    applied++
    changed = true
  }
  report.push(applied ? `${group.name}：新打 ${applied} 处，已存在 ${already} 处` : `${group.name}：已在位（${already} 处）`)
}

if (changed) writeFileSync(file, src)
for (const line of report) console.log(`✔ ${line}`)
