/** Read a Fetch response incrementally. Limit applies to delivered (possibly decoded) bytes. */
export async function readResponseBuffer(response, maxBytes, signal) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid response byte limit')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw Object.assign(new Error('Upstream response exceeds byte limit'), { code: 'UPSTREAM_TOO_LARGE' })
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw Object.assign(new Error('Upstream response exceeds byte limit'), { code: 'UPSTREAM_TOO_LARGE' })
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}
