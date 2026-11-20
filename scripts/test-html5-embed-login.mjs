// 第三方 HTML5 游戏「账号登录只能在顶层页面完成」的提示（src/emulator/html5EmbedLogin.ts）。不联网。
//
// 背景：2026-11-20 玩家在 /games/pokecatch 点游戏里的「用 Google 登录」看到 Google 的 403 页。
// 游戏把自己所在的框跳到 accounts.google.com，Google 对 Sec-Fetch-Dest: iframe 一律回 403；
// 本站能做的只有在详情页提前告诉玩家去新标签页登录。这里守三件事：
// 只认登记过的 https 主机（不能把提示挂到别的外链或本站页面上）、详情页真的渲染了它、八种语言都有文案。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { html5EmbedLoginFor } = await import('../src/emulator/html5EmbedLogin.ts')

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── 命中 ──
const hit = html5EmbedLoginFor('https://pokecatch-online.netlify.app/')
assert.deepEqual(hit && { url: hit.url, providers: [...hit.providers] }, {
  url: 'https://pokecatch-online.netlify.app/',
  providers: ['Google', 'Discord'],
})
ok('Pokecatch 的入口命中，带 Google / Discord')

assert.equal(html5EmbedLoginFor('https://POKECATCH-online.netlify.app./play?lang=zh')?.url, 'https://pokecatch-online.netlify.app./play?lang=zh')
ok('主机名大小写、末尾点、路径和查询串不影响命中，打开的仍是原入口')

// ── 不命中 ──
for (const entry of [
  undefined,
  null,
  '',
  'not a url',
  '/web/PvZ',
  'web/diablo',
  'http://pokecatch-online.netlify.app/', // 只认 https：明文入口本来就进不了 https 页面的框
  'https://pokecatch-online.pages.dev/', // 游戏的 CDN，不是框里加载的入口
  'https://netlify.app/',
  'https://evil-pokecatch-online.netlify.app/',
  'https://pokecatch-online.netlify.app.example.com/',
  'https://example.com/?u=https://pokecatch-online.netlify.app/',
]) {
  assert.equal(html5EmbedLoginFor(entry), null, `不该命中：${entry}`)
}
ok('本站页面、明文 http、相似主机名、查询串里夹带的地址都不命中')

// ── 详情页接线 ──
const page = readFileSync(new URL('../src/pages/GameDetailPage.tsx', import.meta.url), 'utf8')
assert.match(page, /import \{ html5EmbedLoginFor \} from '@\/emulator\/html5EmbedLogin'/)
assert.match(page, /platform\.id !== 'html5'\s*\?\s*null/, '只给 HTML5 平台算这条提示')
assert.match(page, /Object\.values\(game\.roms \?\? \{\}\)/, 'SSR / 水合首帧要从 game.roms 读入口，提示随首屏出来')
const block = page.slice(page.indexOf('{embedLogin && ('), page.indexOf('{embedLogin && (') + 900)
assert.ok(block.length > 100, '详情页要渲染 embedLogin 提示')
assert.match(block, /t\.game\.embedLoginNotice/)
assert.match(block, /t\.game\.embedLoginOpen/)
assert.match(block, /href=\{embedLogin\.url\}/)
assert.match(block, /target="_blank"/)
assert.match(block, /rel="noopener"/, '新标签页不能拿到本站窗口的 opener')
assert.match(block, /window\.confirm\(t\.game\.embedLoginOpenConfirm\)/, '打开前必须确认存档不会由本站复制或合并')
assert.match(block, /event\.preventDefault\(\)/, '取消确认后不能打开新标签页')
assert.match(block, /t\.game\.embedLoginSaveWarning/, '链接旁必须提示存档可能隔离')
ok('详情页提示登录限制、存档隔离，并在新标签页打开前确认')

// ── 八种语言 ──
for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'fr', 'de', 'it', 'ja']) {
  const src = readFileSync(new URL(`../src/locales/${lang}.ts`, import.meta.url), 'utf8')
  const notice = src.match(/^ {4}embedLoginNotice: (['"])(.+)\1,$/m)
  const open = src.match(/^ {4}embedLoginOpen: (['"])(.+)\1,$/m)
  const saveWarning = src.match(/^ {4}embedLoginSaveWarning: (['"])(.+)\1,$/m)
  const openConfirm = src.match(/^ {4}embedLoginOpenConfirm: (['"])(.+)\1,$/m)
  assert.ok(notice, `${lang} 缺 embedLoginNotice`)
  assert.ok(open, `${lang} 缺 embedLoginOpen`)
  assert.ok(saveWarning, `${lang} 缺 embedLoginSaveWarning`)
  assert.ok(openConfirm, `${lang} 缺 embedLoginOpenConfirm`)
  assert.match(notice[2], /\{providers\}/, `${lang} 的提示要带 {providers}`)
  assert.match(notice[2], /403/, `${lang} 的提示要提到玩家实际看到的 403，方便对上号`)
  assert.match(saveWarning[2], /8BitGo|8bitgo/i, `${lang} 要说明本站不会代为复制存档`)
}
ok('八种语言都有登录提示、存档隔离提醒和打开确认文案')

console.log(`\nhtml5 embed login: ${passed} 项通过`)
