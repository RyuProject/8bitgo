/**
 * 8BitGo 对 EKA2L1-WEB 的修改表（AGPL-3.0 对应源码的一部分，见发布目录的 SOURCE.md）。
 *
 * 每条 replace 是 [上游原文, 替换后]，构建脚本要求原文恰好命中一次。
 * 上游升级时逐条复核：命中数不对说明代码变了，要重新判断这条修改是否还需要。
 */
export const EKA2L1_UPSTREAM = 'https://github.com/zixing131/EKA2L1-WEB'
export const EKA2L1_UPSTREAM_COMMIT = 'e727af5df7afd6a45e1aea198e0fc81a0ee9bfe1'

export const EKA2L1_PATCHES = [
  {
    id: 'network-relay-off',
    file: 'src/emu/web/src/web_network.js',
    why: '默认不再把游戏内 TCP 转发到上游作者的中继 wss://qq.zixing.fun/ws/tcp（玩家流量不应经过第三方）；'
      + '未配置中继时 connect 立即以「连接被拒」失败，游戏不会卡在联网等待。',
    replace: [
      [
        "            || 'wss://qq.zixing.fun/ws/tcp';",
        "            || '';",
      ],
      [
        '            const socket = { connected: false, closed: false, timer: null };\n'
        + '            sockets.set(id, socket);\n',
        '            const socket = { connected: false, closed: false, timer: null };\n'
        + '            sockets.set(id, socket);\n'
        + '            // 8BitGo：没有配置中继 = 不联网。异步失败（fail 走 queueMicrotask），不重入内核。\n'
        + '            if (!endpoint()) { fail(id, -34); return; }\n',
      ],
    ],
  },
  {
    id: 'locale-fallback-english',
    file: 'src/emu/web/pages/js/i18n.js',
    why: '浏览器语言既不是中文也不是英文时（德 / 法 / 日 / 西 / 意语访客）显示英文界面，而不是中文。',
    replace: [[
      "            if (l.indexOf('en') === 0) return 'en-US';\n        }\n        return FALLBACK_LOCALE;",
      "            if (l.indexOf('en') === 0) return 'en-US';\n        }\n        return 'en-US'; // 8BitGo：非中文访客默认英文",
    ]],
  },
  {
    id: 'no-service-worker-library',
    file: 'src/emu/web/pages/index.html',
    why: '不注册 Service Worker：本站服务端已发 COOP/COEP，运行时目录按内容哈希版本化并长期缓存；'
      + 'SW 只会在 Cache Storage 再存一份 11MB wasm，并让更新多一层缓存。',
    replace: [[
      "if ('serviceWorker' in navigator) {",
      "if (false && 'serviceWorker' in navigator) { // 8BitGo：不注册 SW",
    ]],
  },
  {
    id: 'no-service-worker-player',
    file: 'src/emu/web/pages/run.html',
    why: '同上（播放页）。',
    replace: [[
      "if ('serviceWorker' in navigator) {",
      "if (false && 'serviceWorker' in navigator) { // 8BitGo：不注册 SW",
    ]],
  },
  {
    id: 'idbfs-current-emscripten',
    file: 'src/emu/web/pages/js/boot.js',
    why: '本站用 emcc 7 构建，胶水里已经没有 FS.filesystems，IDBFS 的 DB_VERSION / DB_STORE_NAME 也成了模块内常量；'
      + '上游 boot.js 照旧挂载 mod.FS.filesystems.IDBFS，核心一启动就报 Cannot read properties of undefined (reading \'IDBFS\')，'
      + '玩家安装固件的第一步就失败（2026-11-19 线上复现）。改为优先取 Module.IDBFS（由 idbfs-module-export 导出），'
      + '数据库版本与存储名缺省时用胶水里的 21 / FILE_DATA，与 savePaths 等直写 IndexedDB 的代码一致。',
    replace: [
      [
        '    function patchIDBFS(mod) {\n'
        + '        var IDBFS = mod.FS.filesystems && mod.FS.filesystems.IDBFS;',
        '    // 8BitGo：新版 Emscripten 去掉了 FS.filesystems，IDBFS 由胶水导出为 Module.IDBFS\n'
        + '    function idbfsOf(mod) {\n'
        + '        return mod.IDBFS || (mod.FS.filesystems && mod.FS.filesystems.IDBFS) || null;\n'
        + '    }\n\n'
        + '    function patchIDBFS(mod) {\n'
        + '        var IDBFS = idbfsOf(mod);',
      ],
      [
        '                req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);',
        '                req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION || 21);',
      ],
      [
        '                var store = db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)\n'
        + '                    ? tx.objectStore(IDBFS.DB_STORE_NAME)\n'
        + '                    : db.createObjectStore(IDBFS.DB_STORE_NAME);',
        "                var storeName = IDBFS.DB_STORE_NAME || 'FILE_DATA';\n"
        + '                var store = db.objectStoreNames.contains(storeName)\n'
        + '                    ? tx.objectStore(storeName)\n'
        + '                    : db.createObjectStore(storeName);',
      ],
      [
        "                mod.FS.mount(mod.FS.filesystems.IDBFS, {}, '/eka2l1');",
        '                var idbfs = idbfsOf(mod);\n'
        + "                if (!idbfs) throw new Error('IDBFS is missing from this EKA2L1 build');\n"
        + "                mod.FS.mount(idbfs, {}, '/eka2l1');",
      ],
    ],
  },
  {
    id: 'watcher-vector-include',
    file: 'src/emu/common/include/common/watcher.h',
    why: '该公共头直接声明 std::vector 别名；没有自包含 vector 头时，WASM 的编译单元顺序会触发未声明类型错误。',
    replace: [[
      '#include <tuple>',
      '#include <tuple>\n#include <vector>',
    ]],
  },
  {
    id: 'exclusive-monitor-algorithm-include',
    file: 'src/emu/cpu/src/12l1r/exclusive_monitor.cpp',
    why: 'clear_exclusive() 调用 std::fill；显式包含 algorithm，避免依赖偶然的传递包含。',
    replace: [[
      '#include <cpu/12l1r/exclusive_monitor.h>',
      '#include <algorithm>\n#include <cpu/12l1r/exclusive_monitor.h>',
    ]],
  },
  {
    id: 'page-table-algorithm-include',
    file: 'src/emu/mem/src/page.cpp',
    why: 'page_directory::reset() 调用 std::fill；显式包含 algorithm，避免依赖传递头文件。',
    replace: [[
      '#include <mem/page.h>',
      '#include <algorithm>\n#include <mem/page.h>',
    ]],
  },
  {
    id: 'container-type-traits-include',
    file: 'src/emu/common/include/common/container.h',
    why: 'ring_buffer 直接使用 std::is_trivial_v；显式包含 type_traits，避免编译结果依赖偶然的传递包含。',
    replace: [[
      '#include <limits>',
      '#include <limits>\n#include <type_traits>',
    ]],
  },
  {
    id: 'pvrt-dec-cstdlib-include',
    file: 'src/emu/drivers/src/graphics/backend/ogl/pvrt-dec.cpp',
    why: '纹理解码器直接调用 malloc/free；显式包含 cstdlib，避免依赖其他图形头文件的传递包含。',
    replace: [[
      '#include <cstdint>',
      '#include <cstdint>\n#include <cstdlib>',
    ]],
  },
  {
    id: 'ini-cstdlib-include',
    file: 'src/emu/common/include/common/ini.h',
    why: 'INI 转换直接调用 std::strtoll/std::atoll；显式包含 cstdlib，避免 WebAssembly 工具链下符号未声明。',
    replace: [[
      '#include <cstdint>',
      '#include <cstdint>\n#include <cstdlib>',
    ]],
  },
  {
    id: 'identity-container-iterator-equality',
    file: 'src/emu/common/include/common/container.h',
    why: 'identity_container::iterator 被 std::find_if 使用，但缺少 const operator==；libc++ 据标准实现算法时无法比较迭代器。',
    replace: [[
      '            bool operator!=(const iterator &ite) {\n'
        + '                return ite_ != ite.ite_;\n'
        + '            }',
      '            // libc++ 的标准算法会用 == 比较迭代器；同时比较所属容器，避免跨容器误判。\n'
        + '            bool operator==(const iterator &ite) const {\n'
        + '                return (container_ == ite.container_) && (ite_ == ite.ite_);\n'
        + '            }\n\n'
        + '            bool operator!=(const iterator &ite) const {\n'
        + '                return !(*this == ite);\n'
        + '            }',
    ]],
  },
]

