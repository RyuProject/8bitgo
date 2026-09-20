import { mkdir, readdir, lstat, unlink, utimes, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const FILE = /^tmp-[a-f0-9]{32}\.jar(?:\.part)?$/i
const JAR = /^tmp-[a-f0-9]{32}\.jar$/i
/** Single-process, exclusive-directory owner. Never share this directory between workers.
 * Async serialized commits enforce the byte quota; readers see only complete renamed JARs.
 * Metadata is loaded once and reconciled by the periodic sweep, not scanned on every upload.
 */
export class TemporaryJarStore {
  constructor({ directory, maxBytes, ttlMs }) {
    this.directory = directory
    this.maxBytes = maxBytes
    this.ttlMs = ttlMs
    this.records = new Map()
    this.total = 0
    this.ready = false
    this.tail = Promise.resolve()
  }
  serial(fn) {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => {})
    return result
  }
  async reconcile() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const records = new Map()
    let total = 0
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!FILE.test(entry.name) || !entry.isFile()) continue
      try {
        const stat = await lstat(path.join(this.directory, entry.name))
        if (!stat.isFile()) continue
        records.set(entry.name, { size: stat.size, mtimeMs: stat.mtimeMs })
        total += stat.size
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    this.records = records
    this.total = total
    this.ready = true
  }
  async init() { if (!this.ready) await this.reconcile() }
  async removeKnown(name) {
    const record = this.records.get(name)
    if (!record) return false
    try { await unlink(path.join(this.directory, name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    this.records.delete(name)
    this.total -= record.size
    return true
  }
  async sweepKnown() {
    let removed = 0
    const now = Date.now()
    for (const [name, record] of this.records) {
      if (now - record.mtimeMs > this.ttlMs) {
        try { if (await this.removeKnown(name)) removed++ }
        catch { /* Undeletable bytes remain charged against quota. */ }
      }
    }
    return removed
  }
  sweep() { return this.serial(async () => { await this.reconcile(); return this.sweepKnown() }) }
  put(buffer) {
    if (!Buffer.isBuffer(buffer)) return Promise.reject(new TypeError('Expected Buffer'))
    return this.serial(async () => {
      await this.init()
      // Reclaim expired files only when needed; periodic maintenance handles normal cleanup.
      if (this.total + buffer.length > this.maxBytes) await this.sweepKnown()
      if (this.total + buffer.length > this.maxBytes) {
        throw Object.assign(new Error('Temporary disk quota exceeded'), { code: 'J2ME_QUOTA' })
      }
      const name = `tmp-${randomBytes(16).toString('hex')}.jar`
      const partial = `${name}.part`
      const target = path.join(this.directory, name)
      const staging = path.join(this.directory, partial)
      let created = false
      try {
        // Exclusive creation; the final public name is never partially written.
        await writeFile(staging, buffer, { flag: 'wx', mode: 0o600 })
        created = true
        await rename(staging, target)
        this.records.set(name, { size: buffer.length, mtimeMs: Date.now() })
        this.total += buffer.length
        return name
      } catch (error) {
        // writeFile can leave a partial file even when it rejects. Never unlink a colliding file.
        if (error.code !== 'EEXIST' || created) {
          try { await unlink(staging) }
          catch (cleanup) {
            if (cleanup.code !== 'ENOENT') {
              // Conservative accounting until the next successful reconciliation.
              this.records.set(partial, { size: buffer.length, mtimeMs: Date.now() })
              this.total += buffer.length
            }
          }
        }
        throw error
      }
    })
  }
  remove(name) {
    if (!JAR.test(name)) return Promise.resolve(false)
    if (this.ready && !this.records.has(name)) return Promise.resolve(false)
    return this.serial(async () => { await this.init(); return this.removeKnown(name) })
  }
  touch(name) {
    if (!JAR.test(name)) return Promise.resolve(false)
    if (this.ready && !this.records.has(name)) return Promise.resolve(false)
    return this.serial(async () => {
      await this.init()
      const record = this.records.get(name)
      if (!record) return false
      const now = new Date()
      try { await utimes(path.join(this.directory, name), now, now) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        this.records.delete(name)
        this.total -= record.size
        return false
      }
      record.mtimeMs = now.getTime()
      return true
    })
  }
}
