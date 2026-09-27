import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_GAME_PAGES, webGamePage } from '../deploy/cloudflare-pages/web-games-config.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2]
const config = webGamePage(name)
if (!config) {
  console.error(`用法：npm run pages:web-game:deploy -- <${Object.keys(WEB_GAME_PAGES).join('|')}>`)
  process.exit(2)
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}

run(process.execPath, ['scripts/build-web-game-pages.mjs', name])
run(process.execPath, ['scripts/check-web-game-pages.mjs', name])
const output = resolve(repo, '.cloudflare-pages', name)
if (!existsSync(output)) throw new Error(`构建目录不存在：${output}`)
run(resolve(repo, 'node_modules/.bin/wrangler'), [
  'pages', 'deploy', output,
  '--project-name', config.project,
  '--branch', 'main',
  '--commit-dirty=true',
])
