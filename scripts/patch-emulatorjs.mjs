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
 *
 * ── 十三、退出时不卸载 /data/saves（影响全平台电池存档，2026-11-12）─────────
 * 症状：GBA / SNES / GB 等游戏内存档（.srm）刷新页面、切游戏、返回之后全部消失 —— 而且是
 * 这个域名下**所有游戏**的电池存档一起没了，不只是当前这款。
 *
 * 引擎的 exit 处理（iframe beforeunload、适配器拆 iframe 都会触发）依次做：
 *     saveSaveFiles() → restart() → saveSaveFiles() → toggleMainLoop(0) → FS.unmount("/data/saves")
 * /data/saves 是 IDBFS + autoPersist：两次 saveSaveFiles 写文件时只是 setTimeout(0) 排了一次
 * 同步，紧接着同一个同步块里就把挂载卸掉了。定时器随后执行 IDBFS.syncfs(mount,false)，
 * getLocalSet 按 mountpoint 路径去走 —— 卸载后那里只剩 MEMFS 的空目录，于是「本地一个文件都
 * 没有」，reconcile 把 IndexedDB 里的每一条记录都当成「本地已删除」逐条删掉。
 *
 * 实测（2026-11-12，本地 dev + 自制 SRAM 计数 ROM）：exit 前 FILE_DATA 里有
 * `/data/saves/mGBA/savetest.srm`，callEvent("exit") 800ms 后 FILE_DATA 为空；刷新页面同样清空。
 *
 * 补丁：删掉那句 unmount。iframe 随后就被拆掉、Module 一秒后 abort，卸不卸载对内存没有区别；
 * 留着挂载，排队的那次同步还会把 exit 里最后一次 saveSaveFiles 写进 IndexedDB。
 * 适配器另有一道运行时保护（src/emulator/ejsSaveFs.ts：持久化方向只写更新、永不删除），
 * 两道独立，任何一道在都不会再清库。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEjsCoreResumeHelper } from './lib/ejs-core-resume-helper.mjs'

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
 * EmulatorJS 解压核心时已经拿到 wasm 的 Uint8Array，却只通过 locateFile 建 blob URL 给 Emscripten。
 * 华为浏览器 17 / Android 12 的现场里，核心数据已从缓存读出，但 Emscripten 对这个 blob URL 的
 * 流式 fetch 和 ArrayBuffer fetch 都报 `TypeError: Failed to fetch`，最终变成「both async and sync
 * fetching of the wasm failed」。把现成字节交给 Emscripten 标准的 `wasmBinary` 入口，直接异步实例化，
 * 不再依赖浏览器再次 fetch blob，也省掉为核心 wasm 另建 blob URL。
 */
const WASM_BINARY_FROM =
  'totalDependencies:0,locateFile:function(i){return this.debug&&console.log(i),i.endsWith(".wasm")?URL.createObjectURL(new Blob([t],{type:"application/wasm"})):i.endsWith(".worker.js")?URL.createObjectURL(new Blob([e],{type:"application/javascript"})):void 0},getSavExt:'
const WASM_BINARY_TO =
  'totalDependencies:0,wasmBinary:t,locateFile:function(i){return this.debug&&console.log(i),i.endsWith(".wasm")?i:i.endsWith(".worker.js")?URL.createObjectURL(new Blob([e],{type:"application/javascript"})):void 0},getSavExt:'

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
/**
 * 2026-11-13 / 2026-11-19 补上自建 FBNeo 变体：名字不在上游名单里，引擎会把 romset ZIP 解成散文件，
 * FBNeo 就报 Romset is unknown / 缺 BIOS 成员（§2.3）。wofcn 专用核心也必须保留原始 ZIP。
 * 旧版补丁（只有 mame-current）由下面 legacy 接管升级。
 */
const KEEP_ZIP_TO_V1 = '(e.dontExtractIfCore?.includes(this.getCore())||"mame-current"===this.getCore())'
const KEEP_ZIP_TO =
  '(e.dontExtractIfCore?.includes(this.getCore())||"mame-current"===this.getCore()||"fbneo-lowmem"===this.getCore()||"fbneo-wofcn"===this.getCore())'

/**
 * 2026-11-16 补上 pcsx_rearmed-lowmem：它是 PS1 默认核心内存不足时的退路（src/emulator/psxLowmem.ts），
 * 代码与默认 PCSX 逐字节相同，引擎对它的处理也必须相同。引擎只在两处按核心名认 PCSX：psx 别名组（故意不加，
 * 理由见 ejsSaveFs.ts 的 copyEngineSettingsToSystem）和这里的 CUE 处理名单 —— 不在名单里的核心会改用另一套
 * 「从压缩包里挑 cue / ccd / toc / m3u」的规则，同一个 cue+bin 包两种核心挑出的文件可能不同。
 */
const PSX_LOWMEM_CUE_FROM =
  '["pcsx_rearmed","genesis_plus_gx","picodrive","mednafen_pce","smsplus","vice_x64","vice_x64sc","vice_x128","vice_xvic","vice_xpet","puae"].includes(this.getCore())'
const PSX_LOWMEM_CUE_TO =
  '["pcsx_rearmed","pcsx_rearmed-lowmem","genesis_plus_gx","picodrive","mednafen_pce","smsplus","vice_x64","vice_x64sc","vice_x128","vice_xvic","vice_xpet","puae"].includes(this.getCore())'

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
 * ── 十、下载不会永远停在「下载游戏核心 100%」（2026-11-10）─────────────
 * 后台 14 天：境外 / 大陆合计 30 多次「加载在『下载游戏核心 N%』这一步停住了」（拳皇 2002 哥伦比亚、
 * 拳皇 97 等）。引擎的下载器有三处会让 Promise 永远不结束，进度文字就停在最后一次的百分比：
 *
 * 1. 30 秒超时（AbortController）在**拿到响应头就清掉**，读包体的 `reader.read()` 没有任何时限：
 *    跨洲线路丢了最后几个包 / 连接半开时，进度到 100% 却等不来流结束。改成每收到一块就重新计时；
 *    20 秒没有新字节就中止 Fetch，并立即用 XHR arraybuffer 完整重取一次。现场证明单纯把失败交给播放器换线路
 *    会让大陆玩家从 EdgeOne 退回吞吐极差的 Cloudflare；XHR 成功就留在当前线路。仅 XHR 也失速才交给播放器。
 * 2. 下载完成后 `await this.storageCache.put()` 才把结果交出去；开局前还 `await storageCache.get()`。
 *    引擎的 IndexedDB 封装有好几条路永远不 settle：`transaction()` 在 onsuccess 里同步抛错（表不存在 /
 *    库正在关闭）、`put/get/delete` 同步抛 TransactionInactiveError / DataCloneError（async 执行器里的
 *    异常没人接）、`remove` 的 onerror 是空函数。缓存只是加速，所以 put 最多等 10 秒、get 最多等
 *    20 秒（大核心从库里读出来要时间），超时就当没缓存；封装里的同步异常一律收成「没有缓存」。
 * 3. 核心下载失败后引擎会去 `cdn.emulatorjs.org/<版本>/data/` 再拉一次（cdnFallback）。我们的引擎自称
 *    4.3.0-pre，那里的核心初始化不出 EJS_Runtime（AGENTS §2.4），只会多等几十秒再报
 *    「Error loading EmulatorJS runtime」。关掉，让失败立刻交给播放器的自动重试。
 */
const BODY_READ_FROM =
  'for(;;){const{done:s,value:o}=await e.read();if(s)break;n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)}'
