/**
 * melonDS DS 链接 ABI 回归。
 *
 * 线上 `RuntimeError: unreachable at wasm-function[2361]:0x1a46fb` 的根因：核心自带的
 * libretro-common 把 path_get_size 声明为 int64_t，EmulatorJS RetroArch 里的定义是 int32_t。
 * 两者被静态链进同一个 wasm 后，wasm-ld 只报 warning，并把 melonDS DS 的调用换成 unreachable 桩
 * （FlushFirmware 两个分支 + 读系统目录各一处）。构建脚本必须绕开这个符号，并把签名不一致
 * 的 warning 升级成构建失败。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = readFileSync(join(root, 'scripts/build-melondsds-core.mjs'), 'utf8')

assert.match(build, /function patchPathGetSizeAbi\(coreDir\)/, '必须修补 path_get_size 的跨 libretro-common 签名冲突')
assert.match(build, /function patchCore\(coreDir\) \{\n\s*patchPathGetSizeAbi\(coreDir\)/, 'patchCore 一开始就要应用 ABI 补丁')
for (const site of ['current.size = path_get_size(filePath);', 'path_get_size(firmwarePath.data())', 'path_get_size(wfcSettingsPath.data())']) {
  assert.ok(build.includes(`'${site}'`), `必须替换上游调用点：${site}`)
}
assert.match(build, /filestream_get_size\(file\)/, '替代实现要走两边签名一致的 filestream API')
assert.match(build, /'grep', '-n', '-E', '\(\^\|\[\^A-Za-z0-9_\]\)path_get_size/, '上游新增直接调用时必须中止构建')
assert.match(build, /function assertNoSignatureMismatch\(log\)/)
assert.match(build, /\/function signature mismatch\/i/)
assert.match(build, /const linkLog = runBashLogged\(.*build-emulatorjs\.sh.*\n\s*assertNoSignatureMismatch\(linkLog\)/,
  '最终链接输出必须经过签名不一致检查，不能只靠人眼看 warning')
assert.match(build, /linkAbiChecked: true/)
assert.match(build, /\/undefined symbol:\/i/, '未定义符号也必须让构建失败（Makefile 用的是 ERROR_ON_UNDEFINED_SYMBOLS=0）')
assert.match(build, /target_compile_options\(melondsds_libretro PRIVATE -fexceptions\)/, '前端必须编译 C++ catch，否则开局错误全变成未捕获异常')
assert.match(build, /findstring melondsds,\$\(TARGET\)\)\)\\n   LDFLAGS \+= -fexceptions/, '最终链接也要带 -fexceptions')
assert.match(build, /for \(const name of \['emulatorjs', 'EmulatorJS'\]\)/, 'RetroArch 目录是小写 emulatorjs，不能只靠 macOS 大小写不敏感')
assert.match(build, /function ensureSevenZip\(workdir\)/)
assert.match(build, /bumpRuntimeGeneration\(sha256\)/, '新核心必须和新的 EJS_RUNTIME_GENERATION 一起发布')
assert.match(build, /function bumpNdsModernCoreBuild\(sha256\)/, '新核心必须让“新核心崩过”的本机记录失效')
// 口袋妖怪 黑 开局 RuntimeError: null function（GPU::SetRenderer 里 Rend 还是 nullptr）
assert.match(build, /function patchConfiguredDependencies\(coreDir\) \{[\s\S]*?patchMelonDsGpuInit\(coreDir\)\n\}/, 'configure 后要修 melonDS GPU 未初始化的截图标志')
assert.ok(build.includes("'    u16 VRAMCaptureBlockFlags[16];'"), 'VRAMCaptureBlockFlags 必须零初始化')
assert.ok(build.includes("u16 VRAMCaptureBlockFlags[16] {};"))
assert.ok(build.includes('if (!Rend) return;'), 'SyncAllVRAMCaptures 在渲染器建好前必须跳过')
assert.match(build, /gpuCaptureFlagsInit: true/)

const report = JSON.parse(readFileSync(join(root, 'public/emulatorjs/cores/reports/melondsds.json'), 'utf8'))
if (report.linkAbiChecked !== true) {
  console.warn(
    '⚠️ public/emulatorjs/cores/melondsds-wasm.data 仍是修复前的构建（report 没有 linkAbiChecked）。' +
    '它在重置、卸载或固件落盘时必然 RuntimeError: unreachable，请运行 npm run build:melondsds 重新出包。',
  )
}

if (report.gpuCaptureFlagsInit !== true) {
  console.warn(
    '⚠️ melondsds-wasm.data 没有 GPU 截图标志初始化补丁（report 没有 gpuCaptureFlagsInit）。' +
    '口袋妖怪 黑 等 ROM 开局必然 RuntimeError: null function，请运行 npm run build:melondsds 重新出包。',
  )
}

console.log('melonDS DS 链接 ABI 守卫通过')
