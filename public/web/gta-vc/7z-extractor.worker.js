import SevenZipFactory from './vendor/un7z-opfs/dist/7zz.js'

const ARCHIVE_NAME = 'source.7z'
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const MAX_ENTRY_COUNT = 50_000
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
const TEMP_PREFIX = '_gta_vc_7z_'

function send(id, message) {
  self.postMessage({ id, ...message })
}

function errorMessage(error) {
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  try { return JSON.stringify(error) || String(error) } catch { return String(error) }
}

async function runSevenZip(module, args, errors, failureMessage) {
  let exitCode
  try {
    exitCode = await module.callMain(args)
  } catch (error) {
    const details = errors.slice(-4).join(' ').trim()
    throw new Error(details || `${failureMessage} (${errorMessage(error)})`)
  }
  if (exitCode !== 0) {
    const details = errors.slice(-4).join(' ').trim()
    throw new Error(details || failureMessage)
  }
}

function normalizedArchivePath(value) {
  const path = String(value || '').replaceAll('\\', '/')
  const parts = path.split('/')
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
      path.includes('\0') || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`7z 中包含不安全的文件路径：${path.slice(0, 160)}`)
  }
  return path
}

function parseListing(lines) {
  const entries = []
  let totalBytes = 0
  let current = {}

  const flush = () => {
    if (current.Path !== undefined && (current.Size !== undefined || current.Folder === '+')) {
      const path = normalizedArchivePath(current.Path.replace(/\/$/, ''))
      const isDirectory = current.Folder === '+' || (current.Attributes || '').trim().startsWith('D')
      const size = Number.parseInt(current.Size || '0', 10)
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`7z 文件大小无效：${path}`)
      if (!isDirectory) totalBytes += size
      entries.push({ path, isDirectory, size })
      if (entries.length > MAX_ENTRY_COUNT) throw new Error('7z 文件数量超过 50,000 个')
      if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error('7z 解包后超过 2 GiB，已停止以保护本机存储')
    }
    current = {}
  }

  for (const line of lines) {
    if (!line.trim()) {
      flush()
      continue
    }
    const separator = line.indexOf(' = ')
    if (separator >= 0) current[line.slice(0, separator)] = line.slice(separator + 3)
  }
  flush()
  return { entries, totalBytes }
}

function storagePath(name) {
  return `/opfs-out/${name}`
}

async function removeEntry(root, name) {
  try {
    await root.removeEntry(name, { recursive: true })
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error
  }
}

async function checkFreeSpace(requiredBytes) {
  const estimate = await navigator.storage.estimate().catch(() => null)
  if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return
  const freeBytes = Math.max(0, estimate.quota - estimate.usage)
  if (freeBytes < requiredBytes + 64 * 1024 * 1024) {
    throw new Error('浏览器本机剩余空间不足；请清理空间后重试，或使用本地安装目录导入')
  }
}

async function openSource(source, id) {
  if (source.file instanceof File) {
    if (!/\.7z$/i.test(source.file.name)) throw new Error('请选择 .7z 文件')
    if (source.file.size > MAX_ARCHIVE_BYTES) throw new Error('7z 文件超过 1 GiB')
    return { stream: source.file.stream(), size: source.file.size }
  }

  if (source.url !== '/game-data/revcdoseng.7z') throw new Error('游戏资源地址无效')
  const response = await fetch(source.url, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok || !response.body) {
    throw new Error(response.status === 404
      ? '8BitGo R2 上还没有 revcdoseng.7z'
      : `下载 7z 失败：HTTP ${response.status}`)
  }

  const size = Number(response.headers.get('content-length')) || 0
  if (size > MAX_ARCHIVE_BYTES) throw new Error('R2 上的 7z 文件超过 1 GiB')
  return { stream: response.body, size, id }
}

async function writeStreamToOpfs(stream, handle, total, id) {
  const access = await handle.createSyncAccessHandle()
  const reader = stream.getReader()
  let offset = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      let written = 0
      while (written < value.byteLength) {
        const count = access.write(value.subarray(written), { at: offset + written })
        if (!count) throw new Error('写入浏览器本机临时文件失败')
        written += count
      }
      offset += value.byteLength
      send(id, { type: 'progress', phase: 'download', done: offset, total })
      if (offset > MAX_ARCHIVE_BYTES) throw new Error('7z 文件超过 1 GiB')
    }
    access.flush()
  } finally {
    reader.releaseLock()
    access.close()
  }
  return offset
}

