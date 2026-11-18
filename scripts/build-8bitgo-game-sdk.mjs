import { transformSync } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(repo, 'public/html5-api/8bitgo-game-sdk.js')
const outputPath = resolve(repo, 'public/html5-api/8bitgo-game-sdk.min.js')

export function buildGameSdk() {
  const source = readFileSync(sourcePath, 'utf8')
  const { code } = transformSync(source, {
    minify: true,
    target: 'es2017',
    legalComments: 'none',
  })
  const output = `${code.trim()}\n`
  writeFileSync(outputPath, output)
  return outputPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildGameSdk()
  console.log('已生成压缩版 8BitGo 游戏 SDK')
}
