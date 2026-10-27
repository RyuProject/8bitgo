#!/usr/bin/env node
/**
 * 构建「当前版 MAME」的 EmulatorJS 核心（mame-current）—— 用来跑 igs011 的
 * mxsqy102tw / 明星三缺一：FBNeo 和 EmulatorJS 自带的 mame2003（0.78）、mame2016（0.174）
 * 都不含这个驱动，只能上当前版 MAME。
 *
 * ── 2026-09-19 重写说明 ────────────────────────────────────────
 * 旧版是照 `EmulatorJS/core` 仓库 + `docker compose` 写的，两个前提**都是错的**：
 *   1. `EmulatorJS/core` 已经 404（官方构建入口迁到了 `EmulatorJS/build`）；
 *   2. `EmulatorJS/build` 压根不用 docker —— 它是 bash 脚本，直接调 emscripten 原生编译：
 *        emmake make -j$(nproc) -f <makescript> platform=emscripten <arguments>
 * 所以现在的正确流程是：拉 EmulatorJS/build → 装 emsdk 3.1.74 → 往 cores.json
 * 注入一条 mame-current → `bash build.sh --core=mame-current`。
 *
 * ── 前置 ──────────────────────────────────────────────────────
 * bash / git / python3 / jq（build.sh 用 jq 解析 cores.json，没有会静默失败）。
 * 资源：MAME 是全宇宙最难编的模拟器之一，建议 ≥8 核、**≥16G 内存**、**≥80G 剩余磁盘**。
 * 实测参考机（4 核 / 8G / 22G）属于勉强能试的下限，链接期很可能 OOM、磁盘也可能不够。
 *
 * ── 产物 ──────────────────────────────────────────────────────
 *   public/emulatorjs/cores/mame-current-wasm.data
 *   public/emulatorjs/cores/mame-current-legacy-wasm.data
 *   public/emulatorjs/cores/reports/mame-current.json   ← 少了它引擎会禁用 IndexedDB 缓存
 * 放进去后引擎即以 `EJS_core = 'mame-current'` 加载（见 src/emulator/adapters/emulatorjs.ts）。
 *
 * ⚠️ 编完之后还要做两件本脚本管不到的事（见文件末尾的提示）：
 *   1. 确认核心的 skip-disclaimer / skip-warnings 选项键名，写进 cores.json 的
 *      options.settings —— 否则玩家进游戏会卡在 MAME 的免责声明屏上，必须按键盘才能过。
 *   2. 确认核心声明的 minimumEJSVersion 与站内自托管引擎（自称 4.3.0-pre）对得上。
 *      新构建工具是 minimumEJSVersion 4.3.0，而按 semver「4.3.0-pre」<「4.3.0」，
 *      引擎有可能因此拒绝加载这个核心 —— 这是目前最大的未验证风险点。
 *
 * 用法：
 *   node scripts/build-mame-current-core.mjs [--workdir /tmp/mame-build] \
 *        [--output public/emulatorjs/cores] [--emsdk 3.1.74] [--jobs 2] [--skip-build]
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const BUILD_REPO = 'https://github.com/EmulatorJS/build'
/** 当前版 MAME 的 libretro 移植。master 就是 current，不像 mame2016 那样钉旧版本 */
const MAME_REPO = 'https://github.com/libretro/mame'

