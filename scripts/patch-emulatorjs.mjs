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
 * ── 十、下载不会永远停在「下载游戏核心 100%」（2026-11-10）─────────────
 * 后台 14 天：境外 / 大陆合计 30 多次「加载在『下载游戏核心 N%』这一步停住了」（拳皇 2002 哥伦比亚、
 * 拳皇 97 等）。引擎的下载器有三处会让 Promise 永远不结束，进度文字就停在最后一次的百分比：
 *
 * 1. 30 秒超时（AbortController）在**拿到响应头就清掉**，读包体的 `reader.read()` 没有任何时限：
 *    跨洲线路丢了最后几个包 / 连接半开时，进度到 100% 却等不来流结束。改成每收到一块就重新计时，
 *    20 秒没有新字节就 abort → 下载器报错 → 适配器 failLoad → 播放器自动重试一次。
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
  {
    name: '下载包体 20 秒无数据中止',
    patches: [[BODY_READ_FROM, BODY_READ_TO]],
    hint: [
      '在下载器 downloadFile 的 arraybuffer 分支找 y.body.getReader() 之后的 for(;;) 读循环；',
      '每次 read 前重置 20 秒定时器，超时调用同一个 AbortController（f）的 abort()。',
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

]

// 被后面各节在原地改写过的补丁：值是所有更新的写法
const SUPERSEDED = new Map([
  [CACHE_GET_TO, [CACHE_GET_DEAD_TO, CACHE_GET_CLEAR_TO]],
  [CACHE_PUT_TO, [CACHE_PUT_DEAD_TO, CACHE_PUT_CLEAR_TO]],
  [CACHE_GET_DEAD_TO, [CACHE_GET_CLEAR_TO]],
  [CACHE_PUT_DEAD_TO, [CACHE_PUT_CLEAR_TO]],
])

let src = readFileSync(file, 'utf8')
let changed = false
const report = []

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
