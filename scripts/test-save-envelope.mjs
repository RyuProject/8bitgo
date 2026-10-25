/** 通用存档容器：身份、核心信息、截断/篡改检测与旧裸存档兼容。 */
import assert from 'node:assert/strict'
import {
  decodeSaveArchive,
  encodeSaveArchive,
  encodeSaveArchiveBlob,
  maxSaveArchiveBytes,
} from '../src/emulator/saveEnvelope.ts'

let passed = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed++
  console.log(`✅ ${message}`)
}
const rejects = async (promise, pattern, message) => {
  await assert.rejects(promise, pattern)
  passed++
  console.log(`✅ ${message}`)
}

const payload = new Uint8Array([0, 1, 2, 3, 254, 255])
const coordinate = { runtime: 'emulatorjs', gameSlug: 'chrono-trigger', slot: 2 }
const archive = await encodeSaveArchive(payload, coordinate, {
  core: 'snes9x',
  build: 'ejs-generation-9',
  romFingerprint: 'sha256:rom',
  format: 'emulatorjs-state',
}, 1_234)

console.log('── 新格式往返 ──')
ok(maxSaveArchiveBytes(0) > 0 && maxSaveArchiveBytes(4 * 1024 * 1024) > 4 * 1024 * 1024, '导入前可算出含文件头的安全上限')
assert.throws(() => maxSaveArchiveBytes(-1), /上限不合法/)
passed++
console.log('✅ 非法大小上限会被拒绝')
const decoded = await decodeSaveArchive(archive, coordinate)
ok(Buffer.from(decoded.payload).equals(Buffer.from(payload)), 'payload 原样往返')
ok(decoded.header?.core === 'snes9x' && decoded.header.build === 'ejs-generation-9', '保留核心与构建代次')
ok(decoded.header?.createdAt === 1_234 && decoded.header.payloadBytes === payload.length, '保留时间与长度')
const blobArchive = await encodeSaveArchiveBlob(new Blob([payload]), coordinate, { core: 'snes9x' }, 1_235)
const blobDecoded = await decodeSaveArchive(new Uint8Array(await blobArchive.arrayBuffer()), coordinate)
ok(
  blobDecoded.header?.checksum.startsWith('fnv1a32:')
    && Buffer.from(blobDecoded.payload).equals(Buffer.from(payload)),
  '大文件 Blob 路径不复制正文也能生成可验证容器',
)

console.log('\n── 身份不匹配要在交给模拟器前拦住 ──')
await rejects(decodeSaveArchive(archive, { runtime: 'ruffle' }), /另一个模拟器/, '拒绝错误运行时')
await rejects(decodeSaveArchive(archive, { gameSlug: 'another-game' }), /另一款游戏/, '拒绝错误游戏')
await rejects(decodeSaveArchive(archive, { slot: 1 }), /另一个存档位/, '拒绝错误槽位')
await rejects(
  decodeSaveArchive(archive, coordinate, { core: 'bsnes', format: 'emulatorjs-state' }),
  /不同的模拟核心/,
  '拒绝同一游戏但不同核心的快照',
)
await rejects(
  decodeSaveArchive(archive, coordinate, { core: 'snes9x', format: 'other-state' }),
  /格式与当前运行时不兼容/,
  '拒绝同一核心但不同状态格式',
)

console.log('\n── 损坏与截断检测 ──')
const changed = archive.slice()
changed[changed.length - 1] ^= 0xff
await rejects(decodeSaveArchive(changed), /校验失败/, 'payload 被篡改时拒绝')
await rejects(decodeSaveArchive(archive.slice(0, -1)), /不完整/, '文件被截断时拒绝')

console.log('\n── 旧存档兼容 ──')
const legacy = await decodeSaveArchive(payload, coordinate)
ok(legacy.header === null && Buffer.from(legacy.payload).equals(Buffer.from(payload)), '没有文件头的历史存档照常读取')

console.log(`\n全部通过 ✅  共 ${passed} 项`)
