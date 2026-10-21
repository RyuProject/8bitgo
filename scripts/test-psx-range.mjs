import assert from 'node:assert/strict'
import { canStreamPsxChd, preparePsxRangeDisc, PSX_RANGE_BYTES } from '../src/emulator/psxRangeDisc.ts'

const version = '1234567890abcdef1234567890abcdef'
const url = `https://assets.8bitgo.com/roms/psx/test.chd?romv=${version}`
const disc = new Uint8Array(PSX_RANGE_BYTES * 5 + 113)
for (let i = 0; i < disc.length; i++) disc[i] = i % 251
disc.set(new TextEncoder().encode('MComprHD'), 0)
new DataView(disc.buffer).setUint32(12, 5)
const requests = []

function fakeResponse(start, end, status = 206, etag = `"${version}"`) {
  const bytes = disc.subarray(start, end + 1)
  return new Response(bytes, {
    status,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${disc.length}`,
      ETag: etag,
    },
  })
}
const fetcher = async (_url, init) => {
  assert.equal(init.headers['If-Match'], `"${version}"`)
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  assert(match)
  const start = Number(match[1]); const end = Number(match[2])
  requests.push([start, end])
  return fakeResponse(start, end)
}

assert(canStreamPsxChd('psx', url))
assert(!canStreamPsxChd('psx', 'https://assets.8bitgo.com/roms/psx/test.chd'))
assert(!canStreamPsxChd('psx', url.replace('.chd', '.chd.8bg')))
assert(!canStreamPsxChd('psp', url))

const controller = new AbortController()
const range = await preparePsxRangeDisc(url, 'test.chd', controller.signal, fetcher)
assert.equal(range.size, disc.length)
assert.equal(range.startupBytes, PSX_RANGE_BYTES + 113)
assert.deepEqual(requests[0], [0, PSX_RANGE_BYTES - 1])
assert.deepEqual(requests[1], [PSX_RANGE_BYTES * 5, disc.length - 1])

let node
const sharedStreamOps = { read: () => 77, write: () => 88 }
class FakeXhr {
  headers = {}
  status = 0
  open(method, requestUrl, async) {
    assert.equal(method, 'GET')
    assert.equal(requestUrl, url)
    assert.equal(async, false)
  }
  overrideMimeType(value) { assert.match(value, /x-user-defined/) }
  setRequestHeader(name, value) { this.headers[name] = value }
  send() {
    const match = /^bytes=(\d+)-(\d+)$/.exec(this.headers.Range)
    assert(match)
    assert.equal(this.headers['If-Match'], `"${version}"`)
    this.start = Number(match[1]); this.end = Number(match[2])
    this.status = 206
    this.responseText = Buffer.from(disc.subarray(this.start, this.end + 1)).toString('latin1')
    requests.push([this.start, this.end])
  }
  getResponseHeader(name) {
    if (name === 'Content-Range') return `bytes ${this.start}-${this.end}/${disc.length}`
    if (name === 'ETag') return `"${version}"`
    return null
  }
}
const fs = {
  writeFile(path, bytes) {
    assert.equal(path, '/test.chd')
    assert.equal(bytes.length, 0)
    node = { usedBytes: 0, stream_ops: sharedStreamOps }
  },
  lookupPath(path) { assert.equal(path, '/test.chd'); return { node } },
}
range.install(fs, { XMLHttpRequest: FakeXhr })
assert.equal(node.usedBytes, disc.length)
assert.notEqual(node.stream_ops, sharedStreamOps)
assert.equal(sharedStreamOps.read(), 77, 'BIOS 与存档必须保留共享文件读取方法')
assert.equal(node.stream_ops.write(), 88)
const out = new Uint8Array(2048)
assert.equal(node.stream_ops.read({}, out, 0, out.length, PSX_RANGE_BYTES * 4 + 7), out.length)
assert.deepEqual(out, disc.subarray(PSX_RANGE_BYTES * 4 + 7, PSX_RANGE_BYTES * 4 + 7 + out.length))
assert(requests.some(([start]) => start === PSX_RANGE_BYTES * 4))
assert.throws(() => node.stream_ops.read({}, new Uint8Array(1), 0, 17 * 1024 * 1024, 0), /异常大/)
range.dispose()

const fatalMessages = []
class FaultyXhr extends FakeXhr {
  send() { throw new Error('network offline') }
}
const failedRange = await preparePsxRangeDisc(url, 'test.chd', new AbortController().signal, fetcher,
  (message) => fatalMessages.push(message))
let failedNode
failedRange.install({
  writeFile() { failedNode = { usedBytes: 0, stream_ops: sharedStreamOps } },
  lookupPath() { return { node: failedNode } },
}, { XMLHttpRequest: FaultyXhr })
assert.throws(() => failedNode.stream_ops.read({}, new Uint8Array(1), 0, 1, PSX_RANGE_BYTES * 4), /读盘失败.*network offline/)
await Promise.resolve()
assert.equal(fatalMessages.length, 1)
assert.match(fatalMessages[0], /network offline/)
assert.throws(() => failedNode.stream_ops.read({}, new Uint8Array(1), 0, 1, 0), /会话已结束/)
failedRange.dispose()

await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => fakeResponse(0, PSX_RANGE_BYTES - 1, 200)),
  /Range/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => fakeResponse(0, PSX_RANGE_BYTES - 1, 206, '"other"')),
  /换版/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => fakeResponse(0, PSX_RANGE_BYTES - 1, 206, `W/"${version}"`)),
  /换版/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => new Response(disc.subarray(0, PSX_RANGE_BYTES), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${PSX_RANGE_BYTES - 1}/${disc.length}` },
    })),
  /换版/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => new Response(disc.subarray(0, PSX_RANGE_BYTES), {
      status: 206,
      headers: {
        'Content-Range': `bytes 0-${PSX_RANGE_BYTES - 1}/${disc.length}`,
        'Content-Length': String(PSX_RANGE_BYTES + 1),
        ETag: `"${version}"`,
      },
    })),
  /长度不符/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(disc.subarray(0, PSX_RANGE_BYTES)); stream.enqueue(new Uint8Array([1])); stream.close() },
    }), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${PSX_RANGE_BYTES - 1}/${disc.length}`, ETag: `"${version}"` },
    })),
  /超过请求长度/,
)
await assert.rejects(
  () => preparePsxRangeDisc(url, 'test.chd', new AbortController().signal,
    async () => new Response(disc.subarray(0, PSX_RANGE_BYTES - 1), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${PSX_RANGE_BYTES - 1}/${disc.length}`, ETag: `"${version}"` },
    })),
  /长度不符/,
)
console.log('✅ PS1 CHD Range 校验、分片读盘、预缓存边界与整包回退条件通过')
