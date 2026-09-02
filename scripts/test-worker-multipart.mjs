// 用内存版 R2 mock 把 Worker 的分片接口跑一遍：开始 → 传片 → 合并 → 标记清理，
// 外加几条必须挡住的路（无口令、坏 etag、直接读写标记对象）。
import worker from '../worker/src/index.js'

const TOKEN = 'test-token'
let seq = 0

function makeBucket() {
  const objects = new Map()
  const uploads = new Map()
  const handle = (key, uploadId) => ({
    key,
    uploadId,
    async uploadPart(partNumber, value) {
      const up = uploads.get(uploadId)
      if (!up) throw new Error('no such upload')
      const bytes = new Uint8Array(value)
      up.parts.set(partNumber, { etag: `etag-${partNumber}-${bytes.length}`, bytes })
      return { partNumber, etag: `etag-${partNumber}-${bytes.length}` }
    },
    async complete(parts) {
      const up = uploads.get(uploadId)
      if (!up) throw new Error('no such upload')
      let size = 0
      for (const p of parts) {
        const got = up.parts.get(p.partNumber)
        if (!got) throw new Error(`part ${p.partNumber} missing`)
        if (got.etag !== p.etag) throw new Error(`part ${p.partNumber} etag mismatch`)
        size += got.bytes.length
      }
      if (parts.length !== up.parts.size) throw new Error('part count mismatch')
      uploads.delete(uploadId)
      objects.set(key, { size, httpEtag: '"done"', uploaded: new Date(), customMetadata: {} })
      return objects.get(key)
    },
    async abort() {
      if (!uploads.has(uploadId)) throw new Error('no such upload')
      uploads.delete(uploadId)
    },
  })
  return {
    objects,
    uploads,
    async put(key, body, opts) {
      const size = body ? (body.byteLength ?? 0) : 0
      objects.set(key, { size, httpEtag: '"e"', uploaded: new Date(), customMetadata: opts?.customMetadata ?? {} })
      return objects.get(key)
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const hits = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([k, v]) => ({ key: k, size: v.size, uploaded: v.uploaded, customMetadata: v.customMetadata }))
      return { objects: hits, truncated: false, cursor: undefined }
    },
    async head(key) {
      return objects.get(key) ? { ...objects.get(key), key, writeHttpMetadata() {} } : null
    },
    async delete(key) {
      objects.delete(key)
    },
    async createMultipartUpload(key) {
      const uploadId = `up-${++seq}`
      uploads.set(uploadId, { key, parts: new Map() })
      return handle(key, uploadId)
    },
    resumeMultipartUpload(key, uploadId) {
      return handle(key, uploadId)
    },
  }
}

const bucket = makeBucket()
const env = { ROMS: bucket, ADMIN_TOKEN: TOKEN, ALLOWED_ORIGINS: '*' }
const auth = { Authorization: `Bearer ${TOKEN}` }
const call = (path, init = {}) => worker.fetch(new Request(`https://w.test${path}`, init), env)

let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

const KEY = '/roms/arcade/kof97.zip'

// 1. ping 要宣告支持分片，前端靠它决定退不退回单发 PUT
const ping = await (await call('/ping')).json()
check('ping.multipart === true', ping.multipart === true, JSON.stringify(ping))

// 2. 没口令一律 401
check('无口令 POST ?uploads → 401', (await call(`${KEY}?uploads`, { method: 'POST' })).status === 401)

// 3. 开始一次分片上传
const created = await (await call(`${KEY}?uploads`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ contentType: 'application/zip', size: 100, name: 'kof97.zip' }),
})).json()
check('create 返回 uploadId', Boolean(created.uploadId), JSON.stringify(created))
check('create 返回 marker 且落在 _uploads/ 下', String(created.marker).startsWith('_uploads/'), created.marker)

