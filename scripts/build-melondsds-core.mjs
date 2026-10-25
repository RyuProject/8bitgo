#!/usr/bin/env node
/**
 * 把 melonDS DS v1.4.0 编成 8BitGo 可直接加载的 EmulatorJS 核心。
 *
 * 为什么不直接拿 libretro buildbot：它发的是桌面动态库，不是 Emscripten bitcode；
 * EmulatorJS 还要把核心和自己的 RetroArch 前端二次链接、打成 `.data`。
 *
 * 用法：
 *   npm run build:melondsds
 *   node scripts/build-melondsds-core.mjs --workdir /tmp/melondsds-build --jobs 6
 *
 * 产物：
 *   public/emulatorjs/cores/melondsds-wasm.data
 *   public/emulatorjs/cores/reports/melondsds.json
 *
 * 普通游戏页没有全站 COOP/COEP，因此这里故意构建非 pthread 软件渲染版：
 * 关 JIT / OpenGL / threaded renderer，保留 libslirp 间接联网。这是兼容性选择，
 * 不是把一个能直接发的「快版」故意关掉。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')

const CORE_REPO = 'https://github.com/JesseTG/melonds-ds.git'
const CORE_TAG = 'v1.4.0'
const CORE_VERSION = '1.4.0'
const CORE_COMMIT = 'f394adbacb5722ee97c1b37c8064da9a25818310'
const RETROARCH_REPO = 'https://github.com/EmulatorJS/RetroArch.git'
const RETROARCH_COMMIT = '1eb5edf2b3becf0a7b29520a34545628db0c5416'
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git'
const EMSDK_VERSION = '3.1.74'

const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

function parseArgs(argv) {
  const args = {
    workdir: '/tmp/melondsds-build',
    output: join(repoRoot, 'public/emulatorjs/cores'),
    jobs: 6,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--workdir') args.workdir = argv[++i]
    else if (arg === '--output') {
      const value = argv[++i]
      args.output = isAbsolute(value) ? value : join(repoRoot, value)
    } else if (arg === '--jobs') args.jobs = Number(argv[++i])
    else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1 || args.jobs > 32) throw new Error('--jobs 必须是 1–32 的整数')
  return args
}

function run(file, args, cwd, env) {
  console.log(`\n$ ${file} ${args.join(' ')}`)
  execFileSync(file, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: 'inherit' })
}

function runBash(command, cwd) {
  console.log(`\n$ ${command}`)
  execFileSync('/bin/bash', ['-lc', command], { cwd, stdio: 'inherit' })
}

/** 和 runBash 一样实时打印，同时把输出存进日志供链接后检查。 */
function runBashLogged(command, cwd, logFile) {
  console.log(`\n$ ${command}`)
  execFileSync('/bin/bash', ['-lc', `set -o pipefail; ( ${command} ) 2>&1 | tee ${q(logFile)}`], { cwd, stdio: 'inherit' })
  return readFileSync(logFile, 'utf8')
}

/**
 * wasm-ld 遇到「同名函数签名不一致」只给 warning，然后把调用替换成 unreachable 桩——
 * 构建照样成功，包在玩家点到那条路径时才 `RuntimeError: unreachable`。核心与 RetroArch
 * 各带一份 libretro-common，这类问题以后还会出现，所以必须在出包前拦住。
 */
function assertNoSignatureMismatch(log) {
  const lines = log.split('\n')
  const pick = (re) => [...new Set(lines.filter((line) => re.test(line)).map((line) => line.trim()))]
  const mismatches = pick(/function signature mismatch/i)
  if (mismatches.length) {
    throw new Error(`最终链接出现函数签名不一致，这些调用会在运行时变成 unreachable：\n${mismatches.join('\n')}`)
  }
  /*
    Makefile.emulatorjs 用 ERROR_ON_UNDEFINED_SYMBOLS=0：缺一个函数也照样出包，只在玩家走到
    那条路径时才 `Aborted(missing function: …)`。当前发布包里这类桩为 0，以后也不允许新增。
  */
  const undefinedSymbols = pick(/undefined symbol:/i)
  if (undefinedSymbols.length) {
    throw new Error(`最终链接存在未定义符号，运行到时会直接中止：\n${undefinedSymbols.join('\n')}`)
  }
}

/**
 * build-emulatorjs.sh 里写死了 `7z`；Homebrew 新的 sevenzip 只提供 `7zz`。缺 `7z` 时在工作目录放
 * 一个同名软链并加进 PATH，子进程（含 build-emulatorjs.sh）都能用。
 */
