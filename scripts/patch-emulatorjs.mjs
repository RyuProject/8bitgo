#!/usr/bin/env node
/**
 * 给自建的 EmulatorJS（public/emulatorjs/emulator.min.js）打补丁。
 * 幂等：打过了再跑直接通过。升级引擎后必须重跑（见 deploy/netplay/README.md）。
 *
 * 各组补丁互不相干，各自独立幂等。
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
 *
 * ── 三、核心报告缓存（影响所有 EmulatorJS 平台）──────────────
 * 核心报告决定核心能否进 IndexedDB 缓存。上游当前有两个连续缺陷：
 * 1. 查 EJS_paths 时直接拿带 `?v=<小时>` 的末段做键，`fbneo.json` 覆盖永远匹配不到；
 * 2. 新下载器返回 CacheItem，报告读取处却仍把它当已经解析的 JSON，buildStart 永远取不到。
 *
 * 两者任一存在，引擎都会打印「Core caching will be disabled」，玩家每次开局重新下载并解压核心。
 * KOF97 的 FBNeo legacy 核心约 8MB，弱网下尤其明显。补丁先让路径匹配忽略查询串，再从
 * CacheItem 第一份文件的 bytes 解码 JSON；旧下载器若已经返回对象则保持原路径。
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
 * 核心的 stderr 必须出得来。
 *
 * 引擎把 Emscripten 的两个输出口都写成了 `t=>{this.debug&&console.log(t)}`，而 `this.debug`
 * 来自 `EJS_DEBUG_XX` —— 站点从没设过，所以核心自己打的诊断（FBNeo 的 `Romset is unknown`、
 * MAME 的 `NOT FOUND` / `WRONG CHECKSUM`、缺 BIOS 那几行）**一个字都出不来**。
 *
 * 后果：同一款 Neo Geo 游戏，「没配 neogeo.zip」「romset 少一个成员」「改版包没贴 RomData」
 * 三种完全不同的病，玩家和运维看到的都是同一句「Failed to start game」，
 * 而 adapters/emulatorjs.ts 里那套按关键词分流的 FATAL_HINTS 一个词都命不中。
 *
 * 只改 `printErr`（stderr）不动 `print`（stdout）—— 后者是核心的常规输出，会刷屏。
 */
const PRINT_ERR_FROM = 'printErr:t=>{this.debug&&console.log(t)}'
const PRINT_ERR_TO = 'printErr:t=>{console.warn(t)}'

/**
 * libretro 的 ERROR 走 stdout，不走 stderr。
 *
 * 只打通上面的 printErr 仍有一个盲区：核心在完整初始化后拿到了
 * RETRO_ENVIRONMENT_GET_LOG_INTERFACE，后续 `retro::error()` 会被 RetroArch 包成
 * `[libretro ERROR] ...` 写到 stdout。引擎却仍用 `this.debug` 把 stdout 整体吞掉，
 * 所以 melonDS DS 的「ROM 为什么被拒绝」这类关键错误线上完全看不见。
 *
 * 常规 stdout 不能全开（MAME 会刷屏），这里只无条件透出 libretro 的 ERROR；其它行仍只在
 * EJS_DEBUG_XX 下输出。这样既能让错误探针和运维拿到根因，也不增加正常游戏的日志开销。
 */
const PRINT_OUT_FROM = 'print:t=>{this.debug&&console.log(t)}'
const PRINT_OUT_TO = 'print:t=>{this.debug&&console.log(t),/^\\[libretro ERROR\\]/i.test(t)&&console.warn(t)}'

