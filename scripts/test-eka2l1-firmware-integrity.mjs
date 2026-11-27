#!/usr/bin/env node
/** EKA2L1 独立说明页自动装固件：清单校验通过后才安装，坏包和必校验缺清单均停止。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { File } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('./eka2l1-default-firmware.js', import.meta.url), 'utf8')
const firmwareUrl = 'https://rom.8bitgo.com/roms/bios/ngage.rom'
const integrityUrl = 'https://rom.8bitgo.com/integrity?key=roms%2Fbios%2Fngage.rom'
const etag = '"fixture-v1"'

async function sha256(bytes) {
  return Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function runCase({ body, manifest, marker = true, useManifestUrl = true }) {
  const firmware = Uint8Array.from(body)
  const expected = Uint8Array.from([1, 2, 3, 4, 5])
  const validManifest = {
    v: 1, alg: 'sha256', key: 'roms/bios/ngage.rom', etag, size: expected.length,
    blockBytes: 2 * 1024 * 1024, blocks: [await sha256(expected)],
  }
  const storage = new Map([
    ['8bitgo.eka2l1.defaultFirmwareUrl', firmwareUrl],
  ])
  if (useManifestUrl) storage.set('8bitgo.eka2l1.defaultFirmwareIntegrityUrl', integrityUrl)
  const local = new Map()
  const classes = (element) => ({ contains: (name) => String(element.className || '').split(/\s+/).includes(name) })
  const dot = { className: 'status-dot yellow', classList: null }
  dot.classList = classes(dot)
  const input = { files: [], dispatchEvent() {} }
  const error = { textContent: '', style: { display: 'none' } }
  const status = { textContent: '' }
  let context
  const elements = new Map([
    ['romInput', input], ['coreStatusText', status], ['coreStatusDot', dot], ['bootError', error],
  ])
  const calls = []
  const window = {
    crypto: webcrypto,
    installDevice() {
      calls.push('install')
      local.set('eka2l1_has_device', '1')
      dot.className = 'status-dot green'
      window.EKA2L1 = { module: { FS: {} }, getLocale: () => 'en' }
      context.EKA2L1 = window.EKA2L1
    },
  }
  context = vm.createContext({
    window,
    document: { getElementById: (id) => elements.get(id) || null },
    location: { href: 'https://8bitgo.com/eka2l1/vtest/index.html' },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      removeItem: (key) => storage.delete(key),
    },
    localStorage: {
      getItem: (key) => local.get(key) || null,
      setItem: (key, value) => local.set(key, String(value)),
    },
    DataTransfer: class {
      constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) } }
    },
    File,
    Blob,
    URL,
    Response,
    Headers,
    Event,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { error() {}, warn() {}, log() {} },
    fetch: async (url) => {
      const target = String(url)
      if (target === integrityUrl) {
        if (!manifest) return new Response('', { status: 404 })
        return new Response(JSON.stringify({ etag, size: expected.length, manifest: validManifest }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(firmware, { status: 200, headers: {
        ETag: etag,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(firmware.length),
        ...(marker ? { 'X-8BitGo-Integrity-Required': 'sha256-v1' } : {}),
      } })
    },
  })
  vm.runInContext(source, context, { filename: 'eka2l1-default-firmware.js' })
  const deadline = Date.now() + 500
  while (!calls.length && error.style.display === 'none' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return { calls, error, status, input }
}

const accepted = await runCase({ body: [1, 2, 3, 4, 5], manifest: true })
assert.deepEqual(accepted.calls, ['install'], '校验通过后才能安装固件')
assert.equal(accepted.error.style.display, 'none')

const corrupted = await runCase({ body: [5, 4, 3, 2, 1], manifest: true })
assert.deepEqual(corrupted.calls, [], '摘要不符时不能调用设备安装器')
assert.notEqual(corrupted.error.style.display, 'none')

const missing = await runCase({ body: [1, 2, 3, 4, 5], manifest: false })
assert.deepEqual(missing.calls, [], '必校验对象没有清单时必须失败关闭')
assert.notEqual(missing.error.style.display, 'none')

const legacyExternal = await runCase({ body: [1, 2, 3, 4, 5], manifest: false, marker: false, useManifestUrl: false })
assert.deepEqual(legacyExternal.calls, ['install'], '未带可信清单的旧对象和外站直链保留兼容路径')

console.log('✓ EKA2L1 自动固件 SHA-256 校验：有效、损坏、缺失清单与兼容路径均通过')