function ensureSevenZip(workdir) {
  const has = (name) => {
    try {
      return execFileSync('/usr/bin/env', ['which', name], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  if (has('7z')) return
  const alt = has('7zz') || has('7za')
  if (!alt) throw new Error('缺少构建工具 7z（macOS：brew install sevenzip 或 brew install p7zip）')
  const bin = join(workdir, 'bin')
  mkdirSync(bin, { recursive: true })
  rmSync(join(bin, '7z'), { force: true })
  symlinkSync(alt, join(bin, '7z'))
  process.env.PATH = `${bin}:${process.env.PATH}`
  console.log(`[tools] 用 ${alt} 充当 7z`)
}

/** RetroArch 仓库里的目录是小写 emulatorjs；macOS 默认大小写不敏感能蒙混，Linux / 区分大小写的卷会直接失败。 */
function emulatorJsDir(retroDir) {
  for (const name of ['emulatorjs', 'EmulatorJS']) {
    const dir = join(retroDir, name)
    if (existsSync(join(dir, 'build-emulatorjs.sh'))) return dir
  }
  throw new Error(`RetroArch 仓库里找不到 emulatorjs/build-emulatorjs.sh：${retroDir}`)
}

function needTool(name) {
  try {
    execFileSync('/usr/bin/env', ['which', name], { stdio: 'ignore' })
  } catch {
    throw new Error(`缺少构建工具 ${name}`)
  }
}

function checkoutExact(repo, url, commit) {
  if (!existsSync(join(repo, '.git'))) run('git', ['clone', '--filter=blob:none', '--no-checkout', url, repo])
  run('git', ['fetch', '--depth', '1', 'origin', commit], repo)
  run('git', ['checkout', '--detach', commit], repo)
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  if (actual !== commit) throw new Error(`${repo} 没有锁到 ${commit}`)
}

/** 上游版本变了就应该停下来重新审核，不能模糊替换后继续出包。 */
function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8')
  if (source.includes(after)) return
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`无法唯一匹配补丁：${path}`)
  }
  writeFileSync(path, source.replace(before, after))
}

/**
 * melonDS DS 自带的 libretro-common（fa8a1b5）把 `path_get_size` 声明成 `int64_t`，而 EmulatorJS
 * RetroArch 里同名函数仍是 `int32_t`。桌面版核心是独立动态库，各用各的；EmulatorJS 却把核心和
 * RetroArch 静态链进**同一个** wasm，同名 C 符号只留 RetroArch 那份。wasm 的函数类型连返回值
 * 宽度都要一致，wasm-ld 于是只报一条 warning，把 melonDS DS 的三处调用全部换成只有 `unreachable`
 * 的桩。发布包里实测：
 *   - 读系统目录（RegisterCoreOptions 扫 BIOS / 固件）时，只要目录里有一个普通文件就崩；
 *   - FlushFirmware 两个分支都直接崩：重置、卸载游戏、游戏改写固件（WFC 设置）后定时落盘都会触发。
 * 这就是线上 `RuntimeError: unreachable` 的来源。改走两边签名一致的 filestream API，
 * 并在最终链接时把这类 warning 升级成构建失败（见 assertNoSignatureMismatch）。
 */
const WEB_PATH_SIZE_HEADER = `#pragma once
// 8BitGo: EmulatorJS 把核心和 RetroArch 静态链接进同一个 wasm，path_get_size 会解析到 RetroArch
// 自带 libretro-common 的 int32_t 版本，与这里头文件的 int64_t 声明签名不符，wasm-ld 会把调用换成
// unreachable 桩。filestream_open / get_size / close 在两份 libretro-common 中签名一致。
#include <cstdint>
#include <streams/file_stream.h>

static inline int64_t melondsds_web_path_get_size(const char* path) noexcept {
    if (!path) return -1;
    RFILE* file = filestream_open(path, RETRO_VFS_FILE_ACCESS_READ, RETRO_VFS_FILE_ACCESS_HINT_NONE);
    if (!file) return -1;
    const int64_t size = filestream_get_size(file);
    filestream_close(file);
    return size;
}
`