const BODY_READ_TO =
  'let __8bgStall=0;const __8bgArm=()=>{clearTimeout(__8bgStall),__8bgStall=setTimeout(()=>{console.warn("[EJS Download] 20 秒没有新数据，中止："+S),f.abort()},2e4)};' +
  'try{for(;;){__8bgArm();const{done:s,value:o}=await e.read();if(s)break;n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)}}finally{clearTimeout(__8bgStall)}'
const BODY_READ_STALL_FROM = 'console.warn("[EJS Download] 20 秒没有新数据，中止："+S),f.abort()'
const BODY_READ_STALL_TO = 'console.warn("[EJS Download] 20 秒没有新数据，中止："+S),f.__8bgStalled=!0,f.abort()'
/**
 * 华为浏览器 17 的两份现场里，核心 HTTP 200 收到 1.3MB 后立刻报 NotReadableError，且在 IndexedDB put 之前。
 * 上游把 `reader.read()` 与 `new Blob(chunks).arrayBuffer()` 放在同一个 catch 里，旧现场没有子阶段栈，无法证明
 * 是哪一行抛错；但该浏览器已有 Blob 存储读不出的现场，而 Blob 往返完全多余。去掉它，按实际收到的字节数拼成
 * Uint8Array；流读取本身若失败，另打印原始异常对象，以便下一份诊断确认阶段。
 */
const BODY_READ_DIAGNOSTICS_FROM =
  'try{for(;;){__8bgArm();const{done:s,value:o}=await e.read();if(s)break;n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)}}finally{clearTimeout(__8bgStall)}'
const BODY_READ_DIAGNOSTICS_TO =
  'try{for(;;){__8bgArm();const{done:s,value:o}=await e.read();if(s)break;n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)}}catch(__8bgReadError){console.warn("[EJS Download] response stream read failed",__8bgReadError);throw __8bgReadError}finally{clearTimeout(__8bgStall)}'
const ARRAYBUFFER_BLOB_FROM = 'const s=new Blob(n),o=await s.arrayBuffer();Z=new Uint8Array(o)'
const ARRAYBUFFER_BLOB_TO_V1 =
  'Z=new Uint8Array(i);let __8bgOffset=0;for(const __8bgChunk of n){Z.set(__8bgChunk,__8bgOffset);__8bgOffset+=__8bgChunk.byteLength}'
const ARRAYBUFFER_BLOB_TO =
  'Z=__8bgTarget||new Uint8Array(i);if(!__8bgTarget){let __8bgOffset=0;for(const __8bgChunk of n){Z.set(__8bgChunk,__8bgOffset);__8bgOffset+=__8bgChunk.byteLength}}'
/**
 * 流读取本身失败或下载器自己的空闲计时判定失速时，改走 XHR arraybuffer 再取一次。
 * 2026-11-15 华为浏览器 17 / Android 12《节奏天国》先加了流读取异常兜底；2026-11-21 大陆 5 份现场确认
 * 20 秒失速中止不能直接失败：同一核心多次只收到 0–1.9MB，网络恢复后必须先换读取 API 重取。
 * 上一节去掉了 Blob 往返；若这类浏览器连 `ReadableStream.read()` 也读不出（NotReadableError），XHR 的
 * arraybuffer 响应既不走流也不走 Blob，是另一条读取路径。只对没有请求体（GET）且不是外部取消的下载回退一次；
 * 已收到的 Fetch 字节只用于拒绝短响应，完整数据从头取，且继续检查状态码、长度和错误页类型。XHR 空闲时限只算前台时间，
 * 标签页隐藏期间暂停，回来后重新给足 20 秒；失败原样交回引擎。
 */
const BODY_READ_FALLBACK_FROM =
  'try{for(;;){__8bgArm();const{done:s,value:o}=await e.read();if(s)break;n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)}}catch(__8bgReadError){console.warn("[EJS Download] response stream read failed",__8bgReadError);' +
  'if(f.signal.aborted||o)throw __8bgReadError;clearTimeout(__8bgStall);console.warn("[EJS Download] 改用 XHR arraybuffer 重新下载："+S);' +
  'const __8bgBuf=await new Promise((__8bgOk,__8bgFail)=>{const __8bgX=new XMLHttpRequest;let __8bgXT=0;const __8bgXArm=()=>{clearTimeout(__8bgXT),__8bgXT=setTimeout(()=>{console.warn("[EJS Download] XHR 20 秒没有新数据，中止："+S),__8bgX.abort()},2e4)};' +
  '__8bgX.open("GET",y.url),__8bgX.responseType="arraybuffer";try{s&&new Headers(s).forEach((__8bgV,__8bgK)=>__8bgX.setRequestHeader(__8bgK,__8bgV))}catch(__8bgH){}' +
  '__8bgX.onprogress=__8bgE=>{__8bgXArm(),r&&__8bgE.lengthComputable&&r("downloading",Math.floor(__8bgE.loaded/__8bgE.total*100),__8bgE.loaded,__8bgE.total)};' +
  '__8bgX.onload=()=>{clearTimeout(__8bgXT),__8bgX.status>=200&&__8bgX.status<300&&__8bgX.response?__8bgOk(__8bgX.response):__8bgFail(new Error("XHR fallback HTTP "+__8bgX.status))};' +
  '__8bgX.onerror=()=>{clearTimeout(__8bgXT),__8bgFail(new Error("XHR fallback network error after "+__8bgReadError))};__8bgX.onabort=()=>{clearTimeout(__8bgXT),__8bgFail(new Error("XHR fallback stalled after "+__8bgReadError))};' +
  '__8bgXArm(),__8bgX.send()});console.warn("[EJS Download] XHR arraybuffer 重新下载成功："+S+" "+__8bgBuf.byteLength+" 字节");n=[new Uint8Array(__8bgBuf)],i=__8bgBuf.byteLength}finally{clearTimeout(__8bgStall)}'
/**
 * 2026-11-17 明星三缺一现场：Fetch 已读到 24.3MB 后断流，XHR 却拿到 121KB 的 HTTP 200，旧逻辑仍报成功，
 * 把错误响应交给解压器后引擎报 EJS_Runtime is not defined。XHR 只有完整、非错误页的响应才可进入缓存。
 * Content-Length 在 Content-Encoding 下是压缩长度，不能与浏览器解码后的 ArrayBuffer 长度硬比；此时至少
 * 要保证不短于已由 Fetch 收到的字节。没有编码时，同时核对原 Response 或 XHR 声明长度。
 */
const BODY_READ_FALLBACK_ONLOAD_FROM =
  '__8bgX.onload=()=>{clearTimeout(__8bgXT),__8bgX.status>=200&&__8bgX.status<300&&__8bgX.response?__8bgOk(__8bgX.response):__8bgFail(new Error("XHR fallback HTTP "+__8bgX.status))};'
/**
 * 2026-11-17 第一版（79be63d）写的是 /^(?:text/html|application/(?:json|xml))\b/i：正则字面量里的 `/` 没转义，
 * `/^(?:text/` 就结束了，`html` 被当成 flag —— 整份 emulator.min.js 无法解析，loader 的 import() 失败，
 * 所有 EmulatorJS 平台报「Failed to load emulator.min.js」（线上拳皇 97 现场）。留着这串只为让补丁认出坏产物并改正。
 * 往补丁字符串里写正则一律别用字面量里的裸 `/`；这里干脆改成按 MIME 字符串比较。
 */
