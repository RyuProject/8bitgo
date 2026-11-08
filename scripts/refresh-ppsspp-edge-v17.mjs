#!/usr/bin/env node
/**
 * 从已校验的 v16 原子生成 v17；旧 URL 的浏览器/CDN 缓存不能被原地覆盖。
 *
 * v17 只改桥（host.js）：iframe 地址带 `edge=cn` 时（父页面判定的大陆访客，见 src/emulator/paths.ts
 * 的 runtimeBase），两份大文件 PPSSPPSDL.wasm（18MB）与 PPSSPPSDL.data（br 后 9MB）改从 EdgeOne 的
 * `https://cn.<裸域>/_cn/ppsspp/.../v17/` 取。其余文件必须留在同源：
 *   - PPSSPPSDL.js 同时是 pthread Worker 入口（pthreadMainJs = _scriptName），浏览器禁止跨源 Worker；
 *   - range-prefetch-worker.js 是 Worker，local-disc-sw.js 是 Service Worker，audio-worklet.js 一并留下。
 * wasm 只在主线程下载编译，Worker 拿到的是编译好的 Module，不会再去取跨源地址。
 *
 * 胶水的 wasm 加载没有可覆盖的钩子（流式编译失败后会用同一个 URL 再取一次），所以桥包一层 fetch，
 * 只认这两个加速地址：第一次走 EdgeOne，失败或同一文件被第二次请求（说明上一次流式编译 / 下载
 * 中途失败）就改走同源。Wasm / data / JS 与 v16 逐字节相同。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v16')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v17')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const a = resolve(from, entry.name)
    const b = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(a, b)
    else if (entry.isFile()) writeFileSync(b, readFileSync(a))
  }
}
const replaceOnce = (text, before, after, label) => {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error(`host.js 补丁点「${label}」命中 ${count} 次，期望 1 次`)
  return text.replace(before, after)
}

export const EDGE_BLOCK = `
  /*
    大陆访客：父页面在 iframe 地址上带 edge=cn（src/emulator/paths.ts 的 runtimeBase 判定），两份大文件
    改从 EdgeOne 的 https://cn.<裸域>/_cn<本目录> 取。JS / Worker / Service Worker / AudioWorklet 必须同源，
    不在名单里。胶水没有覆盖 wasm 加载的钩子，所以只对这两个加速地址包一层 fetch：
    第一次走 EdgeOne；失败，或同一文件被第二次请求（上一次流式编译 / 下载中途断了），改走同源。
  */
  const CORE_EDGE_FILES = ['PPSSPPSDL.wasm', 'PPSSPPSDL.data']
  const coreEdgeBase = (() => {
    try {
      if (new URLSearchParams(location.search).get('edge') !== 'cn') return ''
      const host = location.hostname.replace(/^www\\./, '')
      if (!host.includes('.') || /^[\\d.]+$/.test(host) || host.startsWith('cn.')) return ''
      return \`\${location.protocol}//cn.\${host}/_cn\${new URL('.', location.href).pathname}\`
    } catch {
      return ''
    }
  })()
  const coreUrl = (path) => coreEdgeBase && CORE_EDGE_FILES.includes(path)
    ? coreEdgeBase + path
    : new URL(path, location.href).href
  if (coreEdgeBase) {
    const nativeFetch = window.fetch.bind(window)
    const tried = new Set()
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : ''
      if (!url.startsWith(coreEdgeBase)) return nativeFetch(input, init)
      const fallback = new URL(url.slice(coreEdgeBase.length), location.href).href
      if (tried.has(url)) return nativeFetch(fallback, init)
      tried.add(url)
      return nativeFetch(url, init)
        .then((response) => {
          if (response.ok) return response
          throw new Error(\`HTTP \${response.status}\`)
        })
        .catch((error) => {
          if (init?.signal?.aborted) throw error
          console.warn('[ppsspp] 加速入口取核心失败，改走同源', url, error)
          return nativeFetch(fallback, init)
        })
    }
  }
`

if (!existsSync(sourceDir)) throw new Error('缺少 v16 PPSSPP 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v16 ${name} 哈希不符`)
}
if (!existsSync(resolve(sourceDir, 'PPSSPPSDL.data.br'))) throw new Error('v16 缺少 PPSSPPSDL.data.br')

const patchHost = (text) => {
  let out = text.replaceAll('v16', 'v17')
  out = replaceOnce(out, "  const canvas = document.getElementById('canvas')\n", `${EDGE_BLOCK}\n  const canvas = document.getElementById('canvas')\n`, 'canvas 之前插入加速入口')
  out = replaceOnce(out, '      locateFile(path) {\n        return new URL(path, location.href).href\n      },', '      locateFile(path) {\n        return coreUrl(path)\n      },', 'locateFile')
  return out
}

if (existsSync(targetDir)) {
  const manifest = JSON.parse(readFileSync(resolve(targetDir, 'runtime.json'), 'utf8'))
  const host = readFileSync(resolve(targetDir, 'host.js'), 'utf8')
  if (manifest.runtimeGeneration === 'v17' &&
    host === patchHost(readFileSync(resolve(sourceDir, 'host.js'), 'utf8')) &&
    Object.entries(manifest.artifacts).every(([name, expected]) =>
      hash(readFileSync(resolve(targetDir, name))) === expected.sha256)) {
    console.log('✔ PPSSPP v17 已生成且哈希一致')
    process.exit(0)
  }
  throw new Error('v17 已存在但与当前源码不一致；不可覆盖不可变运行时')
}

const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v17-build-'))
const working = resolve(temporary, 'v17')
try {
  copyDir(sourceDir, working)
  const hostPath = resolve(working, 'host.js')
  writeFileSync(hostPath, patchHost(readFileSync(hostPath, 'utf8')))
  const sourcePath = resolve(working, 'SOURCE.txt')
  writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replaceAll('v16', 'v17'))
  const manifest = {
    ...baseline,
    runtimeGeneration: 'v17',
    // 大陆访客的 wasm / data 走 EdgeOne，失败当场回同源
    cnEdgeCore: 'wasm-data-edgeone-fallback-v1',
  }
  for (const name of ['host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v17：大陆访客的 wasm / data 走 EdgeOne，不可变哈希已生成')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