function patchPathGetSizeAbi(coreDir) {
  writeFileSync(join(coreDir, 'src/libretro/retro/web_path_size.hpp'), WEB_PATH_SIZE_HEADER)
  const dirent = join(coreDir, 'src/libretro/retro/dirent.cpp')
  replaceOnce(dirent, '#include <compat/strl.h>\n', '#include <compat/strl.h>\n#include "web_path_size.hpp"\n')
  replaceOnce(dirent, 'current.size = path_get_size(filePath);', 'current.size = melondsds_web_path_get_size(filePath);')
  const tasks = join(coreDir, 'src/libretro/core/tasks.cpp')
  replaceOnce(tasks, '#include <streams/file_stream.h>\n', '#include <streams/file_stream.h>\n#include "../retro/web_path_size.hpp"\n')
  replaceOnce(tasks, 'path_get_size(firmwarePath.data())', 'melondsds_web_path_get_size(firmwarePath.data())')
  replaceOnce(tasks, 'path_get_size(wfcSettingsPath.data())', 'melondsds_web_path_get_size(wfcSettingsPath.data())')
  // 上游以后若在别处新增调用，这里必须停下来，而不是再发一个会在运行时 trap 的包。
  let grep = ''
  try {
    // 只认函数调用；Tracy 的 ZoneScopedN("path_get_size") 这种字符串不算
    grep = execFileSync('git', ['grep', '-n', '-E', '(^|[^A-Za-z0-9_])path_get_size[[:space:]]*\\(', '--', 'src/libretro'], { cwd: coreDir, encoding: 'utf8' })
  } catch (error) {
    // git grep 没有命中时退出码是 1，这正是期望的结果
    if (error?.status !== 1) throw error
  }
  const left = grep.split('\n').filter((line) => line && !line.includes('web_path_size.hpp'))
  if (left.length) throw new Error(`melonDS DS 仍直接调用 path_get_size（会被链成 unreachable）：\n${left.join('\n')}`)
}

function patchCore(coreDir) {
  patchPathGetSizeAbi(coreDir)
  /*
    RetroArch 读取 `.opt` 时只接受核心预先声明过的选项值。单纯写入随机 MAC 虽然能在
    文件里回读到，实际上会被回退成 firmware，全站仍共享同一默认地址。melonDS DS
    1.4.0 已有 macAddresses 动态选项骨架，但扫描目录处还是 TODO；只接入我们自己的
    17 字节地址文件，让核心先注册该值，再由原有 ParseNetworkOptions 解析。
  */
  replaceOnce(
    join(coreDir, 'src/libretro/config/config.cpp'),
    '                // TODO: Pick a particular file name and load MAC addresses from it (one per line)',
    `                // 8BitGo: WFC 客体身份先注册为合法核心选项，否则 RetroArch 会忽略 .opt 的值。
                if (string_ends_with(d.path, "/8bitgo-wfc-mac.txt")) {
                    if (auto address = config::ParseMacAddressFile(d)) {
                        macAddresses.emplace_back(MacAddressEntry{"8BitGo WFC identity", config::PrintMacAddress(*address)});
                    }
                }`,
  )
  /*
    melonDS DS 用 C++ 异常报告所有开局错误（加密 ROM、坏 ROM、DSi 专用游戏、缺 NAND…），再在
    LoadGame 里 catch 成错误画面。Emscripten 默认不编译 catch：发布包里没有任何
    __cxa_find_matching_catch，这些错误全部变成未捕获的 JS 异常（控制台只有一串数字），
    既没有错误画面，也不会触发兼容核心回退。只给前端开 JS 异常；模拟核心热路径保持原样。
  */
  replaceOnce(
    join(coreDir, 'src/libretro/CMakeLists.txt'),
    'configure_file("${CMAKE_CURRENT_SOURCE_DIR}/version.hpp.in"',
    'if (EMSCRIPTEN)\n    # 8BitGo: 让 LoadGame 里的 catch 真正生效（见 build-melondsds-core.mjs）\n    target_compile_options(melondsds_libretro PRIVATE -fexceptions)\nendif()\n\nconfigure_file("${CMAKE_CURRENT_SOURCE_DIR}/version.hpp.in"',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/CMakeLists.txt'),
    '    set(LIBRARY_TYPE MODULE)',
    '    # EmulatorJS 前端负责最终链接，这里先产出可合并的静态归档。\n    set(LIBRARY_TYPE STATIC)',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/net/net.hpp'),
    '        [[nodiscard]] std::vector<melonDS::AdapterData> GetAdapters() const noexcept;',
    '#ifdef HAVE_NETWORKING_DIRECT_MODE\n        [[nodiscard]] std::vector<melonDS::AdapterData> GetAdapters() const noexcept;\n#endif',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/net/net.cpp'),
    'vector<melonDS::AdapterData> MelonDsDs::NetState::GetAdapters() const noexcept',
    '#ifdef HAVE_NETWORKING_DIRECT_MODE\nvector<melonDS::AdapterData> MelonDsDs::NetState::GetAdapters() const noexcept',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/net/net.cpp'),
    '\nvoid MelonDsDs::NetState::Apply(const CoreConfig& config) noexcept',
    '\n#endif\n\nvoid MelonDsDs::NetState::Apply(const CoreConfig& config) noexcept',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/format.hpp'),
    '    template<>\n    struct formatter<MelonDsDs::FormattedPCapFlags>',
    '#ifdef HAVE_NETWORKING_DIRECT_MODE\n    template<>\n    struct formatter<MelonDsDs::FormattedPCapFlags>',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/format.hpp'),
    '    template<>\n    struct formatter<MelonDsDs::BiosType>',
    '#endif\n\n    template<>\n    struct formatter<MelonDsDs::BiosType>',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/format.cpp'),
    'auto fmt::formatter<MelonDsDs::FormattedPCapFlags>::format',
    '#ifdef HAVE_NETWORKING_DIRECT_MODE\nauto fmt::formatter<MelonDsDs::FormattedPCapFlags>::format',
  )
  replaceOnce(
    join(coreDir, 'src/libretro/format.cpp'),
    '\nauto fmt::formatter<MelonDsDs::BiosType>::format',
    '\n#endif\n\nauto fmt::formatter<MelonDsDs::BiosType>::format',
  )
}

