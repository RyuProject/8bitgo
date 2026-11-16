# EKA2L1-WEB（8BitGo 自托管构建）

本目录是 [EKA2L1-WEB](https://github.com/zixing131/EKA2L1-WEB/tree/e727af5df7afd6a45e1aea198e0fc81a0ee9bfe1)（GNU AGPL-3.0）提交
`e727af5df7afd6a45e1aea198e0fc81a0ee9bfe1` 的构建，工具链 emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 7.0.0 (777e6e5db7b4990bcaeb1b9998ed642cc84e6629)。
许可证文本随本目录的 `LICENSE` 一并提供。

对应源码 = 上游该提交 + 本目录 `source/` 中随附的本站补丁和构建脚本。
补丁表：[`source/scripts/lib/eka2l1-patches.mjs`](source/scripts/lib/eka2l1-patches.mjs)；
构建脚本：[`source/scripts/build-eka2l1-web.mjs`](source/scripts/build-eka2l1-web.mjs)。

- **network-relay-off**（src/emu/web/src/web_network.js）：默认不再把游戏内 TCP 转发到上游作者的中继 wss://qq.zixing.fun/ws/tcp（玩家流量不应经过第三方）；未配置中继时 connect 立即以「连接被拒」失败，游戏不会卡在联网等待。
- **locale-fallback-english**（src/emu/web/pages/js/i18n.js）：浏览器语言既不是中文也不是英文时（德 / 法 / 日 / 西 / 意语访客）显示英文界面，而不是中文。
- **no-service-worker-library**（src/emu/web/pages/index.html）：不注册 Service Worker：本站服务端已发 COOP/COEP，运行时目录按内容哈希版本化并长期缓存；SW 只会在 Cache Storage 再存一份 11MB wasm，并让更新多一层缓存。
- **no-service-worker-player**（src/emu/web/pages/run.html）：同上（播放页）。
- **watcher-vector-include**（src/emu/common/include/common/watcher.h）：该公共头直接声明 std::vector 别名；没有自包含 vector 头时，WASM 的编译单元顺序会触发未声明类型错误。
- **exclusive-monitor-algorithm-include**（src/emu/cpu/src/12l1r/exclusive_monitor.cpp）：clear_exclusive() 调用 std::fill；显式包含 algorithm，避免依赖偶然的传递包含。
- **page-table-algorithm-include**（src/emu/mem/src/page.cpp）：page_directory::reset() 调用 std::fill；显式包含 algorithm，避免依赖传递头文件。
- **container-type-traits-include**（src/emu/common/include/common/container.h）：ring_buffer 直接使用 std::is_trivial_v；显式包含 type_traits，避免编译结果依赖偶然的传递包含。
- **pvrt-dec-cstdlib-include**（src/emu/drivers/src/graphics/backend/ogl/pvrt-dec.cpp）：纹理解码器直接调用 malloc/free；显式包含 cstdlib，避免依赖其他图形头文件的传递包含。
- **ini-cstdlib-include**（src/emu/common/include/common/ini.h）：INI 转换直接调用 std::strtoll/std::atoll；显式包含 cstdlib，避免 WebAssembly 工具链下符号未声明。
- **identity-container-iterator-equality**（src/emu/common/include/common/container.h）：identity_container::iterator 被 std::find_if 使用，但缺少 const operator==；libc++ 据标准实现算法时无法比较迭代器。
- **capstone-cmake4**（patches/external/capstone-wasm.patch）：更新最低 CMake 版本并将 CMP0048 设为 NEW，避免 CMake 4 移除 OLD 策略后配置中止。
- **fmt-wasm-consteval**（patches/external/fmt-wasm.patch）：允许 Emscripten 编译参数关闭 fmt 的 consteval 路径；当前工具链在该路径出现常量表达式编译错误。
- **yaml-cpp-wasm-locale**（patches/external/yaml-cpp-wasm.patch）：WASM 下用 snprintf 代替会构造 std::locale 的 stringstream，避免模拟器启动期崩溃。

Emscripten 子模块补丁原文和应用说明随包提供于 `source/patches/external/`。

8BitGo 还附带 `source/scripts/eka2l1-default-firmware.js`：从本站说明页进入时，若当前浏览器尚无已安装设备，则自动取回后台配置的 N-Gage QD ROM 并调用原有固件安装流程。已有设备不会被覆盖；ROM 只保存在玩家自己的浏览器存储中。

仅后台管理员配置的 N-Gage QD 默认 ROM 会由站点供首次自动安装；其它固件（ROM / RPKG）和游戏安装包由玩家自行提供，内容保存在玩家本机浏览器中。运行时发布包不包含任何固件或游戏文件。
