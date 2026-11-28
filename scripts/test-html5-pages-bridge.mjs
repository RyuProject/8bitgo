import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { html5SaveBridgeOrigin, versionHtml5Entry } from '../src/emulator/adapters/html5.ts'

const main = 'https://8bitgo.com/games/pvz'
assert.equal(html5SaveBridgeOrigin('/web/PvZ/cn', main), 'https://8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://pvz.8bitgo.com/web/PvZ/cn/', main), 'https://pvz.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://cn.8bitgo.com/web/PvZ/cn/', main), 'https://cn.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main), 'https://8bitgo-pvz.pages.dev')
assert.equal(html5SaveBridgeOrigin('https://digiverse.8bitgo.com/web/gamblers-table/', main), 'https://digiverse.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://gamblers-table.8bitgo.com/web/gamblers-table/', main), 'https://gamblers-table.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://attacker.8bitgo.com/game/', main), null)
assert.equal(html5SaveBridgeOrigin('https://cn.8bitgo.com/games/pvz', main), null)
assert.equal(html5SaveBridgeOrigin('https://example.com/game/', main), null)
// cn / tv 入口嵌同一个 Pages 游戏页；游戏页那一侧的父页面名单（pvz-page.js、Gamblers 存档桥）必须认它们。
assert.equal(html5SaveBridgeOrigin('https://pvz.8bitgo.com/web/PvZ/cn/', 'https://cn.8bitgo.com/games/pvz'), 'https://pvz.8bitgo.com')
// PokeCatch 是未经本站管理、也未接入 postMessage 存档协议的第三方页面；不可开放云存档桥。
assert.equal(html5SaveBridgeOrigin('https://pokecatch-online.netlify.app/', main), null)