/**
 * 街机核心的 ROM / BIOS 必须保持 .zip 原样。
 *
 * 引擎给 ROM 与 BIOS 各带一份「不要解压」的核心白名单
 *（downloadType.rom/bios.dontExtractIfCore），名单里是
 * fbneo / fbalpha2012_* / same_cdi / mame / mame2003_plus / mame2003，
 * 却**没有我们自建的 mame-current**。
 *
 * 后果（2026-09-19 实测，无头/有头 Chromium + 真实 mxsqy.zip + pgm.zip）：
 *   引擎把 ROM 与 BIOS 解成散文件 → MAME 按 romset 名找不到压缩包 →
 *   在 driver_device::device_start() 抛异常 → 而这套构建的链接没有开
 *   异常捕获白名单（-sEXCEPTION_CATCHING_ALLOWED）→ wasm 直接 Abort，
 *   玩家看到的只有一句「Failed to start game」。
 *   日志佐证：`[EJS ROM] Core mame-current does not require special handling,
 *   will attempt to extract if compressed.`
 *
 * 这里**不改那份名单**，而是改判定：上游以后增删名单都不会让这处失效。
 */
const KEEP_ZIP_FROM = 'e.dontExtractIfCore?.includes(this.getCore())'
const KEEP_ZIP_TO = '(e.dontExtractIfCore?.includes(this.getCore())||"mame-current"===this.getCore())'

/**
 * melonDS DS 只构建 WebGL2 版，必须让引擎无条件选择 `<core>-wasm.data`。
 *
 * 引擎通常会从 reports/melondsds.json 里的 defaultWebGL2 得到这个结论，但报告 URL
 * 按小时版本化。新核心刚上线时，浏览器或边缘可能还留着同一小时内的 404；报告一旦
 * 取不到，引擎就静默改下 `melondsds-legacy-wasm.data`，而这份文件根本不存在，随后
 * 回落到坏掉的官方 CDN。把核心加入 requiresWebGL2 名单后，报告短暂失败也不会改选
 * 不存在的 legacy 产物；真不支持 WebGL2 的浏览器则在下载前给出明确提示。
 */
const WEBGL2_CORES_FROM = 'm=["ppsspp","azahar"]'
const WEBGL2_CORES_TO = 'm=["ppsspp","azahar","melondsds"]'

/** 核心报告字段允许缺省；老版报告没有最低引擎版本时不应让整个核心初始化崩溃。 */
const CORE_COMPATIBILITY_FROM =
  'checkCoreCompatibility(t){if(this.versionAsInt(t.minimumEJSVersion)>this.versionAsInt(this.ejs_version))'
const CORE_COMPATIBILITY_TO =
  'checkCoreCompatibility(t){if("string"==typeof t.minimumEJSVersion&&t.minimumEJSVersion.length>0&&' +
  'this.versionAsInt(t.minimumEJSVersion)>this.versionAsInt(this.ejs_version))'

/** EJS_paths 的键是文件 basename；下载 URL 自己的查询串不属于文件名。 */
const FILE_PATH_LOOKUP_FROM =
  'let h=(n?"":this.config.dataPath)+t;!n&&this.config.filePaths&&"string"==typeof ' +
  'this.config.filePaths[t.split("/").pop()]&&(h=this.config.filePaths[t.split("/").pop()]);'
const FILE_PATH_LOOKUP_TO =
  'let h=(n?"":this.config.dataPath)+t;const p=(t.split("/").pop()||"").split(/[?#]/)[0];' +
  '!n&&this.config.filePaths&&"string"==typeof this.config.filePaths[p]&&(h=this.config.filePaths[p]);'

/** 新下载器的 text 结果也包在 CacheItem.files[0].bytes 里，报告必须先解码再读 buildStart。 */
const REPORT_PARSE_FROM =
  '(i=-1===i||"string"==typeof i||"string"==typeof i.data?{}:i.data).buildStart||' +
  '(console.warn("Could not fetch core report JSON at "+e+"! Core caching will be disabled!"),' +
  'i.buildStart=100*Math.random())'
const REPORT_PARSE_TO =
  'i=-1===i||"string"==typeof i||"string"==typeof i.data?{}:i.data;' +
  'if(i&&i.files&&i.files[0]&&i.files[0].bytes)try{' +
  'i=JSON.parse(new TextDecoder().decode(i.files[0].bytes))}catch(t){i={}}' +
  'i.buildStart||(console.warn("Could not fetch core report JSON at "+e+' +
  '"! Core caching will be disabled!"),i.buildStart=100*Math.random())'

