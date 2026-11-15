#!/usr/bin/env node
/**
 * 从已校验的 v19 生成 v20：限制 PPSSPP 实际画布尺寸，并保留 worker 崩溃栈。
 *
 * 不重编 Wasm。Cloudflare 会忽略这组资源的查询串，不能覆盖 v19 或只改桥文件。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = resolve(root, 'public/ppsspp/v0dbfaca')
const sourceDir = resolve(base, 'v19')
const targetDir = resolve(base, 'v20')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const fail = (message) => {
  console.error(`✖ PPSSPP v20 生成失败：${message}`)
  process.exit(1)
}
const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    fail(`${label} 锚点缺失或不唯一；不要把补丁套到不同的 Emscripten 输出`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}
const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = resolve(from, entry.name)
    const target = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
  }
}

if (!existsSync(sourceDir)) fail('缺少 v19 PPSSPP 基线')
if (existsSync(targetDir)) fail('v20 已存在；不可覆盖不可变运行时')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts || {})) {
  const path = resolve(sourceDir, name)
  if (!existsSync(path) || hash(readFileSync(path)) !== expected.sha256) {
    fail(`v19 ${name} 与 runtime.json 哈希不符`)
  }
}

const temporary = resolve(base, '.v20-stability-build')
if (existsSync(temporary)) fail('发现未完成的 v20 暂存目录；请先检查它，脚本不会清理开发者文件')
mkdirSync(temporary)
const working = resolve(temporary, 'v20')
try {
  copyDir(sourceDir, working)

  const hostPath = resolve(working, 'host.js')
  let host = readFileSync(hostPath, 'utf8')
  host = host.replaceAll('v19', 'v20')

  const oldProfile = `    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(navigator.deviceMemory) || 0)
    const saveData = navigator.connection?.saveData === true
    // PPSSPP 的游戏内部仍按 PSP 分辨率整数倍渲染；画布只负责最终呈现。此前画布跟着
    // Retina 屏达到约 2K，代理 WebGL 每帧白白多复制 4 倍像素。按设备能力限制最终
    // 后备缓冲，既不改变游戏逻辑，也能同时降低直播编码器的输入尺寸。
    if (saveData || cores <= 2 || (memory > 0 && memory <= 2)) {`
  const newProfile = `    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(navigator.deviceMemory) || 0)
    const connection = navigator.connection
    const type = String(connection?.effectiveType || '').toLowerCase()
    const downlink = Number(connection?.downlink) || 0
    const rtt = Number(connection?.rtt) || 0
    const saveData = connection?.saveData === true
    // 模拟线程会同步等远程 Range；慢网时保留高分辨率和额外 SAS 线程，会加重音频欠载。
    const slowNetwork = type === 'slow-2g' || type === '2g' ||
      (type === '3g' && ((downlink > 0 && downlink <= 3) || rtt >= 400)) ||
      (downlink > 0 && downlink <= 1.5) || rtt >= 800
    // 画布后备缓冲有独立硬上限，防止 SDL 把视口尺寸直接变成每帧昂贵的 WebGL 目标。
    if (saveData || slowNetwork || cores <= 2 || (memory > 0 && memory <= 2)) {`
  host = replaceOnce(host, oldProfile, newProfile, '慢网性能档')
  host = replaceOnce(
    host,
    "const respond = (requestId, ok, payload = undefined, error = undefined, transfer = []) => {",
    "const respond = (requestId, ok, payload = undefined, error = undefined, transfer = [], diagnostics = undefined) => {",
    '运行时错误响应',
  )
  host = replaceOnce(
    host,
    "{ source: SOURCE, version: VERSION, type: 'response', requestId, ok, payload, error },",
    "{ source: SOURCE, version: VERSION, type: 'response', requestId, ok, payload, error, diagnostics },",
    '运行时错误响应内容',
  )
  host = replaceOnce(
    host,
    '    const fail = (message) => {\n      if (fatal) return',
    "    const fail = (message, diagnostics = '') => {\n      if (fatal) return",
    '运行时故障边界',
  )
  host = replaceOnce(
    host,
    '        respond(requestId, false, undefined, message)\n      } else {\n        post(\'runtime-error\', { error: message })',
    "        respond(requestId, false, undefined, message, [], String(diagnostics || '').slice(0, 6000))\n      } else {\n        post('runtime-error', { error: message, diagnostics: String(diagnostics || '').slice(0, 6000) })",
    '运行时诊断转发',
  )
  host = replaceOnce(
    host,
    "window.__8bitgoPspRuntimeError = (message) => fail(`PPSSPP 运行时异常：${String(message || '未知错误')}`)",
    "window.__8bitgoPspRuntimeError = (message, diagnostics) => fail(`PPSSPP 运行时异常：${String(message || '未知错误')}`, diagnostics)",
    '运行时错误入口',
  )
  host = replaceOnce(
    host,
    "    window.__8bitgoPspRuntimeError?.(event.error?.message || event.message || '运行时脚本异常')",
    "    const error = event.error\n    const details = [error?.stack, error?.error?.stack, `${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}`].filter(Boolean).join('\\n')\n    window.__8bitgoPspRuntimeError?.(error?.message || event.message || '运行时脚本异常', details)",
    '页面错误栈采集',
  )
  host = replaceOnce(
    host,
    "    window.__8bitgoPspRuntimeError?.(event.reason?.message || event.reason || '运行时 Promise 异常')",
    "    window.__8bitgoPspRuntimeError?.(event.reason?.message || event.reason || '运行时 Promise 异常', stack)",
    'Promise 错误栈采集',
  )
  writeFileSync(hostPath, host)

  const runtimePath = resolve(working, 'PPSSPPSDL.js')
  let runtime = readFileSync(runtimePath, 'utf8')
  const workerError = 'err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);throw e'
  runtime = replaceOnce(
    runtime,
    workerError,
    'var details=e.error?.stack||e.stack||"";err(`${message} ${e.filename}:${e.lineno}:${e.colno||0}: ${e.message}${details?` ${details}`:""}`);throw e',
    'Emscripten worker 错误栈',
  )
  const canvasHelper = "var __8bitgoPspCanvasSize=(width,height)=>{if(!(width>0&&height>0))return [width,height];var connection=globalThis.navigator?.connection;var type=String(connection?.effectiveType||'').toLowerCase();var downlink=Number(connection?.downlink)||0;var rtt=Number(connection?.rtt)||0;var cores=Math.max(1,Number(globalThis.navigator?.hardwareConcurrency)||4);var memory=Math.max(0,Number(globalThis.navigator?.deviceMemory)||0);var slow=connection?.saveData===true||type==='slow-2g'||type==='2g'||(type==='3g'&&((downlink>0&&downlink<=3)||rtt>=400))||(downlink>0&&downlink<=1.5)||rtt>=800||cores<=2||(memory>0&&memory<=2);var balanced=cores<=4||(memory>0&&memory<=4);var maxWidth=slow?480:balanced?720:960;var maxHeight=slow?272:balanced?408:544;var scale=Math.min(1,maxWidth/width,maxHeight/height);return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]};"
  runtime = replaceOnce(runtime, 'var setCanvasElementSize=(target,width,height)=>{', `${canvasHelper}var setCanvasElementSize=(target,width,height)=>{var __8bgSize=__8bitgoPspCanvasSize(width,height);width=__8bgSize[0];height=__8bgSize[1];`, '主线程画布尺寸上限')
  runtime = replaceOnce(
    runtime,
    'updateCanvasDimensions(canvas,wNative,hNative){if(wNative&&hNative){canvas.widthNative=wNative;canvas.heightNative=hNative}',
    'updateCanvasDimensions(canvas,wNative,hNative){if(wNative&&hNative){var __8bgSize=__8bitgoPspCanvasSize(wNative,hNative);wNative=__8bgSize[0];hNative=__8bgSize[1];canvas.widthNative=wNative;canvas.heightNative=hNative}',
    'Worker 画布尺寸上限',
  )
  writeFileSync(runtimePath, runtime)

  const sourcePath = resolve(working, 'SOURCE.txt')
  const sourceText = readFileSync(sourcePath, 'utf8')
    .replaceAll('v19 browser bridge', 'v20 browser bridge')
    .replace('The v20 browser bridge keeps every game at native internal resolution', 'The v20 browser bridge caps the actual drawing buffer at 480×272, 720×408, or 960×544 by device and network profile, while keeping games at native internal resolution')
  writeFileSync(sourcePath, sourceText)

  const manifest = JSON.parse(readFileSync(resolve(working, 'runtime.json'), 'utf8'))
  manifest.runtimeGeneration = 'v20'
  manifest.performanceProfile = 'adaptive-canvas-slow-network-v2'
  manifest.canvasLimitProfile = 'performance=480x272;balanced=720x408;quality=960x544;slowNetwork=performance'
  manifest.workerErrorDiagnostics = 'stack-v1'
  for (const name of ['PPSSPPSDL.js', 'host.js', 'SOURCE.txt']) {
    const bytes = readFileSync(resolve(working, name))
    manifest.artifacts[name] = { bytes: statSync(resolve(working, name)).size, sha256: hash(bytes) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v20 已生成：慢网画布上限与 worker 崩溃栈诊断已加入，旧 v19 保持不变')
} finally {
  // 暂存目录只包含本脚本新建的 v20 副本；只清理本次明确创建的目录。
  const { rmSync } = await import('node:fs')
  rmSync(temporary, { recursive: true, force: true })
}