const BODY_READ_FALLBACK_ONLOAD_BROKEN =
  '__8bgX.onload=()=>{clearTimeout(__8bgXT);const __8bgBody=__8bgX.response,__8bgBytes=__8bgBody?.byteLength||0,__8bgXHeader=__8bgName=>__8bgX.getResponseHeader?.(__8bgName)||"",__8bgEncoding=(y.headers.get("Content-Encoding")||__8bgXHeader("Content-Encoding")||"").trim(),__8bgLength=__8bgEncoding?0:Number(t)||Number(__8bgXHeader("Content-Length"))||0,__8bgType=__8bgXHeader("Content-Type").trim(),__8bgTextError=/^(?:text/html|application/(?:json|xml))\\b/i.test(__8bgType);if(__8bgX.status===200&&__8bgBody&&__8bgBytes>0&&__8bgBytes>=i&&(!__8bgLength||__8bgBytes===__8bgLength)&&!__8bgTextError)__8bgOk(__8bgBody);else __8bgFail(new Error("XHR fallback incomplete response: HTTP "+__8bgX.status+", received "+__8bgBytes+" bytes, expected at least "+i+(__8bgLength?" / "+__8bgLength:"")+(__8bgTextError?" ("+__8bgType+")":"")))};'
const BODY_READ_FALLBACK_ONLOAD_TO = BODY_READ_FALLBACK_ONLOAD_BROKEN.replace(
  '__8bgTextError=/^(?:text/html|application/(?:json|xml))\\b/i.test(__8bgType);',
  '__8bgMime=__8bgType.split(";")[0].trim().toLowerCase(),__8bgTextError=__8bgMime==="text/html"||__8bgMime==="application/json"||__8bgMime==="application/xml";',
)
if (BODY_READ_FALLBACK_ONLOAD_TO === BODY_READ_FALLBACK_ONLOAD_BROKEN) throw new Error('XHR 兜底的 MIME 判断改写没命中')
const BODY_READ_FALLBACK_PREVIOUS = BODY_READ_FALLBACK_FROM.replace(BODY_READ_FALLBACK_ONLOAD_FROM, BODY_READ_FALLBACK_ONLOAD_TO)
const BODY_READ_FALLBACK_REPLACEMENTS = [
  [
    'if(f.signal.aborted||o)throw __8bgReadError;',
    'if(f.signal.aborted&&!f.__8bgStalled||o)throw __8bgReadError;',
    '失速恢复条件',
  ],
  [
    'const __8bgBuf=await new Promise((__8bgOk,__8bgFail)=>{const __8bgX=new XMLHttpRequest;let __8bgXT=0;const __8bgXArm=()=>{clearTimeout(__8bgXT),__8bgXT=setTimeout(()=>{console.warn("[EJS Download] XHR 20 秒没有新数据，中止："+S),__8bgX.abort()},2e4)};',
    'const __8bgBuf=await new Promise((__8bgOk,__8bgFail)=>{const __8bgX=new XMLHttpRequest;let __8bgXT=0;const __8bgXClear=()=>{clearTimeout(__8bgXT),__8bgXT=0},__8bgXArm=()=>{__8bgXClear(),"hidden"!==document.visibilityState&&(__8bgXT=setTimeout(()=>{"hidden"===document.visibilityState?__8bgXArm():(console.warn("[EJS Download] XHR 20 秒没有新数据，中止："+S),__8bgX.abort())},2e4))},__8bgXVis=()=>{"hidden"===document.visibilityState?__8bgXClear():__8bgXArm()},__8bgXDone=()=>{__8bgXClear(),document.removeEventListener("visibilitychange",__8bgXVis)};document.addEventListener("visibilitychange",__8bgXVis);',
    'XHR 后台暂停计时',
  ],
  ['__8bgX.onload=()=>{clearTimeout(__8bgXT);', '__8bgX.onload=()=>{__8bgXDone();', 'XHR 完成清理'],
  ['__8bgX.onerror=()=>{clearTimeout(__8bgXT),', '__8bgX.onerror=()=>{__8bgXDone(),', 'XHR 错误清理'],
  ['__8bgX.onabort=()=>{clearTimeout(__8bgXT),', '__8bgX.onabort=()=>{__8bgXDone(),', 'XHR 中止清理'],
]
const BODY_READ_FALLBACK_TO = BODY_READ_FALLBACK_REPLACEMENTS.reduce((source, [from, to, label]) => {
  const replaced = source.replace(from, to)
  if (replaced === source) throw new Error(`XHR 兜底${label}补丁未命中`)
  return replaced
}, BODY_READ_FALLBACK_PREVIOUS)
const BODY_READ_FALLBACK_BROKEN = BODY_READ_FALLBACK_FROM.replace(BODY_READ_FALLBACK_ONLOAD_FROM, BODY_READ_FALLBACK_ONLOAD_BROKEN)
const CORE_RESUME_HELPER = renderEjsCoreResumeHelper()
const CORE_RESUME_HELPER_START = '/*\n * EmulatorJS 核心下载续传助手'
const CORE_RESUME_INSERT_FROM = 'class s{constructor(t=null,e=null){this.storageCache=t,this.EJS=e}'
const CORE_RESUME_INSERT_TO = `${CORE_RESUME_HELPER}\n${CORE_RESUME_INSERT_FROM}`
const CORE_RESUME_STATE_FROM = 'let C;try{C=new URL(t)'
const CORE_RESUME_STATE_TO = 'let C,__8bgResumeState=null;try{C=new URL(t)'
const CORE_FETCH_FROM = 'if(y=await fetch(t,{method:n,headers:s,body:o,signal:f.signal}),clearTimeout(V),!y.ok)throw new Error(`HTTP ${y.status}`);'
const CORE_FETCH_TO =
  'let __8bgResumePlan=__8bgCoreResume.plan(t,n,o,s);const __8bgFetchFull=async()=>{clearTimeout(V),f=new AbortController,V=setTimeout(()=>f.abort(),h);try{return await fetch(t,{method:n,headers:s,body:o,signal:f.signal})}finally{clearTimeout(V)}};' +
  'if(y=await fetch(t,{method:n,headers:__8bgResumePlan?__8bgResumePlan.headers:s,body:o,signal:f.signal}),clearTimeout(V),__8bgResumePlan){' +
  'const __8bgAccepted=await __8bgCoreResume.accept(__8bgResumePlan,y,__8bgFetchFull);y=__8bgAccepted.response;__8bgResumeState=__8bgAccepted.state;if(__8bgResumeState)__8bgResumeState.prefix=__8bgAccepted.prefix||[]}' +
  'clearTimeout(V);if(!y.ok)throw new Error(`HTTP ${y.status}`);'
const CORE_FETCH_HEADER_ACCEPT_MARKER = 'const __8bgAccepted='
const CORE_FETCH_HEADER_ACCEPT_AT = CORE_FETCH_TO.indexOf(CORE_FETCH_HEADER_ACCEPT_MARKER)
if (CORE_FETCH_HEADER_ACCEPT_AT < 0) throw new Error('核心响应头兜底找不到续传响应校验段')
const CORE_FETCH_HEADER_FALLBACK_TO_PREVIOUS =
  'let __8bgResumePlan=__8bgCoreResume.plan(t,n,o,s);const __8bgFetchWithHeaderFallback=async(__8bgUrl,__8bgHeaders)=>{clearTimeout(V),f=new AbortController;let __8bgHeaderTimedOut=false;V=setTimeout(()=>{__8bgHeaderTimedOut=true;f.__8bgHeaderTimedOut=true;f.abort()},h);try{return await fetch(__8bgUrl,{method:n,headers:__8bgHeaders,body:o,signal:f.signal})}catch(__8bgHeaderError){clearTimeout(V);if(!__8bgResumePlan||!__8bgHeaderTimedOut)throw __8bgHeaderError;console.warn("[EJS Download] Fetch 响应头超时，改用 XHR arraybuffer："+S);const __8bgHeaderResult=await __8bgCoreResume.xhrFallback({url:__8bgUrl,originalHeaders:s,state:null,offset:0,progress:r,readError:"Fetch response headers timed out"});const __8bgResponse=new Response(__8bgHeaderResult.body,{status:200,headers:{"Content-Length":String(__8bgHeaderResult.body.byteLength)}});Object.defineProperty(__8bgResponse,"url",{value:__8bgUrl});f=new AbortController;return __8bgResponse}finally{clearTimeout(V)}};const __8bgFetchFull=async()=>__8bgFetchWithHeaderFallback(t,s);' +
  'if(y=await __8bgFetchWithHeaderFallback(t,__8bgResumePlan?__8bgResumePlan.headers:s),__8bgResumePlan){' +
  CORE_FETCH_TO.slice(CORE_FETCH_HEADER_ACCEPT_AT)