/** EKA2L1-WEB 已提交的 Emscripten 子模块补丁；全新检出后必须重打，不能依赖开发机里的残留修改。 */
export const EKA2L1_EXTERNAL_PATCHES = [
  {
    id: 'capstone-cmake4',
    file: 'patches/external/capstone-wasm.patch',
    target: 'src/external/capstone',
    why: '更新最低 CMake 版本并将 CMP0048 设为 NEW，避免 CMake 4 移除 OLD 策略后配置中止。',
  },
  {
    id: 'fmt-wasm-consteval',
    file: 'patches/external/fmt-wasm.patch',
    target: 'src/external/fmt',
    why: '允许 Emscripten 编译参数关闭 fmt 的 consteval 路径；当前工具链在该路径出现常量表达式编译错误。',
  },
  {
    id: 'yaml-cpp-wasm-locale',
    file: 'patches/external/yaml-cpp-wasm.patch',
    target: 'src/external/yaml-cpp',
    why: 'WASM 下用 snprintf 代替会构造 std::locale 的 stringstream，避免模拟器启动期崩溃。',
  },
]

/**
 * 对 Emscripten 链接产物（bin/ 里的胶水 JS）的文本修改。完整构建在链接后打，
 * 只换前端的重新打包（repackage-eka2l1-web.mjs）对已发布的同一份胶水打，两边走同一个 applyReplacePatch。
 */
