import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import {
  filterWindowsGuestSaveChanges,
  mergeWindowsGuestSaveChanges,
  readZipEntries,
  readZipFile,
} from '@/lib/jsdosBundle'
import { crc32 } from '@/lib/unzip'
import { windowsGuestArchiveFingerprint, windowsGuestSaveKey } from '@/lib/windowsGuest'
import { parseEmulatorVariantSaveSlug } from '@/emulator/romLanguage'

const encode = (value) => new TextEncoder().encode(value)

function zip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const item of entries) {
    const name = encode(item.name)
    const raw = encode(item.data ?? '')
    const method = item.method ?? 0
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
    const crc = crc32(raw)
    const header = new Uint8Array(30 + name.length)
    const lv = new DataView(header.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    header.set(name, 30)
    local.push(header, data)

    const dir = new Uint8Array(46 + name.length)
    const cv = new DataView(dir.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    dir.set(name, 46)
    central.push(dir)
    offset += header.length + data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...local, ...central, end]
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function names(bytes) {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  return readZipEntries(view.buffer).map((entry) => entry.name)
}

async function textFile(bytes, path) {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  const file = await readZipFile(view.buffer, path)
  return file ? new TextDecoder().decode(file.data) : null
}

const source = zip([
  { name: 'GAME/' },
  { name: 'GAME/SAVE/' },
  { name: 'GAME/SAVE/CAMPAIGN.GAM', data: 'campaign-1' },
  { name: 'GAME/README.TXT', data: 'game folder' },
  { name: 'system-win95.qcow2', data: 'must never persist' },
  { name: 'WINDOWS/SYSTEM.DAT', data: 'must never persist' },
])
const filtered = filterWindowsGuestSaveChanges(source)
assert.ok(filtered)
assert.deepEqual(names(filtered), ['GAME/', 'GAME/SAVE/', 'GAME/SAVE/CAMPAIGN.GAM', 'GAME/README.TXT'])
assert.equal(await textFile(filtered, 'GAME/SAVE/CAMPAIGN.GAM'), 'campaign-1')

const deflated = filterWindowsGuestSaveChanges(zip([
  { name: 'GAME/SAVE/CAMPAIGN.GAM', data: 'campaign-1', method: 8 },
]))
assert.ok(deflated)
assert.equal(await textFile(deflated, 'GAME/SAVE/CAMPAIGN.GAM'), 'campaign-1')

assert.equal(filterWindowsGuestSaveChanges(zip([{ name: 'WINDOWS/SYSTEM.DAT', data: 'ignored' }])), null)

const previous = filterWindowsGuestSaveChanges(zip([
  { name: 'GAME/SAVE/A.GAM', data: 'old-a' },
  { name: 'GAME/SAVE/B.GAM', data: 'keep-b' },
]))
const currentDelta = zip([
  { name: 'GAME/SAVE/A.GAM', data: 'new-a' },
  { name: 'system-win95.qcow2', data: 'system write is excluded' },
])
const merged = mergeWindowsGuestSaveChanges(previous, currentDelta)
assert.ok(merged)
assert.deepEqual(names(merged), ['GAME/', 'GAME/SAVE/', 'GAME/SAVE/A.GAM', 'GAME/SAVE/B.GAM'])
assert.equal(await textFile(merged, 'GAME/SAVE/A.GAM'), 'new-a')
assert.equal(await textFile(merged, 'GAME/SAVE/B.GAM'), 'keep-b')

assert.throws(
  () => filterWindowsGuestSaveChanges(zip([{ name: 'GAME/../../WINDOWS/SYSTEM.INI', data: 'bad' }])),
  /不安全|路径冲突/,
)
assert.throws(
  () => mergeWindowsGuestSaveChanges(
    filterWindowsGuestSaveChanges(zip([{ name: 'GAME/OLD', data: 'file' }])),
    zip([{ name: 'GAME/OLD/NEW.GAM', data: 'collision' }]),
  ),
  /路径冲突/,
)

const fingerprintA = windowsGuestArchiveFingerprint(zip([
  { name: 'GAME/A.EXE', data: 'program' },
  { name: 'GAME/DATA.DAT', data: 'data-v1' },
]).buffer)
const fingerprintReordered = windowsGuestArchiveFingerprint(zip([
  { name: 'GAME/DATA.DAT', data: 'data-v1' },
  { name: 'GAME/A.EXE', data: 'program' },
]).buffer)
const fingerprintRecompressed = windowsGuestArchiveFingerprint(zip([
  { name: 'GAME/DATA.DAT', data: 'data-v1', method: 8 },
  { name: 'GAME/A.EXE', data: 'program', method: 8 },
]).buffer)
const fingerprintB = windowsGuestArchiveFingerprint(zip([
  { name: 'GAME/A.EXE', data: 'program' },
  { name: 'GAME/DATA.DAT', data: 'data-v2' },
]).buffer)
assert.equal(fingerprintA, fingerprintReordered)
assert.equal(fingerprintA, fingerprintRecompressed)
assert.notEqual(fingerprintA, fingerprintB)
assert.equal(windowsGuestSaveKey('aoe', fingerprintA), windowsGuestSaveKey('aoe', fingerprintA))
assert.notEqual(windowsGuestSaveKey('aoe', fingerprintA), windowsGuestSaveKey('aoe', fingerprintB))
assert.notEqual(windowsGuestSaveKey('different-game', fingerprintA), windowsGuestSaveKey('aoe', fingerprintA))
const longLocalizedKey = windowsGuestSaveKey(`${'a'.repeat(120)}~rom-en`, fingerprintA)
assert.ok(longLocalizedKey.length <= 160)
assert.equal(parseEmulatorVariantSaveSlug(longLocalizedKey).romLang, 'en')

console.log('Windows 客体游戏目录存档测试通过')