const CORE_FETCH_HEADER_FALLBACK_TO =
  'let __8bgResumePlan=__8bgCoreResume.plan(t,n,o,s);const __8bgFetchWithHeaderFallback=async(__8bgUrl,__8bgHeaders)=>{clearTimeout(V),f=new AbortController;let __8bgHeaderTimedOut=false,__8bgFetchStartedAt=performance.now();V=setTimeout(()=>{__8bgHeaderTimedOut=true;f.__8bgHeaderTimedOut=true;f.abort()},h);try{return await fetch(__8bgUrl,{method:n,headers:__8bgHeaders,body:o,signal:f.signal})}catch(__8bgFetchError){clearTimeout(V);if(!__8bgResumePlan)throw __8bgFetchError;let __8bgReadError;if(__8bgHeaderTimedOut)__8bgReadError="Fetch response headers timed out";else if(__8bgFetchError?.name==="TypeError"&&!f.signal.aborted&&__8bgCoreResume.fullCoreTransferObserved(__8bgUrl,__8bgFetchStartedAt))__8bgReadError="Fetch rejected after complete core transfer";else throw __8bgFetchError;console.warn("[EJS Download] "+(__8bgHeaderTimedOut?"Fetch 响应头超时":"Fetch 已传完核心但请求失败")+"，改用 XHR arraybuffer："+S);const __8bgHeaderResult=await __8bgCoreResume.xhrFallback({url:__8bgUrl,originalHeaders:s,state:null,offset:0,progress:r,readError:__8bgReadError,expectedBytes:__8bgCoreResume.expectedCoreBytes(__8bgUrl)});const __8bgResponse=new Response(__8bgHeaderResult.body,{status:200,headers:{"Content-Length":String(__8bgHeaderResult.body.byteLength)}});Object.defineProperty(__8bgResponse,"url",{value:__8bgUrl});f=new AbortController;return __8bgResponse}finally{clearTimeout(V)}};const __8bgFetchFull=async()=>__8bgFetchWithHeaderFallback(t,s);' +
  'if(y=await __8bgFetchWithHeaderFallback(t,__8bgResumePlan?__8bgResumePlan.headers:s),__8bgResumePlan){' +
  CORE_FETCH_TO.slice(CORE_FETCH_HEADER_ACCEPT_AT)
const CORE_READER_INIT_FROM = 'const e=y.body.getReader();let i=0,n=[];let __8bgStall=0;'
const CORE_READER_INIT_TO =
  'const e=y.body.getReader();let i=__8bgResumeState?.start||0,n=__8bgResumeState?.prefix||[],__8bgTarget=__8bgResumeState?.total?new Uint8Array(__8bgResumeState.total):null;if(__8bgTarget&&i){let __8bgPrefixOffset=0;for(const __8bgPart of n){__8bgTarget.set(__8bgPart,__8bgPrefixOffset);__8bgPrefixOffset+=__8bgPart.byteLength}n=[]}if(__8bgResumeState?.total)t=__8bgResumeState.total;if(i&&r)r("downloading",Math.floor(i/t*100),i,t);const __8bgWriter=__8bgCoreResume.writer(__8bgResumeState);let __8bgStall=0;'
const CORE_READER_INIT_TO_PREVIOUS =
  'const e=y.body.getReader();let i=__8bgResumeState?.start||0,n=__8bgResumeState?.prefix||[];if(__8bgResumeState?.total)t=__8bgResumeState.total;if(i&&r)r("downloading",Math.floor(i/t*100),i,t);const __8bgWriter=__8bgCoreResume.writer(__8bgResumeState);let __8bgStall=0;'
const BODY_READ_RESUME_FROM = BODY_READ_FALLBACK_TO
let BODY_READ_RESUME_TO = BODY_READ_RESUME_FROM
const replaceResumeSource = (from, to, label) => {
  const next = BODY_READ_RESUME_TO.replace(from, to)
  if (next === BODY_READ_RESUME_TO) throw new Error(`核心 Range 续传 ${label} 补丁未命中`)
  BODY_READ_RESUME_TO = next
}
replaceResumeSource(
  'n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)',
  '(__8bgTarget?__8bgTarget.set(o,i):n.push(o)),i+=o.length,__8bgWriter&&await __8bgWriter.push(o),r&&t&&r("downloading",Math.floor(i/t*100),i,t)',
  '分片持久化',
)
replaceResumeSource(
  'r("downloading",Math.floor(i/t*100),i,t)}}catch(__8bgReadError)',
  'r("downloading",Math.floor(i/t*100),i,t)}if(__8bgResumeState?.total&&i!==__8bgResumeState.total)throw new Error("core body length mismatch: "+i+"/"+__8bgResumeState.total)}catch(__8bgReadError)',
  '完整长度校验',
)
const XHR_FALLBACK_BLOCK_START = 'const __8bgBuf=await new Promise'
const XHR_FALLBACK_BLOCK_END = '__8bgXArm(),__8bgX.send()});'
const xhrStart = BODY_READ_RESUME_TO.indexOf(XHR_FALLBACK_BLOCK_START)
const xhrEndAt = BODY_READ_RESUME_TO.indexOf(XHR_FALLBACK_BLOCK_END, xhrStart)
if (xhrStart < 0 || xhrEndAt < 0) throw new Error('核心 Range 续传找不到现有 XHR 回退块')
const xhrEnd = xhrEndAt + XHR_FALLBACK_BLOCK_END.length
BODY_READ_RESUME_TO = BODY_READ_RESUME_TO.slice(0, xhrStart) +
  'const __8bgResult=await __8bgCoreResume.xhrFallback({url:y.url,originalHeaders:s,state:__8bgResumeState,offset:i,progress:r,readError:__8bgReadError});const __8bgBuf=__8bgResult.body;' +
  BODY_READ_RESUME_TO.slice(xhrEnd)