/**
 * 1.4.0 锁定的 libretro-common 已能在 Emscripten 上探测到系统 mmap，却仍把
 * `__EMSCRIPTEN__` 列进“没有 sys/mman.h”的旧平台清单，结果它自己声明的 size_t off
 * 和工具链标准的 off_t 冲突。依赖由 CMake FetchContent 拉取，只能在 configure 后修正；
 * 让它走已经探测成功的系统 mmap，也避免维护一份重复且 ABI 不一致的 shim。
 */
function patchConfiguredDependencies(coreDir) {
  replaceOnce(
    join(coreDir, 'build-ejs/_deps/libretro-common-src/include/memmap.h'),
    ' || defined(__EMSCRIPTEN__)',
    ' /* Emscripten 使用系统 mmap ABI。 */',
  )
  patchMelonDsSlirpPoll(coreDir)
  patchMelonDsGpuInit(coreDir)
}

/**
 * Emscripten 的 SOCKFS 在 WebSocket OPEN 后只报告 POLLOUT(0x004)，而这里上游请求 / 检查
 * POLLWRNORM(0x100)。两者在桌面系统通常等价，在网页端并不等价：TCP 握手已完成，
 * libslirp 却永远等不到“可写”，游戏的 HTTP 请求一个字节都不会发出去，最终报 WFC 52200。
 * melonDS 源码由 CMake FetchContent 拉取，只能 configure 之后修；桌面平台保持原样。
 */
function patchMelonDsSlirpPoll(coreDir) {
  const slirp = join(coreDir, 'build-ejs/_deps/melonds-src/src/net/Net_Slirp.cpp')
  replaceOnce(slirp,
    '#include <poll.h>\n',
    '#include <poll.h>\n#ifdef __EMSCRIPTEN__\n#define MELONDS_SLIRP_POLL_WRITE POLLOUT\n#else\n#define MELONDS_SLIRP_POLL_WRITE POLLWRNORM\n#endif\n')
  replaceOnce(slirp, 'if (events & SLIRP_POLL_OUT) evt |= POLLWRNORM;',
    'if (events & SLIRP_POLL_OUT) evt |= MELONDS_SLIRP_POLL_WRITE;')
  replaceOnce(slirp, 'if (evt & POLLWRNORM) ret |= SLIRP_POLL_OUT;',
    'if (evt & MELONDS_SLIRP_POLL_WRITE) ret |= SLIRP_POLL_OUT;')
}

/**
 * melonDS（JesseTG/melonDS jtg/fix-uninitialized-opengl）的 GPU.h 里，`VRAMCaptureBlockFlags[16]`
 * 是唯一没有默认初始化的成员。GPU 构造函数第一件事就是 SetRenderer → SyncAllVRAMCaptures，
 * 而这时 `Rend` 还是 nullptr：只要这 16 个标志里有一个带着 IsCapture 位（0x8000），就会调用
 * `Rend->SyncVRAMCapture(...)`。在 wasm 里空指针读出的虚表槽是 0，结果就是
 * `RuntimeError: null function`（Firefox: indirect call to null）。
 *
 * NDS 对象有 4MB 多，new 出来的内存是否“干净”取决于堆里之前放过什么：加载 ROM 时的临时缓冲
 * 释放后被复用，标志位就是 ROM 的残留字节。所以它对具体 ROM 是确定性的——口袋妖怪 黑 每次都崩，
 * 白 一次都不崩。线上调用栈：wasm-function[2284]（GPU::SetRenderer）:0x183807 的 call_indirect，
 * 上层 2256 是 NDS 构造。
 *
 * 修法：标志数组零初始化（根因）；SyncAllVRAMCaptures 在没有渲染器时直接返回（兜底，
 * 万一以后别的路径在 Rend 建好前同步截图也不会再跳空指针）。
 */
