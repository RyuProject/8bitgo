#!/usr/bin/env node
/**
 * 构建独立的 FBNeo 低内存实验版，不覆盖线上默认 `fbneo`。
 *
 * 这次只把 Emscripten 初始堆从 128 MiB 降到 80 MiB，并保留 ALLOW_MEMORY_GROWTH。
 * 最大值仍沿用 2 GiB；先验证 32 位浏览器能否完成核心实例化，再根据真实峰值决定是否设上限。
 *
 * 用法：npm run build:fbneo-lowmem
 *       node scripts/build-fbneo-lowmem-core.mjs --workdir /tmp/fbneo-lowmem-build --jobs 4
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const BUILD_REPO = 'https://github.com/EmulatorJS/build.git'
const BUILD_COMMIT = '677b1334ab1721a1e31b918f211b68f4e54f67a8'
const RETROARCH_REPO = 'https://github.com/EmulatorJS/RetroArch.git'
const RETROARCH_BRANCH = 'v1.22.2'
const RETROARCH_COMMIT = '97f2cfa65d01d57406e4ce9459242c8ada7c7e3b'
const CORE_REPO = 'https://github.com/EmulatorJS/FBNeo.git'
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git'
const EMSDK_VERSION = '3.1.74'
const CORE_ID = 'fbneo-lowmem'
const INITIAL_HEAP_BYTES = 80 * 1024 * 1024
const EXPECTED_MINIMUM_EJS_VERSION = '4.2.2'

function parseArgs(argv) {
  const args = { workdir: '/tmp/fbneo-lowmem-build', jobs: 4 }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--workdir') args.workdir = argv[++i]
    else if (arg === '--jobs') args.jobs = Number(argv[++i])
    else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1 || args.jobs > 32) throw new Error('--jobs 必须是 1–32 的整数')
  return args
}

function run(file, args, cwd) {
  console.log(`\n$ ${file} ${args.join(' ')}`)
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}

function runBash(command, cwd) {
  console.log(`\n$ ${command}`)
  execFileSync('/bin/bash', ['-lc', command], { cwd, stdio: 'inherit' })
}

function q(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function needTool(name) {
  try {
    execFileSync('/usr/bin/env', ['which', name], { stdio: 'ignore' })
  } catch {
    throw new Error(`缺少构建工具 ${name}`)
  }
}

function checkoutBuildRepo(buildDir) {
  if (!existsSync(join(buildDir, 'build.sh'))) {
    run('git', ['clone', '--filter=blob:none', BUILD_REPO, buildDir])
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: buildDir, encoding: 'utf8' }).trim()
  if (head !== BUILD_COMMIT) {
    run('git', ['fetch', '--depth', '1', 'origin', BUILD_COMMIT], buildDir)
    run('git', ['checkout', '--detach', BUILD_COMMIT], buildDir)
  }
}

function prepareEmSdk(emsdkDir) {
  if (!existsSync(join(emsdkDir, 'emsdk'))) run('git', ['clone', '--depth', '1', EMSDK_REPO, emsdkDir])
  run('./emsdk', ['install', EMSDK_VERSION], emsdkDir)
  run('./emsdk', ['activate', EMSDK_VERSION], emsdkDir)
}

/** 临时改官方构建清单，只加一个同源、同功能、不同内存档位的核心名。 */
function configureBuild(buildDir, jobs) {
  const manifestPath = join(buildDir, 'cores.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const fbneo = manifest.find((item) => item.name === 'fbneo')
  if (!fbneo) throw new Error('EmulatorJS/build 的 cores.json 里找不到 fbneo 定义')
  const lowmem = structuredClone(fbneo)
  lowmem.name = CORE_ID
  lowmem.makeoptions = {
    ...fbneo.makeoptions,
    arguments: ['TARGET_NAME=fbneo-lowmem'],
  }
  delete lowmem.branch
  const withoutOld = manifest.filter((item) => item.name !== CORE_ID)
  const index = withoutOld.findIndex((item) => item.name === 'fbneo')
  withoutOld.splice(index + 1, 0, lowmem)
  writeFileSync(manifestPath, `${JSON.stringify(withoutOld, null, 4)}\n`)

  const buildInfoPath = join(buildDir, 'build.json')
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  // 站内引擎的版本字符串仍是 4.2.3；当前构建仓库默认写 4.3.0，预发布版比较時会被誤拒。
  buildInfo.minimumEJSVersion = EXPECTED_MINIMUM_EJS_VERSION
  writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 4)}\n`)

  const buildScript = join(buildDir, 'build.sh')
  const original = readFileSync(buildScript, 'utf8')
  let patched = original.replaceAll('-j$(nproc)', `-j${jobs}`)
  if (patched === original && !original.includes(`-j${jobs}`)) {
    throw new Error('EmulatorJS/build 的 build.sh 并行参数格式已变，停止以免使用错误的主机核数')
  }

  // 上游默认重复编译线程包；本站只发布普通和 legacy 两档，legacy 可复用同一份静态核心。
  // 这也避免实验构建额外生成线程版（其内存上限与本次对照条件不同）。
  const sourceVariants = `    if [[ "$builder" = "cmake" ]]; then
        cmakeBuildThreads
    elif [[ "$custom" = "true" ]]; then
        eval "$build_command"
    else
        cd "$makefilePath"

        # only build the unthreaded version if requireThreads is false
        if [ "$requireThreads" = false ]; then
            build
            if [ "$requiresWebgl2" = false ]; then
                buildLegacy
            fi
        fi

        # build the threaded version
        buildThreads
        if [ "$requiresWebgl2" = false ]; then
            buildThreadsLegacy
        fi
    fi`
  const lowmemVariants = `    if [[ "$name" = "${CORE_ID}" ]]; then
        cd "$makefilePath"
        build
        if [ "$requiresWebgl2" = false ]; then
            cp "$buildPath/$tempPath/normal/"*.bc "$buildPath/$tempPath/legacy/"
        fi
    else
