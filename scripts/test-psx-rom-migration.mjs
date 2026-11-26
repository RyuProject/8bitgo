import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { downloadLegacyPsxPackForMigration, isLegacyPsxPackKey } = await import(
  fileURLToPath(new URL('../src/admin/psxRomMigration.ts', import.meta.url))
)

assert.equal(isLegacyPsxPackKey('roms/psx/resident-evil-3.en.chd.8bg'), true)
assert.equal(isLegacyPsxPackKey('roms/psx/RESIDENT-EVIL-3.ZH-HANS.CHD.8BG'), true)
assert.equal(isLegacyPsxPackKey('https://assets.example/game.chd.8bg'), false)
assert.equal(isLegacyPsxPackKey('/game.chd.8bg'), false)
assert.equal(isLegacyPsxPackKey('roms/psx/game.iso.8bg'), false)
assert.equal(isLegacyPsxPackKey('roms/psx/game.chd'), false)

const calls = []
const controller = new AbortController()
let receivedSignal
const result = await downloadLegacyPsxPackForMigration('roms/psx/game.chd.8bg', {
  urlForKey: (key) => {
    calls.push(['url', key])
    return `https://assets.example/${key}`
  },
  probe: async (url) => {
    calls.push(['probe', url])
    return { url: `${url}?romv=0123456789abcdef0123456789abcdef`, size: 3 }
  },
  download: async (url, size, onProgress, signal) => {
    calls.push(['download', url, size])
    receivedSignal = signal
    onProgress?.(2, size)
    return new Blob([new Uint8Array([1, 2, 3])])
  },
}, (loaded, total) => calls.push(['progress', loaded, total]), controller.signal)

assert.equal(result.name, 'game.chd.8bg')
assert.equal(result.size, 3)
assert.deepEqual(calls.slice(0, 3), [
  ['url', 'roms/psx/game.chd.8bg'],
  ['probe', 'https://assets.example/roms/psx/game.chd.8bg'],
  ['download', 'https://assets.example/roms/psx/game.chd.8bg?romv=0123456789abcdef0123456789abcdef', 3],
])
assert.deepEqual(calls[3], ['progress', 2, 3])
assert.equal(receivedSignal, controller.signal)

await assert.rejects(
  () => downloadLegacyPsxPackForMigration('https://assets.example/game.chd.8bg', {
    urlForKey: () => 'https://assets.example/game.chd.8bg',
    probe: async () => ({ url: 'https://assets.example/game.chd.8bg?romv=x', size: 3 }),
    download: async () => new Blob([new Uint8Array([1, 2, 3])]),
  }),
  /本地 PS1 CHD 8BG/,
)

await assert.rejects(
  () => downloadLegacyPsxPackForMigration('roms/psx/game.chd.8bg', {
    urlForKey: () => 'https://assets.example/game.chd.8bg',
    probe: async () => ({ url: '', size: 3 }),
    download: async () => new Blob([new Uint8Array([1, 2, 3])]),
  }),
  /强版本或大小/,
)

await assert.rejects(
  () => downloadLegacyPsxPackForMigration('roms/psx/game.chd.8bg', {
    urlForKey: () => 'https://assets.example/game.chd.8bg',
    probe: async () => ({ url: 'https://assets.example/game.chd.8bg?romv=0123456789abcdef0123456789abcdef', size: 4 }),
    download: async () => new Blob([new Uint8Array([1, 2, 3])]),
  }),
  /下载不完整/,
)

await assert.rejects(
  () => downloadLegacyPsxPackForMigration('roms/psx/game.chd.8bg', {
    urlForKey: () => 'https://assets.example/game.chd.8bg',
    probe: async () => ({ url: 'https://assets.example/game.chd.8bg?romv=0123456789abcdef0123456789abcdef', size: 1024 * 1024 * 1024 + 3 * 1024 * 1024 }),
    download: async () => { throw new Error('不能进入超限文件下载') },
  }),
  /强版本或大小/,
)

const gameForm = readFileSync(fileURLToPath(new URL('../src/admin/GameForm.tsx', import.meta.url)), 'utf8')
assert.match(gameForm, /迁移为流式 CHD/)
assert.match(gameForm, /resumeKey: romCacheKey\(url\)/)
assert.match(gameForm, /alternateUrls: alternateRomUrls\(url\)/)
assert.match(gameForm, /signal,\n\s+alternateUrls: alternateRomUrls\(url\)/)
assert.match(gameForm, /psxMigrationAbort\.current\?\.abort\(\)/)
assert.match(gameForm, /inspectRomPackBlob\(file\)/)
assert.match(gameForm, /header\.originalSize > 1024 \* 1024 \* 1024/)
assert.match(gameForm, /原 8BG 对象会保留/)
assert.match(gameForm, /if \(!discImageConfirmed && !\(await confirmDiscImage\(platform, file\)\)\)/)
assert.match(gameForm, /if \(!discImageConfirmed && !\(await confirmDiscImage\(platform, uploadSourceFile\)\)\)/)
const selectionHandler = gameForm.match(/const handleFileSelection = async \([\s\S]*?\n  \}\n/)?.[0]
const migrationHandler = gameForm.match(/const migrateBoundPsxPack = async \(\) => \{[\s\S]*?\n  \}\n/)?.[0]
assert.ok(selectionHandler, '普通文件选择处理器应存在')
assert.ok(migrationHandler, '旧 PS1 8BG 迁移处理器应存在')
assert.match(selectionHandler, /await onFile\(file\)/)
assert.doesNotMatch(selectionHandler, /await onFile\(file, true\)/)
assert.match(migrationHandler, /await trackUploadActivity\(`旧 PS1 CHD 迁移：\$\{sourceKey\}`/)
assert.match(migrationHandler, /await onFile\(file, true\)/)

console.log('✅ PS1 旧 8BG 迁移下载固定版本、校验整包长度，失败不继续上传；后台按钮使用备用线路和跨刷新续传')