replaceResumeSource(
  'console.warn("[EJS Download] XHR arraybuffer 重新下载成功："+S+" "+__8bgBuf.byteLength+" 字节");n=[new Uint8Array(__8bgBuf)],i=__8bgBuf.byteLength}',
  'console.warn("[EJS Download] XHR arraybuffer 重新下载成功："+S+" "+__8bgBuf.byteLength+" 字节");if(__8bgResult.resumed){const __8bgXhrBytes=new Uint8Array(__8bgBuf);if(__8bgTarget)__8bgTarget.set(__8bgXhrBytes,i);else n.push(__8bgXhrBytes);i+=__8bgBuf.byteLength}else{__8bgTarget=new Uint8Array(__8bgBuf);n=[],i=__8bgBuf.byteLength}}',
  'XHR 分段结果拼接',
)
const BODY_READ_HEADER_FALLBACK_TO = BODY_READ_RESUME_TO.replace(
  'if(f.signal.aborted&&!f.__8bgStalled||o)throw',
  'if(f.signal.aborted&&!f.__8bgStalled&&!f.__8bgHeaderTimedOut||o)throw',
)
if (BODY_READ_HEADER_FALLBACK_TO === BODY_READ_RESUME_TO) throw new Error('响应头超时 XHR 回退未找到外部取消保护')
const CORE_COMPLETE_FROM = 'c(n)}else{const i="temp-"+Date.now();c(new a(i,B,b,e,d,S,t,A))}'
const CORE_COMPLETE_TO = '(__8bgResumeState&&__8bgCoreResume.complete(__8bgResumeState)),c(n)}else{const i="temp-"+Date.now();(__8bgResumeState&&__8bgCoreResume.complete(__8bgResumeState)),c(new a(i,B,b,e,d,S,t,A))}'
const CORE_FETCH_TO_PREVIOUS = CORE_FETCH_TO.replace(
  'let __8bgResumePlan=__8bgCoreResume.plan(t,n,o,s);',
  'let __8bgResumePlan=__8bgCoreResume.plan(t,n,o,s),__8bgResumeState=null;',
)
let BODY_READ_RESUME_TO_PREVIOUS = BODY_READ_RESUME_FROM
const replacePreviousResumeSource = (from, to) => {
  const next = BODY_READ_RESUME_TO_PREVIOUS.replace(from, to)
  if (next === BODY_READ_RESUME_TO_PREVIOUS) throw new Error('旧版核心续传行为识别串未命中')
  BODY_READ_RESUME_TO_PREVIOUS = next
}
replacePreviousResumeSource(
  'n.push(o),i+=o.length,r&&t&&r("downloading",Math.floor(i/t*100),i,t)',
  'n.push(o),i+=o.length,__8bgWriter&&await __8bgWriter.push(o),r&&t&&r("downloading",Math.floor(i/t*100),i,t)',
)
replacePreviousResumeSource(
  'r("downloading",Math.floor(i/t*100),i,t)}}catch(__8bgReadError)',
  'r("downloading",Math.floor(i/t*100),i,t)}if(__8bgResumeState?.total&&i!==__8bgResumeState.total)throw new Error("core body length mismatch: "+i+"/"+__8bgResumeState.total)}catch(__8bgReadError)',
)
const previousXhrStart = BODY_READ_RESUME_TO_PREVIOUS.indexOf(XHR_FALLBACK_BLOCK_START)
const previousXhrEndAt = BODY_READ_RESUME_TO_PREVIOUS.indexOf(XHR_FALLBACK_BLOCK_END, previousXhrStart)
if (previousXhrStart < 0 || previousXhrEndAt < 0) throw new Error('旧版核心续传行为缺少 XHR 回退块')
BODY_READ_RESUME_TO_PREVIOUS = BODY_READ_RESUME_TO_PREVIOUS.slice(0, previousXhrStart) +
  'const __8bgResult=await __8bgCoreResume.xhrFallback({url:y.url,originalHeaders:s,state:__8bgResumeState,offset:i,progress:r,readError:__8bgReadError});const __8bgBuf=__8bgResult.body;' +
  BODY_READ_RESUME_TO_PREVIOUS.slice(previousXhrEndAt + XHR_FALLBACK_BLOCK_END.length)
replacePreviousResumeSource(
  'console.warn("[EJS Download] XHR arraybuffer 重新下载成功："+S+" "+__8bgBuf.byteLength+" 字节");n=[new Uint8Array(__8bgBuf)],i=__8bgBuf.byteLength}',
  'console.warn("[EJS Download] XHR arraybuffer 重新下载成功："+S+" "+__8bgBuf.byteLength+" 字节");if(__8bgResult.resumed){n.push(new Uint8Array(__8bgBuf));i+=__8bgBuf.byteLength}else{n=[new Uint8Array(__8bgBuf)],i=__8bgBuf.byteLength}}',
)
const CACHE_PUT_FROM = '!1===u&&await this.storageCache.put(n),c(n)'
const CACHE_PUT_TO =
  '!1===u&&await Promise.race([this.storageCache.put(n).catch(t=>console.warn("[EJS Cache] put failed",t)),' +
  'new Promise(t=>setTimeout(()=>{console.warn("[EJS Cache] put 超过 10 秒，跳过缓存"),t()},1e4))]),c(n)'
const CACHE_GET_FROM = 'this.storageCache&&(I=await this.storageCache.get(t,!1,"url"));'
const CACHE_GET_TO =
  'this.storageCache&&(I=await Promise.race([this.storageCache.get(t,!1,"url").catch(t=>(console.warn("[EJS Cache] get failed",t),null)),' +
  'new Promise(t=>setTimeout(()=>{console.warn("[EJS Cache] get 超过 20 秒，改走网络"),t(null)},2e4))]));'
const CORE_CDN_FROM = 'core:{name:"Core",dontCache:!1,cdnFallback:!0}'
const CORE_CDN_TO = 'core:{name:"Core",dontCache:!1,cdnFallback:!1}'
const IDB_OPEN_FROM = 'n.onerror=()=>e(),n.onsuccess=()=>{let i=n.result.transaction(this.storeName,t).objectStore(this.storeName);e(i)},'
const IDB_OPEN_TO = 'n.onerror=()=>e(),n.onblocked=()=>e(),n.onsuccess=()=>{try{let i=n.result.transaction(this.storeName,t).objectStore(this.storeName);e(i)}catch(t){console.warn("[EJS Cache] store unavailable",t),e()}},'
const IDB_PUT_FROM = 'let o=s.put(e,t);o.onerror=()=>i(),'
const IDB_PUT_TO = 'let o;try{o=s.put(e,t)}catch(t){return console.warn("[EJS Cache] put threw",t),i()}o.onerror=()=>i(),'
const IDB_DELETE_FROM = 'let s=n.delete(t);this.addFileToDB(t,!1),s.onsuccess=()=>e(),s.onerror=()=>{}'
const IDB_DELETE_TO = 'let s;try{s=n.delete(t)}catch(t){return e()}this.addFileToDB(t,!1),s.onsuccess=()=>e(),s.onerror=()=>e()'
const IDB_GET_FROM = 'else{let e=s.get(t);e.onsuccess=()=>i(e.result),e.onerror=()=>i()}'
const IDB_GET_TO = 'else{let e;try{e=s.get(t)}catch(t){return i()}e.onsuccess=()=>i(e.result),e.onerror=()=>i()}'
const BLOB_PUT_FROM = 'const s=i.put(e,t);s.onsuccess=()=>n(),s.onerror=()=>n()'
const BLOB_PUT_TO = 'let s;try{s=i.put(e,t)}catch(t){return n()}s.onsuccess=()=>n(),s.onerror=()=>n()'
const BLOB_GET_FROM = 'const n=e.get(t);n.onsuccess=()=>i(n.result??null),n.onerror=()=>i(null)'
const BLOB_GET_TO = 'let n;try{n=e.get(t)}catch(t){return i(null)}n.onsuccess=()=>i(n.result??null),n.onerror=()=>i(null)'
const BLOB_DELETE_FROM = 'const n=e.delete(t);n.onsuccess=()=>i(),n.onerror=()=>i()'
const BLOB_DELETE_TO = 'let n;try{n=e.delete(t)}catch(t){return i()}n.onsuccess=()=>i(),n.onerror=()=>i()'

/**
 * 第十一节：IndexedDB 挂死一次，就整局（并在本浏览器几天内）不再碰引擎缓存。
 *
 * 2026-11-11 萨尔瓦多 macOS Safari 26.6《超级马里奥》：同一玩家隔 17 小时两次来访，三局都停在
 * 「下载游戏核心」（**没有百分比**），62 秒后被判卡住。ROM 1 秒内就下完了，引擎文件全是边缘缓存命中。
 * 没有百分比说明连 `r("downloading",0)` 都没走到：卡在 `storageCache.get()`。第十节给 get 加了 20 秒
 * 时限，但一局要连查两次（核心报告 + 核心），两次都等满就是 40 秒，期间文字一直是「下载游戏核心」，
 * 超过适配器 30 秒的卡死预算。库坏掉的浏览器每局都会这样，重试也没用。
 *
 * 1. get 超时（15 秒：首查要建库 + 全表清理，大核心读库也要时间；一次等待加报告下载仍在 30 秒卡死预算内）或 put 超时：下载器打上 `__8bgCacheDead`，
 *    本局后续 get / put 直接跳过；并在 localStorage 记 `8bitgo.ejs.idbStall`，适配器据此在后面几天
 *    关掉引擎缓存开局（`EJS_cacheConfig.enabled=false`），不再每局先等一次。
 * 2. 缓存过期后的 HEAD 复验原来没有任何时限；加 8 秒。
 * 3. 文本类响应（核心报告 JSON）读包体没有时限（第十节只管 arraybuffer）；加 20 秒，超时 abort。
 */