// 4. 标记能被列出来（跨浏览器可见的残留清单就靠它）
const index1 = await (await call('/multipart', { headers: auth })).json()
check('/multipart 列出 1 条', index1.uploads?.length === 1, JSON.stringify(index1))
check('/multipart 带回 key 与 uploadId', index1.uploads?.[0]?.key === 'roms/arcade/kof97.zip' && index1.uploads[0].uploadId === created.uploadId)
check('/multipart 带回文件名与大小', index1.uploads?.[0]?.name === 'kof97.zip' && index1.uploads[0].size === 100)

// 5. 桶内文件列表不能把标记混进去
const listed = await (await call('/list?prefix=', { headers: auth })).json()
check('/list 过滤掉 _uploads/ 标记', (listed.objects ?? []).every((o) => !o.key.startsWith('_uploads/')), JSON.stringify(listed.objects))

// 6. 传三片
const parts = []
for (const [n, len] of [[1, 8], [2, 8], [3, 2]]) {
  const r = await call(`${KEY}?uploadId=${created.uploadId}&partNumber=${n}`, {
    method: 'PUT',
    headers: auth,
    body: new Uint8Array(len),
  })
  const data = await r.json()
  check(`第 ${n} 片返回 etag`, r.status === 200 && Boolean(data.etag), JSON.stringify(data))
  parts.push({ partNumber: n, etag: data.etag })
}

// 7. 片号越界要挡住
check('partNumber 0 → 400', (await call(`${KEY}?uploadId=${created.uploadId}&partNumber=0`, { method: 'PUT', headers: auth, body: new Uint8Array(1) })).status === 400)

// 8. etag 对不上要回 fatal，让前端别死循环重试
const bad = await call(`${KEY}?uploadId=${created.uploadId}`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-bogus' }, ...parts.slice(1)] }),
})
const badData = await bad.json()
check('坏 etag → 400 + fatal', bad.status === 400 && badData.fatal === true, JSON.stringify(badData))

// 9. 正常合并
const done = await call(`${KEY}?uploadId=${created.uploadId}`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ parts, marker: created.marker }),
})
const doneData = await done.json()
check('合并成功且大小 = 各片之和', done.status === 200 && doneData.size === 18, JSON.stringify(doneData))
check('合并后对象已落地', bucket.objects.has('roms/arcade/kof97.zip'))

// 10. 合并后标记必须消失，否则残留清单永远清不空
const index2 = await (await call('/multipart', { headers: auth })).json()
check('合并后 /multipart 为空', index2.uploads?.length === 0, JSON.stringify(index2))

// 11. abort 也要把标记清掉
const c2 = await (await call(`${KEY}?uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).json()
const aborted = await (await call(`${KEY}?uploadId=${c2.uploadId}&marker=${encodeURIComponent(c2.marker)}`, { method: 'DELETE', headers: auth })).json()
check('abort 成功', aborted.aborted === true, JSON.stringify(aborted))
const index3 = await (await call('/multipart', { headers: auth })).json()
check('abort 后 /multipart 为空', index3.uploads?.length === 0, JSON.stringify(index3))

// 12. 已经没了的 uploadId 再 abort：标记还是要删，不能让列表卡住
const c3 = await (await call(`${KEY}?uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).json()
bucket.uploads.delete(c3.uploadId)
const again = await (await call(`${KEY}?uploadId=${c3.uploadId}&marker=${encodeURIComponent(c3.marker)}`, { method: 'DELETE', headers: auth })).json()
check('失效 uploadId 仍回 ok（aborted=false）', again.ok === true && again.aborted === false, JSON.stringify(again))
check('失效 uploadId 的标记也被删掉', (await (await call('/multipart', { headers: auth })).json()).uploads.length === 0)

// 13. 标记对象不能当普通对象读写
check('直接 PUT 标记 → 404', (await call('/_uploads/x.marker', { method: 'PUT', headers: auth, body: new Uint8Array(1) })).status === 404)
check('直接 GET 标记 → 404', (await call('/_uploads/x.marker')).status === 404)

// 14. CORS 预检要放行 POST
const pre = await call(KEY, { method: 'OPTIONS' })
check('预检放行 POST', (pre.headers.get('access-control-allow-methods') ?? '').includes('POST'))

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
