const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1536 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_PATH_BYTES = 1024;
const ALLOWED_ROOTS = new Set(["vcbr", "vcsky"]);
const REQUIRED_FILES = new Map([
  ["vcbr/vc-sky-en-v6.data", 100 * 1024 * 1024],
  ["vcbr/vc-sky-en-v6.wasm", 1],
  ["vcsky/sha256sums.txt", 1],
]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function concatBytes(left, right) {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function readHeaderString(header, start, length) {
  let end = start;
  while (end < start + length && header[end] !== 0) end += 1;
  return decoder.decode(header.subarray(start, end));
}

function readTarNumber(header, start, length, label) {
  if ((header[start] & 0x80) !== 0) {
    throw new Error(`${label} 使用了不支持的 TAR base-256 数字格式`);
  }
  const raw = readHeaderString(header, start, length).trim().replace(/\0/g, "");
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`${label} 不是合法的八进制数字`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 超出安全范围`);
  return value;
}

function assertHeaderChecksum(header) {
  const expected = readTarNumber(header, 148, 8, "TAR 校验和");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error("TAR 文件头校验失败，压缩包可能已损坏或下载不完整");
}

function isZeroBlock(header) {
  for (const value of header) if (value !== 0) return false;
  return true;
}

function normalizeTarPath(rawPath) {
  const path = String(rawPath || "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.includes("\0")) throw new Error("归档包含空路径或绝对路径");
  if (encoder.encode(path).byteLength > MAX_PATH_BYTES) throw new Error("归档路径过长");

  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`归档包含不安全路径：${path}`);
  }
  if (!ALLOWED_ROOTS.has(parts[0])) throw new Error(`归档包含未知顶层目录：${parts[0]}`);
  return parts.join("/");
}

function parsePaxPath(bytes) {
  const text = decoder.decode(bytes);
  let offset = 0;
  let path = "";
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) throw new Error("PAX 元数据格式无效");
    const recordLength = Number(text.slice(offset, space));
    if (!Number.isInteger(recordLength) || recordLength <= 0 || offset + recordLength > text.length) {
      throw new Error("PAX 元数据长度无效");
    }
    const record = text.slice(space + 1, offset + recordLength).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += recordLength;
  }
  return path;
}

async function removeEntryIfPresent(root, name, options = {}) {
  try {
    await root.removeEntry(name, options);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

async function prepareEmptyImport(root) {
  // 先删就绪标记，避免导入失败后旧标记把半套新文件误判成可玩。
  await removeEntryIfPresent(root, "_game_ready");
  await removeEntryIfPresent(root, "vcbr", { recursive: true });
  await removeEntryIfPresent(root, "vcsky", { recursive: true });
}

async function cleanupFailedImport(root) {
  await removeEntryIfPresent(root, "_game_ready").catch(() => {});
  await removeEntryIfPresent(root, "vcbr", { recursive: true }).catch(() => {});
  await removeEntryIfPresent(root, "vcsky", { recursive: true }).catch(() => {});
}

async function ensureDirectory(root, parts) {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  return directory;
}

async function openFileWriter(root, path) {
  const parts = path.split("/");
  const filename = parts.pop();
  const directory = await ensureDirectory(root, parts);
  const fileHandle = await directory.getFileHandle(filename, { create: true });

  if (fileHandle.createSyncAccessHandle) {
    const handle = await fileHandle.createSyncAccessHandle();
    handle.truncate(0);
    let offset = 0;
    return {
      async write(bytes) {
        let written = 0;
        while (written < bytes.byteLength) {
          const count = handle.write(bytes.subarray(written), { at: offset + written });
          if (!Number.isInteger(count) || count <= 0) throw new Error(`无法写入 ${path}`);
          written += count;
        }
        offset += written;
      },
      async close() {
        handle.flush();
        handle.close();
      },
      async abort() {
        try { handle.close(); } catch {}
      },
    };
  }

  const writable = await fileHandle.createWritable();
  return {
    async write(bytes) {
      // 每次只交给 OPFS 当前流块，不能把整个 TAR 的底层 ArrayBuffer 一并保活。
      await writable.write(bytes.slice());
    },
    async close() {
      await writable.close();
    },
    async abort() {
      await writable.abort().catch(() => {});
    },
  };
}

async function writeSmallFile(root, path, bytes) {
  const writer = await openFileWriter(root, path);
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

class StreamingTarExtractor {
  constructor(root, progress) {
    this.root = root;
    this.progress = progress;
    this.buffer = new Uint8Array(0);
    this.entry = null;
    this.padding = 0;
    this.pendingLongName = "";
    this.pendingPaxPath = "";
    this.ended = false;
    this.entryCount = 0;
    this.expandedBytes = 0;
    this.seenFiles = new Map();
  }

  async push(chunk) {
    if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    this.expandedBytes += chunk.byteLength;
    if (this.expandedBytes > MAX_EXPANDED_BYTES) throw new Error("归档解压后超过 4 GiB 安全上限");
    if (this.ended) {
      if (chunk.some((value) => value !== 0)) throw new Error("TAR 结束标记后仍有非零数据");
      return;
    }

    this.buffer = concatBytes(this.buffer, chunk);
    await this.drain();
  }

  async drain() {
    while (this.buffer.byteLength > 0) {
      if (this.entry) {
        const count = Math.min(this.entry.remaining, this.buffer.byteLength);
        if (count > 0) {
          const bytes = this.buffer.subarray(0, count);
          await this.consumeEntryBytes(bytes);
          this.buffer = this.buffer.subarray(count);
          this.entry.remaining -= count;
        }
        if (this.entry.remaining > 0) return;
        await this.finishEntry();
        continue;
      }

      if (this.padding > 0) {
        const count = Math.min(this.padding, this.buffer.byteLength);
        this.buffer = this.buffer.subarray(count);
        this.padding -= count;
        if (this.padding > 0) return;
        continue;
      }

      if (this.buffer.byteLength < TAR_BLOCK_BYTES) return;
      const header = this.buffer.subarray(0, TAR_BLOCK_BYTES);
      this.buffer = this.buffer.subarray(TAR_BLOCK_BYTES);
      if (isZeroBlock(header)) {
        this.ended = true;
        if (this.buffer.some((value) => value !== 0)) throw new Error("TAR 结束标记后仍有非零数据");
        this.buffer = new Uint8Array(0);
        return;
      }

      assertHeaderChecksum(header);
      await this.startEntry(header);
    }
  }

  async startEntry(header) {
    const rawName = readHeaderString(header, 0, 100);
    const prefix = readHeaderString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readTarNumber(header, 124, 12, `TAR 条目 ${headerPath} 的大小`);
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (size > MAX_ENTRY_BYTES) throw new Error(`归档条目 ${headerPath} 超过 1.5 GiB 安全上限`);

    this.entryCount += 1;
    if (this.entryCount > MAX_ENTRIES) throw new Error("归档文件数量超过 100000 个安全上限");

    const path = this.pendingPaxPath || this.pendingLongName || headerPath;
    this.pendingPaxPath = "";
    this.pendingLongName = "";
    this.padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

    if (type === "L" || type === "x") {
      if (size > MAX_METADATA_BYTES) throw new Error("TAR 路径元数据过大");
      this.entry = { kind: type === "L" ? "longname" : "pax", remaining: size, chunks: [] };
      if (size === 0) await this.finishEntry();
      return;
    }

    if (type === "5") {
      const directoryPath = normalizeTarPath(path);
      await ensureDirectory(this.root, directoryPath.split("/"));
      this.entry = { kind: "directory", remaining: size };
      if (size === 0) await this.finishEntry();
      return;
    }

    if (type !== "0") throw new Error(`归档包含不支持的 TAR 条目类型 ${JSON.stringify(type)}：${path}`);

    const safePath = normalizeTarPath(path);
    const writer = await openFileWriter(this.root, safePath);
    this.entry = { kind: "file", remaining: size, size, path: safePath, writer };
    if (size === 0) await this.finishEntry();
  }

  async consumeEntryBytes(bytes) {
    if (this.entry.kind === "file") {
      await this.entry.writer.write(bytes);
    } else if (this.entry.kind === "longname" || this.entry.kind === "pax") {
      this.entry.chunks.push(bytes.slice());
    }
  }

  async finishEntry() {
    const entry = this.entry;
    this.entry = null;
    if (!entry) return;

    if (entry.kind === "file") {
      try {
        await entry.writer.close();
      } catch (error) {
        await entry.writer.abort();
        throw error;
      }
      this.seenFiles.set(entry.path, entry.size);
      this.progress(this.entryCount);
      return;
    }

    if (entry.kind === "longname" || entry.kind === "pax") {
      const total = entry.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of entry.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (entry.kind === "longname") {
        this.pendingLongName = decoder.decode(bytes).replace(/\0+$/, "");
      } else {
        this.pendingPaxPath = parsePaxPath(bytes);
      }
    }
  }

  async finish() {
    await this.drain();
    if (this.entry || this.padding > 0 || this.buffer.byteLength > 0) {
      throw new Error("TAR 归档被截断，最后一个文件不完整");
    }
    if (!this.ended) throw new Error("TAR 归档缺少结束标记");

    for (const [path, minimumSize] of REQUIRED_FILES) {
      const actualSize = this.seenFiles.get(path) || 0;
      if (actualSize < minimumSize) throw new Error(`归档缺少必需文件或文件过小：${path}`);
    }
  }
}

async function importArchive(file) {
  if (!file || typeof file.stream !== "function") throw new Error("没有收到可读取的归档文件");
  if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) throw new Error("game.tar.gz 必须大于 0 且不超过 1 GiB");

  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) throw new Error("所选文件不是有效的 gzip 归档");

  const root = await navigator.storage.getDirectory();
  await prepareEmptyImport(root);
  let loaded = 0;
  let lastPercent = -1;
  let lastReportedEntries = -1;
  let extractedEntries = 0;

  const report = () => {
    const percent = Math.min(95, 5 + Math.floor((loaded / file.size) * 90));
    if (percent === lastPercent && extractedEntries === lastReportedEntries) return;
    lastPercent = percent;
    lastReportedEntries = extractedEntries;
    self.postMessage({
      type: "progress",
      phase: "extracting",
      pct: percent,
      done: extractedEntries,
      total: "…",
    });
  };

  const countedCompressed = file.stream().pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (loaded > MAX_ARCHIVE_BYTES) throw new Error("读取量超过 1 GiB 安全上限");
      report();
      controller.enqueue(chunk);
    },
  }));
  const reader = countedCompressed.pipeThrough(new DecompressionStream("gzip")).getReader();
  const extractor = new StreamingTarExtractor(root, (count) => {
    extractedEntries = count;
    report();
  });

  try {
    self.postMessage({ type: "progress", phase: "reading", pct: 0 });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await extractor.push(value);
    }
    await extractor.finish();
    await writeSmallFile(root, "_game_ready", encoder.encode("v4"));
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await cleanupFailedImport(root);
    throw error;
  }
}

self.onmessage = async (event) => {
  try {
    await importArchive(event.data?.file);
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
