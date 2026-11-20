import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] || join(tmpdir(), '8bitgo-pokecatch-save-bridge-firefox-android.zip'))
const work = await mkdtemp(join(tmpdir(), '8bitgo-pokecatch-extension-'))

try {
  for (const filename of ['background.js', 'bridge.js', 'popup.html', 'popup.js']) {
    await cp(join(root, filename), join(work, filename))
  }
  const manifest = await readFile(join(root, 'manifest.firefox-android.json'), 'utf8')
  await writeFile(join(work, 'manifest.json'), manifest)
  execFileSync('zip', ['-q', '-r', output, 'manifest.json', 'background.js', 'bridge.js', 'popup.html', 'popup.js'], { cwd: work })
  console.log(`Firefox Android 的 Mozilla AMO 提交包已生成：${output}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