function patchMelonDsGpuInit(coreDir) {
  const src = join(coreDir, 'build-ejs/_deps/melonds-src/src')
  replaceOnce(
    join(src, 'GPU.h'),
    '    u16 VRAMCaptureBlockFlags[16];',
    '    u16 VRAMCaptureBlockFlags[16] {}; // 8BitGo: 构造时 SyncAllVRAMCaptures 会读它，必须是 0',
  )
  replaceOnce(
    join(src, 'GPU.cpp'),
    'void GPU::SyncAllVRAMCaptures()\n{\n',
    'void GPU::SyncAllVRAMCaptures()\n{\n    if (!Rend) return; // 8BitGo: 构造期间还没有渲染器\n',
  )
}

function patchRetroArch(retroDir, jobs) {
  // 前端以 -fexceptions 编译，最终链接也必须带上，否则 catch 需要的运行时符号缺失（会被上面的守卫拦下）。
  replaceOnce(
    join(retroDir, 'Makefile.emulatorjs'),
    'ifneq (,$(findstring same_cdi,$(TARGET)))',
    '# 8BitGo: melonDS DS 前端需要 C++ 异常捕获\nifneq (,$(findstring melondsds,$(TARGET)))\n   LDFLAGS += -fexceptions\nendif\n\nifneq (,$(findstring same_cdi,$(TARGET)))',
  )
  // 部分浏览器的 devicePixelContentBoxSize 是 CSS 尺寸的 2 倍，window.devicePixelRatio 却报 1。
  // 画布据前者建好后，输入驱动若仍乘后者，右侧触屏的点击只会落在左半边；
  // 必须把“真实画布像素 / CSS 像素”的同一比例传给指针驱动。
  replaceOnce(
    join(retroDir, 'emscripten/library_platform_emscripten.js'),
    '{{{ makeSetValue("dpr", "0", "window.devicePixelRatio", "double") }}};',
    '{{{ makeSetValue("dpr", "0", "entry.contentRect.width > 0 ? width / entry.contentRect.width : window.devicePixelRatio", "double") }}};',
  )
  const script = join(emulatorJsDir(retroDir), 'build-emulatorjs.sh')
  replaceOnce(script, '  name=`echo "$f" | sed "s/\\(_libretro_emscripten\\|\\).bc$//"`', '  name=${f%_libretro_emscripten.bc}')
  const source = readFileSync(script, 'utf8')
  // 同一构建目录重跑时可能保留上次的 -jN；允许更换并行度，避免仅因 jobs 不同而拒绝重编修复。
  const next = source.replace(/(TARGET=\$\{name\}_libretro\.js -j)(?:\$\(nproc\)|\d+)/, `$1${jobs}`)
  if (next === source && !source.includes(`TARGET=\${name}_libretro.js -j${jobs}`)) {
    throw new Error('build-emulatorjs.sh 的并行度补丁位置已变')
  }
  writeFileSync(script, next)
}

function mergeArchives(coreDir, env) {
  const build = join(coreDir, 'build-ejs')
  const output = join(build, 'melondsds_libretro_emscripten.bc')
  const archives = [
    'src/libretro/melondsds_libretro.so',
    '_deps/melonds-build/src/libcore.a',
    '_deps/melonds-build/src/teakra/src/libteakra.a',
    'libretro-common.a',
    'libslirp.a',
    '_deps/fmt-build/libfmt.a',
    '_deps/glm-build/glm/libglm.a',
    '_deps/zlib-build/libz.a',
  ].map((path) => join(build, path))
  for (const archive of archives) if (!existsSync(archive)) throw new Error(`缺少链接输入：${archive}`)
  const mri = join(build, 'merge.mri')
  writeFileSync(mri, [`create ${output}`, ...archives.map((path) => `addlib ${path}`), 'save', 'end', ''].join('\n'))
  // emar 属于 EMSDK，不在普通 shell 的 PATH；这里必须沿用编译阶段同一套工具链环境，
  // 否则源码已经编完也会在归档合并的最后一步报 command not found。
  runBash(`${env} && emar -M < ${q(mri)}`, build)
  return output
}