${sourceVariants}
    fi`
  if (patched.includes(sourceVariants)) patched = patched.replace(sourceVariants, lowmemVariants)
  else if (!patched.includes(lowmemVariants)) throw new Error('EmulatorJS/build 的核心变体构建流程变化，停止以免多构建/少构建实验产物')

  const threadLinking = `            mv core-temp/threads/*.bc ./
            emmake ./build-emulatorjs.sh --clean --threads >> "$logPath/$name-emake.log"
            rm -f *.bc

            if [ "$requiresWebgl2" = false ]; then
                mv core-temp/legacyThreads/*.bc ./
                emmake ./build-emulatorjs.sh --clean --threads --legacy >> "$logPath/$name-emake.log"
                rm -f *.bc
            fi`
  const skipLowmemThreads = `            if [[ "$name" != "${CORE_ID}" ]]; then
${threadLinking}
            fi`
  if (patched.includes(threadLinking)) patched = patched.replace(threadLinking, skipLowmemThreads)
  else if (!patched.includes(skipLowmemThreads)) throw new Error('EmulatorJS/build 的线程包链接流程变化，停止以免留下缺失产物')

  const zipArtifacts = `        zip $outputPath/$name.zip $name-thread*wasm.data
        if [ $requireThreads = false ]; then
            zip -u $outputPath/$name.zip  $name-wasm.data $name-legacy-wasm.data
        fi`
  const zipLowmemArtifacts = `        if [[ "$name" = "${CORE_ID}" ]]; then
            zip -q $outputPath/$name.zip $name-wasm.data $name-legacy-wasm.data
        else
            zip $outputPath/$name.zip $name-thread*wasm.data
            if [ $requireThreads = false ]; then
                zip -u $outputPath/$name.zip  $name-wasm.data $name-legacy-wasm.data
            fi
        fi`
  if (patched.includes(zipArtifacts)) patched = patched.replace(zipArtifacts, zipLowmemArtifacts)
  else if (!patched.includes(zipLowmemArtifacts)) throw new Error('EmulatorJS/build 的核心归档流程变化，停止以免生成不完整包')
  writeFileSync(buildScript, patched)
}

function prepareRetroArch(buildDir) {
  const compileDir = join(buildDir, 'compile')
  mkdirSync(compileDir, { recursive: true })
  const oldLocation = join(buildDir, 'RetroArch')
  const retroDir = join(compileDir, 'RetroArch')
  if (!existsSync(retroDir) && existsSync(oldLocation)) renameSync(oldLocation, retroDir)
  if (!existsSync(join(retroDir, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', RETROARCH_BRANCH, RETROARCH_REPO, retroDir])
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: retroDir, encoding: 'utf8' }).trim()
  if (head !== RETROARCH_COMMIT) {
    run('git', ['fetch', '--depth', '1', 'origin', RETROARCH_COMMIT], retroDir)
    run('git', ['checkout', '--detach', RETROARCH_COMMIT], retroDir)
  }
  return retroDir
}

/** 链接脚本用 INITIAL_HEAP 配置初始堆，并固定开启 ALLOW_MEMORY_GROWTH。 */
function setLowMemoryHeap(retroDir, jobs) {
  const script = join(retroDir, 'emulatorjs', 'build-emulatorjs.sh')
  const original = readFileSync(script, 'utf8')
  let source = original.replaceAll('$(nproc)', String(jobs))
  const oldHeapBlock = new RegExp(
    `  if \\[[ \\[]*"\\$name" = "${CORE_ID}" \\]\\]; then\\n    heap_mem=\\d+ #[^\\n]*\\n  fi\\n`,
    'g',
  )
  source = source.replace(oldHeapBlock, '')
  // 上游脚本的 GNU sed 分组写法在 macOS BSD sed 上不匹配，核心名会残留完整文件名。
  // 用 Bash 后缀删除能同时识别普通、legacy 和线程包的输入名。
  const nameLine = /^  name=.*sed.*$/m
  const fixedNameParser = '  name="${f%_libretro_emscripten.bc}"\n  if [[ "$name" = "$f" ]]; then\n    name="${f%_emscripten.bc}"\n  fi'
  if (nameLine.test(source)) source = source.replace(nameLine, fixedNameParser)
  else if (!source.includes(fixedNameParser)) throw new Error('EmulatorJS 链接脚本的核心名解析位置变化，停止以免错误选择内存档位')
  const marker = '  if [[ $(containsElement $name "${largeHeap[@]}") = 1 ]]; then\n    heap_mem=536870912 # 512mb\n  fi\n'
  const setting = `  if [[ "$name" = "${CORE_ID}" ]]; then\n    heap_mem=${INITIAL_HEAP_BYTES} # 初始堆 80 MiB，仍启用动态增长\n  fi\n`
  if (!source.includes(setting)) {
    if (!source.includes(marker)) throw new Error('EmulatorJS 链接脚本中的 largeHeap 位置变化，停止应用内存补丁')
    source = source.replace(marker, `${marker}${setting}`)
  }
  if (!source.includes(setting)) throw new Error('FBNeo 低内存堆设置没有写入链接脚本')
  if (source !== original) writeFileSync(script, source)
}

