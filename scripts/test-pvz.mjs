/*
  PvZ 浏览器回归：用很小的假资源替代商业素材，只验证本站外壳的加载、缓存降级、存档和退出逻辑。
*/
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const root = resolve('public')
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (pathname === '/pvz-host.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><iframe id="game" src="/web/PvZ/cn"></iframe><script>
        window.__bridgeMessages = [];
        window.addEventListener('message', (event) => window.__bridgeMessages.push(event.data));
        window.__bridgeSend = (type, requestId, data) => {
          const payload = { source: '8bitgo-save-bridge', version: 1, type, requestId, data };
          document.getElementById('game').contentWindow.postMessage(payload, location.origin, data ? [data] : []);
        };
      </script>`)
      return
    }
    if (pathname === '/web/PvZ/cn' || pathname === '/web/PvZ/cn/') pathname = '/web/PvZ/cn/index.html'
    if (pathname === '/web/PvZ/en' || pathname === '/web/PvZ/en/') pathname = '/web/PvZ/en/index.html'
    const file = resolve(root, '.' + pathname)
    if (!file.startsWith(root)) throw new Error('bad path')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const origin = `http://127.0.0.1:${server.address().port}`

const engineStub = (syncFailure = false) => `
window.__writes = [];
window.__callMainCount = 0;
(function () {
  var dirs = new Set(['/']);
  var files = Object.create(null);
  Module.FS = {
    filesystems: { IDBFS: {} },
    mkdir: function (path) { if (dirs.has(path)) throw new Error('EEXIST'); dirs.add(path); },
    stat: function (path) { if (dirs.has(path)) return { mode: 16384 }; if (files[path]) return { mode: 32768 }; throw new Error('ENOENT'); },
    isDir: function (mode) { return mode === 16384; },
    mount: function () {},
    syncfs: function (populate, cb) { setTimeout(function () { cb(${syncFailure ? "new Error('mock IDB failure')" : 'null'}); }, 0); },
    writeFile: function (path, bytes) { files[path] = new Uint8Array(bytes); window.__writes.push([path, bytes.byteLength]); },
    readFile: function (path) { return files[path] || new Uint8Array(); },
    readdir: function (path) {
      var prefix = path === '/' ? '/' : path + '/';
      var names = new Set(['.', '..']);
      for (var item of [...dirs, ...Object.keys(files)]) {
        if (!item.startsWith(prefix) || item === path) continue;
        var rest = item.slice(prefix.length);
        if (rest) names.add(rest.split('/')[0]);
      }
      return [...names];
    },
    unlink: function (path) { delete files[path]; },
    rmdir: function (path) { dirs.delete(path); }
  };
  Module.callMain = function () { window.__callMainCount++; };
  setTimeout(function () { Module.onRuntimeInitialized(); }, 0);
})();
`

const mockReanimFiles = Array.from({ length: 2000 }, (_, i) => ({ path: `reanim/test-${i}.reanim`, size: 1 }))
const mockHeader = Buffer.from(JSON.stringify({
  format: '8bitgo.pvz.gzip-pack.v1',
  fileCount: mockReanimFiles.length,
  unpackedBytes: mockReanimFiles.length,
  files: mockReanimFiles,
}))
const mockHeaderLength = Buffer.alloc(4)
mockHeaderLength.writeUInt32LE(mockHeader.length)
const mockBundle = gzipSync(Buffer.concat([
  Buffer.from('8BPVZ1\n'),
  mockHeaderLength,
  mockHeader,
  Buffer.alloc(mockReanimFiles.length, 7),
]), { level: 9 })
const digest = (body) => createHash('sha256').update(body).digest('hex')
const manifest = {
  format: '8bitgo.pvz.manifest.v2',
  files: [
    { r2: 'main.pak', fs: 'main.pak', size: 4, sha256: digest(Buffer.from([1, 2, 3, 4])) },
    { r2: 'properties/default.xml', fs: 'properties/default.xml', size: 4, sha256: digest(Buffer.from([1, 2, 3, 4])) },
  ],
  bundles: [{
    r2: 'packs/mock.pvzpack.gz',
    fs: '@bundle/reanim',
    format: '8bitgo.pvz.gzip-pack.v1',
    size: mockBundle.byteLength,
    sha256: digest(mockBundle),
    fileCount: mockReanimFiles.length,
    unpackedBytes: mockReanimFiles.length,
  }],
}

async function makePage(browser, options = {}) {
  const context = await browser.newContext(options.mobile ? {
    viewport: { width: 844, height: 390 },
    screen: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  } : {})
  if (options.idbOpenThrows) {
    await context.addInitScript(() => {
      indexedDB.open = function () { throw new Error('mock quota/private mode'); }
    })
  }
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // 清单 URL 带发布代次，测试拦截也要覆盖查询串，避免把缓存失效策略误判成启动故障。
  await page.route('**/web/PvZ/cn/pvz-manifest.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(manifest),
  }))
  await page.route('**/web/PvZ/pvz-portable.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: engineStub(options.syncFailure),
  }))
  await page.route('**/web/PvZ/pvz-portable.wasm', (route) => route.fulfill({
    status: 200,
    contentType: 'application/wasm',
    body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  }))
  await page.route('https://html5.8bitgo.com/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (options.missingReanim && path.includes('/packs/')) {
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'missing' })
    }
    if (path.includes('/packs/')) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/gzip', 'content-length': String(mockBundle.byteLength), 'access-control-allow-origin': '*' },
        body: mockBundle,
      })
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4', 'access-control-allow-origin': '*' },
      body: Buffer.from([1, 2, 3, 4]),
    })
  })
  return { context, page, pageErrors }
}