function parseArgs(argv) {
  const args = {
    workdir: '/tmp/mame-build',
    output: join(repoRoot, 'public/emulatorjs/cores'),
    emsdk: '3.1.74',
    // 默认 2：MAME 单个编译单元就能吃掉 1~2G，-j$(nproc) 在 8G 机器上必 OOM。
    jobs: 2,
    skipBuild: false,
    /**
     * 只编进这些驱动源文件（MAME 的 SUBTARGET + SOURCES 机制）。全量 MAME 的 wasm 解压后约 242MB：
     * 冷启动 ~57s（37MB 下载 + 7z 解压 + 编译）、回访 ~20s（每次都要重新编译），手机上内存也吃紧。
     * 本站实际只用到 Namco System 10/11/12 与 IGS011（taiko2 / 铁拳 / 灵魂能力 / 明星三缺一），
     * 裁剪后预计只剩几十 MB。⚠️ ptblank2 的克隆集横跨 namcos11 与 namcos12，两者必须一起编。
     * 例：--sources src/mame/namco/namcos10.cpp,src/mame/namco/namcos11.cpp,src/mame/namco/namcos12.cpp,src/mame/igs/igs011.cpp
     * 裁剪版上线前必须逐款实玩验收（见 AGENTS §4），并重跑 patch-ejs-state-glue 与 gen-ejs-core-versions。
     */
    sources: '',
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--workdir') args.workdir = argv[++i]
    else if (a === '--output') args.output = join(repoRoot, argv[++i])
    else if (a === '--emsdk') args.emsdk = argv[++i]
    else if (a === '--jobs') args.jobs = Number(argv[++i])
    else if (a === '--skip-build') args.skipBuild = true
    else if (a === '--sources') args.sources = String(argv[++i] || '').trim()
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}${cwd ? `  (cwd=${cwd})` : ''}`)
  execSync(cmd, { stdio: 'inherit', cwd, shell: '/bin/bash' })
}

function needTool(name) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore', shell: '/bin/bash' })
  } catch {
    throw new Error(`缺 ${name}。build.sh 依赖它（jq 用来解析 cores.json，少了会静默失败）。`)
  }
}

/** 往 cores.json 里注入 mame-current；已存在就复用 */
function makeArguments(sources) {
  if (!sources) return []
  const list = sources.split(',').map((x) => x.trim()).filter(Boolean)
  for (const item of list) {
    if (!/^src\/mame\/[\w/]+\.cpp$/.test(item)) throw new Error(`--sources 里有不像驱动源文件的项：${item}`)
  }
  return ['SUBTARGET=8bitgo', `SOURCES=${list.join(',')}`, 'REGENIE=1']
}

function injectCore(buildDir, sources) {
  const coresPath = join(buildDir, 'cores.json')
  const list = JSON.parse(readFileSync(coresPath, 'utf8'))
  const existing = list.find((c) => c.name === 'mame-current')
  if (existing) {
    // 复用条目时也要同步裁剪参数，否则换了 --sources 还是编出上一次的那一版
    existing.makeoptions = { ...existing.makeoptions, arguments: makeArguments(sources) }
    writeFileSync(coresPath, `${JSON.stringify(list, null, 4)}\n`)
    console.log(`[skip] cores.json 里已有 mame-current，复用（arguments=${JSON.stringify(existing.makeoptions.arguments)}）。`)
    return
  }
  list.push({
    name: 'mame-current',
    extensions: ['zip'],
    // build.sh 的编译命令是：
    //   emmake make -j$(nproc) -f <makescript> platform=emscripten <arguments…>
    // libretro-mame 用 Makefile.libretro（不是 Makefile），不带目标时默认就是 current。
    makeoptions: { buildpath: './', makescript: 'Makefile.libretro', arguments: makeArguments(sources) },
    options: {},
    save: false,
    license: 'LICENSE.md',
    repo: MAME_REPO,
  })
  writeFileSync(coresPath, `${JSON.stringify(list, null, 4)}\n`)
  console.log(`[ok] cores.json 已注入 mame-current（repo=${MAME_REPO}，makescript=Makefile.libretro）`)
}

/** build.sh 写死了 -j$(nproc)，8G 机器上会 OOM；按需改成固定并行度 */
function pinJobs(buildDir, jobs) {
  if (!jobs) return
  const p = join(buildDir, 'build.sh')
  const s = readFileSync(p, 'utf8')
  const next = s.replace(/-j\$\(nproc\)/g, `-j${jobs}`)
  if (next === s) {
    console.log(`[warn] build.sh 里没找到 -j$(nproc)，并行度没改（也许官方已经支持参数了）`)
    return
  }
  writeFileSync(p, next)
  console.log(`[ok] build.sh 并行度已固定为 -j${jobs}（内存小于 16G 时别调大）`)
}

/** 递归找出构建产物；EmulatorJS/build 的产物目录位置随版本变，这里按名字找 */
function findArtifacts(buildDir) {
  const wanted = []
  const skip = new Set(['.git', 'node_modules', 'emsdk', '.emsdk'])
  const walk = (dir, depth) => {
    if (depth > 6) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/^mame-current.*\.data$/.test(e.name) && !e.name.includes('-thread-')) wanted.push(p)
      else if (e.name === 'mame-current.json') wanted.push(p)
    }
  }
  walk(buildDir, 0)
  return wanted
}

/** 构建工具把 libretro/mame clone 在自己的工作目录里；从这份同源源码重建 CHD 目录，避免核心升级后后台还拿旧 CRC 猜。 */
function findMameSource(buildDir) {
  const skip = new Set(['.git', 'node_modules', 'emsdk', '.emsdk'])
  const walk = (dir, depth) => {
    if (depth > 7) return null
    if (existsSync(join(dir, 'src/mame'))) return dir
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue
      const found = walk(join(dir, entry.name), depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(buildDir, 0)
}

function syncMameChdCatalog(buildDir, sources) {
  const source = findMameSource(buildDir)
  if (!source) {
    throw new Error('构建完成后找不到 libretro/mame 源码，无法同步 MAME CHD 目录；不要发布可能已过期的识别索引')
  }
  const sourceArg = sources ? ` --sources ${sources}` : ''
  run(`${process.execPath} ${join(repoRoot, 'scripts/gen-mame-chd-catalog.mjs')} ${source}${sourceArg}`, repoRoot)
}

function install(output, buildDir) {
  const found = findArtifacts(buildDir)
  if (!found.length) {
    console.warn(`\n[warn] 在 ${buildDir} 里没找到任何 mame-current 产物。`)
    console.warn('       构建多半没走完（常见于 OOM 或磁盘写满）。去看日志：')
    console.warn(`         ${join(buildDir, 'logs')}`)
    process.exitCode = 2
    return
  }
  mkdirSync(join(output, 'reports'), { recursive: true })
  let n = 0
  for (const src of found) {
    const name = src.split('/').pop()
    const dst = name.endsWith('.json') ? join(output, 'reports', name) : join(output, name)
    copyFileSync(src, dst)
    console.log(`[install] ${relative(output, dst)}`)
    n++
  }
  const report = join(output, 'reports', 'mame-current.json')
  if (!existsSync(report)) {
    writeFileSync(report, `${JSON.stringify({ core: 'mame-current' }, null, 2)}\n`)
    console.log('[install] 生成占位 reports/mame-current.json（引擎会禁用该核心的 IndexedDB 缓存，但不影响运行）')
    n++
  }
  console.log(`\n[done] 已放入 ${output}（${n} 个文件）。`)
  console.log('接下来：')
  console.log('  0) node scripts/patch-ejs-state-glue.mjs —— 新编的胶水仍是 EJS RetroArch 那份「释放栈地址、漏整份快照」')
  console.log('     的即时存档实现，必须打 v3 补丁（npm run test:psx-state 会拦），并同步报告与换代常量。')
  console.log('  1) npm run test:ejs-cores —— 它认得 SELF_BUILT_CORES，会确认核心就位。')
  console.log('  2) 部署后到 Cloudflare 控制台 Purge Everything（/emulatorjs/ 边缘缓存 30 天）。')
  console.log('  3) 后台把该游戏的 core 填 mame-current（下拉里已经有这一项）。')
  console.log('  4) ROM 必须是 **non-merged** 的 mxsqy102tw.zip（自带父集文件、单包自洽）；')
  console.log('     它是克隆集，split 包会缺父集文件，MAME 直接报 missing files。')
}

function main() {
  const args = parseArgs(process.argv)
  console.log('== 构建 mame-current（当前版 MAME 的 EmulatorJS 核心）==')
  console.log(JSON.stringify(args, null, 2))

  for (const t of ['bash', 'git', 'python3', 'jq']) needTool(t)

  mkdirSync(args.workdir, { recursive: true })

  // 1) 拉官方构建仓库
  const buildDir = join(args.workdir, 'build')
  if (!existsSync(join(buildDir, 'build.sh'))) {
    run(`git clone --depth 1 ${BUILD_REPO} ${buildDir}`)
  } else {
    console.log('[skip] EmulatorJS/build 已存在，复用。')
  }

  // 2) 装 emsdk（build_env.sh 钉的就是这个版本，别乱升）
  const emsdkDir = join(buildDir, '.emsdk')
  if (!existsSync(join(emsdkDir, 'emsdk_env.sh'))) {
    run(`git clone https://github.com/emscripten-core/emsdk.git ${emsdkDir}`)
    run(`./emsdk install ${args.emsdk} && ./emsdk activate ${args.emsdk}`, emsdkDir)
  } else {
    console.log(`[skip] emsdk 已存在，复用（${args.emsdk}）。`)
  }

  // 3) 注入核心配置 + 收束并行度
  injectCore(buildDir, args.sources)
  pinJobs(buildDir, args.jobs)

  // 4) 编译。必须 source 过 emsdk_env.sh，否则 emmake 不在 PATH 上
  if (args.skipBuild) {
    console.log('[skip] --skip-build：只准备了目录，没编译。')
  } else {
    run(`source ${emsdkDir}/emsdk_env.sh && bash build.sh --core=mame-current`, buildDir)
  }

  // MAME 版本与 ROM/CHD 哈希不可分割；核心刷新时把后台识别目录一起刷新，不能靠人工记得补游戏。
  // --skip-build 的约定只是准备构建目录：此时上游源码通常还不存在，不能因为目录尚未 clone
  // 就错误地把“预检”报成构建失败，更不能拿不完整的目录重写现有的识别清单。
  if (!args.skipBuild) syncMameChdCatalog(buildDir, args.sources)

  // 5) 收产物
  install(args.output, buildDir)
}

try {
  main()
} catch (err) {
  console.error('\n[失败]', err.message)
  process.exit(1)
}
