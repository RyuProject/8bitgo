#!/usr/bin/env node
/**
 * 从已校验的 v21 生成 v22：按设备、网络与省流量状态收紧实际画布上限。
 *
 * 不重编 Wasm；Cloudflare 忽略运行时资源查询串，因此只生成新的实体目录，不覆盖旧版本。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = resolve(root, 'public/ppsspp/v0dbfaca')
const sourceDir = resolve(base, 'v21')
const targetDir = resolve(base, 'v22')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const fail = (message) => {
  console.error(`✖ PPSSPP v22 生成失败：${message}`)
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

if (!existsSync(sourceDir)) fail('缺少 v21 PPSSPP 基线')
if (existsSync(targetDir)) fail('v22 已存在；不可覆盖不可变运行时')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts || {})) {
  const path = resolve(sourceDir, name)
  if (!existsSync(path) || hash(readFileSync(path)) !== expected.sha256) {
    fail(`v21 ${name} 与 runtime.json 哈希不符`)
  }
}

const temporary = resolve(base, '.v22-performance-build')
if (existsSync(temporary)) fail('发现未完成的 v22 暂存目录；请先检查它，脚本不会清理开发者文件')
mkdirSync(temporary)
const working = resolve(temporary, 'v22')
try {
  copyDir(sourceDir, working)

  const hostPath = resolve(working, 'host.js')
  let host = readFileSync(hostPath, 'utf8').replaceAll('v21', 'v22')
  const oldProfile = `  const performanceProfile = () => {
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(navigator.deviceMemory) || 0)
    const connection = navigator.connection
    const type = String(connection?.effectiveType || '').toLowerCase()
    const downlink = Number(connection?.downlink) || 0
    const rtt = Number(connection?.rtt) || 0
    const saveData = connection?.saveData === true
    const qqBrowser = /(?:QQBrowser|MQQBrowser\\/|QQ\\/)/i.test(String(navigator.userAgent || ''))
    // 2026-11-15 QQ Browser 21 现场长时间音频欠载后发生 Worker RuntimeError；该环境固定用 PSP 原生尺寸，
    // 并关闭额外 SAS 线程，减少画布与线程调度开销。v20 的慢网判定继续覆盖其它浏览器。
    if (qqBrowser) return { id: 'qq-compat', width: 480, height: 272, separateSasThread: false }
    // 模拟线程会同步等远程 Range；慢网时保留高分辨率和额外 SAS 线程，会加重音频欠载。
    const slowNetwork = type === 'slow-2g' || type === '2g' ||
      (type === '3g' && ((downlink > 0 && downlink <= 3) || rtt >= 400)) ||
      (downlink > 0 && downlink <= 1.5) || rtt >= 800
    // 画布后备缓冲有独立硬上限，防止 SDL 把视口尺寸直接变成每帧昂贵的 WebGL 目标。
    if (saveData || slowNetwork || cores <= 2 || (memory > 0 && memory <= 2)) {
      return { id: 'performance', width: 480, height: 272, separateSasThread: false }
    }
    if (cores <= 4 || (memory > 0 && memory <= 4)) {
      return { id: 'balanced', width: 720, height: 408, separateSasThread: false }
    }
    return { id: 'quality', width: 960, height: 544, separateSasThread: true }
  }`
  const newProfile = `  const performanceProfile = () => {
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(navigator.deviceMemory) || 0)
    const connection = navigator.connection
    const type = String(connection?.effectiveType || '').toLowerCase()
    const downlink = Number(connection?.downlink) || 0
    const rtt = Number(connection?.rtt) || 0
    const saveData = connection?.saveData === true
    const userAgent = String(navigator.userAgent || '')
    const qqBrowser = /(?:QQBrowser|MQQBrowser\\/|QQ\\/)/i.test(userAgent)
    const mobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
      (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints) > 1)
    // 设备信息不完整时不猜高配；移动端和 QQ 浏览器优先压低每帧要处理的像素数。
    if (qqBrowser) return { id: 'qq-compat', width: 480, height: 272, separateSasThread: false }
    if (mobileDevice) return { id: 'mobile', width: 480, height: 272, separateSasThread: false }
    const slowNetwork = type === 'slow-2g' || type === '2g' ||
      (type === '3g' && ((downlink > 0 && downlink <= 3) || rtt >= 400)) ||
      (downlink > 0 && downlink <= 1.5) || rtt >= 800
    // 弱网、省流或低配设备保持 PSP 原生画布；SAS 线程也只留给明确识别的桌面高配设备。
    if (saveData || slowNetwork || cores <= 4 || (memory > 0 && memory <= 4)) {
      return { id: 'performance', width: 480, height: 272, separateSasThread: false }
    }
    const highEndDesktop = cores >= 8 && memory >= 8
    if (highEndDesktop) return { id: 'high-end', width: 720, height: 408, separateSasThread: true }
    return { id: 'balanced', width: 640, height: 360, separateSasThread: false }
  }`
  host = replaceOnce(host, oldProfile, newProfile, '性能优先的设备分档')
  writeFileSync(hostPath, host)

  const runtimePath = resolve(working, 'PPSSPPSDL.js')
  let runtime = readFileSync(runtimePath, 'utf8')
  const oldCanvasHelper = "var __8bitgoPspCanvasSize=(width,height)=>{if(!(width>0&&height>0))return [width,height];var navigator=globalThis.navigator;var connection=navigator?.connection;var type=String(connection?.effectiveType||'').toLowerCase();var downlink=Number(connection?.downlink)||0;var rtt=Number(connection?.rtt)||0;var cores=Math.max(1,Number(navigator?.hardwareConcurrency)||4);var memory=Math.max(0,Number(navigator?.deviceMemory)||0);var qqBrowser=/(?:QQBrowser|MQQBrowser\\/|QQ\\/)/i.test(String(navigator?.userAgent||''));var slow=qqBrowser||connection?.saveData===true||type==='slow-2g'||type==='2g'||(type==='3g'&&((downlink>0&&downlink<=3)||rtt>=400))||(downlink>0&&downlink<=1.5)||rtt>=800||cores<=2||(memory>0&&memory<=2);var balanced=cores<=4||(memory>0&&memory<=4);var maxWidth=slow?480:balanced?720:960;var maxHeight=slow?272:balanced?408:544;var scale=Math.min(1,maxWidth/width,maxHeight/height);return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]};"
  const newCanvasHelper = "var __8bitgoPspCanvasSize=(width,height)=>{if(!(width>0&&height>0))return [width,height];var navigator=globalThis.navigator;var connection=navigator?.connection;var type=String(connection?.effectiveType||'').toLowerCase();var downlink=Number(connection?.downlink)||0;var rtt=Number(connection?.rtt)||0;var cores=Math.max(1,Number(navigator?.hardwareConcurrency)||4);var memory=Math.max(0,Number(navigator?.deviceMemory)||0);var userAgent=String(navigator?.userAgent||'');var qqBrowser=/(?:QQBrowser|MQQBrowser\\/|QQ\\/)/i.test(userAgent);var mobileDevice=/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)||(navigator?.platform==='MacIntel'&&Number(navigator?.maxTouchPoints)>1);var slow=connection?.saveData===true||type==='slow-2g'||type==='2g'||(type==='3g'&&((downlink>0&&downlink<=3)||rtt>=400))||(downlink>0&&downlink<=1.5)||rtt>=800;var low=cores<=4||(memory>0&&memory<=4);var highEndDesktop=cores>=8&&memory>=8&&!mobileDevice&&!slow&&!qqBrowser;var maxWidth=qqBrowser||mobileDevice||slow||low?480:highEndDesktop?720:640;var maxHeight=qqBrowser||mobileDevice||slow||low?272:highEndDesktop?408:360;var scale=Math.min(1,maxWidth/width,maxHeight/height);return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]};"
  runtime = replaceOnce(runtime, oldCanvasHelper, newCanvasHelper, '实际绘图缓冲的设备自适应硬上限')
  writeFileSync(runtimePath, runtime)

  const sourcePath = resolve(working, 'SOURCE.txt')
  const sourceText = readFileSync(sourcePath, 'utf8')
    .replaceAll('v21 browser bridge', 'v22 browser bridge')
    .replace('480×272, 720×408, or 960×544', '480×272, 640×360, or 720×408')
    .replace('by browser, device, and network profile', 'by mobile/desktop device, known hardware, browser, and network profile')
  writeFileSync(sourcePath, sourceText)

  const manifestPath = resolve(working, 'runtime.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.runtimeGeneration = 'v22'
  manifest.performanceProfile = 'adaptive-performance-first-device-v1'
  manifest.maxCanvasPixels = 293760
  manifest.canvasLimitProfile = 'qq/mobile/weak/low=480x272;default=640x360;highEndDesktop=720x408'
  for (const name of ['PPSSPPSDL.js', 'host.js', 'SOURCE.txt']) {
    const bytes = readFileSync(resolve(working, name))
    manifest.artifacts[name] = { bytes: statSync(resolve(working, name)).size, sha256: hash(bytes) }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v22 已生成：移动/弱网低配 480×272，默认 640×360，明确桌面高配 720×408')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
