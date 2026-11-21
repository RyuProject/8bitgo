#!/usr/bin/env node
/**
 * 从固定提交构建 EKA2L1-WEB（塞班 / N-Gage 模拟器的 WebAssembly 移植），
 * 打上本站补丁，发布到 public/eka2l1/v<构建哈希>/。
 *
 * 用法：
 *   node scripts/build-eka2l1-web.mjs --src <EKA2L1-WEB 检出目录> [--emsdk <emsdk 目录>] [--jobs N]
 *
 * 为什么是「源码 + 补丁 + 内容哈希目录」：
 * - 上游只在个人站点托管构建，wasm 11MB 不压缩、max-age=0，且默认把游戏内 TCP
 *   转发到作者的中继（wss://qq.zixing.fun/ws/tcp）。自托管后由本站发 COOP/COEP、
 *   Brotli 预压缩和长期缓存。
 * - AGPL-3.0：本站修改过的版本必须向网络用户提供对应源码。补丁表就在本文件里，
 *   发布目录同时写 SOURCE.md（上游提交 + 每条补丁的说明），/symbian 页链接它。
 * - 目录名是产物内容哈希，换构建就换 URL，二进制可以 immutable 缓存，旧页面不会混用新旧文件。
 *
 * 每条补丁必须恰好命中一次；上游改了代码导致命中数不对时当场失败，别为了让构建通过删断言。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EKA2L1_ALL_PATCHES, EKA2L1_EXTERNAL_PATCHES, EKA2L1_GLUE_PATCHES, EKA2L1_PATCHES,
  EKA2L1_UPSTREAM, EKA2L1_UPSTREAM_COMMIT, applyReplacePatch,
} from './lib/eka2l1-patches.mjs'
import { EKA2L1_SITE_SCRIPTS, injectSiteScripts } from './lib/eka2l1-site-scripts.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const fail = (message) => {
  console.error(`✖ EKA2L1 构建失败：${message}`)
  process.exit(1)
}

const sourceArg = arg('--src') || process.env.EKA2L1_SOURCE_DIR
const src = sourceArg ? resolve(sourceArg) : fail('缺少 --src <EKA2L1-WEB 检出目录>')
const emsdk = arg('--emsdk') ? resolve(arg('--emsdk')) : process.env.EMSDK
const jobs = Number(arg('--jobs') || process.env.EKA2L1_BUILD_JOBS || 4)
const buildDir = join(src, 'build_wasm_8bitgo')

function run(cmd, cmdArgs, opts = {}) {
  const spawnArgs = emsdk
    ? ['-c', 'source "$1/emsdk_env.sh" >/dev/null 2>&1 && shift && exec "$@"', '--', emsdk, cmd, ...cmdArgs]
    : cmdArgs
  const executable = emsdk ? 'bash' : cmd
  const r = spawnSync(executable, spawnArgs, {
    cwd: opts.cwd || src,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: opts.capture ? 'utf8' : undefined,
  })
  if (r.error) fail(`${cmd} 启动失败：${r.error.message}`)
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} 退出码 ${r.status}${opts.capture ? `\n${r.stderr}` : ''}`)
  return (r.stdout || '').trim()
}

// 1. 固定提交：补丁按这一版写，换上游必须同时复核补丁
if (!existsSync(join(src, 'CMakeLists.txt'))) fail(`${src} 不是完整的 EKA2L1-WEB 源码目录`)
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) fail(`无效的并行任务数：${jobs}`)
if (emsdk && !existsSync(join(emsdk, 'emsdk_env.sh'))) fail(`emsdk 目录缺少 emsdk_env.sh：${emsdk}`)
const head = run('git', ['rev-parse', 'HEAD'], { capture: true })
if (head !== EKA2L1_UPSTREAM_COMMIT) fail(`检出的是 ${head}，期望 ${EKA2L1_UPSTREAM_COMMIT}`)

// 完整源码和许可证在编译前检查，稀疏检出 / 未初始化依赖不应先消耗数小时的链接资源。
const sourceRequirements = [
  'src/external/CMakeLists.txt',
  'src/emu/CMakeLists.txt',
  'src/emu/web/CMakeLists.txt',
  'src/emu/web/pages/js/boot.js',
  'src/emu/web/src/web_network.js',
  'src/emu/drivers/resources/gles',
  'src/emu/web/assets/fonts',
  'patches/external/README.md',
  ...EKA2L1_EXTERNAL_PATCHES.map((patch) => patch.file),
  'miscs',
]
for (const rel of sourceRequirements) {
  if (!existsSync(join(src, rel))) fail(`源码不完整，缺少 ${rel}；请完成完整检出和子模块下载后再构建`)
}
const licenseName = ['LICENSE', 'COPYING', 'LICENSE.txt'].find((name) => existsSync(join(src, name)))
if (!licenseName) fail('上游源码缺少 AGPL 许可证文本；不能发布派生运行文件')
const licenseBytes = readFileSync(join(src, licenseName))
if (!/GNU AFFERO GENERAL PUBLIC LICENSE|AGPL[- ]3/i.test(licenseBytes.toString('utf8').slice(0, 4096))) {
  fail(`${licenseName} 未声明 AGPL-3.0，需复核上游授权后再发布`)
}

// 2. 打补丁（幂等：已打过的跳过，未打过的必须恰好命中一次）
for (const patch of EKA2L1_PATCHES) {
  const file = join(src, patch.file)
  const original = readFileSync(file, 'utf8')
  let text = original
  try { text = applyReplacePatch(original, patch) } catch (err) { fail(err.message) }
  if (text !== original) {
    writeFileSync(file, text)
    console.log(`✓ 补丁 ${patch.id}`)
  } else {
    console.log(`· 补丁 ${patch.id} 已在位`)
  }
}

// 子模块补丁必须显式重打：完整源码目录里的开发机残留不能代表可复现构建。
for (const patch of EKA2L1_EXTERNAL_PATCHES) {
  const target = join(src, patch.target)
  const patchFile = join(src, patch.file)
  const check = spawnSync('git', ['-C', target, 'apply', '--check', patchFile], {
    cwd: src, stdio: 'pipe', encoding: 'utf8',
  })
  if (check.status === 0) {
    run('git', ['-C', target, 'apply', patchFile])
    console.log(`✓ 子模块补丁 ${patch.id}`)
    continue
  }
  const reverse = spawnSync('git', ['-C', target, 'apply', '--reverse', '--check', patchFile], {
    cwd: src, stdio: 'pipe', encoding: 'utf8',
  })
  if (reverse.status === 0) {
    console.log(`· 子模块补丁 ${patch.id} 已在位`)
    continue
  }
  fail(`子模块补丁「${patch.id}」无法正向或反向匹配 ${patch.target}\n${check.stderr || reverse.stderr || ''}`)
}

// 3. 构建（与上游 buildscript/build_release.sh 同参数）
const emcc = run('emcc', ['--version'], { capture: true }).split('\n')[0]
run('emcmake', ['cmake', '-S', src, '-B', buildDir, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
  '-DEKA2L1_DEBUG_BUILD=OFF',
  '-DEKA2L1_BUILD_TESTS=OFF',
  '-DEKA2L1_BUILD_TOOLS=OFF',
  '-DEKA2L1_BUILD_PATCH=OFF',
  '-DEKA2L1_ENABLE_SCRIPTING_ABILITY=OFF',
])
run('cmake', ['--build', buildDir, '--target', 'eka2l1_wasm', `-j${jobs}`])

// 4. 收集产物并按最终发布字节生成版本号；上游 build_id 不包含 web_network.js，
//    只用它做 URL 版本会让只改 relay 补丁的版本撞上旧的 immutable 缓存。
const bin = join(buildDir, 'bin')

// 链接产物上的文本补丁（与 repackage-eka2l1-web.mjs 共用同一份补丁和同一个 applyReplacePatch）
for (const patch of EKA2L1_GLUE_PATCHES) {
  const file = join(bin, patch.file)
  if (!existsSync(file)) fail(`构建产物缺少 ${patch.file}，无法打补丁「${patch.id}」`)
  const original = readFileSync(file, 'utf8')
  let text = original
  try { text = applyReplacePatch(original, patch) } catch (err) { fail(err.message) }
  if (text !== original) writeFileSync(file, text)
  console.log(`✓ 产物补丁 ${patch.id}`)
}
const buildIdJs = readFileSync(join(bin, 'js', 'build_id.js'), 'utf8')
const upstreamBuildId = /EKA2L1_BUILD_ID='([0-9a-f]{12})'/.exec(buildIdJs)?.[1]
  ?? fail('build_id.js 里没有 12 位构建哈希')

// 只发布运行需要的文件；构建暂存目录（resources/ miscs/ patch/ fonts/ 已打进 .data）、
// 上游的 Service Worker、冒烟页、EdgeOne 配置都不进站点。
const SHIP = ['index.html', 'run.html', 'manifest.json', 'eka2l1.js', 'eka2l1.wasm', 'eka2l1.data', 'css', 'js', 'icons']

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

const sourceDoc = [
  '# EKA2L1-WEB（8BitGo 自托管构建）',
  '',
  `本目录是 [EKA2L1-WEB](${EKA2L1_UPSTREAM}/tree/${EKA2L1_UPSTREAM_COMMIT})（GNU AGPL-3.0）提交`,
  `\`${EKA2L1_UPSTREAM_COMMIT}\` 的构建，工具链 ${emcc}。`,
  '许可证文本随本目录的 `LICENSE` 一并提供。',
  '',
  '对应源码 = 上游该提交 + 本目录 `source/` 中随附的本站补丁和构建脚本。',
  '补丁表：[`source/scripts/lib/eka2l1-patches.mjs`](source/scripts/lib/eka2l1-patches.mjs)；',
  '构建脚本：[`source/scripts/build-eka2l1-web.mjs`](source/scripts/build-eka2l1-web.mjs)。',
  '',
  ...EKA2L1_ALL_PATCHES.map((p) => `- **${p.id}**（${p.file}）：${p.why}`),
  '',
  'Emscripten 子模块补丁原文和应用说明随包提供于 `source/patches/external/`。',
  '',
  ...EKA2L1_SITE_SCRIPTS.filter((script) => script.doc).flatMap((script) => [script.doc, '']),
  '后台管理员配置的 N-Gage QD 默认 ROM 和站内游戏包会供玩家导入；其它固件（ROM / RPKG）由玩家自行提供。导入内容保存在玩家本机浏览器中，运行时发布包本身不包含任何固件或游戏文件。',
  '',
].join('\n')

const payload = new Map()
const publishedOverrides = new Map()
for (const name of SHIP) {
  const from = join(bin, name)
  if (!existsSync(from)) fail(`构建产物缺少 ${name}`)
  const paths = []
  if (readdirSync(bin, { withFileTypes: true }).find((entry) => entry.name === name)?.isDirectory()) {
    paths.push(...walk(from))
  } else {
    paths.push(from)
  }
  for (const file of paths) {
    const rel = relative(bin, file).split('\\').join('/')
    let data = readFileSync(file)
    if (rel === 'index.html') {
      const html = data.toString('utf8')
      for (const script of EKA2L1_SITE_SCRIPTS) {
        if (html.includes(script.published)) fail(`上游 index.html 意外已包含本站脚本 ${script.published}`)
      }
      try { data = Buffer.from(injectSiteScripts(html)) } catch (err) { fail(err.message) }
      publishedOverrides.set(rel, data)
    }
    payload.set(rel, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
}
for (const script of EKA2L1_SITE_SCRIPTS) {
  const bytes = readFileSync(join(root, script.source))
  payload.set(script.published, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  publishedOverrides.set(script.published, bytes)
}
payload.set('LICENSE', { bytes: licenseBytes.length, sha256: createHash('sha256').update(licenseBytes).digest('hex') })
const sourceBytes = Buffer.from(sourceDoc)
payload.set('SOURCE.md', { bytes: sourceBytes.length, sha256: createHash('sha256').update(sourceBytes).digest('hex') })
const sourceArtifacts = [
  ['source/scripts/build-eka2l1-web.mjs', join(root, 'scripts', 'build-eka2l1-web.mjs')],
  ['source/scripts/lib/eka2l1-patches.mjs', join(root, 'scripts', 'lib', 'eka2l1-patches.mjs')],
  ['source/scripts/lib/eka2l1-site-scripts.mjs', join(root, 'scripts', 'lib', 'eka2l1-site-scripts.mjs')],
  ...EKA2L1_SITE_SCRIPTS.map((script) => [script.sourceCopy, join(root, script.source)]),
  ['source/patches/external/README.md', join(src, 'patches/external/README.md')],
  ...EKA2L1_EXTERNAL_PATCHES.map((patch) => [`source/${patch.file}`, join(src, patch.file)]),
]
for (const [rel, file] of sourceArtifacts) {
  const data = readFileSync(file)
  payload.set(rel, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}

const contentHash = createHash('sha256')
for (const [rel, file] of [...payload].sort(([a], [b]) => a.localeCompare(b))) {
  contentHash.update(rel).update('\0').update(file.sha256).update('\n')
}
const buildId = contentHash.digest('hex').slice(0, 12)
const outDir = join(root, 'public', 'eka2l1', `v${buildId}`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const name of SHIP) cpSync(join(bin, name), join(outDir, name), { recursive: true })
for (const [rel, data] of publishedOverrides) {
  const file = join(outDir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, data)
}
writeFileSync(join(outDir, 'LICENSE'), licenseBytes)
writeFileSync(join(outDir, 'SOURCE.md'), sourceBytes)
for (const [rel, source] of sourceArtifacts) {
  const dest = join(outDir, rel)
  mkdirSync(join(dest, '..'), { recursive: true })
  cpSync(source, dest)
}

const files = Object.fromEntries([...payload].sort(([a], [b]) => a.localeCompare(b)))

writeFileSync(join(outDir, 'runtime.json'), `${JSON.stringify({
  runtime: 'EKA2L1-WEB',
  buildId,
  upstreamBuildId,
  upstream: EKA2L1_UPSTREAM,
  commit: EKA2L1_UPSTREAM_COMMIT,
  license: 'AGPL-3.0',
  emscripten: emcc,
  patches: EKA2L1_ALL_PATCHES.map((p) => p.id),
  files,
}, null, 2)}\n`)

// 5. 播放入口常量：/symbian 页按它跳转，check 脚本核对目录存在
writeFileSync(join(root, 'src', 'emulator', 'eka2l1Runtime.ts'), [
  '// 由 scripts/build-eka2l1-web.mjs 生成，勿手改。换构建 = 换目录，旧目录保留给已打开的页面。',
  `export const EKA2L1_BUILD_ID = '${buildId}'`,
  `export const EKA2L1_RUNTIME_DIR = '/eka2l1/v${buildId}/'`,
  '// boot.js 给 wasm / data 加的 ?v=（上游 build_id.js），预热要用同一个地址才命中缓存',
  `export const EKA2L1_UPSTREAM_BUILD_ID = '${upstreamBuildId}'`,
  '',
].join('\n'))

const total = Object.values(files).reduce((n, f) => n + f.bytes, 0)
console.log(`\n✓ 已发布 public/eka2l1/v${buildId}/（${(total / 1048576).toFixed(1)} MiB，${Object.keys(files).length} 个文件）`)
console.log('  下一步：node scripts/precompress-runtimes.mjs && node scripts/check-eka2l1-web.mjs')
