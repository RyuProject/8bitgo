import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeCoreContentManifest } from '../gen-ejs-core-versions.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const sourcePath = join(root, 'scripts', 'lib', 'ejs-core-resume-runtime.js')
const contentManifestMarker = 'const CORE_CONTENT_MANIFEST = Object.freeze({})'

/** Render the exact runtime helper embedded in EmulatorJS with current, version-bound core sizes. */
export function renderEjsCoreResumeHelper() {
  const source = readFileSync(sourcePath, 'utf8').trim()
  if (!source.includes(contentManifestMarker)) throw new Error('核心续传助手缺少内容长度清单标记')
  return source.replace(
    contentManifestMarker,
    `const CORE_CONTENT_MANIFEST = Object.freeze(${JSON.stringify(computeCoreContentManifest())})`,
  )
}