export const EKA2L1_GLUE_PATCHES = [
  {
    id: 'idbfs-module-export',
    file: 'eka2l1.js',
    why: '胶水（Emscripten 链接产物）只把 FS 挂到 Module 上，没有导出 IDBFS，新版 Emscripten 又去掉了 FS.filesystems，'
      + 'boot.js 没有别的途径拿到 IDBFS 去挂载 /eka2l1。在 Module.FS 旁边一并导出 Module.IDBFS。',
    replace: [['Module["FS"]=FS;', 'Module["FS"]=FS;Module["IDBFS"]=IDBFS;']],
  },
]

export const EKA2L1_ALL_PATCHES = [...EKA2L1_PATCHES, ...EKA2L1_GLUE_PATCHES, ...EKA2L1_EXTERNAL_PATCHES]

/** 已发布页面在发布目录里的相对路径；不是页面文件（C++ 等）返回空串 */
export function eka2l1PublishedPagePath(patchFile) {
  const prefix = 'src/emu/web/pages/'
  return patchFile.startsWith(prefix) ? patchFile.slice(prefix.length) : ''
}

/**
 * 打一条 replace 补丁：替换后的文本已在就跳过（幂等），否则原文必须恰好命中一次。
 * 返回新文本；命中数不对时抛错，说明上游 / 产物变了，要重新判断这条修改。
 */
export function applyReplacePatch(text, patch) {
  let out = text
  for (const [from, to] of patch.replace) {
    if (out.includes(to)) continue
    const hits = out.split(from).length - 1
    if (hits !== 1) throw new Error(`补丁「${patch.id}」在 ${patch.file} 命中 ${hits} 次（应为 1）`)
    out = out.replace(from, () => to)
  }
  return out
}
