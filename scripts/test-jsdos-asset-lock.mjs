/**
 * js-dos「版本号 ↔ 字节」锁（2026-11-15 #8）。跑：npm run test:jsdos-asset-lock
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesFingerprint, readLock, verifyLock, writeLock, LOCK_FILE } from './lib/jsdos-asset-lock.mjs'

const files = [{ name: 'a.js', size: 3, sha256: 'aa' }, { name: 'b.wasm', size: 9, sha256: 'bb' }]
const fp = filesFingerprint(files)
assert.equal(fp, filesFingerprint([...files].reverse()), '与清单顺序无关')
assert.notEqual(fp, filesFingerprint([{ ...files[0], sha256: 'ab' }, files[1]]), '任何一个文件变了指纹就变')

assert.deepEqual(verifyLock(null, '8.5.3-8bitgo.4', fp), { ok: true, action: 'new-version' })
assert.deepEqual(verifyLock({ assetVersion: '8.5.3-8bitgo.4', fingerprint: fp }, '8.5.3-8bitgo.4', fp), { ok: true, action: 'match' })
assert.deepEqual(verifyLock({ assetVersion: '8.5.3-8bitgo.3', fingerprint: 'old' }, '8.5.3-8bitgo.4', fp), { ok: true, action: 'new-version' })
const bad = verifyLock({ assetVersion: '8.5.3-8bitgo.4', fingerprint: 'old' }, '8.5.3-8bitgo.4', fp)
assert.equal(bad.ok, false, '同一版本号、字节不同必须拒绝')
assert.match(bad.reason, /JSDOS_ASSET_VERSION/)

const dir = mkdtempSync(join(tmpdir(), 'jsdos-lock-'))
try {
  const file = join(dir, 'lock.json')
  writeLock('8.5.3-8bitgo.9', fp, file)
  assert.deepEqual({ ...readLock(file), _note: undefined }, { _note: undefined, assetVersion: '8.5.3-8bitgo.9', fingerprint: fp })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// 仓库里的锁与当前版本号一致，且两个脚本都接上了
const paths = readFileSync(new URL('../src/emulator/paths.ts', import.meta.url), 'utf8')
const version = paths.match(/export const JSDOS_ASSET_VERSION = '([^']+)'/)?.[1]
assert.equal(readLock(LOCK_FILE)?.assetVersion, version, 'scripts/jsdos-asset-lock.json 必须与 JSDOS_ASSET_VERSION 同步提交')
assert.match(readFileSync(new URL('./check-jsdos.mjs', import.meta.url), 'utf8'), /verifyLock\(lock, assetVersion/)
assert.match(readFileSync(new URL('./copy-jsdos.mjs', import.meta.url), 'utf8'), /verdict\.action === 'new-version'\) writeLock/)
console.log('✔ js-dos 版本号与产物字节锁：指纹、拒绝同号换字节、新版本自动记锁、接线')
