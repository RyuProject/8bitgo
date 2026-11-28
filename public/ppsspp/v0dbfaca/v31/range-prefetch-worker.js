/*
 * PSP 光盘读盘请求由同源 SharedWorker 汇聚：PPSSPP 的多个 pthread 可能同时读同一个 CHD 块，
 * 每线程各自预读会把同一 Range 重复送上网络。SharedWorker 只下载一份，再写入每个线程自己的
 * SharedArrayBuffer；不支持嵌套 SharedWorker 的浏览器仍可把本文件当 DedicatedWorker 使用。
 */
const jobsByKey = new Map()
const jobsById = new Map()
const MIN_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 180_000

function validRange(value, start, end, total) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim())
  return Boolean(match && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === total)
}

function sharedKey(job) {
  return [
    job.dedupeKey || `${job.url}\n${job.start}-${job.end}/${job.total}`,
    job.ifMatch || '',
    job.ifUnmodifiedSince || '',
    job.sendValidators === false ? 'pinned' : 'validated',
  ].join('\n')
}

function notifyClient(task, client, succeeded) {
  if (succeeded && client.bytes.buffer !== task.bytes.buffer) client.bytes.set(task.bytes)
  if (succeeded && client.state.buffer.byteLength > 8) {
    const metadata = new TextEncoder().encode(task.rawHeaders)
    const target = new Uint8Array(client.state.buffer, 8)
    if (metadata.byteLength < target.byteLength) {
      target.set(metadata)
      target[metadata.byteLength] = 0
    }
  }
  Atomics.store(client.state, 0, succeeded ? 1 : 2)
  Atomics.notify(client.state, 0)
  try { client.port.postMessage({ type: 'done', id: client.id, key: client.key }) } catch { /* 线程已退出，SAB 状态仍已写完。 */ }
}

function settle(task, succeeded) {
  if (task.settled) return
  task.settled = true
  clearTimeout(task.timeout)
  if (jobsByKey.get(task.sharedKey) === task) jobsByKey.delete(task.sharedKey)
  for (const client of task.clients.values()) {
    jobsById.delete(client.id)
    notifyClient(task, client, succeeded)
  }
  task.clients.clear()
}

function updateTimeout(task, timeoutMs) {
  const next = Math.min(MAX_TIMEOUT_MS, Math.max(task.timeoutMs, MIN_TIMEOUT_MS, Number(timeoutMs) || MIN_TIMEOUT_MS))
  if (next === task.timeoutMs && task.timeout) return
  task.timeoutMs = next
  clearTimeout(task.timeout)
  task.timeout = setTimeout(() => task.controller.abort(), task.timeoutMs)
}

async function run(task) {
  const job = task.job
  try {
    const headers = { Range: `bytes=${job.start}-${job.end}`, Accept: 'application/octet-stream' }
    // romv 已锁定内容版本；不带条件头才能让浏览器复用完整的 206 缓存。
    if (job.sendValidators !== false) {
      if (job.ifMatch) headers['If-Match'] = job.ifMatch
      if (job.ifUnmodifiedSince) headers['If-Unmodified-Since'] = job.ifUnmodifiedSince
    }
    const response = await fetch(job.url, { headers, signal: task.controller.signal, mode: 'cors' })
    const range = response.headers.get('content-range')
    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    if (
      response.status !== 206 ||
      !validRange(range, job.start, job.end, job.total) ||
      (job.ifMatch && etag !== job.ifMatch) ||
      (job.ifUnmodifiedSince && lastModified !== job.ifUnmodifiedSince) ||
      !response.body
    ) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error('Range 响应与请求范围或内容版本不符')
    }

    task.rawHeaders = `content-range: ${range}\r\n` +
      (etag ? `etag: ${etag}\r\n` : '') +
      (lastModified ? `last-modified: ${lastModified}\r\n` : '')
    const reader = response.body.getReader()
    let offset = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (offset + value.byteLength > task.bytes.byteLength) throw new Error('Range 响应超出请求范围')
        task.bytes.set(value, offset)
        offset += value.byteLength
      }
    } finally {
      if (offset !== task.bytes.byteLength) await reader.cancel().catch(() => {})
    }
    if (offset !== task.bytes.byteLength) throw new Error('Range 响应长度不足')
    settle(task, true)
  } catch {
    // 失败时所有等待线程回退到各自原生同步 XHR 与原有线路重试，不交付半块数据。
    settle(task, false)
  }
}

function handle(message, port) {
  if (message?.type === 'cancel') {
    const client = jobsById.get(message.id)
    if (!client || client.port !== port) return
    jobsById.delete(client.id)
    client.task.clients.delete(client.id)
    if (client.task.clients.size === 0) client.task.controller.abort()
    return
  }
  if (message?.type !== 'fetch') return

  const state = new Int32Array(message.state)
  const bytes = new Uint8Array(message.bytes)
  const expectedLength = message.end - message.start + 1
  if (
    !message.id || !message.key || !message.url ||
    !Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.end) ||
    !Number.isSafeInteger(message.total) || expectedLength <= 0 || bytes.byteLength !== expectedLength ||
    state.length < 1
  ) {
    Atomics.store(state, 0, 2)
    Atomics.notify(state, 0)
    return
  }

  const client = { id: message.id, key: message.key, port, bytes, state, task: null }
  const key = sharedKey(message)
  let task = jobsByKey.get(key)
  if (task) {
    if (task.bytes.byteLength !== bytes.byteLength || task.job.total !== message.total) {
      Atomics.store(state, 0, 2)
      Atomics.notify(state, 0)
      return
    }
    Atomics.add(state, 1, 1)
    client.task = task
    task.clients.set(client.id, client)
    jobsById.set(client.id, client)
    updateTimeout(task, message.timeoutMs)
    return
  }

  task = {
    sharedKey: key,
    job: message,
    bytes,
    controller: new AbortController(),
    clients: new Map(),
    timeout: null,
    timeoutMs: 0,
    settled: false,
  }
  client.task = task
  task.clients.set(client.id, client)
  jobsByKey.set(key, task)
  jobsById.set(client.id, client)
  updateTimeout(task, message.timeoutMs)
  void run(task)
}

function connect(port) {
  port.onmessage = ({ data }) => handle(data, port)
  port.start?.()
  port.postMessage({ type: 'ready' })
}

if ('onconnect' in self) {
  self.onconnect = ({ ports }) => {
    for (const port of ports || []) connect(port)
  }
} else {
  self.onmessage = ({ data }) => handle(data, self)
  postMessage({ type: 'ready' })
}
