/**
 * 把远程光盘伪装成 WORKERFS 能读的 Blob。
 *
 * WORKERFS 的 read() 是同步接口，而网络 fetch 是异步的。Dolphin 核心已经跑在
 * DedicatedWorker 里，Worker 允许同步 XHR，所以这里在**核心线程内**按 2MB 对齐取块，
 * 再把命中的区间包装成 Blob 交给 FileReaderSync。这样 ISO / RVZ 不必整份下载。
 *
 * 同步请求会阻塞模拟线程，但不会卡住网页主线程；块缓存把一次网络往返摊到后续大量
 * 扇区读取上。这个折中只用于远程盘，本地 File 仍走上游原生 WORKERFS 零拷贝路径。
 */

export const REMOTE_DISC_CHUNK_BYTES = 2 * 1024 * 1024;
export const REMOTE_DISC_CACHE_BYTES = 192 * 1024 * 1024;

function defaultFetchRange(url, start, endInclusive) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", `bytes=${start}-${endInclusive}`);
  xhr.send(null);

  if (xhr.status !== 206) {
    throw new Error(`Remote disc requires HTTP 206 Range responses; received ${xhr.status || "network error"}`);
  }
  const bytes = new Uint8Array(xhr.response);
  const expected = endInclusive - start + 1;
  if (bytes.byteLength !== expected) {
    throw new Error(`Remote disc block is incomplete: expected ${expected} bytes, received ${bytes.byteLength}`);
  }
  return bytes;
}

export class RangeBackedFile {
  constructor({
    url,
    name,
    size,
    chunkBytes = REMOTE_DISC_CHUNK_BYTES,
    cacheBytes = REMOTE_DISC_CACHE_BYTES,
    fetchRange = defaultFetchRange,
    onFetch = () => {}
  }) {
    if (!url || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error("Remote disc descriptor is missing a valid URL or size");
    }
    this.url = url;
    this.name = name || "disc.iso";
    this.size = size;
    this.type = "application/octet-stream";
    this.lastModified = Date.now();
    this.lastModifiedDate = new Date(this.lastModified);
    this.chunkBytes = chunkBytes;
    this.cacheBytes = cacheBytes;
    this.fetchRange = fetchRange;
    this.onFetch = onFetch;
    this.cache = new Map();
    this.cachedBytes = 0;
    this.stats = { requests: 0, hits: 0, bytesFetched: 0 };
  }

  slice(start = 0, end = this.size) {
    const from = Math.max(0, Math.min(this.size, Math.trunc(start)));
    const to = Math.max(from, Math.min(this.size, Math.trunc(end)));
    const output = new Uint8Array(to - from);
    if (output.byteLength === 0) return new Blob([output], { type: this.type });

    const first = Math.floor(from / this.chunkBytes);
    const last = Math.floor((to - 1) / this.chunkBytes);
    for (let index = first; index <= last; index += 1) {
      const chunk = this.readChunk(index);
      const chunkStart = index * this.chunkBytes;
      const copyFrom = Math.max(from, chunkStart) - chunkStart;
      const copyTo = Math.min(to, chunkStart + chunk.byteLength) - chunkStart;
      if (copyTo > copyFrom) {
        output.set(chunk.subarray(copyFrom, copyTo), chunkStart + copyFrom - from);
      }
    }
    return new Blob([output], { type: this.type });
  }

  readChunk(index) {
    const hit = this.cache.get(index);
    if (hit) {
      this.stats.hits += 1;
      this.cache.delete(index);
      this.cache.set(index, hit);
      return hit;
    }

    const start = index * this.chunkBytes;
    const endInclusive = Math.min(this.size, start + this.chunkBytes) - 1;
    const raw = this.fetchRange(this.url, start, endInclusive);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const expected = endInclusive - start + 1;
    if (bytes.byteLength !== expected) {
      throw new Error(`Remote disc block is incomplete: expected ${expected} bytes, received ${bytes.byteLength}`);
    }

    this.stats.requests += 1;
    this.stats.bytesFetched += bytes.byteLength;
    this.cache.set(index, bytes);
    this.cachedBytes += bytes.byteLength;
    this.evict(index);
    this.onFetch({ ...this.stats, index, start, endInclusive });
    return bytes;
  }

  evict(current) {
    for (const key of this.cache.keys()) {
      if (this.cachedBytes <= this.cacheBytes) break;
      if (key === current) continue;
      this.cachedBytes -= this.cache.get(key)?.byteLength || 0;
      this.cache.delete(key);
    }
  }

  dispose() {
    this.cache.clear();
    this.cachedBytes = 0;
  }
}