async function extract(source, id) {
  const root = await navigator.storage.getDirectory()
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('7z 导入任务编号无效')
  const tempName = `${TEMP_PREFIX}${id}`
  let archiveAccess
  let archiveNode
  let module

  try {
    const input = await openSource(source, id)
    await checkFreeSpace(input.size || 0)
    const tempDirectory = await root.getDirectoryHandle(tempName, { create: true })
    const archiveHandle = await tempDirectory.getFileHandle(ARCHIVE_NAME, { create: true })
    const archiveBytes = await writeStreamToOpfs(input.stream, archiveHandle, input.size, id)
    if (!archiveBytes) throw new Error('7z 文件为空')

    send(id, { type: 'progress', phase: 'checking', done: 0, total: 0 })
    const listingLines = []
    const extractionErrors = []
    let phase = 'listing'
    let currentFile = null

    module = await SevenZipFactory({
      locateFile(path) {
        return new URL(`./vendor/un7z-opfs/dist/${path}`, self.location.href).href
      },
      print(line) {
        if (phase === 'listing') {
          listingLines.push(line)
        } else if (phase === 'extracting') {
          const match = /-\s(.+)$/.exec(line)
          if (match) currentFile = match[1]
        }
      },
      printErr(line) {
        if (line) extractionErrors.push(String(line).slice(0, 240))
      },
    })

    module.FS.mkdir('/opfs-out')
    module.FS.mount(module.OPFS, {}, '/opfs-out')
    module.FS.createPath('/opfs-out', tempName, true, true)
    const archivePath = storagePath(`${tempName}/${ARCHIVE_NAME}`)
    archiveNode = module.FS.createFile(storagePath(tempName), ARCHIVE_NAME, {}, true, false)
    archiveNode.opfsSize = archiveBytes
    archiveAccess = await archiveHandle.createSyncAccessHandle()
    const archiveFile = await archiveHandle.getFile()
    if (archiveFile.size !== archiveBytes) throw new Error(`7z 临时文件长度不符：${archiveFile.size} / ${archiveBytes}`)
    const signature = new Uint8Array(6)
    const signatureBytes = archiveAccess.read(signature, { at: 0 })
    if (signatureBytes !== signature.byteLength ||
        signature.some((value, index) => value !== [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c][index])) {
      throw new Error('7z 临时文件读回校验失败')
    }
    module.OPFS.fileHandles.set(archivePath, archiveAccess)
    const originalClose = module.OPFS.stream_ops.close
    module.OPFS.stream_ops.close = (stream) => {
      if (stream.path === archivePath) {
        // 7-Zip 会为同一归档重复开关输入流；保留这一个只读 OPFS 句柄直到命令结束。
        stream.opfsHandle = null
        return
      }
      return originalClose(stream)
    }
    // 先通过 Emscripten 挂载层读回文件头，确认 7-Zip 能访问 OPFS 中的输入文件。
    const fsProbe = module.FS.open(archivePath, 'r')
    try {
      const fsSignature = new Uint8Array(signature.byteLength)
      const fsBytes = module.FS.read(fsProbe, fsSignature, 0, fsSignature.byteLength, 0)
      if (fsBytes !== fsSignature.byteLength ||
          fsSignature.some((value, index) => value !== signature[index])) {
        throw new Error('7z 虚拟文件系统读回校验失败')
      }
    } finally {
      module.FS.close(fsProbe)
    }
    const originalOpen = module.OPFS.stream_ops.open
    module.OPFS.stream_ops.open = (stream) => {
      try {
        return originalOpen(stream)
      } catch (error) {
        if (stream.path === archivePath) extractionErrors.push(`输入文件打开失败 path=${stream.path} mapped=${module.OPFS.fileHandles.has(stream.path)}: ${errorMessage(error)}`)
        throw error
      }
    }
    const originalRead = module.OPFS.stream_ops.read
    module.OPFS.stream_ops.read = (stream, buffer, offset, length, position) => {
      try {
        return originalRead(stream, buffer, offset, length, position)
      } catch (error) {
        if (stream.path === archivePath) extractionErrors.push(`输入文件读取失败 path=${stream.path} pos=${position} len=${length}: ${errorMessage(error)}`)
        throw error
      }
    }

    await runSevenZip(module, ['l', '-slt', archivePath], extractionErrors, '无法读取 7z 文件目录')
    const { entries, totalBytes } = parseListing(listingLines)
    if (!entries.length) throw new Error('7z 中没有可导入的文件')
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw new Error('7z 文件超过 1 GiB')
    // 解包时压缩包和解出的目录会同时占用 OPFS，按峰值总量预检，避免解到一半才写满。
    await checkFreeSpace(archiveBytes + totalBytes)

    const extractedDirectory = 'source'
    const extractedFsPath = storagePath(`${tempName}/${extractedDirectory}`)
    let processedBytes = 0
    module.OPFS.onWrite = (_path, count) => {
      processedBytes += count
      send(id, {
        type: 'progress', phase: 'extract', done: processedBytes, total: totalBytes,
        file: currentFile,
      })
    }
    phase = 'extracting'
    await runSevenZip(module, [
      'x', archivePath, `-o${extractedFsPath}`, '-y', '-bb1', '-bso1',
    ], extractionErrors, '7z 解包失败')

    if (module.OPFS.fileHandles.has(archivePath)) {
      module.OPFS.fileHandles.get(archivePath).close()
      module.OPFS.fileHandles.delete(archivePath)
      archiveAccess = null
    }
    await removeEntry(tempDirectory, ARCHIVE_NAME)
    send(id, {
      type: 'done',
      archiveBytes,
      entryCount: entries.length,
      totalBytes,
      extractRoot: `${tempName}/${extractedDirectory}`,
      cleanupRoot: tempName,
    })
  } catch (error) {
    if (archiveAccess) {
      try { archiveAccess.close() } catch {}
    }
    if (module && archiveNode) {
      const path = storagePath(`${tempName}/${ARCHIVE_NAME}`)
      const handle = module.OPFS.fileHandles.get(path)
      if (handle) {
        try { handle.close() } catch {}
        module.OPFS.fileHandles.delete(path)
      }
    }
    await removeEntry(root, tempName).catch(() => {})
    throw error
  }
}

self.addEventListener('message', async (event) => {
  const message = event.data
  if (!message || message.type !== 'extract') return
  try {
    await extract(message.source, message.id)
  } catch (error) {
    send(message.id, { type: 'error', message: errorMessage(error) })
  }
})
