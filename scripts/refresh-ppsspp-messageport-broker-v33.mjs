#!/usr/bin/env node
/**
 * PPSSPP v33 用直接 MessagePort 替换 BroadcastChannel Broker。
 *
 * v32 临时产物的实测发现 Chromium BroadcastChannel 不能传递 pthread 的 SharedArrayBuffer，
 * 共享 Range 请求因此退回原生 XHR。v33 沿 Emscripten load 消息给每个 pthread 分配独立端口，
 * 由 iframe 内的单个 Broker Worker 共享验证后的 Range 响应；从校验完整的 v31 基线生成，
 * 保留稳定版的 host.js，不继承 v32 测试时写入的诊断日志和临时 homebrew 文件。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPspRangeBrokerPorts, replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = resolve(root, 'public/ppsspp/v0dbfaca')
const sourceDir = resolve(base, 'v31')
const targetDir = resolve(base, 'v33')
const temporaryBase = mkdtempSync(resolve(base, '.v33-messageport-broker-'))
const working = resolve(temporaryBase, 'v33')
const rangeSource = readFileSync(join(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8')
const prefetchWorkerSource = readFileSync(join(root, 'vendor/ppsspp/range-prefetch-worker.js'), 'utf8')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sri = (digest) => `sha256-${Buffer.from(digest, 'hex').toString('base64')}`
const fail = (message) => { throw new Error(message) }

try {
  if (!existsSync(sourceDir)) fail('缺少已校验的 PPSSPP v31 移动触控基线')
  if (existsSync(targetDir)) fail('PPSSPP v33 已存在；不可覆盖不可变运行时')

  const sourceManifest = JSON.parse(readFileSync(join(sourceDir, 'runtime.json'), 'utf8'))
  if (sourceManifest.runtimeGeneration !== 'v31' || sourceManifest.coreAssetGeneration !== 'v31') {
    fail('PPSSPP v31 的实体目录代次与清单不一致')
  }
  for (const [name, expected] of Object.entries(sourceManifest.artifacts || {})) {
    const bytes = readFileSync(join(sourceDir, name))
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
      fail(`v31 中的 ${name} 与已校验清单不符`)
    }
  }
  cpSync(sourceDir, working, { recursive: true })

  const runtimeScriptPath = join(working, 'PPSSPPSDL.js')
  const runtimeScript = readFileSync(runtimeScriptPath, 'utf8')
  let refreshedRuntimeScript = replacePspRangeReadAhead(runtimeScript, rangeSource)
  refreshedRuntimeScript = installPspRangeBrokerPorts(refreshedRuntimeScript)
  if (refreshedRuntimeScript === runtimeScript) fail('Range 运行时与 pthread Broker 端口补丁均未更新')
  writeFileSync(runtimeScriptPath, refreshedRuntimeScript)
  writeFileSync(join(working, 'range-prefetch-worker.js'), prefetchWorkerSource)

  const hostPath = join(working, 'host.js')
  let host = readFileSync(hostPath, 'utf8')
  const hostAnchor = "    const script = document.createElement('script')"
  const brokerInit = `    try {
      // 专用 Worker 通过 Emscripten 的 pthread 初始化消息分发 MessagePort；浏览器事件队列不会阻塞 ROM 同步读盘。
      if (typeof Worker === 'function' && typeof MessageChannel === 'function') {
        window.__8bitgoPspRangeBrokerWorker = new Worker(new URL('range-prefetch-worker.js', location.href))
      }
    } catch (error) {
      console.warn('[ppsspp] Range Broker Worker 无法启动，改用核心原生读盘', error)
    }

${hostAnchor}`
  if (host.includes('__8bitgoPspRangeBrokerWorker')) fail('v31 host.js 已包含 Broker 启动代码，检查代次来源')
  if (host.split(hostAnchor).length !== 2) fail('v31 host.js 缺少唯一的 PPSSPP runtime 注入位置')
  host = host.replace(hostAnchor, brokerInit)

  const runtimeSriPattern = /script\.integrity = 'sha256-[^']+'/g
  if ((host.match(runtimeSriPattern) || []).length !== 1) fail('v31 host.js 的核心脚本 SRI 位置不唯一')
  host = host.replace(runtimeSriPattern, `script.integrity = '${sri(sha256(readFileSync(runtimeScriptPath)))}'`)
  writeFileSync(hostPath, host)

  const indexPath = join(working, 'index.html')
  let indexHtml = readFileSync(indexPath, 'utf8')
  const hostTag = /<script src="host\.js" integrity="sha256-[^"]+" crossorigin="anonymous"><\/script>/
  if (!hostTag.test(indexHtml)) fail('v31 index.html 缺少 host.js SRI 标签')
  indexHtml = indexHtml.replace(hostTag,
    `<script src="host.js" integrity="${sri(sha256(Buffer.from(host)))}" crossorigin="anonymous"></script>`)
  writeFileSync(indexPath, indexHtml)

  const sourceInfoPath = join(working, 'SOURCE.txt')
  const sourceInfo = readFileSync(sourceInfoPath, 'utf8')
  writeFileSync(sourceInfoPath,
    `${sourceInfo.trimEnd()}\n\nv33 connects each Emscripten pthread to one page-owned Range Broker through a direct MessagePort. Unlike BroadcastChannel, MessagePort carries SharedArrayBuffer, so duplicate in-flight Range reads share one validated network response.\n`)

  const manifest = {
    ...sourceManifest,
    runtimeGeneration: 'v33',
    coreAssetGeneration: 'v33',
    rangeReadAheadProfile: 'adaptive-rolling-buffer-messageport-page-broker-demand-coalescing-v3',
    artifacts: { ...sourceManifest.artifacts },
  }
  for (const name of readdirSync(working)) {
    const path = join(working, name)
    if (!statSync(path).isFile() || name === 'runtime.json' || name.endsWith('.br.json')) continue
    const bytes = readFileSync(path)
    manifest.artifacts[name] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
  }
  for (const name of ['PPSSPPSDL.wasm', 'PPSSPPSDL.data']) {
    const expected = manifest.integrityBlocks?.[name]
    const bytes = readFileSync(join(working, name))
    const actual = []
    if (!expected || expected.bytes !== bytes.byteLength || expected.blocks.length === 0) {
      fail(`${name} 缺少完整性分块清单`)
    }
    for (let offset = 0; offset < bytes.byteLength; offset += expected.blockBytes) {
      actual.push(sha256(bytes.subarray(offset, Math.min(bytes.byteLength, offset + expected.blockBytes))))
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected.blocks)) fail(`${name} 与 v31 的 SHA-256 分块不一致`)
  }
  writeFileSync(join(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  renameSync(working, targetDir)
  console.log('✔ PPSSPP v33 pthread MessagePort Broker 实体运行时已生成')
  console.log('  Wasm/data 与校验通过的 v31 基线 SHA-256 完全一致，JS / Worker、host.js SRI 与运行时清单同步')
} finally {
  rmSync(temporaryBase, { recursive: true, force: true })
}
