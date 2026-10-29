/** NDS 多语言存档与大 ROM 下载边界：防止切 ROM 串档、异常响应耗尽内存。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ndsVariantSaveSlug, parseNdsVariantSaveSlug } from '../src/emulator/romLanguage.ts'
import { MAX_NDS_ROM_BYTES } from '../src/lib/romValidation.ts'

const langs = ['zh-Hans', 'en']
assert.equal(ndsVariantSaveSlug('pokemon-white-2', 'zh-Hans', langs), 'pokemon-white-2', '第一语言保留历史存档键')
assert.equal(ndsVariantSaveSlug('pokemon-white-2', 'en', langs), 'pokemon-white-2~nds-en', '第二语言必须另存档')
assert.equal(ndsVariantSaveSlug('pokemon-white-2', 'en', ['en']), 'pokemon-white-2', '单语言游戏不能无故搬迁历史存档')
assert.equal(ndsVariantSaveSlug('local:demo.nds', 'en', langs), 'local:demo.nds', '本地文件不按站内语言槽重写')
assert.deepEqual(parseNdsVariantSaveSlug('pokemon-white-2~nds-en:melonds-compat'), {
  gameSlug: 'pokemon-white-2', romLang: 'en',
}, '兼容核心的第二语言存档必须回到原游戏')
assert.deepEqual(parseNdsVariantSaveSlug('pokemon-white-2:melonds-compat'), {
  gameSlug: 'pokemon-white-2',
}, '兼容核心的第一语言存档不能链接到不存在的 slug')
assert.deepEqual(parseNdsVariantSaveSlug('local:demo~nds-en:melonds-compat'), {
  gameSlug: 'local:demo~nds-en:melonds-compat',
}, '玩家自己命名的文件不能被误拆')
assert.deepEqual(parseNdsVariantSaveSlug('pokemon-white-2~nds-xx'), {
  gameSlug: 'pokemon-white-2~nds-xx',
}, '未知语言标记不能被猜成站内变体')

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
const profile = readFileSync(new URL('../src/components/profile/CloudSaves.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const archive = readFileSync(new URL('../src/emulator/remoteArchive.ts', import.meta.url), 'utf8')
assert.match(player, /targetPlatform === 'nds'[\s\S]{0,140}ndsVariantSaveSlug\(gameSlugRef\.current, romLangRef\.current, romLangsRef\.current \?\? \[\]\)/)
assert.match(profile, /if \(s\.runtime === 'emulatorjs'\) \{\s*const nds = parseNdsVariantSaveSlug\(parsePsxChdSaveSlug\(s\.gameSlug\)\)\s*return nds\.romLang \? nds : parseEmulatorVariantSaveSlug\(nds\.gameSlug\)/)
assert.match(adapter, /maxBytes: options\.platform === 'nds' \? MAX_NDS_ROM_BYTES \+ 32 \* 1024 \* 1024 : undefined/)
assert.match(adapter, /maxBytes: options\.platform === 'nds' \? MAX_NDS_ROM_BYTES \+ 64 \* 1024 \* 1024 : undefined/)
assert.match(adapter, /const \{ header \} = await inspectRomPackBlob\(stored\)[\s\S]{0,140}header\.originalSize > options\.maxUnpackedBytes/, '8BG 声称巨大解包量时必须在解密前拒绝')
assert.match(adapter, /maxUnpackedBytes: options\.platform === 'nds' \? MAX_NDS_ROM_BYTES \+ 32 \* 1024 \* 1024 : undefined/)
assert.match(adapter, /stored\.size > options\.maxBytes/, '历史缓存不能绕过本版网络下载上限')
assert.match(adapter, /const prepared = await prepare\(cached\)[\s\S]{0,170}onProgress\?\.\(\{ phase: 'rom',[\s\S]{0,100}cached: true/, '坏缓存不能先把进度报成 100%')
assert.match(adapter, /loadRemoteArchiveRom\(remoteGameUrl,[\s\S]{0,130}prepareAbort\.signal, validateNds\)/, '外站 ZIP 的 NDS 也必须在缓存命中时验 ROM')
assert.match(archive, /await validate\?\.\(cached\)[\s\S]{0,180}onProgress\?\.\(\{ phase: 'rom'/, '外站 ZIP 坏缓存不能先报 100%')
assert.match(archive, /await romCacheDelete\(cacheKey\)/, '外站 ZIP 坏缓存必须删除后回源')
assert.match(archive, /await validate\?\.\(blob\)[\s\S]{0,180}romCachePutBlob/, '网络新包必须验完再写缓存')
assert.equal(MAX_NDS_ROM_BYTES, 512 * 1024 * 1024)

console.log('NDS 多语言存档隔离、兼容核心链接与下载边界回归通过')