const browser = await chromium.launch({ headless: true })
try {
  {
    const { context, page, pageErrors } = await makePage(browser)
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.classList.contains('game-mode'))
    assert.equal(await page.evaluate(() => window.__callMainCount), 1)
    const writes = await page.evaluate(() => window.__writes.map((item) => item[0]))
    assert.equal(writes.length, 2002)
    assert.ok(writes.includes('/main.pak'))
    assert.ok(writes.includes('/properties/default.xml'))
    assert.ok(writes.includes('/reanim/test-1999.reanim'))
    assert.equal(await page.evaluate(() => normalizeSaveImportPath('../escape.dat')), '')
    assert.equal(await page.evaluate(() => normalizeResourcePath('wrapper/main.pak')), 'main.pak')
    assert.equal(await page.locator('#save-export-btn').textContent(), '💾 导出存档')
    assert.equal(await page.locator('#save-import-btn').textContent(), '📂 读取存档')
    const fileChooser = page.waitForEvent('filechooser')
    await page.locator('#save-import-btn').click()
    await fileChooser
    assert.deepEqual(pageErrors, [])
    await context.close()
  }

  {
    const { context, page, pageErrors } = await makePage(browser, { mobile: true })
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.classList.contains('game-mode'))
    assert.equal(await page.locator('#pvz-keyboard-btn').isHidden(), true, '游戏未请求文字输入时不应遮挡触控')

    await page.evaluate(() => { Module.wasmSoftKeyboardState = { active: true } })
    await page.locator('#pvz-keyboard-btn').waitFor({ state: 'visible' })
    await page.locator('#pvz-keyboard-btn').click()
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'pvz-soft-keyboard',
      '移动端键盘按钮没有在可信点击中聚焦原生输入框',
    )

    await page.evaluate(() => document.getElementById('pvz-soft-keyboard').blur())
    await page.locator('#canvas').tap({ position: { x: 400, y: 190 } })
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'pvz-soft-keyboard',
      'WASM 请求文字输入后，再点画布没有重新唤起原生输入框',
    )

    await page.evaluate(() => { Module.wasmSoftKeyboardState.active = false })
    await page.locator('#pvz-keyboard-btn').waitFor({ state: 'hidden' })
    assert.deepEqual(pageErrors, [])
    await context.close()
  }

  {
    const { context, page, pageErrors } = await makePage(browser)
    await page.goto(origin + '/pvz-host.html', { waitUntil: 'domcontentloaded' })
    const frame = await (await page.waitForSelector('#game')).contentFrame()
    assert.ok(frame, 'PvZ iframe 没有加载')
    await frame.waitForFunction(() => document.body.classList.contains('game-mode'))
    await page.waitForFunction(() => window.__bridgeMessages.some((item) => item?.type === 'ready'))
    await frame.evaluate(() => {
      ensureDirectory('/saves/userdata')
      Module.FS.writeFile('/saves/userdata/player.dat', new Uint8Array([8, 16, 32]))
    })

    await frame.locator('#save-export-btn').click()
    await page.waitForFunction(() => window.__bridgeMessages.some((item) => item?.type === 'request-save'))
    assert.equal(await frame.locator('#save-export-btn').textContent(), '💾 保存存档')
    await frame.locator('#save-import-btn').click()
    await page.waitForFunction(() => window.__bridgeMessages.some((item) => item?.type === 'request-load'))
    assert.equal(await frame.locator('#save-import-btn').textContent(), '📂 读取存档')

    await page.evaluate(() => window.__bridgeSend('export', 41))
    await page.waitForFunction(() => window.__bridgeMessages.some((item) => item?.type === 'response' && item.requestId === 41))
    const zipMagic = await page.evaluate(() => {
      const response = window.__bridgeMessages.find((item) => item?.type === 'response' && item.requestId === 41)
      return Array.from(new Uint8Array(response.data).subarray(0, 4))
    })
    assert.deepEqual(zipMagic, [80, 75, 3, 4], '存档桥导出的不是 ZIP')

    await frame.evaluate(() => {
      Module.FS.unlink('/saves/userdata/player.dat')
      Module.FS.writeFile('/saves/userdata/stale.dat', new Uint8Array([99]))
    })
    await page.evaluate(() => {
      const response = window.__bridgeMessages.find((item) => item?.type === 'response' && item.requestId === 41)
      window.__bridgeSend('import', 42, response.data.slice(0))
    })
    await page.waitForFunction(() => window.__bridgeMessages.some((item) => item?.type === 'response' && item.requestId === 42 && item.ok))
    assert.deepEqual(
      await frame.evaluate(() => Array.from(Module.FS.readFile('/saves/userdata/player.dat'))),
      [8, 16, 32],
      '存档桥导入后没有恢复 userdata',
    )
    assert.equal(
      await frame.evaluate(() => Module.FS.readdir('/saves/userdata').includes('stale.dat')),
      false,
      '读取完整快照后仍残留旧存档文件',
    )
    assert.deepEqual(pageErrors, [])
    await context.close()
  }

  {
    const { context, page, pageErrors } = await makePage(browser, { idbOpenThrows: true })
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.classList.contains('game-mode'))
    assert.equal(await page.evaluate(() => window.__callMainCount), 1, 'IndexedDB 缓存失败不应阻止本局启动')
    assert.deepEqual(pageErrors, [])
    await context.close()
  }

  {
    const { context, page } = await makePage(browser, { missingReanim: true })
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.getElementById('loading-drop-zone').textContent.includes('必需资源'))
    assert.equal(await page.evaluate(() => window.__callMainCount), 0)
    assert.match(await page.locator('#loading-drop-zone').textContent(), /@bundle\/reanim/)
    await context.close()
  }

  {
    const { context, page } = await makePage(browser, { syncFailure: true })
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.getElementById('loading-drop-zone').textContent.includes('mock IDB failure'))
    assert.equal(await page.evaluate(() => window.__callMainCount), 0, '首次存档读取失败时必须阻止启动，避免覆盖旧存档')
    await context.close()
  }

  {
    const { context, page } = await makePage(browser)
    await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.classList.contains('game-mode'))
    await page.evaluate(() => {
      window.__pvzStartTs = Date.now() - 9000
      window.__pvzGuardedReload = () => false
      window.onGameExit()
    })
    await page.waitForFunction(() => document.getElementById('loading-drop-zone').textContent.includes('已停止自动刷新'))
    assert.equal(new URL(page.url()).pathname, '/web/PvZ/cn')
    await context.close()
  }

  console.log('PvZ 浏览器回归通过：正常启动、移动端软键盘、缓存降级、必需资源、8BitGo 存档桥、刷新守卫均正常')
} finally {
  await browser.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