/**
 * ── 七、7z 解压 Worker 用完即关（2026-10-27）─────────────────────
 * 引擎每解一次核心就 `new Worker(blob:extract7z)`，收到完成消息 `t===1` 后从不 terminate：
 * 那只 Worker 的堆（输入 7z + 解出的全部文件，mame-current 是 37MB + 242MB）一直活到关页。
 * 手机上这几百 MB 正好压在游戏运行时，GC 与内存压力都更大。完成后立刻关掉。
 */
const EXTRACT_DONE_FROM = '1===t.data.t&&s(l)}},a.postMessage(e)'
const EXTRACT_DONE_TO = '1===t.data.t&&(a.terminate(),s(l))}},a.postMessage(e)'

/**
 * ── 八、缓存键只抽样哈希（2026-10-27）───────────────────────────
 * `generateCacheKey` 在主线程上逐字节跑一遍 JS 循环：核心存库时是解出的第一个文件（mame-current 的
 * wasm 242MB），街机 blob ROM 每次开局也要整包算一遍（这个键之后根本不用）。键只需在库里唯一 ——
 * 查找走 URL 索引 —— 首尾各 1MB + 中间 1MB + 长度足够区分，把几百毫秒到一秒多的卡顿去掉。
 */
const CACHE_KEY_FROM =
  'generateCacheKey(t){let e=function(t){let e=0;for(let i=0;i<t.length;i++)e=(e<<5)-e+t[i]&4294967295;return e}(t);return"Obj-"+e+"-"+t.length}'
const CACHE_KEY_TO =
  'generateCacheKey(t){let e=function(t){let e=0;const n=t.length,s=1048576,o=(o,a)=>{for(let i=Math.max(0,o);i<Math.min(n,a);i++)e=(e<<5)-e+t[i]&4294967295};' +
  'n<=3*s?o(0,n):(o(0,s),o((n>>1)-(s>>1),(n>>1)+(s>>1)),o(n-s,n));return e}(t);return"Obj-"+e+"-"+t.length}'

/**
 * ── 九、首次开局也要带上核心默认选项（2026-10-27）────────────────
 * `getCoreSettings()` 写的是核心**加载前**读的那份选项文件。浏览器有 localStorage 时，它只在
 * `localStorage[<gameId>-<core>-<gameName>]` **已经存在**才把 `EJS_defaultOptions` 拼进去，否则返回空串；
 * 而这条记录要等玩家动过设置 / 音量 / 按键才会写。默认值于是只能在 callMain 之后经菜单 setVariable 补上 ——
 * 只在 retro_load_game 读一次的选项（FBNeo 的 fbneo-samplerate、fbneo-allow-depth-32 等）对绝大多数玩家
 * 从来没生效过。没有记录时改成和「禁用 localStorage」那条分支一样输出默认值。
 */