/** 读取最终 WASM 的内存页数；一页是 64 KiB。 */
function readWasmMemoryLimits(archive, member) {
  const wasm = execFileSync('7z', ['x', '-so', archive, member], { maxBuffer: 96 * 1024 * 1024 })
  if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw new Error(`${member} 不是有效 WASM 文件`)
  const readUleb = (offset) => {
    let value = 0
    let shift = 0
    while (offset < wasm.length) {
      const byte = wasm[offset++]
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [value, offset]
      shift += 7
    }
    throw new Error(`${member} 的 WASM section 被截断`)
  }
  let offset = 8
  while (offset < wasm.length) {
    const sectionId = wasm[offset++]
    let sectionSize
    ;[sectionSize, offset] = readUleb(offset)
    const sectionEnd = offset + sectionSize
    if (sectionId === 5) {
      let count
      ;[count, offset] = readUleb(offset)
      if (count < 1) throw new Error(`${member} 没有声明 WASM 内存`)
      let flags
      let minimumPages
      ;[flags, offset] = readUleb(offset)
      ;[minimumPages, offset] = readUleb(offset)
      let maximumPages = null
      if (flags & 1) [maximumPages, offset] = readUleb(offset)
      return {
        minimumPages,
        maximumPages,
        minimumBytes: minimumPages * 65536,
        maximumBytes: maximumPages === null ? null : maximumPages * 65536,
      }
    }
    offset = sectionEnd
  }
  throw new Error(`${member} 没有可检查的 WASM memory section`)
}

function bumpRuntimeGeneration(sha256) {
  const file = join(repoRoot, 'src/emulator/paths.ts')
  const source = readFileSync(file, 'utf8')
  const re = /export const EJS_RUNTIME_GENERATION = '([^']*)'/
  const current = source.match(re)
  if (!current) throw new Error('src/emulator/paths.ts 里找不到 EJS_RUNTIME_GENERATION')
  const base = current[1].replace(/-fbneolowmem-[a-f0-9]{8}/g, '')
  const next = `${base}-fbneolowmem-${sha256.slice(0, 8)}`
  if (current[1] !== next) writeFileSync(file, source.replace(re, `export const EJS_RUNTIME_GENERATION = '${next}'`))
}

