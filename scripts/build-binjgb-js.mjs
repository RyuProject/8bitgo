#!/usr/bin/env node
/**
 * 构建 binjgb 的纯 JavaScript 版（Emscripten `-s WASM=0`，wasm2js），给关闭了 WebAssembly 的浏览器跑 GB/GBC。
 *
 * 为什么不是 jsGBC 之类的纯 JS 模拟器：同一个 binjgb 核心、同一个上游提交（public/binjgb/UPSTREAM.md），
 * 精度一样，即时存档 / 电池存档格式一样，适配器（src/emulator/adapters/binjgb.ts）原样复用；
 * 上游 CMakeLists.txt 本来就有 `option(WASM ... OFF)` → `-s WASM=0` 这条构建路径。代价只是比 WebAssembly 慢，
 * 而 GB/GBC 的负载很轻。
 *
 * 用法：
 *   node scripts/build-binjgb-js.mjs [--workdir /tmp/binjgb-js-build] [--jobs 6]
 * 产物：public/binjgb/binjgb-js.js（全局名 BinjgbJs，免得和 WebAssembly 版的 Binjgb 撞名）+ public/binjgb/binjgb-js.json。
 * 升级 binjgb 时两份构建（.wasm 和 -js）必须同一个提交，`BINJGB_BUILD` 也一起换。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BINJGB_REPO = 'https://github.com/binji/binjgb.git'
// 必须和 public/binjgb/UPSTREAM.md、adapters/binjgb.ts 的 BINJGB_BUILD 一致
const BINJGB_COMMIT = '16621111ed0ee73bcc45c912a823bcebedcffc0f'
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git'
const EMSDK_VERSION = '4.0.20'

const args = { workdir: '/tmp/binjgb-js-build', jobs: 6 }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--workdir') args.workdir = process.argv[++i]
  else if (arg === '--jobs') args.jobs = Number(process.argv[++i]) || 6
  else throw new Error(`未知参数：${arg}`)
}

const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const sh = (command, cwd = args.workdir) => execFileSync('/bin/bash', ['-lc', `set -euo pipefail; ${command}`], { cwd, stdio: 'inherit' })

mkdirSync(args.workdir, { recursive: true })
const emsdkDir = join(args.workdir, 'emsdk')
const srcDir = join(args.workdir, 'binjgb')
const outDir = join(args.workdir, 'out-js')

if (!existsSync(join(emsdkDir, 'emsdk_env.sh'))) sh(`git clone --depth 1 ${q(EMSDK_REPO)} ${q(emsdkDir)}`)
sh(`./emsdk install ${EMSDK_VERSION} && ./emsdk activate ${EMSDK_VERSION}`, emsdkDir)
const env = `source ${q(join(emsdkDir, 'emsdk_env.sh'))} >/dev/null`

if (!existsSync(join(srcDir, '.git'))) sh(`git clone ${q(BINJGB_REPO)} ${q(srcDir)}`)
sh(`git fetch --quiet origin && git checkout --quiet ${BINJGB_COMMIT} && git submodule update --init --recursive --quiet`, srcDir)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir, encoding: 'utf8' }).trim()
if (head !== BINJGB_COMMIT) throw new Error(`binjgb 提交不对：${head}`)

sh(`${env}; emcmake cmake -S ${q(srcDir)} -B ${q(outDir)} -G Ninja -DCMAKE_BUILD_TYPE=Release -DWASM=OFF && cmake --build ${q(outDir)} --target binjgb -j ${args.jobs}`)

const built = readdirSync(outDir).filter((name) => /^binjgb\.(js|wasm|mem|js\.mem)$/.test(name))
if (built.includes('binjgb.wasm') || built.includes('binjgb.mem') || built.includes('binjgb.js.mem')) {
  throw new Error(`WASM=0 构建不该产出额外文件：${built.join(', ')}`)
}
let js = readFileSync(join(outDir, 'binjgb.js'), 'utf8')
if (/WebAssembly\.(instantiate|compile|Module)\(/.test(js) && !/WebAssembly\s*=/.test(js) && !/wasm2js/i.test(js)) {
  // wasm2js 产物自带一个最小 WebAssembly 兼容层；真引用原生 WebAssembly 就不是我们要的东西
  console.warn('⚠️ 产物里有对原生 WebAssembly 的调用，核对一下是不是真的 WASM=0 构建')
}
const before = js.length
js = js.replace(/^var Binjgb\s*=/m, 'var BinjgbJs=')
if (js.length === before && !/var BinjgbJs=/.test(js)) throw new Error('没找到 `var Binjgb=` 导出，无法改成 BinjgbJs')
const header = `// binjgb ${BINJGB_COMMIT} 纯 JavaScript 构建（Emscripten ${EMSDK_VERSION}，-s WASM=0）。由 scripts/build-binjgb-js.mjs 生成，勿手改。MIT，见 LICENSE。\n`
js = header + js
const target = join(repoRoot, 'public/binjgb/binjgb-js.js')
writeFileSync(target, js)
const sha256 = createHash('sha256').update(js).digest('hex')
writeFileSync(join(repoRoot, 'public/binjgb/binjgb-js.json'), `${JSON.stringify({
  upstream: BINJGB_REPO,
  commit: BINJGB_COMMIT,
  emsdk: EMSDK_VERSION,
  wasm: false,
  exportName: 'BinjgbJs',
  bytes: Buffer.byteLength(js),
  sha256,
}, null, 2)}\n`)
console.log(`✔ public/binjgb/binjgb-js.js  ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB  sha256 ${sha256.slice(0, 16)}…`)
