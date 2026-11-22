import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] || join(tmpdir(), '8bitgo-pokecatch-save-bridge-safari.zip'))
const work = await mkdtemp(join(tmpdir(), '8bitgo-pokecatch-safari-'))
const files = [
  'background.safari.js',
  'bridge.js',
  'game-main.safari.js',
  'game-bridge.safari.js',
  'popup.html',
  'popup.js',
]

try {
  for (const filename of files) await cp(join(root, filename), join(work, filename))
  const manifest = await readFile(join(root, 'manifest.safari.json'), 'utf8')
  await writeFile(join(work, 'manifest.json'), manifest)
  execFileSync('zip', ['-q', '-r', output, 'manifest.json', ...files], { cwd: work })
  console.log(`Safari Web Extension Packager 可用的扩展 ZIP 已生成：${output}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