const versioned = new URL(versionHtml5Entry('https://pvz.8bitgo.com/web/PvZ/cn/', main))
const adapterSource = readFileSync(new URL('../src/emulator/adapters/html5.ts', import.meta.url), 'utf8')
const shellVersion = adapterSource.match(/const PVZ_SHELL_VERSION = '([^']+)'/)?.[1]
assert.ok(shellVersion, 'HTML5 适配器必须声明 PvZ shell 发布代次')
assert.equal(versioned.origin, 'https://pvz.8bitgo.com')
assert.equal(versioned.searchParams.get('shell'), shellVersion)
assert.equal(new URL(versionHtml5Entry('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main)).searchParams.get('shell'), shellVersion)
assert.equal(versionHtml5Entry('https://example.com/web/PvZ/cn/', main), 'https://example.com/web/PvZ/cn/')

const migrations = [
  ['/web/PvZ/cn/', 'https://pvz.8bitgo.com/web/PvZ/cn/'],
  ['/web/diablo/', 'https://diablo.8bitgo.com/web/diablo/'],
  ['/web/Minecraft/', 'https://minecraft.8bitgo.com/web/Minecraft/eaglercraft/index.html'],
  ['/web/celeste/', 'https://celeste.8bitgo.com/web/celeste/'],
  ['/web/terraria/', 'https://terraria.8bitgo.com/web/terraria/'],
  ['/web/cs16/', 'https://cs16.8bitgo.com/web/cs16/'],
]
for (const [legacy, expected] of migrations) {
  const migrated = new URL(versionHtml5Entry(`${legacy}?from=database#resume`, main))
  const target = new URL(expected)
  assert.equal(migrated.origin, target.origin)
  assert.equal(migrated.pathname, target.pathname)
  assert.equal(migrated.searchParams.get('from'), 'database')
  assert.equal(migrated.hash, '#resume')
}

const migratedPvz = versionHtml5Entry('/web/PvZ/cn/', main)
assert.equal(html5SaveBridgeOrigin(migratedPvz, main), 'https://pvz.8bitgo.com')
assert.equal(versionHtml5Entry('/web/PvZ2/', main), '/web/PvZ2/')

// 大陆 / TV 入口可能收到数据库保存的主站绝对旧地址；也要迁到带生命周期桥的 Pages 入口。
const absoluteLegacyFromCn = new URL(versionHtml5Entry(
  'https://8bitgo.com/web/PvZ/en?shell=20260923-save2&lang=en#resume',
  'https://cn.8bitgo.com/games/plants-vs-zombies-web',
))
assert.equal(absoluteLegacyFromCn.origin, 'https://pvz.8bitgo.com')
assert.equal(absoluteLegacyFromCn.pathname, '/web/PvZ/en')
assert.equal(absoluteLegacyFromCn.searchParams.get('shell'), shellVersion, '旧绝对入口也要更新到当前 Pages 外壳')
assert.equal(absoluteLegacyFromCn.searchParams.get('lang'), 'en')
assert.equal(absoluteLegacyFromCn.hash, '#resume')
assert.equal(
  versionHtml5Entry('https://not-8bitgo.com/web/PvZ/en/', 'https://cn.8bitgo.com/games/pvz'),
  'https://not-8bitgo.com/web/PvZ/en/',
  '只迁移精确的 8BitGo 第一方域名',
)
assert.equal(
  versionHtml5Entry('http://8bitgo.com/web/PvZ/en/', 'https://cn.8bitgo.com/games/pvz'),
  'http://8bitgo.com/web/PvZ/en/',
  '跨源旧入口必须是 HTTPS',
)

// 拆播放器时先收最后一份自动快照：存档桥监听不能先于 iframe 置空被摘掉，等待有上限。
{
  const adapter = readFileSync(new URL('../src/emulator/adapters/html5.ts', import.meta.url), 'utf8')
  const destroy = adapter.slice(adapter.indexOf('    destroy() {'))
  const blank = destroy.indexOf("iframe.src = 'about:blank'")
  const unhook = destroy.indexOf("window.removeEventListener('message', onSaveBridgeMessage)")
  assert.ok(blank > 0 && unhook > blank, '存档桥监听必须在 iframe 置空之后（收尾宽限结束时）才摘掉')
  assert.ok(destroy.includes("type: 'auto-final-snapshot'"), 'destroy 要先请游戏页交出最后一份自动快照')
  const limit = Number(adapter.match(/const SAVE_BRIDGE_FINAL_SNAPSHOT_MS = ([\d_]+)/)?.[1].replace(/_/g, ''))
  assert.ok(limit > 0 && limit <= 1500, '收尾等待不超过 1.5 秒，游戏页不回应也要拆')
  assert.ok(destroy.includes('window.setTimeout(teardownFrame, SAVE_BRIDGE_FINAL_SNAPSHOT_MS)'), '收尾有超时兜底')
  assert.ok(adapter.includes("event.source !== saveBridgeWindow"), 'iframe 已脱离 DOM 时仍认存档桥 window 发来的 pagehide 快照')
  assert.ok(adapter.includes("account: result.enabled ? cloudSaveAccountTag() : null"), '开局恢复回执带账号摘要，游戏页据此分账号记同步基线')
}

console.log('Pages 跨域运行桥：旧入口迁移、精确来源白名单、PvZ 发布代次与存档收尾检查通过')

// —— 大陆访客的 Pages 游戏改走 EdgeOne 镜像（PvZ 与 CS1.6）——
{
  const { cnMirrorHtml5Entry, CN_MIRROR_FALLBACK_MS } = await import('../src/emulator/adapters/html5.ts')
  const pages = versionHtml5Entry('/web/cs16/?room=AB12CD#x', main)
  assert.equal(new URL(pages).origin, 'https://cs16.8bitgo.com')
  const ctxMain = { cnVisitor: true, onCnSite: false, edgeOrigin: 'https://cn.8bitgo.com', pageOrigin: 'https://8bitgo.com' }
  // 主域（Cloudflare）上的大陆访客：嵌 cn.8bitgo.com 的源站副本，去掉会被 301 的尾斜杠，保留查询串与 hash
  assert.deepEqual(cnMirrorHtml5Entry(pages, ctxMain), { url: 'https://cn.8bitgo.com/web/cs16?room=AB12CD#x', readySelector: '#canvas' })
  // 页面本身已在 EdgeOne 上（cn 子域 / NS 迁移后的主域）：同源嵌入
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, onCnSite: true, pageOrigin: 'https://cn.8bitgo.com' })?.url, 'https://cn.8bitgo.com/web/cs16?room=AB12CD#x')
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, onCnSite: true, pageOrigin: 'https://8bitgo.com' })?.url, 'https://8bitgo.com/web/cs16?room=AB12CD#x')
  // 非大陆访客、AI 修补禁用、本地开发（无加速入口）都留在 Pages
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, cnVisitor: false }), null)
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, disabled: true }), null)
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, edgeOrigin: '' }), null)
  assert.equal(cnMirrorHtml5Entry(pages, { ...ctxMain, onCnSite: true, pageOrigin: 'http://localhost:5173' }), null)
  const pvzPages = versionHtml5Entry('https://pvz.8bitgo.com/web/PvZ/cn/?shell=check', main)
  assert.deepEqual(cnMirrorHtml5Entry(pvzPages, ctxMain), {
    url: `https://cn.8bitgo.com/web/PvZ/cn?shell=${shellVersion}`, readySelector: '#canvas',
  })
  assert.equal(cnMirrorHtml5Entry(pvzPages, { ...ctxMain, onCnSite: true, pageOrigin: 'https://cn.8bitgo.com' })?.url,
    `https://cn.8bitgo.com/web/PvZ/cn?shell=${shellVersion}`)
  assert.equal(cnMirrorHtml5Entry('https://pvz.8bitgo.com/web/PvZ/', ctxMain), null, 'PvZ 根提示頁不是可玩入口，不鏡像')
  assert.equal(cnMirrorHtml5Entry('https://pvz.8bitgo.com/web/PvZ/en/', ctxMain)?.url, 'https://cn.8bitgo.com/web/PvZ/en')
  // 未逐文件核對過的 Pages 游戏不切；第三方入口、相似域名不切
  for (const other of ['https://diablo.8bitgo.com/web/diablo/', 'https://cs16.8bitgo.com.evil.com/web/cs16/', 'https://cs16.8bitgo.com/web/cs16x/']) {
    assert.equal(cnMirrorHtml5Entry(other, ctxMain), null, other)
  }
  assert.ok(CN_MIRROR_FALLBACK_MS >= 10_000 && CN_MIRROR_FALLBACK_MS <= 60_000)
  // 退回逻辑接线：超时 / iframe error / 同源错误页 / 桥报 failed 都换回 Pages，每局只退一次；SDK 识别镜像入口
  assert.match(adapterSource, /fallbackToPages\('iframe 加载错误'\)/)
  assert.match(adapterSource, /fallbackToPages\('大陆入口返回的不是游戏页'\)/)
  assert.match(adapterSource, /if \(cnMirror\) armMirrorTimer\(\)/)
  assert.match(adapterSource, /if \(!mirrorPending \|\| destroyed \|\| !pagesEntry\) return false\n\s+mirrorPending = false/)
  assert.match(adapterSource, /cs16\.8bitgo\.com' \|\| FIRST_PARTY_SITE_HOSTS\.has\(host\)/)
}