/**
 * 新核心必须和新的 EJS_RUNTIME_GENERATION 一起发布。EmulatorJS 按 reports/*.json 的 buildStart
 * 判断 IndexedDB 里的核心缓存是否过期，而 .data 地址只带这个代号：代号不变时，边缘缓存可能
 * 还在回旧 .data，浏览器就会把**旧核心**存到**新 buildStart** 名下，此后一直用坏核心。
 */
function bumpRuntimeGeneration(sha256) {
  const file = join(repoRoot, 'src/emulator/paths.ts')
  const source = readFileSync(file, 'utf8')
  const re = /export const EJS_RUNTIME_GENERATION = '([^']*)'/
  const current = source.match(re)
  if (!current) throw new Error('src/emulator/paths.ts 里找不到 EJS_RUNTIME_GENERATION')
  const utcDay = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  // 中国凌晨仍是前一天 UTC；核心 SHA 已换代，也不要让代号里的日期倒退造成误判。
  const previousDay = current[1].match(/^(\d{8})-melondsds-/)?.[1] || ''
  const day = utcDay > previousDay ? utcDay : previousDay
  // 其它功能可能已经在代号尾部加了自己的缓存代次；重编 NDS 不能无声丢掉 PSX 等独立修复。
  const suffix = current[1].match(/^\d{8}-melondsds-[a-f0-9]{8}(.*)$/)?.[1] || ''
  const next = `${day}-melondsds-${sha256.slice(0, 8)}${suffix}`
  bumpNdsModernCoreBuild(sha256)
  bumpNdsEngineCacheGeneration(sha256)
  if (current[1] === next) return next
  writeFileSync(file, source.replace(re, `export const EJS_RUNTIME_GENERATION = '${next}'`))
  console.log(`[cache] EJS_RUNTIME_GENERATION ${current[1]} -> ${next}`)
  return next
}

function bumpNdsEngineCacheGeneration(sha256) {
  const file = join(repoRoot, 'src/emulator/adapters/emulatorjs.ts')
  const source = readFileSync(file, 'utf8')
  const re = /const EJS_CACHE_GENERATION = '([^']*)'/
  const current = source.match(re)
  if (!current) throw new Error('emulatorjs.ts 里找不到 EJS_CACHE_GENERATION')
  // 引擎的解压工件按文件名缓存在 IndexedDB；只换 .data URL 不一定会重新解压。
  // 每次 NDS 核心字节发生变化都自动换代，避免“源码修好但玩家仍运行旧 wasm”。
  const next = `${current[1].replace(/\.melondsds-core-[a-f0-9]{8}/, '')}.melondsds-core-${sha256.slice(0, 8)}`
  if (current[1] === next) return
  writeFileSync(file, source.replace(re, `const EJS_CACHE_GENERATION = '${next}'`))
  console.log(`[cache] EJS_CACHE_GENERATION ${current[1]} -> ${next}`)
}

/** “这份 ROM 在新核心上崩过”的本机记录按核心 sha 分桶；换核心后旧记录必须失效，玩家才会重新试新核心。 */
function bumpNdsModernCoreBuild(sha256) {
  const file = join(repoRoot, 'src/emulator/ndsCorePreference.ts')
  const source = readFileSync(file, 'utf8')
  const re = /export const NDS_MODERN_CORE_BUILD = '([^']*)'/
  const current = source.match(re)
  if (!current) throw new Error('src/emulator/ndsCorePreference.ts 里找不到 NDS_MODERN_CORE_BUILD')
  const next = sha256.slice(0, 16)
  if (current[1] === next) return
  writeFileSync(file, source.replace(re, `export const NDS_MODERN_CORE_BUILD = '${next}'`))
  console.log(`[cache] NDS_MODERN_CORE_BUILD ${current[1]} -> ${next}`)
}