function main() {
  const args = parseArgs(process.argv)
  const buildDir = isAbsolute(args.workdir) ? args.workdir : join(repoRoot, args.workdir)
  const emsdkDir = join(buildDir, '.emsdk')
  const startedAt = new Date().toISOString()
  for (const tool of ['git', 'jq', 'python3', 'make', 'zip']) needTool(tool)
  needTool('7z')
  mkdirSync(buildDir, { recursive: true })
  checkoutBuildRepo(buildDir)
  prepareEmSdk(emsdkDir)
  configureBuild(buildDir, args.jobs)
  const retroDir = prepareRetroArch(buildDir)
  setLowMemoryHeap(retroDir, args.jobs)

  const env = join(emsdkDir, 'emsdk_env.sh')
  runBash(`source ${q(env)} && bash build.sh --core=${CORE_ID}`, buildDir)

  const buildOutput = join(buildDir, 'output')
  const coreOutput = join(repoRoot, 'public/emulatorjs/cores')
  const built = {
    normal: join(buildOutput, `${CORE_ID}-wasm.data`),
    legacy: join(buildOutput, `${CORE_ID}-legacy-wasm.data`),
  }
  for (const file of Object.values(built)) if (!existsSync(file)) throw new Error(`构建完成但缺少产物：${file}`)

  const reference = readWasmMemoryLimits(join(repoRoot, 'public/emulatorjs/cores/fbneo-wasm.data'), 'fbneo_libretro.wasm')
  const lowmem = readWasmMemoryLimits(built.normal, `${CORE_ID}_libretro.wasm`)
  const lowmemLegacy = readWasmMemoryLimits(built.legacy, `${CORE_ID}_libretro.wasm`)
  if (lowmem.minimumBytes >= reference.minimumBytes) {
    throw new Error(`低内存版本初始内存 ${lowmem.minimumBytes} B 没有低于原版 ${reference.minimumBytes} B`)
  }
  if (lowmem.maximumBytes !== reference.maximumBytes) {
    throw new Error(`内存增长上限变化：低内存版 ${lowmem.maximumBytes} B，原版 ${reference.maximumBytes} B`)
  }
  if (lowmemLegacy.minimumBytes !== lowmem.minimumBytes || lowmemLegacy.maximumBytes !== lowmem.maximumBytes) {
    throw new Error(`legacy 核心内存限制与普通版不一致：${lowmemLegacy.minimumBytes}/${lowmemLegacy.maximumBytes} B`)
  }

  mkdirSync(join(coreOutput, 'reports'), { recursive: true })
  copyFileSync(built.normal, join(coreOutput, `${CORE_ID}-wasm.data`))
  copyFileSync(built.legacy, join(coreOutput, `${CORE_ID}-legacy-wasm.data`))

  const reportPath = join(buildOutput, 'reports', `${CORE_ID}.json`)
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { core: CORE_ID }
  const sourceDir = join(buildDir, 'compile', CORE_ID)
  const upstreamCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim()
  const retroarchCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: retroDir, encoding: 'utf8' }).trim()
  report.buildStart = report.buildStart || startedAt
  report.buildEnd = new Date().toISOString()
  report.upstreamRepo = CORE_REPO
  report.upstreamCommit = upstreamCommit
  report.emulatorJsRetroArchCommit = retroarchCommit
  report.emsdkVersion = EMSDK_VERSION
  report.minimumEJSVersion = EXPECTED_MINIMUM_EJS_VERSION
  const sha256 = createHash('sha256').update(readFileSync(join(coreOutput, `${CORE_ID}-wasm.data`))).digest('hex')
  report.sha256 = sha256
  report.memory = {
    initialHeapBytes: INITIAL_HEAP_BYTES,
    allowMemoryGrowth: true,
    minimumBytes: lowmem.minimumBytes,
    legacyMinimumBytes: lowmemLegacy.minimumBytes,
    maximumBytes: lowmem.maximumBytes,
    baselineMinimumBytes: reference.minimumBytes,
  }
  writeFileSync(join(coreOutput, 'reports', `${CORE_ID}.json`), `${JSON.stringify(report, null, 2)}\n`)

  run('node', ['scripts/sync-emulatorjs-core-metadata.mjs'], repoRoot)
  run('node', ['scripts/gen-ejs-core-versions.mjs'], repoRoot)
  bumpRuntimeGeneration(sha256)

  console.log(`\n[done] ${relative(repoRoot, join(coreOutput, `${CORE_ID}-wasm.data`))}`)
  console.log(`       WASM 初始内存 ${(lowmem.minimumBytes / 1024 / 1024).toFixed(1)} MiB（原版 ${(reference.minimumBytes / 1024 / 1024).toFixed(1)} MiB）`)
  console.log(`       WASM 最大内存 ${(lowmem.maximumBytes / 1024 / 1024).toFixed(0)} MiB，动态增长已保留`)
  console.log(`       FBNeo commit ${upstreamCommit}`)
}

main()
