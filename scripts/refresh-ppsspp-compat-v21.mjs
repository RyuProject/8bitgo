#!/usr/bin/env node
/**
 * 从已校验的 v20 生成 v21：QQ Browser 使用保守画布档，运行时崩溃前先冲刷电池存档。
 *
 * 不重编 Wasm；Cloudflare 忽略运行时资源查询串，因此只生成新的实体目录，不覆盖 v20。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = resolve(root, 'public/ppsspp/v0dbfaca')
const sourceDir = resolve(base, 'v20')
const targetDir = resolve(base, 'v21')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const fail = (message) => {
  console.error(`✖ PPSSPP v21 生成失败：${message}`)
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

if (!existsSync(sourceDir)) fail('缺少 v20 PPSSPP 基线')
if (existsSync(targetDir)) fail('v21 已存在；不可覆盖不可变运行时')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts || {})) {
  const path = resolve(sourceDir, name)
  if (!existsSync(path) || hash(readFileSync(path)) !== expected.sha256) {
    fail(`v20 ${name} 与 runtime.json 哈希不符`)
  }
}

const temporary = resolve(base, '.v21-compat-build')
if (existsSync(temporary)) fail('发现未完成的 v21 暂存目录；请先检查它，脚本不会清理开发者文件')
mkdirSync(temporary)
const working = resolve(temporary, 'v21')
try {
  copyDir(sourceDir, working)

  const hostPath = resolve(working, 'host.js')
  let host = readFileSync(hostPath, 'utf8')
  host = host.replaceAll('v20', 'v21')

  const oldProfile = `  const performanceProfile = () => {
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
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
  host = replaceOnce(host, oldProfile, newProfile, 'QQ 浏览器性能档')

  const oldSync = `  const syncSaves = () => {
    if (!saveSyncEnabled) return
    if (syncRunning) {
      syncQueued = true
      return
    }
    try {
      if (typeof FS === 'undefined') return
      syncRunning = true
      FS.syncfs(false, (error) => {
        syncRunning = false
        if (error) console.warn('[ppsspp] 存档写入 IndexedDB 失败', error)
        if (syncQueued) {
          syncQueued = false
          syncSaves()
        }
      })
    } catch (error) {
      syncRunning = false
      console.warn('[ppsspp] 无法同步存档', error)
    }
  }`
  const newSync = `  let syncPromise = null
  const syncSaves = () => {
    if (!saveSyncEnabled || typeof FS === 'undefined') return Promise.resolve()
    if (syncRunning) {
      syncQueued = true
      return syncPromise || Promise.resolve()
    }
    syncRunning = true
    let resolveSync
    const currentSync = new Promise((resolve) => { resolveSync = resolve })
    syncPromise = currentSync
    try {
      FS.syncfs(false, (error) => {
        syncRunning = false
        if (error) console.warn('[ppsspp] 存档写入 IndexedDB 失败', error)
        const queued = syncQueued
        syncQueued = false
        syncPromise = null
        if (queued) {
          void syncSaves().then(resolveSync, resolveSync)
        } else {
          resolveSync()
        }
      })
    } catch (error) {
      syncRunning = false
      syncPromise = null
      console.warn('[ppsspp] 无法同步存档', error)
      resolveSync()
    }
    return currentSync
  }`
  host = replaceOnce(host, oldSync, newSync, '存档同步 Promise')

  const oldFatal = `    const fail = (message, diagnostics = '') => {
      if (fatal) return
      fatal = true
      localDisc?.channel.close()
      stopReadyChecks()
      window.clearInterval(syncTimer)
      setStatus(message, 'error')
      if (!requestSettled) {
        requestSettled = true
        respond(requestId, false, undefined, message, [], String(diagnostics || '').slice(0, 6000))
      } else {
        post('runtime-error', { error: message, diagnostics: String(diagnostics || '').slice(0, 6000) })
      }
    }`
  const newFatal = `    const fail = (message, diagnostics = '') => {
      if (fatal) return
      fatal = true
      localDisc?.channel.close()
      stopReadyChecks()
      window.clearInterval(syncTimer)
      setStatus(message, 'error')
      if (!requestSettled) {
        requestSettled = true
        respond(requestId, false, undefined, message, [], String(diagnostics || '').slice(0, 6000))
      } else {
        // 运行多分钟后核心可能突然崩溃。先让 IDBFS 冲刷当前 Memory Stick，最多等 1.5 秒再通知父页拆播放器。
        // 同步失败或 IndexedDB 卡住时仍要上报 RuntimeError，不能让界面永久留在错误页。
        let flushTimer = 0
        const flushDeadline = new Promise((resolve) => {
          flushTimer = window.setTimeout(resolve, 1500)
        })
        void Promise.race([syncSaves(), flushDeadline]).finally(() => {
          window.clearTimeout(flushTimer)
          post('runtime-error', { error: message, diagnostics: String(diagnostics || '').slice(0, 6000) })
        })
      }
    }`
  host = replaceOnce(host, oldFatal, newFatal, '运行时故障前冲刷存档')
  writeFileSync(hostPath, host)

  const runtimePath = resolve(working, 'PPSSPPSDL.js')
  let runtime = readFileSync(runtimePath, 'utf8')
  const oldCanvasHelper = "var __8bitgoPspCanvasSize=(width,height)=>{if(!(width>0&&height>0))return [width,height];var connection=globalThis.navigator?.connection;var type=String(connection?.effectiveType||'').toLowerCase();var downlink=Number(connection?.downlink)||0;var rtt=Number(connection?.rtt)||0;var cores=Math.max(1,Number(globalThis.navigator?.hardwareConcurrency)||4);var memory=Math.max(0,Number(globalThis.navigator?.deviceMemory)||0);var slow=connection?.saveData===true||type==='slow-2g'||type==='2g'||(type==='3g'&&((downlink>0&&downlink<=3)||rtt>=400))||(downlink>0&&downlink<=1.5)||rtt>=800||cores<=2||(memory>0&&memory<=2);var balanced=cores<=4||(memory>0&&memory<=4);var maxWidth=slow?480:balanced?720:960;var maxHeight=slow?272:balanced?408:544;var scale=Math.min(1,maxWidth/width,maxHeight/height);return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]};"
  const newCanvasHelper = "var __8bitgoPspCanvasSize=(width,height)=>{if(!(width>0&&height>0))return [width,height];var navigator=globalThis.navigator;var connection=navigator?.connection;var type=String(connection?.effectiveType||'').toLowerCase();var downlink=Number(connection?.downlink)||0;var rtt=Number(connection?.rtt)||0;var cores=Math.max(1,Number(navigator?.hardwareConcurrency)||4);var memory=Math.max(0,Number(navigator?.deviceMemory)||0);var qqBrowser=/(?:QQBrowser|MQQBrowser\\/|QQ\\/)/i.test(String(navigator?.userAgent||''));var slow=qqBrowser||connection?.saveData===true||type==='slow-2g'||type==='2g'||(type==='3g'&&((downlink>0&&downlink<=3)||rtt>=400))||(downlink>0&&downlink<=1.5)||rtt>=800||cores<=2||(memory>0&&memory<=2);var balanced=cores<=4||(memory>0&&memory<=4);var maxWidth=slow?480:balanced?720:960;var maxHeight=slow?272:balanced?408:544;var scale=Math.min(1,maxWidth/width,maxHeight/height);return [Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]};"
  runtime = replaceOnce(runtime, oldCanvasHelper, newCanvasHelper, 'QQ 浏览器实际画布上限')
  writeFileSync(runtimePath, runtime)

  const sourcePath = resolve(working, 'SOURCE.txt')
  const sourceText = readFileSync(sourcePath, 'utf8')
    .replaceAll('v20 browser bridge', 'v21 browser bridge')
    .replace('by device and network profile', 'by browser, device, and network profile')
  writeFileSync(sourcePath, sourceText)

  const manifest = JSON.parse(readFileSync(resolve(working, 'runtime.json'), 'utf8'))
  manifest.runtimeGeneration = 'v21'
  manifest.performanceProfile = 'qq-browser-stable-canvas-audio-v1+adaptive-canvas-slow-network-v2'
  manifest.canvasLimitProfile = 'qqBrowser=480x272;performance=480x272;balanced=720x408;quality=960x544;slowNetwork=performance'
  manifest.runtimeErrorSaveFlush = 'idbfs-flush-before-report-1500ms-v1'
  for (const name of ['PPSSPPSDL.js', 'host.js', 'SOURCE.txt']) {
    const bytes = readFileSync(resolve(working, name))
    manifest.artifacts[name] = { bytes: statSync(resolve(working, name)).size, sha256: hash(bytes) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v21 已生成：QQ 浏览器稳态档与运行时故障前存档冲刷已加入，旧 v20 保持不变')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
