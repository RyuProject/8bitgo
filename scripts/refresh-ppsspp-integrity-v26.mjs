#!/usr/bin/env node
/**
 * PPSSPP v26 给运行时的大 data / wasm 资源加可信 SHA-256 分块校验。
 * 为避免玩家因换代重下约 38MB 核心，新桥与页面单独发布，二进制仍引用已缓存的 v25。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = resolve(root, 'public/ppsspp/v0dbfaca')
const sourceDir = resolve(base, 'v25')
const targetDir = resolve(base, 'v26')
const blockBytes = 2 * 1024 * 1024
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sri = (digest) => `sha256-${Buffer.from(digest, 'hex').toString('base64')}`

if (!existsSync(sourceDir)) throw new Error('缺少 PPSSPP v25 核心基线')
if (existsSync(targetDir)) throw new Error('PPSSPP v26 已存在；不可覆盖不可变运行时')

const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (sha256(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v25 ${name} 哈希不符`)
}

const expectedCore = {}
for (const name of ['PPSSPPSDL.wasm', 'PPSSPPSDL.data']) {
  const bytes = readFileSync(resolve(sourceDir, name))
  const previous = baseline.artifacts[name]
  if (bytes.byteLength !== previous.bytes || sha256(bytes) !== previous.sha256) throw new Error(`v25 ${name} 与原清单不符`)
  const blocks = []
  for (let offset = 0; offset < bytes.byteLength; offset += blockBytes) {
    blocks.push(sha256(bytes.subarray(offset, Math.min(bytes.byteLength, offset + blockBytes))))
  }
  expectedCore[name] = { bytes: bytes.byteLength, blockBytes, blocks }
}

const temporary = mkdtempSync(resolve(base, '.v26-integrity-'))
const working = resolve(temporary, 'v26')
mkdirSync(working, { recursive: true })
try {
  for (const name of ['index.html', 'audio-worklet.js', 'range-prefetch-worker.js', 'local-disc-sw.js']) {
    writeFileSync(resolve(working, name), readFileSync(resolve(sourceDir, name)))
  }

  let host = readFileSync(resolve(sourceDir, 'host.js'), 'utf8')
  const replaceOnce = (from, to, label) => {
    if (!host.includes(from)) throw new Error(`v25 host.js 缺少 ${label} 锚点`)
    host = host.replace(from, to)
  }
  replaceOnce("const RUNTIME_SCRIPT = 'PPSSPPSDL.js'", "const RUNTIME_SCRIPT = '../v25/PPSSPPSDL.js'", '核心 JS 地址')
  replaceOnce("const AUDIO_WORKLET_SCRIPT = 'audio-worklet.js'", "const AUDIO_WORKLET_SCRIPT = '../v25/audio-worklet.js'", '音频 worklet 地址')
  replaceOnce("  const AUDIO_WORKLET_SCRIPT = '../v25/audio-worklet.js'", "  const AUDIO_WORKLET_SCRIPT = '../v25/audio-worklet.js'\n  const CORE_ASSET_PATH = '../v25/'", '核心资源目录')
  replaceOnce('new URL(\'.\', location.href).pathname', 'new URL(CORE_ASSET_PATH, location.href).pathname', 'Edge 核心目录')
  replaceOnce("  const coreUrl = (path) => coreEdgeBase && CORE_EDGE_FILES.includes(path)\n    ? coreEdgeBase + path\n    : new URL(path, location.href).href", "  const coreUrl = (path) => CORE_EDGE_FILES.includes(path)\n    ? (coreEdgeBase ? coreEdgeBase + path : new URL(CORE_ASSET_PATH + path, location.href).href)\n    : new URL(path, location.href).href", '核心 wasm/data 实际路径')

  const edgeStart = host.indexOf('  if (coreEdgeBase) {')
  const edgeEnd = host.indexOf('\n\n  const canvas =', edgeStart)
  if (edgeStart < 0 || edgeEnd < 0) throw new Error('v25 host.js 的 Edge fetch 区块位置改变；拒绝猜测替换')
  const integrityJson = JSON.stringify(expectedCore)
  const edgeAndIntegrity = `  const CORE_INTEGRITY = Object.freeze(${integrityJson})
  const CORE_INTEGRITY_BLOCK_BYTES = ${blockBytes}
  const coreFetchCounts = new Map()
  const wasmIntegrityByResponse = new WeakMap()
  const nativeFetch = window.fetch.bind(window)
  const requestUrl = (input) => typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || ''
  const isCoreWasmUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl, location.href)
      const sameOriginPath = new URL(CORE_ASSET_PATH + 'PPSSPPSDL.wasm', location.href)
      if (url.origin === sameOriginPath.origin && url.pathname === sameOriginPath.pathname) return true
      if (!coreEdgeBase) return false
      const edgePath = new URL('PPSSPPSDL.wasm', coreEdgeBase)
      return url.origin === edgePath.origin && url.pathname === edgePath.pathname
    } catch {
      return false
    }
  }
  const sha256Hex = async (bytes) => {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('浏览器不支持 SHA-256，无法安全校验 PSP 核心')
    return Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const verifyCoreBytes = async (source, name) => {
    const expected = CORE_INTEGRITY[name]
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
    if (!expected || bytes.byteLength !== expected.bytes) throw new Error(name + ' 长度与可信清单不符')
    for (let index = 0; index < expected.blocks.length; index++) {
      const start = index * CORE_INTEGRITY_BLOCK_BYTES
      const block = bytes.subarray(start, Math.min(bytes.byteLength, start + CORE_INTEGRITY_BLOCK_BYTES))
      if (await sha256Hex(block) !== expected.blocks[index]) throw new Error(name + ' SHA-256 校验失败（第 ' + (index + 1) + ' 块）')
    }
    return bytes
  }
  const verifyCoreResponse = async (response, name) => {
    const expected = CORE_INTEGRITY[name]
    if (!expected) throw new Error(name + ' 缺少可信 SHA-256 清单')
    if (!response.body?.getReader) return verifyCoreBytes(await response.arrayBuffer(), name)
    const reader = response.body.getReader()
    const block = new Uint8Array(CORE_INTEGRITY_BLOCK_BYTES)
    let used = 0
    let loaded = 0
    let index = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        loaded += value.byteLength
        if (loaded > expected.bytes) throw new Error(name + ' 超过可信清单长度')
        let offset = 0
        while (offset < value.byteLength) {
          const count = Math.min(block.byteLength - used, value.byteLength - offset)
          block.set(value.subarray(offset, offset + count), used)
          used += count
          offset += count
          if (used === block.byteLength) {
            if (await sha256Hex(block) !== expected.blocks[index]) throw new Error(name + ' SHA-256 校验失败（第 ' + (index + 1) + ' 块）')
            index++
            used = 0
          }
        }
      }
      if (used > 0) {
        if (await sha256Hex(block.subarray(0, used)) !== expected.blocks[index]) throw new Error(name + ' SHA-256 校验失败（第 ' + (index + 1) + ' 块）')
        index++
      }
      if (loaded !== expected.bytes || index !== expected.blocks.length) throw new Error(name + ' 长度与可信清单不符（' + loaded + '/' + expected.bytes + '）')
      return true
    } catch (error) {
      void reader.cancel(error).catch(() => {})
      throw error
    }
  }
  Object.defineProperty(window, '__8bitgoPspCoreIntegrity', {
    configurable: false,
    value: Object.freeze({ verifyCoreBytes, verifyCoreResponse }),
  })
  const fetchCoreResponse = async (input, init, attempt) => {
    const url = requestUrl(input)
    if (!coreEdgeBase || !url.startsWith(coreEdgeBase)) {
      return nativeFetch(input, attempt > 1 ? { ...init, cache: 'reload' } : init)
    }
    const fallback = new URL(CORE_ASSET_PATH + url.slice(coreEdgeBase.length), location.href).href
    if (attempt > 1) return nativeFetch(fallback, { ...init, cache: 'reload' })
    try {
      const response = await nativeFetch(input, init)
      if (response.ok) return response
      throw new Error('HTTP ' + response.status)
    } catch (error) {
      if (init?.signal?.aborted) throw error
      console.warn('[ppsspp] 加速入口取核心失败，改走同源', url, error)
      return nativeFetch(fallback, init)
    }
  }
  window.fetch = async (input, init) => {
    const url = requestUrl(input)
    const isCoreFile = CORE_EDGE_FILES.some((name) => {
      try { return new URL(url, location.href).pathname.endsWith('/' + name) } catch { return false }
    })
    const attempt = isCoreFile ? (coreFetchCounts.get(url) || 0) + 1 : 1
    if (isCoreFile) coreFetchCounts.set(url, attempt)
    const response = await fetchCoreResponse(input, init, attempt)
    if (isCoreWasmUrl(url) && response.ok) {
      // clone 的分支只留一个 2 MiB 校验块；原始响应继续交给浏览器流式编译，SHA-256 与下载并行。
      const verification = verifyCoreResponse(response.clone(), 'PPSSPPSDL.wasm')
      wasmIntegrityByResponse.set(response, verification)
      verification.catch(() => {})
    }
    return response
  }
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    const nativeInstantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    WebAssembly.instantiateStreaming = async (source, imports) => {
      const response = await source
      const verification = wasmIntegrityByResponse.get(response)
      const result = await nativeInstantiateStreaming(response, imports)
      if (verification) await verification
      return result
    }
  }
  const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly)
  WebAssembly.instantiate = async (source, imports) => {
    if (source instanceof WebAssembly.Module) return nativeInstantiate(source, imports)
    await verifyCoreBytes(source, 'PPSSPPSDL.wasm')
    return nativeInstantiate(source, imports)
  }
`
  host = host.slice(0, edgeStart) + edgeAndIntegrity + host.slice(edgeEnd)

  const runtimeFailure = "      return url.origin === runtimeRoot.origin &&\n        url.pathname.startsWith(runtimeRoot.pathname) &&\n        /\\/(?:host|PPSSPPSDL)\\.js$/i.test(url.pathname)"
  const runtimeFailureReplacement = "      const coreRoot = new URL(CORE_ASSET_PATH, location.href)\n      const isShell = url.origin === runtimeRoot.origin && url.pathname.startsWith(runtimeRoot.pathname) && /\\/host\\.js$/i.test(url.pathname)\n      const isCore = url.origin === coreRoot.origin && url.pathname.startsWith(coreRoot.pathname) && /\\/PPSSPPSDL\\.js$/i.test(url.pathname)\n      return isShell || isCore"
  if (!host.includes(runtimeFailure)) throw new Error('v25 host.js 错误归属检查锚点改变；拒绝漏掉 v25 核心错误')
  host = host.replace(runtimeFailure, runtimeFailureReplacement)

  const replaceHostOnce = (from, to, label) => {
    if (!host.includes(from)) throw new Error(`host.js 缺少 ${label} 锚点`)
    host = host.replace(from, to)
  }
  replaceHostOnce("    script.src = RUNTIME_SCRIPT\n    script.async = true", `    script.src = RUNTIME_SCRIPT\n    script.integrity = '${sri(baseline.artifacts['PPSSPPSDL.js'].sha256)}'\n    script.crossOrigin = 'anonymous'\n    script.async = true`, 'PPSSPP 核心 JS SRI')
  replaceHostOnce("  const fetchCoreData = async (url, expectedSize) => {\n    const attempts = 3", "  const fetchCoreData = async (url, expectedSize) => {\n    if (expectedSize > 0 && expectedSize !== CORE_INTEGRITY['PPSSPPSDL.data'].bytes) throw new Error('PPSSPPSDL.data 下载长度与可信清单不一致')\n    const attempts = 3", 'data 预期长度')
  replaceHostOnce("          const bytes = await response.arrayBuffer()\n          if (expectedSize > 0 && bytes.byteLength !== expectedSize) throw new Error('核心资源长度不正确')\n          window.clearTimeout(stallTimer)\n          return bytes", "          const bytes = await response.arrayBuffer()\n          window.clearTimeout(stallTimer)\n          if (expectedSize > 0 && bytes.byteLength !== expectedSize) throw new Error('核心资源长度不正确')\n          await verifyCoreBytes(bytes, 'PPSSPPSDL.data')\n          return bytes", 'data 无流回退校验')
  replaceHostOnce("          cache: 'force-cache',", "          cache: attempt === 1 ? 'force-cache' : 'reload',", '重试缓存策略')
  replaceHostOnce("        window.clearTimeout(stallTimer)\n        if (output) return output.buffer\n        const joined = new Uint8Array(loaded)\n        let offset = 0\n        for (const chunk of chunks) {\n          joined.set(chunk, offset)\n          offset += chunk.byteLength\n        }\n        return joined.buffer", "        window.clearTimeout(stallTimer)\n        setStatus('正在校验 PSP 核心资源…')\n        if (output) {\n          await verifyCoreBytes(output, 'PPSSPPSDL.data')\n          return output.buffer\n        }\n        const joined = new Uint8Array(loaded)\n        let offset = 0\n        for (const chunk of chunks) {\n          joined.set(chunk, offset)\n          offset += chunk.byteLength\n        }\n        await verifyCoreBytes(joined, 'PPSSPPSDL.data')\n        return joined.buffer", 'data 下载后校验')

  const sourceText = `${readFileSync(resolve(sourceDir, 'SOURCE.txt'), 'utf8').replaceAll('v25', 'v26').trimEnd()}\n\nThe v26 shell verifies the v25 PPSSPPSDL.wasm and .data against trusted SHA-256 blocks while streaming. The immutable core binaries remain under v25 so existing browser caches are reused.\n`
  let indexHtml = readFileSync(resolve(working, 'index.html'), 'utf8')
  const hostTag = '<script src="host.js"></script>'
  if (!indexHtml.includes(hostTag)) throw new Error('v25 index.html 缺少 host.js script 锚点')
  indexHtml = indexHtml.replace(hostTag, `<script src="host.js" integrity="${sri(sha256(Buffer.from(host)))}" crossorigin="anonymous"></script>`)
  writeFileSync(resolve(working, 'host.js'), host)
  writeFileSync(resolve(working, 'SOURCE.txt'), sourceText)
  writeFileSync(resolve(working, 'index.html'), indexHtml)

  const manifest = {
    ...baseline,
    runtimeGeneration: 'v26',
    coreAssetGeneration: 'v25',
    runtimeIntegrityProfile: 'sha256-2miblocks-v1',
    integrityBlocks: expectedCore,
  }
  for (const name of ['index.html', 'host.js', 'audio-worklet.js', 'range-prefetch-worker.js', 'local-disc-sw.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: sha256(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ 已生成 PPSSPP v26 校验壳；v25 核心二进制与 HTTP 缓存保持复用')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