const CACHE_DEAD_MARK =
  'this.__8bgCacheDead=!0;try{localStorage.setItem("8bitgo.ejs.idbStall",String(Date.now()))}catch(t){}'
const CACHE_GET_DEAD_FROM = CACHE_GET_TO
const CACHE_GET_DEAD_TO =
  'this.storageCache&&!this.__8bgCacheDead&&(I=await Promise.race([this.storageCache.get(t,!1,"url").catch(t=>(console.warn("[EJS Cache] get failed",t),null)),' +
  'new Promise(t=>setTimeout(()=>{console.warn("[EJS Cache] get 超过 15 秒，本局停用缓存，改走网络");' + CACHE_DEAD_MARK + 't(null)},15e3))]));'
const CACHE_PUT_DEAD_FROM = CACHE_PUT_TO
const CACHE_PUT_DEAD_TO =
  '!1===u&&!this.__8bgCacheDead&&await Promise.race([this.storageCache.put(n).catch(t=>console.warn("[EJS Cache] put failed",t)),' +
  'new Promise(t=>setTimeout(()=>{console.warn("[EJS Cache] put 超过 10 秒，本局停用缓存");' + CACHE_DEAD_MARK + 't()},1e4))]),c(n)'
const HEAD_REVALIDATE_FROM = 'e=(await fetch(t,{method:"HEAD",headers:s})).headers.get("Last-Modified")'
const HEAD_REVALIDATE_TO =
  'e=(await Promise.race([fetch(t,{method:"HEAD",headers:s}),new Promise((t,e)=>setTimeout(()=>e(new Error("HEAD timeout")),8e3))])).headers.get("Last-Modified")'
const TEXT_BODY_FROM = 'else Z=await y[d]()}catch(t){return clearTimeout(V),void m(`Download failed: ${t}`)}'
const TEXT_BODY_TO =
  'else Z=await Promise.race([y[d](),new Promise((t,e)=>setTimeout(()=>{f.abort(),e(new Error("20 秒没有读完响应体"))},2e4))])}catch(t){return clearTimeout(V),void m(`Download failed: ${t}`)}'

/**
 * 第十二节：缓存时限的定时器要在 get / put 完成后清掉（2026-11-11）。
 *
 * 第十、十一节用 `Promise.race([get(), new Promise(r => setTimeout(..., 15e3))])`，定时器**从不清除**：
 * get 早就回来了，15 秒后定时器照样触发，打 `__8bgCacheDead` 并写 localStorage 的挂死标记（put 那条 10 秒同理）。
 * 后果：开局超过 15 秒的每一局都把这个浏览器记成「IndexedDB 挂死」，适配器之后 3 天关掉引擎缓存；
 * 关缓存的那一局 get 仍会调用，15 秒后又续一次标记——永远关着。孟加拉 Android 10《拳皇 2002》两局：
 * 核心 HTTP 缓存秒到，但每局都要重新解 7z（手机上约 12 秒），慢启动 20 秒，而以前第二局起是 0.7 秒。
 * 修法：settle 后 clearTimeout。挂死标记换成新键 `8bitgo.ejs.idbStall2`，旧键全是误判，直接作废。
 */
const CACHE_DEAD_MARK_V2 =
  'this.__8bgCacheDead=!0;try{localStorage.setItem("8bitgo.ejs.idbStall2",String(Date.now()))}catch(t){}'
const CACHE_GET_CLEAR_FROM = CACHE_GET_DEAD_TO
const CACHE_GET_CLEAR_TO =
  'this.storageCache&&!this.__8bgCacheDead&&(I=await (()=>{let __8bgT;return Promise.race([this.storageCache.get(t,!1,"url").catch(t=>(console.warn("[EJS Cache] get failed",t),null)),' +
  'new Promise(t=>{__8bgT=setTimeout(()=>{console.warn("[EJS Cache] get 超过 15 秒，本局停用缓存，改走网络");' + CACHE_DEAD_MARK_V2 + 't(null)},15e3)})]).finally(()=>clearTimeout(__8bgT))})());'
const CACHE_PUT_CLEAR_FROM = CACHE_PUT_DEAD_TO
const CACHE_PUT_CLEAR_TO =
  '!1===u&&!this.__8bgCacheDead&&await (()=>{let __8bgT;return Promise.race([this.storageCache.put(n).catch(t=>console.warn("[EJS Cache] put failed",t)),' +
  'new Promise(t=>{__8bgT=setTimeout(()=>{console.warn("[EJS Cache] put 超过 10 秒，本局停用缓存");' + CACHE_DEAD_MARK_V2 + 't()},1e4)})]).finally(()=>clearTimeout(__8bgT))})(),c(n)'
const CACHE_PUT_CLEAR_TO_COMPLETED = CACHE_PUT_CLEAR_TO.replace(
  ',c(n)',
  ',(__8bgResumeState&&__8bgCoreResume.complete(__8bgResumeState)),c(n)',
)
// 历史产物在等价的 catch 表达式上少了一层括号；接受该既有写法，保证补丁脚本可幂等重跑。
const CACHE_PUT_CLEAR_TO_LEGACY = CACHE_PUT_CLEAR_TO.replace(
  'catch(t=>(console.warn("[EJS Cache] put failed",t)))',
  'catch(t=>console.warn("[EJS Cache] put failed",t))',
)

/** 第十三节：exit 里不再卸载 /data/saves（卸载后排队的 autoPersist 会把整个 IndexedDB 存档库清空） */
const EXIT_UNMOUNT_FROM =
  'this.toggleMainLoop(0),this.FS.unmount("/data/saves"),setTimeout(()=>{try{this.Module.abort()}catch(t){console.warn(t)}},1e3)'
const EXIT_UNMOUNT_TO =
  'this.toggleMainLoop(0),setTimeout(()=>{try{this.Module.abort()}catch(t){console.warn(t)}},1e3)'

/**
 * 第十四节：游戏文件写进虚拟文件系统时让 MEMFS 直接接管那块数组，不再整份复制（2026-11-14）。
 *
 * 引擎 download() 拿到（或解压出）游戏字节后用 `FS.writeFile(path, bytes)` 写进 MEMFS；不带 canOwn 时
 * MEMFS 会 `slice` 一份新的，开局那一刻同一份 ROM 在 JS 侧就有两份。2GB 内存的 Android 手机开 64MB 的
 * NDS ROM（《使命召唤：战争世界》），核心把 ROM 读进 WASM 堆时堆长不动，melonDS DS 和兼容核心都只剩一句
 * `Aborted()`。canOwn 后 MEMFS 的文件内容就是这块数组，引擎之后只读不写它（缓存写 IndexedDB 是结构化克隆）。
 */
const GAME_WRITE_FROM = '(this.gameManager.FS.writeFile(`/${t}`,e),t)};if(o&&o.files)'
const GAME_WRITE_TO = '(this.gameManager.FS.writeFile(`/${t}`,e,{canOwn:!0}),t)};if(o&&o.files)'

