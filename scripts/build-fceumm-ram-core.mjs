#!/usr/bin/env node
/**
 * 重编本站默认 FCEUmm 核心，让浏览器侧可以复制 Libretro system RAM 快照。
 * 用法：npm run build:fceumm-ram-core
 *       node scripts/build-fceumm-ram-core.mjs --workdir /tmp/fceumm-ram-build --jobs 4
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_REPO = 'https://github.com/EmulatorJS/build.git'
const BUILD_COMMIT = '677b1334ab1721a1e31b918f211b68f4e54f67a8'
const RETROARCH_REPO = 'https://github.com/EmulatorJS/RetroArch.git'
const RETROARCH_BRANCH = 'v1.22.2'
const RETROARCH_COMMIT = '97f2cfa65d01d57406e4ce9459242c8ada7c7e3b'
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git'
const EMSDK_VERSION = '3.1.74'
const FCEUMM_COMMIT = 'e1630de02074801eb96f3bc4ff33f69df9554c69'
const CORE_ID = 'fceumm'
const MINIMUM_EJS_VERSION = '4.2.2'

function parseArgs(argv) {
  const args = { workdir: '/tmp/fceumm-ram-build', jobs: 4, skipBuild: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workdir') args.workdir = argv[++i]
    else if (argv[i] === '--jobs') args.jobs = Number(argv[++i])
    else if (argv[i] === '--skip-build') args.skipBuild = true
    else throw new Error(`未知参数：${argv[i]}`)
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

function checkoutPinnedRepo(dir, url, commit) {
  if (!existsSync(join(dir, '.git'))) run('git', ['clone', '--filter=blob:none', url, dir])
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  if (head !== commit) {
    run('git', ['fetch', '--depth', '1', 'origin', commit], dir)
    run('git', ['checkout', '--detach', commit], dir)
  }
}

function checkoutBuildRepo(buildDir) {
  checkoutPinnedRepo(buildDir, BUILD_REPO, BUILD_COMMIT)
}

function prepareEmsdk(emsdkDir) {
  if (!existsSync(join(emsdkDir, 'emsdk'))) run('git', ['clone', '--depth', '1', EMSDK_REPO, emsdkDir])
  run('./emsdk', ['install', EMSDK_VERSION], emsdkDir)
  run('./emsdk', ['activate', EMSDK_VERSION], emsdkDir)
}

function prepareRetroArch(buildDir) {
  const compileDir = join(buildDir, 'compile')
  mkdirSync(compileDir, { recursive: true })
  const oldPath = join(buildDir, 'RetroArch')
  const retroDir = join(compileDir, 'RetroArch')
  if (!existsSync(retroDir) && existsSync(oldPath)) run('mv', [oldPath, retroDir])
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

function replaceOnce(source, before, after, description) {
  if (source.includes(after)) return source
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error(`${description} 的上游位置变化，停止修改构建脚本`)
  }
  return source.slice(0, at) + after + source.slice(at + before.length)
}

function configureBuild(buildDir, jobs) {
  const manifestPath = join(buildDir, 'cores.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.some((item) => item.name === CORE_ID)) throw new Error('EmulatorJS/build 的 cores.json 中没有 fceumm')

  const buildInfoPath = join(buildDir, 'build.json')
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  buildInfo.minimumEJSVersion = MINIMUM_EJS_VERSION
  writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 4)}\n`)

  const scriptPath = join(buildDir, 'build.sh')
  const original = readFileSync(scriptPath, 'utf8')
  let source = original.replaceAll('-j$(nproc)', `-j${jobs}`)
  source = source.replaceAll('date -u -Is', 'date -u +%Y-%m-%dT%H:%M:%SZ')
  if (source === original && !original.includes(`-j${jobs}`)) {
    throw new Error('EmulatorJS/build 的并行参数位置变化，停止构建')
  }

  const gitUpdate = '    git pull\n    git submodule update --recursive'
  const patcher = join(root, 'scripts/patch-fceumm-ram-exports.mjs')
  const legacyPatchHook = `${gitUpdate}\n    if [ "$name" = "${CORE_ID}" ]; then\n        node ${q(patcher)} "$PWD"\n    fi`
  const patchHook = `${gitUpdate}\n    if [ "$name" = "${CORE_ID}" ]; then\n        git fetch --depth 1 origin ${FCEUMM_COMMIT}\n        git checkout --detach ${FCEUMM_COMMIT}\n        git submodule update --init --recursive\n        node ${q(patcher)} "$PWD"\n    fi`
  if (source.includes(patchHook)) {
    // Already configured with the pinned FCEUmm source.
  } else if (source.includes(legacyPatchHook)) {
    source = source.replace(legacyPatchHook, patchHook)
  } else {
    source = replaceOnce(source, gitUpdate, patchHook, 'FCEUmm RAM 导出钩子')
  }
  if (source !== original) writeFileSync(scriptPath, source)
}

function configureEmulatorJsBuild(retroDir, jobs) {
  const scriptPath = join(retroDir, 'EmulatorJS/build-emulatorjs.sh')
  const original = readFileSync(scriptPath, 'utf8')
  const upstreamName = '  name=`echo "$f" | sed "s/\\(_libretro_emscripten\\|\\).bc$//"`'
  const portableName = '  name="${f%_libretro_emscripten.bc}"'
  let source = replaceOnce(original, upstreamName, portableName, 'EmulatorJS 核心文件名解析')
  source = source.replaceAll('-j$(nproc)', `-j${jobs}`)
  if (source !== original) writeFileSync(scriptPath, source)
}

function verifyExports(archive) {
  run('7z', ['t', archive])
  const listing = execFileSync('7z', ['l', '-slt', archive], { maxBuffer: 96 * 1024 * 1024 }).toString('utf8')
  for (const file of ['fceumm_libretro.js', 'fceumm_libretro.wasm']) {
    if (!listing.includes(`Path = ${file}`)) throw new Error(`${archive} 缺少 ${file}；拒绝安装不完整的核心`)
  }
  const glue = execFileSync('7z', ['e', '-so', archive, 'fceumm_libretro.js'], { maxBuffer: 96 * 1024 * 1024 })
  const text = glue.toString('utf8')
  for (const symbol of ['_retro_get_memory_data', '_retro_get_memory_size', 'EmulatorJSGetMemoryData']) {
    if (!text.includes(symbol)) throw new Error(`${archive} 没有导出 ${symbol}；拒绝安装不可读 RAM 的核心`)
  }
}

function installValidatedBuild({ output, buildDir, retroDir, startedAt }) {
  const destination = join(root, 'public/emulatorjs/cores')
  const reportDir = join(destination, 'reports')
  const metadataDir = join(destination, 'metadata')
  mkdirSync(reportDir, { recursive: true })
  mkdirSync(metadataDir, { recursive: true })

  const archives = [`${CORE_ID}-wasm.data`, `${CORE_ID}-legacy-wasm.data`]
  for (const name of archives) {
    const archive = join(output, name)
    if (!existsSync(archive)) throw new Error(`构建完成但缺少 ${archive}`)
    verifyExports(archive)
  }

  const fceummSource = join(buildDir, 'compile/fceumm')
  const reportPath = join(output, 'reports', `${CORE_ID}.json`)
  const report = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, 'utf8'))
    : { core: CORE_ID, buildStart: startedAt }
  report.core = CORE_ID
  report.buildEnd = new Date().toISOString()
  report.upstreamRepo = 'https://github.com/EmulatorJS/libretro-fceumm'
  report.upstreamCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fceummSource, encoding: 'utf8' }).trim()
  report.emulatorJsRetroArchCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: retroDir, encoding: 'utf8' }).trim()
  report.emsdkVersion = EMSDK_VERSION
  report.minimumEJSVersion = MINIMUM_EJS_VERSION
  report.systemRam = { libretroType: 2, bytes: 0x800, exports: ['retro_get_memory_data', 'retro_get_memory_size'] }
  report.sha256 = createHash('sha256').update(readFileSync(join(output, `${CORE_ID}-wasm.data`))).digest('hex')
  const reportText = `${JSON.stringify(report, null, 2)}\n`

  // 同一目录暂存后再 rename，避免构建 / 报告失败时把正在玩的核心换成半套文件。
  const stageDir = join(destination, `.fceumm-ram-${process.pid}`)
  const backupDir = join(stageDir, 'backup')
  mkdirSync(backupDir, { recursive: true })
  const files = [
    ...archives.map((name) => ({ source: join(output, name), target: join(destination, name) })),
    { source: null, target: join(reportDir, `${CORE_ID}.json`), content: reportText },
    { source: null, target: join(metadataDir, `${CORE_ID}.json`), content: reportText },
    { source: null, target: join(root, 'src/emulator/ejsCoreVersionsData.ts') },
  ]
  const snapshots = new Map()
  let commitStarted = false
  try {
    // 先备份完整提交集；任何备份或暂存失败都发生在改写线上产物之前。
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!existsSync(file.target)) continue
      const backup = join(backupDir, `old-${i}`)
      copyFileSync(file.target, backup)
      snapshots.set(file.target, backup)
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const staged = join(stageDir, `new-${i}`)
      if (file.source) copyFileSync(file.source, staged)
      else if (file.content !== undefined) writeFileSync(staged, file.content)
      file.staged = staged
    }

    commitStarted = true
    for (const file of files.slice(0, archives.length)) renameSync(file.staged, file.target)
    renameSync(files[archives.length].staged, files[archives.length].target)
    renameSync(files[archives.length + 1].staged, files[archives.length + 1].target)
    run(process.execPath, ['scripts/gen-ejs-core-versions.mjs'], root)
  } catch (error) {
    const rollbackErrors = []
    if (commitStarted) {
      for (const file of files) {
        try {
          const backup = snapshots.get(file.target)
          if (backup) copyFileSync(backup, file.target)
          else rmSync(file.target, { force: true })
        } catch (rollbackError) {
          rollbackErrors.push(`${file.target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
    }
    if (rollbackErrors.length && error instanceof Error) error.message += `；回滚有文件失败：${rollbackErrors.join('；')}`
    throw error
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }

  console.log(`\n[done] 已安装 FCEUmm RAM 导出版到 ${relative(root, destination)}`)
  console.log(`       上游核心 commit ${report.upstreamCommit}`)
  console.log('       System RAM：NES CPU RAM 2 KiB；浏览器读取接口返回复制后的快照')
}

function main() {
  const args = parseArgs(process.argv)
  const buildDir = args.workdir.startsWith('/') ? args.workdir : join(root, args.workdir)
  const emsdkDir = join(buildDir, '.emsdk')
  const startedAt = new Date().toISOString()
  for (const tool of ['git', 'python3', 'jq', 'make', 'zip']) needTool(tool)
  needTool('7z')
  mkdirSync(buildDir, { recursive: true })
  checkoutBuildRepo(buildDir)
  if (!args.skipBuild) prepareEmsdk(emsdkDir)
  configureBuild(buildDir, args.jobs)
  const retroDir = prepareRetroArch(buildDir)
  configureEmulatorJsBuild(retroDir, args.jobs)

  if (!args.skipBuild) {
    const env = join(emsdkDir, 'emsdk_env.sh')
    runBash(`source ${q(env)} && bash build.sh --core=${CORE_ID}`, buildDir)
  }
  const output = join(buildDir, 'output')
  installValidatedBuild({ output, buildDir, retroDir, startedAt })
}

try {
  main()
} catch (error) {
  console.error(`\n[构建失败] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
