#!/usr/bin/env node
/**
 * 构建仅供 wofcn 汉化包使用的 FBNeo 核心，不替换站点默认 FBNeo。
 * 用法：npm run build:fbneo-wofcn
 *       node scripts/build-fbneo-wofcn-core.mjs --workdir /tmp/fbneo-wofcn-build --jobs 4
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_ID = 'fbneo-wofcn'
const BUILD_REPO = 'https://github.com/EmulatorJS/build.git'
const BUILD_COMMIT = '677b1334ab1721a1e31b918f211b68f4e54f67a8'
const RETROARCH_REPO = 'https://github.com/EmulatorJS/RetroArch.git'
const RETROARCH_BRANCH = 'v1.22.2'
const RETROARCH_COMMIT = '97f2cfa65d01d57406e4ce9459242c8ada7c7e3b'
const CORE_REPO = 'https://github.com/EmulatorJS/FBNeo.git'
const CORE_COMMIT = 'd5f072e147cfd01cb7c095470fd9c5c2697753d8'
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git'
const EMSDK_VERSION = '3.1.74'
const MINIMUM_EJS_VERSION = '4.2.2'

function parseArgs(argv) {
  const args = { workdir: '/tmp/fbneo-wofcn-build', jobs: 4 }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workdir') args.workdir = argv[++i]
    else if (argv[i] === '--jobs') args.jobs = Number(argv[++i])
    else throw new Error('未知参数：' + argv[i])
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1 || args.jobs > 32) throw new Error('--jobs 必须是 1–32 的整数')
  return args
}

function run(file, args, cwd) {
  console.log('\n$ ' + file + ' ' + args.join(' '))
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}
function runBash(command, cwd) {
  console.log('\n$ ' + command)
  execFileSync('/bin/bash', ['-lc', command], { cwd, stdio: 'inherit' })
}
function q(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'" }
function needTool(name) {
  try { execFileSync('/usr/bin/env', ['which', name], { stdio: 'ignore' }) }
  catch { throw new Error('缺少构建工具 ' + name) }
}
function checkoutPinnedRepo(dir, url, commit) {
  if (!existsSync(join(dir, '.git'))) run('git', ['clone', '--filter=blob:none', url, dir])
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  if (head !== commit) {
    run('git', ['fetch', '--depth', '1', 'origin', commit], dir)
    run('git', ['checkout', '--detach', commit], dir)
  }
}
function replaceOnce(source, from, to, description) {
  if (source.includes(to)) return source
  const at = source.indexOf(from)
  if (at < 0 || source.indexOf(from, at + from.length) >= 0) {
    throw new Error(description + ' 的上游位置变化，停止修改构建脚本')
  }
  return source.slice(0, at) + to + source.slice(at + from.length)
}

function prepareBuild(buildDir) {
  checkoutPinnedRepo(buildDir, BUILD_REPO, BUILD_COMMIT)
  const emsdkDir = join(buildDir, '.emsdk')
  if (!existsSync(join(emsdkDir, 'emsdk'))) run('git', ['clone', '--depth', '1', EMSDK_REPO, emsdkDir])
  run('./emsdk', ['install', EMSDK_VERSION], emsdkDir)
  run('./emsdk', ['activate', EMSDK_VERSION], emsdkDir)

  const compileDir = join(buildDir, 'compile')
  mkdirSync(compileDir, { recursive: true })
  const oldRetroDir = join(buildDir, 'RetroArch')
  const retroDir = join(compileDir, 'RetroArch')
  if (!existsSync(retroDir) && existsSync(oldRetroDir)) renameSync(oldRetroDir, retroDir)
  if (!existsSync(join(retroDir, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', RETROARCH_BRANCH, RETROARCH_REPO, retroDir])
  }
  const retroHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: retroDir, encoding: 'utf8' }).trim()
  if (retroHead !== RETROARCH_COMMIT) {
    run('git', ['fetch', '--depth', '1', 'origin', RETROARCH_COMMIT], retroDir)
    run('git', ['checkout', '--detach', RETROARCH_COMMIT], retroDir)
  }
  return { emsdkDir, retroDir }
}

function configureBuild(buildDir, jobs) {
  const manifestPath = join(buildDir, 'cores.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const fbneo = manifest.find((item) => item.name === 'fbneo')
  if (!fbneo) throw new Error('EmulatorJS/build 的 cores.json 里找不到 fbneo 定义')
  if (!manifest.some((item) => item.name === CORE_ID)) {
    const variant = structuredClone(fbneo)
    variant.name = CORE_ID
    variant.makeoptions = { ...fbneo.makeoptions, arguments: ['TARGET_NAME=' + CORE_ID] }
    manifest.splice(manifest.findIndex((item) => item.name === 'fbneo') + 1, 0, variant)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n')
  }

  const buildInfoPath = join(buildDir, 'build.json')
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  buildInfo.minimumEJSVersion = MINIMUM_EJS_VERSION
  writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 4) + '\n')

  const scriptPath = join(buildDir, 'build.sh')
  const original = readFileSync(scriptPath, 'utf8')
  let source = original.replaceAll('-j$(nproc)', '-j' + jobs)
  // build.sh 来自 GNU/Linux 环境；macOS 自带 date 不支持 -Is，使用两边都可用的格式。
  source = source.replaceAll('date -u -Is', 'date -u +%Y-%m-%dT%H:%M:%SZ')
  const retroarchPull = '    cd RetroArch\n    git pull'
  const pinnedRetroarch = '    cd RetroArch\n    # RetroArch 已锁定到固定 commit，不能在构建脚本中更新。'
  if (source.includes(retroarchPull)) source = replaceOnce(source, retroarchPull, pinnedRetroarch, 'RetroArch 固定源码版本')
  else if (!source.includes(pinnedRetroarch)) throw new Error('找不到 RetroArch 更新步骤，停止修改构建脚本')

  const corePull = '    if [ "$name" != "fbneo" ] && [ "$name" != "' + CORE_ID + '" ]; then git pull; fi\n    git submodule update --recursive'
  const unguardedPull = '    git pull\n    git submodule update --recursive'
  if (source.includes(unguardedPull)) source = replaceOnce(source, unguardedPull, corePull, 'FBNeo 固定源码版本')
  else if (!source.includes(corePull)) throw new Error('找不到核心源码更新步骤，停止修改构建脚本')

  const sourceVariants = [
    '    if [[ "$builder" = "cmake" ]]; then',
    '        cmakeBuildThreads',
    '    elif [[ "$custom" = "true" ]]; then',
    '        eval "$build_command"',
    '    else',
    '        cd "$makefilePath"',
    '',
    '        # only build the unthreaded version if requireThreads is false',
    '        if [ "$requireThreads" = false ]; then',
    '            build',
    '            if [ "$requiresWebgl2" = false ]; then',
    '                buildLegacy',
    '            fi',
    '        fi',
    '',
    '        # build the threaded version',
    '        buildThreads',
    '        if [ "$requiresWebgl2" = false ]; then',
    '            buildThreadsLegacy',
    '        fi',
    '    fi',
  ].join('\n')
  const variantSources = [
    '    if [[ "$name" = "' + CORE_ID + '" ]]; then',
    '        cd "$makefilePath"',
    '        build',
    '        if [ "$requiresWebgl2" = false ]; then',
    '            cp "$buildPath/$tempPath/normal/"*.bc "$buildPath/$tempPath/legacy/"',
    '        fi',
    '    else',
    sourceVariants,
    '    fi',
  ].join('\n')
  if (source.includes(variantSources)) { /* 已配置 wofcn 单线程普通 / legacy 构建 */ }
  else if (source.includes(sourceVariants)) source = source.replace(sourceVariants, variantSources)
  else if (!source.includes(variantSources)) throw new Error('FBNeo 变体编译步骤已变化，停止生成不完整核心')

  const threadLinking = [
    '            mv core-temp/threads/*.bc ./',
    '            emmake ./build-emulatorjs.sh --clean --threads >> "$logPath/$name-emake.log"',
    '            rm -f *.bc',
    '',
    '            if [ "$requiresWebgl2" = false ]; then',
    '                mv core-temp/legacyThreads/*.bc ./',
    '                emmake ./build-emulatorjs.sh --clean --threads --legacy >> "$logPath/$name-emake.log"',
    '                rm -f *.bc',
    '            fi',
  ].join('\n')
  const skipThreads = [
    '            if [[ "$name" != "' + CORE_ID + '" ]]; then',
    threadLinking,
    '            fi',
  ].join('\n')
  if (source.includes(skipThreads)) { /* 已跳过 wofcn 线程包 */ }
  else if (source.includes(threadLinking)) source = source.replace(threadLinking, skipThreads)
  else if (!source.includes(skipThreads)) throw new Error('FBNeo 线程包链接步骤已变化，停止生成不完整核心')

  const zipArtifacts = [
    '        zip $outputPath/$name.zip $name-thread*wasm.data',
    '        if [ $requireThreads = false ]; then',
    '            zip -u $outputPath/$name.zip  $name-wasm.data $name-legacy-wasm.data',
    '        fi',
  ].join('\n')
  const zipVariant = [
    '        if [[ "$name" = "' + CORE_ID + '" ]]; then',
    '            zip -q $outputPath/$name.zip $name-wasm.data $name-legacy-wasm.data',
    '        else',
    zipArtifacts,
    '        fi',
  ].join('\n')
  if (source.includes(zipVariant)) { /* 已将 wofcn 归档为普通 / legacy 两种包 */ }
  else if (source.includes(zipArtifacts)) source = source.replace(zipArtifacts, zipVariant)
  else if (!source.includes(zipVariant)) throw new Error('FBNeo 核心归档步骤已变化，停止生成不完整核心')

  const emulatorJsPull = '    cd EmulatorJS\n    git pull\n\n    cd "$outPath"'
  const pinnedEmulatorJs = '    cd EmulatorJS\n    # 由锁定的 EmulatorJS 构建提交提供编译脚本，不拉取浮动上游\n\n    cd "$outPath"'
  if (source.includes(emulatorJsPull)) source = replaceOnce(source, emulatorJsPull, pinnedEmulatorJs, 'EmulatorJS 构建脚本版本固定')
  else if (!source.includes(pinnedEmulatorJs)) throw new Error('找不到 EmulatorJS 更新步骤，停止修改构建脚本')
  if (source !== original) writeFileSync(scriptPath, source)

  // BSD sed 不支持上游用来去掉 libretro 后缀的扩展正则，macOS 会把整段文件名当成核心名，
  // 产物因此变成 *_libretro_emscripten.bc-wasm.data，打包器找不到它。用 shell 后缀展开跨平台去除。
  const emulatorBuilderPath = join(buildDir, 'compile/RetroArch/emulatorjs/build-emulatorjs.sh')
  const emulatorBuilderOriginal = readFileSync(emulatorBuilderPath, 'utf8')
  const sedName = '  name=`echo "$f" | sed "s/\\(_libretro_emscripten\\|\\).bc$//"`'
  const portableName = '  name="${f%_libretro_emscripten.bc}"'
  let emulatorBuilder = emulatorBuilderOriginal
  if (emulatorBuilder.includes(sedName)) emulatorBuilder = replaceOnce(emulatorBuilder, sedName, portableName, 'EmulatorJS 核心文件名解析')
  else if (!emulatorBuilder.includes(portableName)) throw new Error('找不到 EmulatorJS 核心文件名解析步骤，停止生成错名核心')
  // EmulatorJS 的子构建脚本也调用 GNU nproc；固定 jobs，避免 macOS 下构建退化成串行。
  emulatorBuilder = emulatorBuilder.replaceAll('$(nproc)', String(jobs))
  if (emulatorBuilder !== emulatorBuilderOriginal) writeFileSync(emulatorBuilderPath, emulatorBuilder)
}