const DEFAULT_OPTIONS_FROM = 'catch(t){console.warn("Could not load previous settings",t)}return""}loadSettings(){'
const DEFAULT_OPTIONS_TO =
  'catch(t){console.warn("Could not load previous settings",t)}if(this.config.defaultOptions){let t="";for(const e in this.config.defaultOptions){' +
  't+=`${e} = ${isNaN(this.config.defaultOptions[e])?`"${this.config.defaultOptions[e]}"`:this.config.defaultOptions[e]}\\n`}return t}return""}loadSettings(){'

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
    name: '版本化文件路径覆盖',
    patches: [[FILE_PATH_LOOKUP_FROM, FILE_PATH_LOOKUP_TO]],
    hint: [
      '在 downloadFile 里找 config.filePaths[t.split("/").pop()] 的两处读取；',
      '查询 EJS_paths 前先从 basename 去掉 ?query / #hash，否则核心报告的按小时版本串会让覆盖失效。',
    ],
  },
  {
    name: '核心报告 JSON 解析',
    patches: [[REPORT_PARSE_FROM, REPORT_PARSE_TO]],
    hint: [
      '在 loadCore 里找 buildStart 与「Core caching will be disabled」警告；',
      '新下载器返回 CacheItem，需从 files[0].bytes 用 TextDecoder + JSON.parse 还原报告对象。',
    ],
  },
  {
    name: '核心 stderr 出得来',
    patches: [[PRINT_ERR_FROM, PRINT_ERR_TO]],
    hint: [
      '在 initModule 里找 Emscripten 的 Module 配置，那对 print / printErr 回调；',
      '只把 printErr 改成无条件 console.warn，print 保持原样（stdout 会刷屏）。',
      '⚠️ 这一组没了的话，街机起不来时永远只有一句「Failed to start game」，查不出是缺 BIOS 还是 romset 不全。',
    ],
  },
  {
    name: 'libretro ERROR 出得来',
    patches: [[PRINT_OUT_FROM, PRINT_OUT_TO]],
    hint: [
      '在 initModule 里找 Emscripten 的 print 回调；',
      '只无条件输出 `[libretro ERROR]`，其余 stdout 仍受 debug 控制，避免 MAME 日志刷屏。',
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
  {
    name: '街机 ROM 保持 zip（mame-current）',
    patches: [[KEEP_ZIP_FROM, KEEP_ZIP_TO]],
    hint: [
      '在 download() 里找 `dontExtractIfCore?.includes(this.getCore())` 那个三元条件；',
      '把 mame-current 也判成「不解压」—— 否则 MAME 拿不到 romset 压缩包会直接 Abort。',
      '⚠️ 这一组没了的话，mame-current 的游戏 100% 起不来，且只有一句「Failed to start game」。',
    ],
  },
  {
    name: 'melonDS DS 强制 WebGL2 核心',
    patches: [[WEBGL2_CORES_FROM, WEBGL2_CORES_TO]],
    hint: [
      '在核心别名表后找 requiresWebGL2 使用的数组（当前含 ppsspp / azahar）；',
      '把 melondsds 加进去，避免核心报告暂时 404 时误选不存在的 legacy 文件。',
    ],
  },
  {
    name: '7z 解压 Worker 用完即关',
    patches: [[EXTRACT_DONE_FROM, EXTRACT_DONE_TO]],
    hint: [
      '在 decompressFile / extract7z 那段找 new Worker(URL.createObjectURL(...)) 的 onmessage；',
      '完成消息（t===1）里先 terminate 这只 Worker 再 resolve。',
    ],
  },
  {
    name: '缓存键抽样哈希',
    patches: [[CACHE_KEY_FROM, CACHE_KEY_TO]],
    hint: [
      '在 EJS 的缓存类里找 generateCacheKey(t)：逐字节 (e<<5)-e+t[i] 的那段；',
      '改成首 / 中 / 尾各 1MB 抽样，返回格式保持 "Obj-<hash>-<length>"。',
    ],
  },
  {
    name: '首次开局带核心默认选项',
    patches: [[DEFAULT_OPTIONS_FROM, DEFAULT_OPTIONS_TO]],
    hint: [
      '在 getCoreSettings() 末尾找「Could not load previous settings」那个 catch 后面的 return ""；',
      '没有已保存设置时也输出 config.defaultOptions（与 disableLocalStorage 分支同一格式）。',
    ],
  },
  {
    name: '核心最低引擎版本字段缺省保护',
    patches: [[CORE_COMPATIBILITY_FROM, CORE_COMPATIBILITY_TO]],
    hint: [
      '在 checkCoreCompatibility 里找 minimumEJSVersion 的比较；',
      '第三方/旧版核心报告可能没有该字段，缺省时应跳过兼容性比较，不能把 undefined 传给 versionAsInt。',
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