/**
 * 每组：name 显示用；patches 是 [要找的原文, 替换后]；
 * legacy 可选，把「替换后」映射成更早一版补丁的样子，用来在引擎升级后接管旧补丁；
 * hint 是位置对不上时打给人看的排查思路。
 */
const GROUPS = [
  {
    name: '核心分片续传助手',
    patches: [[CORE_RESUME_INSERT_FROM, CORE_RESUME_INSERT_TO]],
    hint: [
      '在 Downloader 类前嵌入 scripts/lib/ejs-core-resume-runtime.js；',
      '助手只管带内容版本号的 EmulatorJS 核心 GET，IDB / Range 不可用时必须自动退回完整下载。',
    ],
  },
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
    name: '核心 WASM 直接使用已解压字节',
    patches: [[WASM_BINARY_FROM, WASM_BINARY_TO]],
    hint: [
      '在 initModule 的 Emscripten 配置里把已解压的 wasm Uint8Array 作为 wasmBinary 传入；',
      '核心二进制已经在内存里，不应再建 blob URL 并要求浏览器用 fetch 读回。',
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
    name: '街机 ROM 保持 zip（mame-current / FBNeo 自建变体）',
    patches: [[KEEP_ZIP_FROM, KEEP_ZIP_TO]],
    legacy: () => KEEP_ZIP_TO_V1,
    hint: [
      '在 download() 里找 `dontExtractIfCore?.includes(this.getCore())` 那个三元条件；',
      '把 mame-current / fbneo-lowmem / fbneo-wofcn 也判成「不解压」—— 否则 FBNeo 拿到散文件报 Romset is unknown。',
      '⚠️ 这一组没了的话，mame-current 的游戏 100% 起不来，且只有一句「Failed to start game」。',
    ],
  },
  {
    name: 'PS1 低内存核心沿用 PCSX 的 CUE 处理',
    patches: [[PSX_LOWMEM_CUE_FROM, PSX_LOWMEM_CUE_TO]],
    hint: [
      '在 determineCueSettings() 里找那份核心名单（第一个是 pcsx_rearmed）；',
      '把 pcsx_rearmed-lowmem 加在 pcsx_rearmed 后面。只改名单，不要把它加进 getCores 的 psx 组。',
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
  {
    name: '下载包体 20 秒无数据中止',
    patches: [[BODY_READ_FROM, BODY_READ_TO]],
    hint: [
      '在下载器 downloadFile 的 arraybuffer 分支找 y.body.getReader() 之后的 for(;;) 读循环；',
      '每次 read 前重置 20 秒定时器，超时调用同一个 AbortController（f）的 abort()。',
    ],
  },
  {
    name: '识别下载器自己的失速中止',
    patches: [[BODY_READ_STALL_FROM, BODY_READ_STALL_TO]],
    hint: [
      '在包体 20 秒空闲中止回调里，把本地 AbortController 标记为下载器主动失速；',
      'XHR 回退只允许由这类失速或真实流读取异常触发，外部取消仍须立即结束。',
    ],
  },
  {
    name: '核心响应直接拼接 Uint8Array',
    patches: [
      [BODY_READ_DIAGNOSTICS_FROM, BODY_READ_DIAGNOSTICS_TO],
      [ARRAYBUFFER_BLOB_FROM, ARRAYBUFFER_BLOB_TO],
    ],
    legacy: (to) => to === ARRAYBUFFER_BLOB_TO ? ARRAYBUFFER_BLOB_TO_V1 : undefined,
    hint: [
      'arraybuffer 下载已经拿到 Uint8Array 分块，不要再用 new Blob(chunks).arrayBuffer() 读回；',
      '直接按总字节数分配 Uint8Array 并顺序 set，读流异常同时输出原始错误对象。',
    ],
  },
  {
    name: '核心响应流失败或失速改走 XHR',
    patches: [[BODY_READ_DIAGNOSTICS_TO, BODY_READ_FALLBACK_TO]],
    // 未打过本节的旧引擎，或 79be63d 打出的语法错误版本
    legacy: () => [BODY_READ_FALLBACK_PREVIOUS, BODY_READ_FALLBACK_FROM, BODY_READ_FALLBACK_BROKEN],
    hint: [
      '在「核心响应直接拼接 Uint8Array」那段 catch 里：只对无请求体（o 为空）、非外部取消的下载，用 XHR arraybuffer 重下一次，',
      '校验响应状态、声明长度、已收字节下限与错误页类型后，才写回分块数组 n 与总长 i；截断响应不得进入 IndexedDB。',
      '下载器自己的失速中止允许这次 XHR 回退；后台隐藏期间暂停空闲计时，避免切回前台立即误中止。',
    ],
  },
  {
    name: '引擎缓存读写有时限',
    patches: [
      [CACHE_PUT_FROM, CACHE_PUT_TO],
      [CACHE_GET_FROM, CACHE_GET_TO],
      [IDB_OPEN_FROM, IDB_OPEN_TO],
      [IDB_PUT_FROM, IDB_PUT_TO],
      [IDB_DELETE_FROM, IDB_DELETE_TO],
      [IDB_GET_FROM, IDB_GET_TO],
      [BLOB_PUT_FROM, BLOB_PUT_TO],
      [BLOB_GET_FROM, BLOB_GET_TO],
      [BLOB_DELETE_FROM, BLOB_DELETE_TO],
    ],
    hint: [
      '下载器里 storageCache.get(t,!1,"url") / storageCache.put(n) 两处 await 用 Promise.race 加时限；',
      'IndexedDB 封装（getObjectStore / get / put / remove 与 blob 表三个助手）里的同步异常收成「没有缓存」。',
    ],
  },
  {
    name: '核心不回落官方 CDN',
    patches: [[CORE_CDN_FROM, CORE_CDN_TO]],
    hint: [
      '在 downloadType 表里找 core:{...cdnFallback:!0}，改成 !1；',
      'cdn.emulatorjs.org/4.3.0-pre 的核心起不来（AGENTS §2.4），回落只会多等再报错。',
    ],
  },

  {
    name: '缓存挂死一次就停用 + HEAD / 文本包体时限',
    patches: [
      [CACHE_GET_DEAD_FROM, CACHE_GET_DEAD_TO],
      [CACHE_PUT_DEAD_FROM, CACHE_PUT_DEAD_TO],
      [HEAD_REVALIDATE_FROM, HEAD_REVALIDATE_TO],
      [TEXT_BODY_FROM, TEXT_BODY_TO],
    ],
    hint: [
      '必须排在「引擎缓存读写有时限」之后：前两条找的是那一组打完后的文本；',
      '下载器里缓存过期复验的 fetch(t,{method:"HEAD"...}) 与非 arraybuffer 分支的 y[d]() 各加时限。',
    ],
  },

  {
    name: '缓存时限定时器用完即清',
    patches: [
      [CACHE_GET_CLEAR_FROM, CACHE_GET_CLEAR_TO],
      [CACHE_PUT_CLEAR_FROM, CACHE_PUT_CLEAR_TO],
    ],
    hint: [
      '必须排在「缓存挂死一次就停用」之后：找的是那一组打完后的文本；',
      'race 结束后 clearTimeout，否则 get / put 成功 15 / 10 秒后照样把缓存判死并写挂死标记。',
    ],
  },

  {
    name: '核心断点续传与持久化',
    patches: [
      [CORE_RESUME_STATE_FROM, CORE_RESUME_STATE_TO],
      [CORE_FETCH_FROM, CORE_FETCH_TO],
      [CORE_READER_INIT_FROM, CORE_READER_INIT_TO],
      [BODY_READ_RESUME_FROM, BODY_READ_RESUME_TO],
      [CORE_COMPLETE_FROM, CORE_COMPLETE_TO],
    ],
    hint: [
      '只对版本化的 cores/*-wasm.data GET 加 Range；首片必须是从 0 到文件尾的完整 206，后续必须匹配 Content-Range / ETag。',
      'IndexedDB 只保存 1 MiB 完整片，最终片不落盘；恢复前先校验连续前缀，校验失败就取消 Range 并从头请求。',
      'XHR 只在验证 206 偏移、总长、ETag、MIME 后拼接；Range 不兼容时最多追加一次完整 GET。',
    ],
    legacy: (to) => to === CORE_FETCH_TO ? CORE_FETCH_TO_PREVIOUS : to === CORE_READER_INIT_TO ? CORE_READER_INIT_TO_PREVIOUS : to === BODY_READ_RESUME_TO ? BODY_READ_RESUME_TO_PREVIOUS : undefined,
  },

  {
    name: '核心响应头超时改走 XHR',
    patches: [
      [CORE_FETCH_TO, CORE_FETCH_HEADER_FALLBACK_TO],
      [BODY_READ_RESUME_TO, BODY_READ_HEADER_FALLBACK_TO],
    ],
    legacy: (to) => to === CORE_FETCH_HEADER_FALLBACK_TO ? CORE_FETCH_HEADER_FALLBACK_TO_PREVIOUS : undefined,
    hint: [
      '只对带版本号的核心请求，在本地响应头时限触发，或 TypeError 且 Resource Timing 按内容哈希证明整份文件已传完时改走 XHR；普通网络错误、部分传输和外部取消仍直接失败。',
      'XHR 必须匹配按核心内容哈希生成的完整字节数，再构造 200 Response 走原有校验；流回退只放行本地响应头超时。',
    ],
  },

  {
    name: '游戏文件写 MEMFS 不复制',
    patches: [[GAME_WRITE_FROM, GAME_WRITE_TO]],
    hint: [
      '在 download() 末尾找写游戏文件的那个箭头函数（建中间目录后 FS.writeFile(`/${t}`,e)，紧跟 if(o&&o.files) 循环）；',
      '给 writeFile 加第三个参数 {canOwn:!0}，见头注释第十四节。',
    ],
  },
  {
    name: '退出时不卸载 /data/saves',
    patches: [[EXIT_UNMOUNT_FROM, EXIT_UNMOUNT_TO]],
    hint: [
      '在 gameManager 构造里找 this.EJS.on("exit",…)：saveSaveFiles / restart / toggleMainLoop(0) 之后那句 FS.unmount("/data/saves")；',
      '删掉它。卸载后 autoPersist 排队的 syncfs 会把 IndexedDB 里所有电池存档当成「已删除」清空（见头注释第十三节）。',
    ],
  },

]

// 被后面各节在原地改写过的补丁：值是所有更新的写法
const SUPERSEDED = new Map([
  [CORE_FETCH_TO, [CORE_FETCH_HEADER_FALLBACK_TO_PREVIOUS, CORE_FETCH_HEADER_FALLBACK_TO]],
  [BODY_READ_RESUME_TO, [BODY_READ_HEADER_FALLBACK_TO]],
  [BODY_READ_TO, [BODY_READ_DIAGNOSTICS_TO, BODY_READ_FALLBACK_FROM, BODY_READ_FALLBACK_PREVIOUS, BODY_READ_FALLBACK_TO, BODY_READ_RESUME_TO, BODY_READ_RESUME_TO_PREVIOUS, BODY_READ_HEADER_FALLBACK_TO, BODY_READ_FALLBACK_BROKEN]],
  [BODY_READ_DIAGNOSTICS_TO, [BODY_READ_FALLBACK_FROM, BODY_READ_FALLBACK_PREVIOUS, BODY_READ_FALLBACK_TO, BODY_READ_RESUME_TO, BODY_READ_RESUME_TO_PREVIOUS, BODY_READ_HEADER_FALLBACK_TO, BODY_READ_FALLBACK_BROKEN]],
  [BODY_READ_FALLBACK_FROM, [BODY_READ_FALLBACK_PREVIOUS, BODY_READ_FALLBACK_TO, BODY_READ_RESUME_TO, BODY_READ_RESUME_TO_PREVIOUS, BODY_READ_HEADER_FALLBACK_TO]],
  [BODY_READ_FALLBACK_TO, [BODY_READ_RESUME_TO, BODY_READ_RESUME_TO_PREVIOUS, BODY_READ_HEADER_FALLBACK_TO]],
  [CACHE_GET_TO, [CACHE_GET_DEAD_TO, CACHE_GET_CLEAR_TO]],
  [CACHE_PUT_TO, [CACHE_PUT_DEAD_TO, CACHE_PUT_CLEAR_TO, CACHE_PUT_CLEAR_TO_LEGACY, CACHE_PUT_CLEAR_TO_COMPLETED]],
  [CACHE_GET_DEAD_TO, [CACHE_GET_CLEAR_TO]],
  [CACHE_PUT_DEAD_TO, [CACHE_PUT_CLEAR_TO, CACHE_PUT_CLEAR_TO_LEGACY, CACHE_PUT_CLEAR_TO_COMPLETED]],
  [CACHE_PUT_CLEAR_TO, [CACHE_PUT_CLEAR_TO_COMPLETED]],
])

let src = readFileSync(file, 'utf8')
let changed = false
const report = []

// 助手独立成源码文件。每次 ejspatch 都同步内嵌副本，避免后续安全修复只改到一份。
const embeddedHelperStart = src.indexOf(CORE_RESUME_HELPER_START)
if (embeddedHelperStart >= 0) {
  const embeddedHelperEnd = src.indexOf(CORE_RESUME_INSERT_FROM, embeddedHelperStart)
  if (embeddedHelperEnd < 0) {
    console.error('✖ 找到核心续传助手起始标记，但找不到 Downloader 类；没有写盘。')
    process.exit(1)
  }
  const embeddedHelper = src.slice(embeddedHelperStart, embeddedHelperEnd).trimEnd()
  if (embeddedHelper !== CORE_RESUME_HELPER) {
    src = src.slice(0, embeddedHelperStart) + CORE_RESUME_HELPER + '\n' + src.slice(embeddedHelperEnd)
    changed = true
  }
}

for (const group of GROUPS) {
  let applied = 0
  let already = 0
  for (const [from, to] of group.patches) {
    // 被后面的组在原地改写过的补丁（第十 → 十一 → 十二节）也算已在位
    if (src.includes(to) || (SUPERSEDED.get(to) ?? []).some((later) => src.includes(later))) {
      already++
      continue
    }
    const legacyPatched = group.legacy?.(to)
    const legacySources = Array.isArray(legacyPatched) ? legacyPatched : [legacyPatched]
    const source = legacySources.find((candidate) => candidate && src.includes(candidate)) ?? from
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

if (changed) {
  // 写盘前真解析一遍：补丁字符串拼错（例如正则里裸 `/`）时引擎整份 import 失败，别把它写进 public/
  const { moduleSyntaxError } = await import('./lib/js-module-syntax.mjs')
  const syntaxError = moduleSyntaxError(src)
  if (syntaxError) {
    console.error(`✖ 打完补丁的 emulator.min.js 无法按 ES 模块解析：${syntaxError}`)
    console.error('  没有写盘。检查本文件里刚改的补丁字符串。')
    process.exit(1)
  }
  writeFileSync(file, src)
}
for (const line of report) console.log(`✔ ${line}`)

/*
  引擎入口按内容取版本（src/emulator/ejsCoreVersionsData.ts）。补丁改了 emulator.min.js 就顺手重生成表，
  省掉以前「打完补丁还要记得换 EJS_RUNTIME_GENERATION」这一步；没改动时生成结果不变，幂等。
*/
{
  const { spawnSync } = await import('node:child_process')
  const gen = fileURLToPath(new URL('./gen-ejs-core-versions.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [gen], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
