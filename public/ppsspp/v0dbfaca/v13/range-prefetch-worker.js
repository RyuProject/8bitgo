/*
 * PSP 预读必须在独立 Worker 完成：模拟线程的同步 Range XHR 会冻结它自己的事件循环，
 * 同线程异步 XHR 即使已经收到数据，也来不及执行完成回调，下一块只能重复下载。
 */
const jobs = new Map()

function validRange(value, start, end, total) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim())
  return Boolean(match && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === total)
}

async function prefetch(job) {
  const state = new Int32Array(job.state)
  const bytes = new Uint8Array(job.bytes)
  const controller = new AbortController()
  jobs.set(job.id, controller)
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const headers = { Range: `bytes=${job.start}-${job.end}`, Accept: 'application/octet-stream' }
    if (job.ifMatch) headers['If-Match'] = job.ifMatch
    if (job.ifUnmodifiedSince) headers['If-Unmodified-Since'] = job.ifUnmodifiedSince
    const response = await fetch(job.url, { headers, signal: controller.signal, mode: 'cors' })
    if (
      response.status !== 206 ||
      !validRange(response.headers.get('content-range'), job.start, job.end, job.total) ||
      (job.ifMatch && response.headers.get('etag') !== job.ifMatch) ||
      (job.ifUnmodifiedSince && response.headers.get('last-modified') !== job.ifUnmodifiedSince) ||
      !response.body
    ) throw new Error('预读响应不符合当前镜像的 Range 或版本校验')

    const reader = response.body.getReader()
    let offset = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (offset + value.byteLength > bytes.byteLength) throw new Error('预读响应超出请求范围')
        bytes.set(value, offset)
        offset += value.byteLength
      }
    } finally {
      if (offset !== bytes.byteLength) await reader.cancel().catch(() => {})
    }
    if (offset !== bytes.byteLength) throw new Error('预读响应长度不足')
    Atomics.store(state, 0, 1)
  } catch {
    // 失败只让正式读盘回退到原生同步 XHR，绝不把半块数据当作有效缓存。
    Atomics.store(state, 0, 2)
  } finally {
    clearTimeout(timeout)
    if (jobs.get(job.id) === controller) jobs.delete(job.id)
    Atomics.notify(state, 0)
    postMessage({ type: 'done', id: job.id, key: job.key })
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === 'fetch') void prefetch(data)
  else if (data?.type === 'cancel') jobs.get(data.id)?.abort()
}

postMessage({ type: 'ready' })
