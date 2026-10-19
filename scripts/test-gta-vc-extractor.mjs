import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerPath = resolve(repo, 'public/web/gta-vc/extract-worker.js')

class MemoryFileHandle {
  constructor() {
    this.bytes = new Uint8Array(0)
  }

  async createWritable() {
    const chunks = []
    return {
      write: async (bytes) => chunks.push(new Uint8Array(bytes)),
      close: async () => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        this.bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          this.bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
      },
      abort: async () => {},
    }
  }
}

class MemoryDirectoryHandle {
  constructor() {
    this.entries = new Map()
  }

  async getDirectoryHandle(name, options = {}) {
    const current = this.entries.get(name)
    if (current instanceof MemoryDirectoryHandle) return current
    if (current || !options.create) throw new DOMException('Not found', 'NotFoundError')
    const directory = new MemoryDirectoryHandle()
    this.entries.set(name, directory)
    return directory
  }

  async getFileHandle(name, options = {}) {
    const current = this.entries.get(name)
    if (current instanceof MemoryFileHandle) return current
    if (current || !options.create) throw new DOMException('Not found', 'NotFoundError')
    const file = new MemoryFileHandle()
    this.entries.set(name, file)
    return file
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new DOMException('Not found', 'NotFoundError')
  }
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512)
  const writeText = (value, offset, length) => Buffer.from(value).copy(header, offset, 0, length)
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`
  writeText(name, 0, 100)
  writeText(octal(0o644, 8), 100, 8)
  writeText(octal(0, 8), 108, 8)
  writeText(octal(0, 8), 116, 8)
  writeText(octal(size, 12), 124, 12)
  writeText(octal(0, 12), 136, 12)
  header.fill(32, 148, 156)
  writeText(type, 156, 1)
  writeText('ustar\0', 257, 6)
  writeText('00', 263, 2)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeText(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

function makeTar(entries) {
  const chunks = []
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value)
    chunks.push(tarHeader(name, bytes.byteLength), bytes)
    const padding = (512 - (bytes.byteLength % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function entryAt(root, path) {
  let entry = root
  for (const part of path.split('/')) entry = entry.entries.get(part)
  return entry
}

const root = new MemoryDirectoryHandle()
const messages = []
const originalSelf = globalThis.self
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
globalThis.self = { postMessage: (message) => messages.push(message) }
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => root } },
})

try {
  const originalSource = readFileSync(workerPath, 'utf8')
  const source = originalSource.replace('100 * 1024 * 1024', '1')
  assert.notEqual(source, originalSource, '测试必须只放宽必需 data 文件的最小体积')
  new vm.Script(source, { filename: workerPath }).runInThisContext()

  const validArchive = gzipSync(makeTar([
    ['vcbr/vc-sky-en-v6.data', 'data'],
    ['vcbr/vc-sky-en-v6.wasm', 'wasm'],
    ['vcsky/sha256sums.txt', 'hash'],
  ]))
  await globalThis.self.onmessage({ data: { file: new Blob([validArchive]) } })
  assert.equal(messages.at(-1).type, 'done')
  assert.equal(new TextDecoder().decode(entryAt(root, '_game_ready').bytes), 'v4')
  assert.equal(new TextDecoder().decode(entryAt(root, 'vcbr/vc-sky-en-v6.data').bytes), 'data')

  messages.length = 0
  const unsafeArchive = gzipSync(makeTar([
    ['vcsky/../outside.txt', 'blocked'],
  ]))
  await globalThis.self.onmessage({ data: { file: new Blob([unsafeArchive]) } })
  assert.equal(messages.at(-1).type, 'error')
  assert.match(messages.at(-1).message, /不安全路径/)
  assert.equal(entryAt(root, '_game_ready'), undefined, '失败导入不得留下就绪标记')
  assert.equal(entryAt(root, 'vcbr'), undefined, '失败导入不得留下上一代或半成品数据')
  assert.equal(entryAt(root, 'vcsky'), undefined, '失败导入不得留下上一代或半成品数据')
} finally {
  if (originalSelf === undefined) delete globalThis.self
  else globalThis.self = originalSelf
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  else delete globalThis.navigator
}

console.log('GTA VC 流式 TAR 导入、必需文件校验与路径保护通过')
