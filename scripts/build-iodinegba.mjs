import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = path.join(root, 'vendor/iodinegba')
const index = await readFile(path.join(upstreamDir, 'index.html'), 'utf8')
const sources = [...index.matchAll(/<script\s+src="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((src) => src.startsWith('IodineGBA/'))

if (sources.length < 40) throw new Error(`IodineGBA 上游脚本清单异常：${sources.length}`)

const body = await Promise.all(sources.map((src) => readFile(path.join(upstreamDir, src), 'utf8')))
const source = `(function(){\n${body.join('\n;\n')}\nwindow.IodineGBA = GameBoyAdvanceEmulator;\n})();\n`
const { code } = await transform(source, {
  loader: 'js',
  target: 'es2015',
  minify: true,
  legalComments: 'none',
})
const sha256 = createHash('sha256').update(code).digest('hex')
const version = sha256.slice(0, 16)
const publicDir = path.join(root, 'public/iodinegba')
await mkdir(publicDir, { recursive: true })
await writeFile(path.join(publicDir, 'iodinegba.js'), code)
await writeFile(path.join(root, 'src/emulator/iodinegbaVersion.ts'), `export const IODINEGBA_BUILD = '${version}' as const\n/** 完整摘要用于浏览器 SRI；短代次只负责换缓存 URL，不能代替完整性校验。 */\nexport const IODINEGBA_SHA256 = '${sha256}' as const\n`)
console.info(`IodineGBA ${version}: ${sources.length} upstream scripts → public/iodinegba/iodinegba.js`)
