import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WEB_GAME_PAGES } from '../deploy/cloudflare-pages/web-games-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outputRoot = resolve(repo, '.cloudflare-pages')
const names = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const selected = names.length ? names : Object.keys(WEB_GAME_PAGES)

const walk = (root) => {
  const files = []
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name)
      if (item.isDirectory()) visit(path)
      else if (item.isFile()) files.push(path)
    }
  }
  visit(root)
  return files
}

for (const name of selected) {
  const config = WEB_GAME_PAGES[name]
  assert.ok(config, `未知 Pages 游戏：${name}`)
  const root = resolve(outputRoot, name)
  assert.ok(existsSync(root), `${name} 尚未构建`)
  assert.ok(existsSync(resolve(root, config.entry.replace(/^\//, ''), 'index.html')) ||
    existsSync(resolve(root, config.entry.replace(/^\//, '').replace(/\/$/, '/index.html'))), `${name} 入口缺失`)
  assert.ok(existsSync(resolve(root, '_worker.js')), `${name} 缺少 _worker.js`)
  assert.ok(!existsSync(resolve(root, 'web', config.sourceDir, '_framework')), `${name} 错把超大 _framework 打进 Pages`)

  const files = walk(root)
  assert.ok(files.length <= 20_000, `${name} 文件数超过 Pages 免费版上限`)
  for (const file of files) {
    assert.ok(statSync(file).size <= 25 * 1024 * 1024, `${name}/${relative(root, file)} 超过 25 MiB`)
  }

  for (const [file] of config.html) {
    const html = readFileSync(resolve(root, 'web', config.sourceDir, file), 'utf8')
    assert.match(html, /\/html5-api\/8bitgo-runtime-bridge\.js/, `${name}/${file} 没有 Pages 运行桥`)
    if (name === 'pvz') {
      assert.match(html, /h==='8bitgo-pvz\.pages\.dev'/, `${name}/${file} 没有放行自己的固定 Pages 域名`)
    }
  }

  const workerUrl = `${pathToFileURL(resolve(root, '_worker.js')).href}?check=${Date.now()}`
  const worker = (await import(workerUrl)).default
  const originalFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), init })
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', ETag: '"test"' },
    })
  }
  try {
    const assets = {
      fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }),
    }
    const redirect = await worker.fetch(new Request(`https://${config.domain}/`), { ASSETS: assets })
    assert.equal(redirect.status, 302)
    assert.equal(new URL(redirect.headers.get('location')).pathname, config.entry)

    const staticResponse = await worker.fetch(new Request(`https://${config.domain}${config.entry}`), { ASSETS: assets })
    assert.equal(staticResponse.headers.get('x-content-type-options'), 'nosniff')
    if (config.isolated) {
      assert.equal(staticResponse.headers.get('cross-origin-opener-policy'), 'same-origin')
      assert.equal(staticResponse.headers.get('cross-origin-embedder-policy'), 'require-corp')
    }

    if (config.runtime === 'diablo') {
      const response = await worker.fetch(new Request(`https://${config.domain}/web/diablo/static/media/Diablo.1234abcd.wasm`, {
        headers: { 'Accept-Encoding': 'br' },
      }), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-encoding'), 'br')
      assert.match(fetched.at(-1).url, /web\/diablo\/runtime\/Diablo\.1234abcd\.wasm\.br$/)
    }
    if (config.runtime === 'celeste' || config.runtime === 'terraria') {
      const response = await worker.fetch(new Request(`https://${config.domain}/web/${config.runtime}/_framework/dotnet.js`), { ASSETS: assets })
      assert.equal(response.status, 200)
      assert.match(fetched.at(-1).url, new RegExp(`web/${config.runtime}/_framework/dotnet\\.js$`))
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  console.log(`${name}: Pages 包与 Worker 检查通过`)
}
