#!/usr/bin/env node

/**
 * 构建 /web/diablo（上游 d07RiV/diabloweb，一个 CRA v2 工程），产物同步到
 * `public/web/diablo/`，由 vite 原样拷进 dist/client，最后走 server 的 /web/:name 路由。
 *
 * 为什么源码要留在仓库里（`diabloweb/`）而不是只提交构建产物：
 * 这个工程是 2019 年的 webpack 4 工具链，**不重建就没法改文案/改上游**，
 * 而它踩的坑（下面那三条）只有源码在手才排得掉。工程体积 4.1MB，其中 3MB 是 wasm。
 *
 * 三条必须记住的构建约束 —— 每一条都对应一次真实的构建失败：
 *
 * 1. **babel 只认 class 属性，不认私有字段**。上游 package.json 的 `babel` 字段是
 *    `preset-env` + `preset-react`；`preset-env` 只在「目标浏览器不支持 class 字段」时才
 *    转译它，而 browserslist 数据一年年更新，现在（2026）的 `>0.2%, not dead` 全都支持，
 *    于是 class 字段被原样留给 webpack 4 —— webpack 4 的 acorn 解析不了，构建直接红。
 *    解法是给它一个**不随 browserslist 漂移的目标**（package.json 里写死的 targets）
 *    ＋ 显式加上 `@babel/plugin-proposal-class-properties`。
 *    同理，任何**依赖里**出现 `#private` 语法（Stage 3 之后才进 preset-env）也会炸：
 *    `peerjs` 从 1.5 起就带 `static #_ = ...`，所以这里钉在 1.0.2。
 *
 * 2. **上游的 package-lock.json 里带着没解决的 git 冲突标记**（4 处 node-sass 子树），
 *    是 2022 年一次合并留下的。JSON 都解析不了，`npm ci` 必失败，npm 会退化成
 *    按 package.json 的 ^ 范围重新解析 → 拿到今天最新的 @babel/core，于是踩上第 1 条。
 *    仓库里这份 lockfile 已经把冲突修掉并重新生成。
 *
 * 3. **Node 17+ 加载 webpack 4 需要 `--openssl-legacy-provider`**：webpack 4 用 md4 算
 *    模块哈希，OpenSSL 3 默认不再提供。报错是 `error:0308010C:digital envelope routines::unsupported`。
 *
 * 用法：npm run diablo:build
 *      npm run diablo:build -- --install   # node_modules 缺失时自动 npm ci
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'diabloweb')
const buildDir = join(sourceDir, 'build')
const targetDir = join(root, 'public/web/diablo')

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', cwd: sourceDir, ...options })

if (!existsSync(join(sourceDir, 'package.json'))) {
  console.error('✖ 找不到 diabloweb/package.json')
  process.exit(1)
}

if (!existsSync(join(sourceDir, 'node_modules'))) {
  console.log('· diabloweb/node_modules 不存在，先装依赖（约 1500 个包，第一次会慢一点）…')
  // --legacy-peer-deps：webpack 4 那代包的 peer 声明今天基本都不自洽，
  // 默认严格模式会直接拒绝安装。
  run('npm', ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'])
}

// CI=false：CRA 在 CI 环境下把 eslint 警告当错误，这里希望警告只提示、不拦构建。
// NODE_OPTIONS：见头注释第 3 条。
run('node', ['scripts/build.js'], {
  env: { ...process.env, CI: 'false', NODE_OPTIONS: '--openssl-legacy-provider' },
})

// 先清空再整体复制：webpack 的 chunk 文件名带内容哈希，增量复制会把上一版留成垃圾，
// 而且旧 index.html 指向的旧 chunk 会在线上继续可取（同名 chunk 内容不同是排查噩梦）。
rmSync(targetDir, { recursive: true, force: true })
cpSync(buildDir, targetDir, { recursive: true })
console.log(`✔ 已同步 ${buildDir} → ${targetDir}`)

/*
  webpack 仍负责给三份 wasm 生成内容哈希 URL，但正式站不再把二进制塞进 git / dist。
  清单留下“这个前端精确需要哪一批核心”，服务端按相同 URL 从 R2 回源；旧哈希对象不删，
  边缘还缓存着旧 worker 时仍能取到它配套的核心，不会拼成新旧混合物。
*/
const mediaDir = join(targetDir, 'static/media')
const wasmFiles = readdirSync(mediaDir).filter((name) => /^(?:Diablo|DiabloSpawn|MpqCmp)\.[a-f0-9]{8}\.wasm$/.test(name))
if (wasmFiles.length !== 3) throw new Error(`预期 3 份 Diablo wasm，实际 ${wasmFiles.length}：${wasmFiles.join(', ')}`)
const runtimeManifest = {
  version: 1,
  assets: wasmFiles.sort().map((file) => {
    const full = join(mediaDir, file)
    const bytes = readFileSync(full)
    return {
      file,
      size: statSync(full).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      r2: `web/diablo/runtime/${file}.br`,
    }
  }),
}
writeFileSync(join(targetDir, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
for (const file of wasmFiles) rmSync(join(mediaDir, file))
console.log('✔ Diablo wasm 已从公开目录剥离；runtime-manifest.json 记录 R2 配套核心')

// 校验单独放在脚本里，构建后立刻跑一次；prebuild / postbuild:client 也会跑。
execFileSync(process.execPath, [join(root, 'scripts/check-diabloweb.mjs')], { stdio: 'inherit' })