function packageCore(args, coreDir, startedAt) {
  const raw = join(args.workdir, 'EmulatorJS/data/cores/melondsds-wasm.data')
  if (!existsSync(raw)) throw new Error(`EmulatorJS 没有产出 ${raw}`)

  const packageDir = join(args.workdir, 'package')
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(packageDir, { recursive: true })
  run('7z', ['x', '-y', `-o${packageDir}`, raw], args.workdir)
  /*
   * Emscripten 默认把每个 POSIX socket 都连向同一个 WebSocket URL，服务端因而不知道
   * 原本的协议 / 目标 IP / 端口。WFC 有 DNS(UDP) 和登录(TCP) 等多个目标，必须让
   * SOCKFS 在创建每条连接时调用前端提供的 URL 工厂；普通 NDS 离线游戏不受影响。
   * 精确匹配产物，升级 emsdk 后不允许静默打丢这个补丁。
   */
  const runtimeJs = join(packageDir, 'melondsds_libretro.js')
  const source = readFileSync(runtimeJs, 'utf8')
  const from = 'if(SOCKFS.websocketArgs["url"]){url=SOCKFS.websocketArgs["url"]}'
  const to = 'if(SOCKFS.websocketArgs["url"]){url=typeof SOCKFS.websocketArgs["url"]==="function"?SOCKFS.websocketArgs["url"](addr,port,sock.type,sock.stream.node.name):SOCKFS.websocketArgs["url"]}'
  if (!source.includes(from)) throw new Error('SOCKFS WebSocket URL 入口已变化，WFC 补丁未应用')
  writeFileSync(runtimeJs, source.replace(from, to))
  // 61020 发生在 GameSpy 挑战之后时，仅记录 29900 端口的入队/出队长度；
  // 开发环境可区分“中继收到了”与“客体真的读到了”，不打印挑战或账户报文。
  replaceOnce(runtimeJs,
    'sock.recv_queue.push({addr:peer.addr,port:peer.port,data});SOCKFS.emit("message",sock.stream.fd)',
    'sock.recv_queue.push({addr:peer.addr,port:peer.port,data});if(Module["wfcTrace"]&&peer.port===29900)console.info("[nds-wfc-core] gp queued",data.length);SOCKFS.emit("message",sock.stream.fd)')
  replaceOnce(runtimeJs,
    'var queued=sock.recv_queue.shift();if(!queued)',
    'var queued=sock.recv_queue.shift();if(Module["wfcTrace"]&&sock.dport===29900&&queued)console.info("[nds-wfc-core] gp read",queued.data.length);if(!queued)')
  /*
   * EJS RetroArch 1eb5edf 的 save_state_info() 把说明写在栈上的局部数组里返回；旧胶水却
   * free(说明) 又从不释放真正 malloc 的快照（melonDS DS 每次 19.7MB）。与
   * scripts/patch-ejs-state-glue.mjs 同一份修法：先复制、只释放 dataStart，乱码说明不外抛。
   */
  replaceOnce(runtimeJs,
    'const data=HEAPU8.subarray(dataStart,dataStart+size);_free(info);_free(data);return new Uint8Array(data)',
    'const data=new Uint8Array(HEAPU8.subarray(dataStart,dataStart+size));_free(dataStart);return data')
  replaceOnce(runtimeJs,
    'if(state[2]!=="1"){console.error("Failed to save state!",state[0]);throw new Error(state[0])}',
    String.raw`if(state[2]!=="1"){const reason=/^[\x20-\x7e]{1,120}$/.test(state[0]||"")?state[0]:"State is not available yet";console.warn("Failed to save state!",reason);throw new Error(reason)}`)
  copyFileSync(join(coreDir, 'LICENSE'), join(packageDir, 'license.txt'))
  writeFileSync(join(packageDir, 'core.json'), `${JSON.stringify({
    name: 'melondsds',
    extensions: ['nds', 'dsi', 'ids'],
    makeoptions: {
      builder: 'cmake',
      cmake_args: [
        '-DCMAKE_BUILD_TYPE=Release', '-DENABLE_JIT=OFF', '-DENABLE_OPENGL=OFF',
        '-DENABLE_THREADED_RENDERER=OFF', '-DENABLE_NETWORKING=ON',
        '-DENABLE_DYNAMIC=OFF', '-DBUILD_TESTING=OFF',
      ],
    },
    options: { defaultWebGL2: true, supportsMouse: true },
    save: 'srm',
    license: 'LICENSE',
    repo: CORE_REPO.replace(/\.git$/, ''),
    branch: CORE_TAG,
  }, null, 2)}\n`)
  writeFileSync(join(packageDir, 'build.json'), `${JSON.stringify({
    minimumEJSVersion: '4.2.2',
    version: '2.0.3',
    upstreamVersion: CORE_VERSION,
    upstreamCommit: CORE_COMMIT,
  }, null, 2)}\n`)

  const finalData = join(packageDir, 'melondsds-wasm.data')
  const members = ['melondsds_libretro.js', 'melondsds_libretro.wasm', 'build.json', 'core.json', 'license.txt']
  for (const member of members) if (!existsSync(join(packageDir, member))) throw new Error(`打包前缺 ${member}`)
  run('7z', ['a', '-t7z', '-mx=9', finalData, ...members], packageDir)

  mkdirSync(join(args.output, 'reports'), { recursive: true })
  const installed = join(args.output, 'melondsds-wasm.data')
  copyFileSync(finalData, installed)
  const sha256 = createHash('sha256').update(readFileSync(installed)).digest('hex')
  const report = {
    core: 'melondsds',
    buildStart: startedAt,
    buildEnd: new Date().toISOString(),
    upstreamVersion: CORE_VERSION,
    upstreamCommit: CORE_COMMIT,
    emulatorJsRetroArchCommit: RETROARCH_COMMIT,
    emsdkVersion: EMSDK_VERSION,
    sha256,
    // 已修正 path_get_size 的跨 libretro-common 签名冲突，且最终链接没有任何签名不一致 warning
    linkAbiChecked: true,
    saveStateGlue: 'v3',
    patch: 'emulatorjs-save-state-glue-v3',
    // GPU::VRAMCaptureBlockFlags 已零初始化（否则部分 ROM 开局 RuntimeError: null function）
    gpuCaptureFlagsInit: true,
    // melonDS DS 前端以 -fexceptions 构建，开局错误会显示核心自己的错误画面
    cxxExceptions: 'frontend',
    options: {
      defaultWebGL2: true, supportsMouse: true, jit: false, opengl: false,
      threadedRenderer: false, networking: 'indirect',
    },
  }
  writeFileSync(join(args.output, 'reports/melondsds.json'), `${JSON.stringify(report, null, 2)}\n`)
  // 只在写进本仓库默认目录时联动缓存代号；--output 指到别处时不碰源码。
  if (args.output === join(repoRoot, 'public/emulatorjs/cores')) bumpRuntimeGeneration(sha256)
  console.log(`\n[done] ${relative(repoRoot, installed)}\n       sha256 ${sha256}`)
}

