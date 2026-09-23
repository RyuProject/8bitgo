#!/usr/bin/env node
/**
 * 把 melonDS DS v1.3.1 编成 8BitGo 可直接加载的 EmulatorJS 核心。
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
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')

const CORE_REPO = 'https://github.com/JesseTG/melonds-ds.git'
const CORE_TAG = 'v1.3.1'
const CORE_VERSION = '1.3.1'
const CORE_COMMIT = 'bc4e4b67d2d470d7c682810a1e892cafd6f9082b'
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

function patchCore(coreDir) {
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

function patchRetroArch(retroDir, jobs) {
  const script = join(retroDir, 'EmulatorJS/build-emulatorjs.sh')
  replaceOnce(script, '  name=`echo "$f" | sed "s/\\(_libretro_emscripten\\|\\).bc$//"`', '  name=${f%_libretro_emscripten.bc}')
  const source = readFileSync(script, 'utf8')
  const next = source.replaceAll('$(nproc)', String(jobs))
  if (next === source && !source.includes(`-j${jobs}`)) throw new Error('build-emulatorjs.sh 的并行度补丁位置已变')
  writeFileSync(script, next)
}

function mergeArchives(coreDir) {
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
  runBash(`emar -M < ${q(mri)}`, build)
  return output
}

function packageCore(args, coreDir, startedAt) {
  const raw = join(args.workdir, 'EmulatorJS/data/cores/melondsds-wasm.data')
  if (!existsSync(raw)) throw new Error(`EmulatorJS 没有产出 ${raw}`)

  const packageDir = join(args.workdir, 'package')
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(packageDir, { recursive: true })
  run('7z', ['x', '-y', `-o${packageDir}`, raw], args.workdir)
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
    options: {
      defaultWebGL2: true, supportsMouse: true, jit: false, opengl: false,
      threadedRenderer: false, networking: 'indirect',
    },
  }
  writeFileSync(join(args.output, 'reports/melondsds.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n[done] ${relative(repoRoot, installed)}\n       sha256 ${sha256}`)
}

function main() {
  const args = parseArgs(process.argv)
  const startedAt = new Date().toISOString()
  for (const tool of ['git', 'cmake', 'make', '7z']) needTool(tool)
  mkdirSync(args.workdir, { recursive: true })

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
  runBash(`${env} && cmake --build build-ejs --parallel ${args.jobs}`, coreDir)
  const bitcode = mergeArchives(coreDir)

  const ejsDir = join(retroDir, 'EmulatorJS')
  copyFileSync(bitcode, join(ejsDir, 'melondsds_libretro_emscripten.bc'))
  runBash(`${env} && emmake ./build-emulatorjs.sh --clean`, ejsDir)
  packageCore(args, coreDir, startedAt)
}

try {
  main()
} catch (error) {
  console.error(`\n[构建失败] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
