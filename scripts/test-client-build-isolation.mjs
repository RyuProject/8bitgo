import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withLocalPublicScratchExcluded } from './lib/client-build-scratch.mjs'

const root = mkdtempSync(join(tmpdir(), '8bitgo-client-build-isolation-'))
try {
  mkdirSync(join(root, 'public/__tracked-dir/__nested'), { recursive: true })
  mkdirSync(join(root, 'dist/client/__tracked-dir/__nested'), { recursive: true })
  writeFileSync(join(root, 'public/__tracked.html'), 'tracked')
  writeFileSync(join(root, 'public/__tracked-dir/inside.txt'), 'tracked child')
  writeFileSync(join(root, 'public/__tracked-dir/__nested/keep.txt'), 'tracked nested child')
  writeFileSync(join(root, 'public/__tracked-dir/private-local.zip'), 'private nested ROM')
  writeFileSync(join(root, 'public/__tracked-dir/__nested/private.bin'), 'private deeper file')
  writeFileSync(join(root, 'public/__private.zip'), 'private local fixture')
  symlinkSync('/path/that/does/not/exist.jsdos', join(root, 'public/__dangling.jsdos'))

  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', 'public/__tracked.html', 'public/__tracked-dir/inside.txt', 'public/__tracked-dir/__nested/keep.txt'], { cwd: root })

  writeFileSync(join(root, 'dist/client/__tracked.html'), 'old tracked copy')
  writeFileSync(join(root, 'dist/client/__tracked-dir/inside.txt'), 'old tracked child')
  writeFileSync(join(root, 'dist/client/__tracked-dir/__nested/keep.txt'), 'old tracked nested child')
  writeFileSync(join(root, 'dist/client/__tracked-dir/private-local.zip'), 'stale private nested ROM')
  writeFileSync(join(root, 'dist/client/__tracked-dir/__nested/private.bin'), 'stale private deeper file')
  writeFileSync(join(root, 'dist/client/__private.zip'), 'stale private copy')
  writeFileSync(join(root, 'dist/client/__dangling.jsdos'), 'stale link copy')

  let code = await withLocalPublicScratchExcluded(root, async () => {
    assert.equal(existsSync(join(root, 'public/__tracked.html')), true)
    assert.equal(existsSync(join(root, 'public/__tracked-dir/inside.txt')), true)
    assert.equal(existsSync(join(root, 'public/__tracked-dir/__nested/keep.txt')), true)
    assert.equal(existsSync(join(root, 'public/__tracked-dir/private-local.zip')), false)
    assert.equal(existsSync(join(root, 'public/__tracked-dir/__nested/private.bin')), false)
    assert.equal(existsSync(join(root, 'public/__private.zip')), false)
    assert.equal(existsSync(join(root, 'public/__dangling.jsdos')), false)
    writeFileSync(join(root, 'dist/client/__tracked-dir/private-local.zip'), 'new private nested ROM')
    writeFileSync(join(root, 'dist/client/__tracked-dir/__nested/private.bin'), 'new private deeper file')
    writeFileSync(join(root, 'dist/client/__private.zip'), 'new private copy')
    writeFileSync(join(root, 'dist/client/__dangling.jsdos'), 'new dangling copy')
    return 0
  })

  assert.equal(code, 0)
  assert.equal(readFileSync(join(root, 'public/__private.zip'), 'utf8'), 'private local fixture')
  assert.equal(readFileSync(join(root, 'public/__tracked-dir/private-local.zip'), 'utf8'), 'private nested ROM')
  assert.equal(readFileSync(join(root, 'public/__tracked-dir/__nested/private.bin'), 'utf8'), 'private deeper file')
  assert.equal(lstatSync(join(root, 'public/__dangling.jsdos')).isSymbolicLink(), true)
  assert.equal(readlinkSync(join(root, 'public/__dangling.jsdos')), '/path/that/does/not/exist.jsdos')
  assert.equal(existsSync(join(root, 'dist/client/__private.zip')), false)
  assert.equal(existsSync(join(root, 'dist/client/__dangling.jsdos')), false)
  assert.equal(existsSync(join(root, 'dist/client/__tracked-dir/private-local.zip')), false)
  assert.equal(existsSync(join(root, 'dist/client/__tracked-dir/__nested/private.bin')), false)
  assert.equal(readFileSync(join(root, 'dist/client/__tracked.html'), 'utf8'), 'old tracked copy')
  assert.equal(readFileSync(join(root, 'dist/client/__tracked-dir/inside.txt'), 'utf8'), 'old tracked child')
  assert.equal(readFileSync(join(root, 'dist/client/__tracked-dir/__nested/keep.txt'), 'utf8'), 'old tracked nested child')

  writeFileSync(join(root, 'public/__tracked-dir/failed-build.zip'), 'private file after build failure')
  await assert.rejects(withLocalPublicScratchExcluded(root, async () => {
    assert.equal(existsSync(join(root, 'public/__tracked-dir/failed-build.zip')), false)
    writeFileSync(join(root, 'dist/client/__tracked-dir/failed-build.zip'), 'partial build copy')
    throw new Error('simulated build failure')
  }), /simulated build failure/)
  assert.equal(readFileSync(join(root, 'public/__tracked-dir/failed-build.zip'), 'utf8'), 'private file after build failure')
  assert.equal(existsSync(join(root, 'dist/client/__tracked-dir/failed-build.zip')), false)
  console.log('✔ 客户端构建隔离未跟踪 public/__ 文件、保留源文件与已跟踪资源，并清除旧 dist 副本')
} finally {
  rmSync(root, { recursive: true, force: true })
}