function main() {
  const args = parseArgs(process.argv)
  const startedAt = new Date().toISOString()
  for (const tool of ['git', 'cmake', 'make', 'python3']) needTool(tool)
  mkdirSync(args.workdir, { recursive: true })
  ensureSevenZip(args.workdir)

  const coreDir = join(args.workdir, 'melonds-ds')
  const retroDir = join(args.workdir, 'retroarch')
  const emsdkDir = join(args.workdir, 'emsdk')
  checkoutExact(coreDir, CORE_REPO, CORE_COMMIT)
  checkoutExact(retroDir, RETROARCH_REPO, RETROARCH_COMMIT)
  patchCore(coreDir)
  patchRetroArch(retroDir, args.jobs)

  if (!existsSync(join(emsdkDir, 'emsdk_env.sh'))) run('git', ['clone', '--depth', '1', EMSDK_REPO, emsdkDir])
  run('./emsdk', ['install', EMSDK_VERSION], emsdkDir)
  run('./emsdk', ['activate', EMSDK_VERSION], emsdkDir)

  const env = `source ${q(join(emsdkDir, 'emsdk_env.sh'))}`
  const cmakeArgs = [
    '-S', '.', '-B', 'build-ejs', '-DCMAKE_BUILD_TYPE=Release', '-DENABLE_JIT=OFF',
    '-DENABLE_OPENGL=OFF', '-DENABLE_THREADED_RENDERER=OFF', '-DENABLE_NETWORKING=ON',
    '-DENABLE_DYNAMIC=OFF', '-DBUILD_TESTING=OFF',
  ].map(q).join(' ')
  runBash(`${env} && emcmake cmake ${cmakeArgs}`, coreDir)
  patchConfiguredDependencies(coreDir)
  runBash(`${env} && cmake --build build-ejs --parallel ${args.jobs}`, coreDir)
  const bitcode = mergeArchives(coreDir, env)

  const ejsDir = emulatorJsDir(retroDir)
  copyFileSync(bitcode, join(ejsDir, 'melondsds_libretro_emscripten.bc'))
  const linkLog = runBashLogged(`${env} && emmake ./build-emulatorjs.sh --clean`, ejsDir, join(args.workdir, 'emulatorjs-link.log'))
  assertNoSignatureMismatch(linkLog)
  packageCore(args, coreDir, startedAt)
}

try {
  main()
} catch (error) {
  console.error(`\n[构建失败] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
