import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withLocalPublicScratchExcluded } from './lib/client-build-scratch.mjs'

const root = mkdtempSync(join(tmpdir(), '8bitgo-client-build-isolation-'))
try {
  mkdirSync(join(root, 'public/__tracked-dir'), { recursive: true })
  mkdirSync(join(root, 'dist/client'), { recursive: true })
  writeFileSync(join(root, 'public/__tracked.html'), 'tracked')
  writeFileSync(join(root, 'public/__tracked-dir/inside.txt'), 'tracked child')
  writeFileSync(join(root, 'public/__private.zip'), 'private local fixture')
  symlinkSync('/path/that/does/not/exist.jsdos', join(root, 'public/__dangling.jsdos'))

  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', 'public/__tracked.html', 'public/__tracked-dir/inside.txt'], { cwd: root })

  writeFileSync(join(root, 'dist/client/__tracked.html'), 'old tracked copy')
  writeFileSync(join(root, 'dist/client/__private.zip'), 'stale private copy')
  writeFileSync(join(root, 'dist/client/__dangling.jsdos'), 'stale link copy')

  let code = await withLocalPublicScratchExcluded(root, async () => {
    assert.equal(existsSync(join(root, 'public/__tracked.html')), true)
    assert.equal(existsSync(join(root, 'public/__tracked-dir/inside.txt')), true)
    assert.equal(existsSync(join(root, 'public/__private.zip')), false)
    assert.equal(existsSync(join(root, 'public/__dangling.jsdos')), false)
    writeFileSync(join(root, 'dist/client/__private.zip'), 'new private copy')
    writeFileSync(join(root, 'dist/client/__dangling.jsdos'), 'new dangling copy')
    return 0
  })

  assert.equal(code, 0)
  assert.equal(readFileSync(join(root, 'public/__private.zip'), 'utf8'), 'private local fixture')
  assert.equal(lstatSync(join(root, 'public/__dangling.jsdos')).isSymbolicLink(), true)
  assert.equal(readlinkSync(join(root, 'public/__dangling.jsdos')), '/path/that/does/not/exist.jsdos')
  assert.equal(existsSync(join(root, 'dist/client/__private.zip')), false)
  assert.equal(existsSync(join(root, 'dist/client/__dangling.jsdos')), false)
  assert.equal(readFileSync(join(root, 'dist/client/__tracked.html'), 'utf8'), 'old tracked copy')
  console.log('✔ 客户端构建隔离未跟踪 public/__ 文件、保留源文件与已跟踪资源，并清除旧 dist 副本')
} finally {
  rmSync(root, { recursive: true, force: true })
}
