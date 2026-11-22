import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUILTIN_WEB_GAMES, builtinWebGameFor } from '../shared/builtin-web-games.js'

const page = readFileSync(new URL('../src/pages/GameDetailPage.tsx', import.meta.url), 'utf8')
const roms = readFileSync(new URL('../src/services/roms.ts', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/AppRoutes.tsx', import.meta.url), 'utf8')

assert.equal(builtinWebGameFor('pokecatch')?.entry, 'https://pokecatch-online.netlify.app/#')
assert.equal(builtinWebGameFor('pokecatch')?.externalLaunchUrl, 'https://pokecatch-online.netlify.app/#')
for (const [slug, game] of Object.entries(BUILTIN_WEB_GAMES)) {
  if (slug !== 'pokecatch') assert.equal(game.externalLaunchUrl, undefined, `${slug} must keep its existing launch path`)
}
assert.match(page, /const externalLaunchUrl = game\?\.platform === 'html5'\s*\? builtinWebGameFor\(game\.slug\)\?\.externalLaunchUrl\s*: undefined/)
assert.match(page, /\) : externalLaunchUrl \? \([\s\S]*?href=\{externalLaunchUrl\}[\s\S]*?\) : usesIsolatedLaunchCard \? \(/)
assert.match(page, /if \(game && !usesIsolatedLaunchCard && !externalLaunchUrl\) preloadPlayer\(\)/)
assert.match(page, /<EmulatorPlayer/)
assert.match(roms, /if \(game\.platform === 'html5' && builtinWebGameFor\(game\.slug\)\?\.externalLaunchUrl\) return false/)
assert.match(roms, /if \(game\.platform === 'html5' && builtinWebGameFor\(game\.slug\)\?\.externalLaunchUrl\) \{[\s\S]*?setState\(\{ status: 'idle', url: '' \}\)/)
assert.match(routes, /<Route path="\/pokecatch-save-sync" element=\{<PokecatchSaveSyncPage \/>\} \/>/)
for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'zh-Hans', 'zh-Hant']) {
  const locale = readFileSync(new URL(`../src/locales/${lang}.ts`, import.meta.url), 'utf8')
  assert.match(locale, /^ {4}externalGameHint:/m, `${lang} missing external game hint`)
}
console.log('Pokecatch external launch isolation: 4 groups passed')
