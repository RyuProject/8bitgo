import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isValidPlatformBiosKey } from '../server/src/platform-bios-key.js'

const read = (relativePath) => readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
const [panel, platforms] = await Promise.all([
  read('../src/admin/PlatformBiosPanel.tsx'),
  read('../src/data/platforms.ts'),
])

const gbaRow = panel.match(/\{\s*id:\s*'gba',([\s\S]*?)\n\s*\},/)
assert.ok(gbaRow, 'BIOS 管理页必须列出 GBA 平台')
assert.match(gbaRow[1], /IodineGBA/)
assert.match(gbaRow[1], /WebAssembly/)
assert.match(gbaRow[1], /16 KiB/)
assert.match(gbaRow[1], /accept:\s*'\.zip,\.bin,\.bios,\.gba'/)
assert.match(panel, /accept=\{r\.accept \?\? \(r\.id === 'symbian' \? '\.rom' : undefined\)\}/)
assert.match(platforms, /id:\s*'gba'/, 'GBA 平台数据必须仍存在，否则管理行会被过滤')
assert.equal(isValidPlatformBiosKey('gba'), true, '服务端必须接受 GBA 平台级绑定')

console.log('GBA BIOS 管理入口、文件类型和服务端绑定校验通过')