// —— 源站 PvZ /web/PvZ/{cn,en} 与 /web/cs16 补上 Pages 构建注入的桥 ——
{
  const { injectWebGameScripts, WEB_GAME_HTML_INJECTIONS, createWebGameHtmlRenderer } = await import('../server/src/web-game-html.js')
  const versions = { bridge: 'b'.repeat(16), media: 'm'.repeat(16), sdk: 's'.repeat(16) }
  const source = readFileSync(new URL('../public/web/cs16/index.html', import.meta.url), 'utf8')
  const out = injectWebGameScripts(source, WEB_GAME_HTML_INJECTIONS.cs16, versions)
  assert.ok(out.includes(`<script src="/html5-api/8bitgo-runtime-bridge.js?v=${versions.bridge}" data-ready-selector="#canvas"></script></body>`))
  assert.ok(out.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${versions.sdk}" data-canvas-selector="#canvas"`))
  const mediaAt = out.indexOf('8bitgo-media-bridge.js')
  const engineAt = out.indexOf('cs16.bundle.js')
  assert.ok(mediaAt > 0 && mediaAt < engineAt, '媒体桥必须排在引擎脚本之前')
  assert.equal(injectWebGameScripts(out, WEB_GAME_HTML_INJECTIONS.cs16, versions), out, '重复注入必须幂等')
  assert.equal(injectWebGameScripts(source, undefined, versions), source)
  // 真实文件：版本号是脚本内容的 sha256 前 16 位，与 Pages 构建一致
  const { createHash } = await import('node:crypto')
  const sha = (rel) => createHash('sha256').update(readFileSync(new URL(`../public/${rel}`, import.meta.url))).digest('hex').slice(0, 16)
  const rendered = createWebGameHtmlRenderer(new URL('../public', import.meta.url).pathname)('cs16')
  assert.ok(rendered?.includes(`8bitgo-runtime-bridge.js?v=${sha('html5-api/8bitgo-runtime-bridge.js')}`))
  assert.ok(rendered?.includes(`8bitgo-game-sdk.min.js?v=${sha('html5-api/8bitgo-game-sdk.min.js')}`))
  const pvzSource = readFileSync(new URL('../public/web/PvZ/cn/index.html', import.meta.url), 'utf8')
  const pvzInjected = injectWebGameScripts(pvzSource, WEB_GAME_HTML_INJECTIONS.pvz, versions)
  assert.ok(pvzInjected.includes(`8bitgo-runtime-bridge.js?v=${versions.bridge}" data-ready-selector="body.game-mode canvas#canvas"`))
  assert.ok(pvzInjected.includes(`8bitgo-game-sdk.min.js?v=${versions.sdk}" data-canvas-selector="body.game-mode canvas#canvas"`))
  assert.ok(pvzInjected.indexOf('8bitgo-media-bridge.js') < pvzInjected.indexOf('pvz-wasm-loader.js'), 'PvZ 媒体桥必须早于 WASM 引擎初始化')
  assert.equal(injectWebGameScripts(pvzInjected, WEB_GAME_HTML_INJECTIONS.pvz, versions), pvzInjected, 'PvZ 重复注入必须幂等')
  const renderer = createWebGameHtmlRenderer(new URL('../public', import.meta.url).pathname)
  const renderedPvz = renderer('PvZ', 'cn')
  assert.ok(renderedPvz?.includes(`8bitgo-runtime-bridge.js?v=${sha('html5-api/8bitgo-runtime-bridge.js')}`))
  assert.ok(renderedPvz?.includes('body.game-mode canvas#canvas'))
  assert.equal(renderer('PvZ'), null, '未登记的 PvZ 根提示页照发原文件')
  assert.equal(renderer('PvZ', 'other'), null, '不允许把未登记语言子目录当成注入入口')
  assert.equal(renderer('not-managed-game'), null, '未登记的游戏照发原文件')
  const serverSource = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
  assert.match(serverSource, /const injected = renderWebGameHtml\(name, sub\)/)
}
console.log('html5 大陆镜像入口：通过')
