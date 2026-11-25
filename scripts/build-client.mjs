import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { withLocalPublicScratchExcluded } from './lib/client-build-scratch.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const viteCli = join(root, 'node_modules/vite/bin/vite.js')

try {
  const code = await withLocalPublicScratchExcluded(root, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteCli, 'build', ...process.argv.slice(2)], {
      cwd: root,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)))
  }))
  process.exitCode = code
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
