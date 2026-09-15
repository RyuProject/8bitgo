// 从管理页的真实调用入口测试：200 HTML、错大小和清理失败都不能伪装成成功。
import assert from 'node:assert/strict'

const storage = () => {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}
globalThis.localStorage = storage()
globalThis.sessionStorage = storage()
globalThis.localStorage.setItem('8bitgo.rom.api', 'https://w.test')
globalThis.localStorage.setItem('8bitgo.rom.base', 'https://assets.test')
globalThis.sessionStorage.setItem('8bitgo.rom.token', 'test-token')
globalThis.window = { setInterval, clearInterval }

let xhrResponse = () => ({ status: 200, body: '<html>wrong endpoint</html>' })
globalThis.XMLHttpRequest = class {
  upload = {}
  status = 0
  responseText = ''
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader() {}
  send(blob) {
    queueMicrotask(() => {
      const result = xhrResponse(this, blob)
      this.status = result.status
      this.responseText = result.body
      this.onload?.()
    })
  }
  abort() { this.onabort?.() }
}

const { uploadRom, deleteRomDir, listRomObjects } = await import('../src/services/roms.ts')
const { uploadRomMultipart, listOrphanUploads, abortOrphanUpload, listPendingUploads } = await import('../src/services/romMultipart.ts')

const small = new Blob(['abc'])
await assert.rejects(uploadRom(small, 'roms/nes/demo.nes'), /上传响应不完整/)
console.log('✅ 200 HTML 不会被当成成功上传')

xhrResponse = () => ({ status: 200, body: JSON.stringify({ ok: true, key: 'roms/nes/demo.nes', size: 2 }) })
await assert.rejects(uploadRom(small, 'roms/nes/demo.nes'), /对象大小不符/)
console.log('✅ 单发 PUT 的返回大小必须与原文件相同')
xhrResponse = () => ({ status: 200, body: JSON.stringify({ ok: true, key: 'roms/nes/demo.nes', size: 3 }) })
assert.equal((await uploadRom(small, 'roms/nes/demo.nes')).size, 3)
console.log('✅ 正常的小文件上传仍可完成')

const uploads = [
  { marker: '_uploads/one.marker', key: 'roms/ps2/one.iso', uploadId: 'up-1', size: 1, name: 'one.iso', at: '2026-09-15' },
  { marker: '_uploads/two.marker', key: 'roms/ps2/two.iso', uploadId: 'up-2', size: 1, name: 'two.iso', at: '2026-09-15' },
]
const seen = []
globalThis.fetch = async (url) => {
  seen.push(String(url))
  if (String(url).endsWith('/multipart')) return Response.json({ uploads: [uploads[0]], truncated: true, cursor: 'next' })
  if (String(url).includes('cursor=next')) return Response.json({ uploads: [uploads[1]], truncated: false })
  return Response.json({ error: 'abort denied' }, { status: 500 })
}
assert.deepEqual(await listOrphanUploads(), uploads)
assert.equal(seen.length, 2)
await assert.rejects(abortOrphanUpload(uploads[0]), /abort denied/)
console.log('✅ 残留列表翻完所有页；清理失败会报错')

let aborts = 0
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('?uploads')) return Response.json({ uploadId: 'up-large', marker: '_uploads/large.marker' })
  if (String(url).includes('uploadId=up-large') && init?.method === 'POST') return Response.json({ ok: true, key: 'roms/ps2/demo.iso', size: 1 })
  if (init?.method === 'DELETE') aborts++
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `etag-${new URL(xhr.url).searchParams.get('partNumber')}` }) })
const large = new Blob([new Uint8Array(25 * 1024 * 1024)])
await assert.rejects(uploadRomMultipart(large, 'roms/ps2/demo.iso'), /R2 已完成上传，但对象大小/)
assert.equal(aborts, 0, '完成后的大小不符不能再重试或 abort 已经完成的对象')
console.log('✅ 分片合并后大小不符会阻止绑定，也不会重试 complete')

// 两份镜像的文件名、大小、修改时间完全相同，只有内容不同；旧续传条件会把它们拼错。
const bytes = new Uint8Array(25 * 1024 * 1024)
const firstFile = new File([bytes], 'same.iso', { lastModified: 123 })
bytes[0] = 1
const changedFile = new File([bytes], 'same.iso', { lastModified: 123 })
let creates = 0
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('?uploads')) return Response.json({ uploadId: `up-ident-${++creates}`, marker: `_uploads/ident-${creates}.marker` })
  if (String(url).includes('uploadId=up-ident-') && init?.method === 'POST') return Response.json({ ok: true, key: 'roms/ps2/collision.iso', size: changedFile.size })
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => {
  const number = Number(new URL(xhr.url).searchParams.get('partNumber'))
  if (creates === 1 && number !== 1) return { status: 0, body: '' }
  return { status: 200, body: JSON.stringify({ etag: `etag-${number}` }) }
}
await assert.rejects(uploadRomMultipart(firstFile, 'roms/ps2/collision.iso'), /重新选同一个文件/)
assert.equal(listPendingUploads().length, 1, '第一次失败后应留下可续传的账本')
await uploadRomMultipart(changedFile, 'roms/ps2/collision.iso')
assert.equal(creates, 2, '内容不同必须新建上传，不能拿旧分片拼进新 ISO')
console.log('✅ 同名同大小同时间戳、内容不同的 ISO 不会错误续传')

const deleted = []
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/list?')) return Response.json({ objects: [
    { key: 'roms/flash/demo/a.swf', size: 1 },
    { key: 'roms/flash/demo/b.swf', size: 1 },
  ], truncated: false })
  if (String(url).endsWith('/bulk')) {
    const keys = JSON.parse(init.body).keys
    deleted.push(keys)
    return Response.json({ ok: true, deleted: keys })
  }
  throw new Error(`unexpected request: ${url}`)
}
assert.deepEqual(await deleteRomDir('roms/flash/demo'), ['roms/flash/demo/a.swf', 'roms/flash/demo/b.swf'])
assert.equal(deleted.length, 1)
console.log('✅ 多文件包通过一次 R2 批量请求删除')

let oldDeletes = 0
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/list?')) return Response.json({ objects: [
    { key: 'roms/flash/demo/a.swf', size: 1 },
    { key: 'roms/flash/demo/b.swf', size: 1 },
  ], truncated: false })
  if (String(url).endsWith('/bulk')) return Response.json({ error: 'POST 需要 ?uploads（开始）或 ?uploadId=（完成）' }, { status: 400 })
  if (init?.method === 'DELETE') {
    oldDeletes++
    return Response.json({ ok: true })
  }
  throw new Error(`unexpected request: ${url}`)
}
assert.equal((await deleteRomDir('roms/flash/demo')).length, 2)
assert.equal(oldDeletes, 2)
console.log('✅ 旧 Worker 会退回原来的逐文件删除')

globalThis.fetch = async (url) => Response.json({ objects: [], truncated: true, cursor: String(Number(new URL(url).searchParams.get('cursor') || 0) + 1) })
await assert.rejects(listRomObjects('roms/ps2'), /文件过多/)
console.log('✅ R2 列表超过页面上限时明确报错，不会静默遗漏文件')