function prepareCoreSource(buildDir) {
  const sourceDir = join(buildDir, 'compile', CORE_ID)
  checkoutPinnedRepo(sourceDir, CORE_REPO, CORE_COMMIT)
  run('git', ['submodule', 'update', '--init', '--recursive'], sourceDir)
  run(process.execPath, [join(repoRoot, 'scripts/patch-fbneo-wofcn-source.mjs'), sourceDir], repoRoot)
  const cpsScrollSource = readFileSync(join(sourceDir, 'src/burn/drv/capcom/cps_scr.cpp'), 'utf8')
  if (!/t = BURN_ENDIAN_SWAP_INT16\(pst\[0\]\);\s*rawCode = t;\s*if \(Scroll1TileMask\) t &= Scroll1TileMask;/.test(cpsScrollSource)) {
    throw new Error('WOF CN 打补丁后没有在通用 tile 掩码前保存原始字码，拒绝编译')
  }
  if (!cpsScrollSource.includes('#include <emscripten/em_asm.h>')) {
    throw new Error('WOF CN 的 Emscripten EM_ASM 声明头缺失，拒绝编译')
  }
  const cpsDriverSource = readFileSync(join(sourceDir, 'src/burn/drv/capcom/d_cps1.cpp'), 'utf8')
  if (/memcpy\(CpsGfx \+ 0x(?:040000|380000),/.test(cpsDriverSource)) {
    throw new Error('WOF CN 字库映射仍覆盖普通场景图形 tile，拒绝编译')
  }
  const makefilePath = join(sourceDir, 'src/burner/libretro/Makefile.common')
  const makefile = readFileSync(makefilePath, 'utf8')
  const gnuDate = 'GIT_DATE := $(shell git log -1 --format="%at" | xargs -I{} date -d @{} +%y%m%d)'
  const portableDate = 'GIT_DATE := $(shell git log -1 --date=format:%y%m%d --format=%ad)'
  if (makefile.includes(gnuDate)) writeFileSync(makefilePath, makefile.replace(gnuDate, portableDate))
  else if (!makefile.includes(portableDate)) throw new Error('FBNeo GIT_DATE 生成方式变化，停止生成不完整核心')
  return sourceDir
}

function main() {
  const args = parseArgs(process.argv)
  const buildDir = isAbsolute(args.workdir) ? args.workdir : join(repoRoot, args.workdir)
  const startedAt = new Date().toISOString()
  for (const tool of ['git', 'jq', 'python3', 'make', 'zip', '7z']) needTool(tool)
  mkdirSync(buildDir, { recursive: true })
  const prepared = prepareBuild(buildDir)
  configureBuild(buildDir, args.jobs)
  const sourceDir = prepareCoreSource(buildDir)

  runBash('source ' + q(join(prepared.emsdkDir, 'emsdk_env.sh')) + ' && bash build.sh --core=' + CORE_ID, buildDir)
  const outputDir = join(buildDir, 'output')
  const coreDir = join(repoRoot, 'public/emulatorjs/cores')
  const normal = join(outputDir, CORE_ID + '-wasm.data')
  const legacy = join(outputDir, CORE_ID + '-legacy-wasm.data')
  for (const path of [normal, legacy]) if (!existsSync(path)) throw new Error('构建结束但缺少核心文件：' + path)

  mkdirSync(join(coreDir, 'reports'), { recursive: true })
  copyFileSync(normal, join(coreDir, CORE_ID + '-wasm.data'))
  copyFileSync(legacy, join(coreDir, CORE_ID + '-legacy-wasm.data'))
  const sha256 = createHash('sha256').update(readFileSync(join(coreDir, CORE_ID + '-wasm.data'))).digest('hex')
  const legacySha256 = createHash('sha256').update(readFileSync(join(coreDir, CORE_ID + '-legacy-wasm.data'))).digest('hex')
  const report = {
    core: CORE_ID,
    buildStart: startedAt,
    buildEnd: new Date().toISOString(),
    options: {},
    upstreamRepo: CORE_REPO,
    upstreamCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim(),
    patchSha256: createHash('sha256').update(readFileSync(join(repoRoot, 'scripts/patch-fbneo-wofcn-source.mjs'))).digest('hex'),
    emulatorJsBuildCommit: BUILD_COMMIT,
    emulatorJsRetroArchCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: prepared.retroDir, encoding: 'utf8' }).trim(),
    emsdkVersion: EMSDK_VERSION,
    minimumEJSVersion: MINIMUM_EJS_VERSION,
    sha256,
    legacySha256,
  }
  writeFileSync(join(coreDir, 'reports', CORE_ID + '.json'), JSON.stringify(report, null, 2) + '\n')
  run(process.execPath, ['scripts/sync-emulatorjs-core-metadata.mjs'], repoRoot)
  run(process.execPath, ['scripts/gen-ejs-core-versions.mjs'], repoRoot)
  console.log('\n[完成] 已安装 ' + relative(repoRoot, join(coreDir, CORE_ID + '-wasm.data')))
  console.log('[完成] FBNeo ' + report.upstreamCommit + '，产物 SHA-256 ' + sha256)
}

main()
