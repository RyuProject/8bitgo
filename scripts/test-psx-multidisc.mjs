import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildPsxM3u, isPsxM3uUrl, parsePsxM3u, PSX_M3U_MAX_DISCS } from '../src/emulator/psxM3u.ts'
import { canStreamPsxM3u, preparePsxRangePlaylist, PSX_RANGE_BYTES } from '../src/emulator/psxRangeDisc.ts'
import { psxCoreForTransfer, PSX_CHD_COMPAT_CORE } from '../src/emulator/psxChd.ts'

const entries = [
  { filename: 'Disc 1 - Final Fantasy VII.chd', label: 'Disc 1' },
  { filename: 'Disc 2 - Final Fantasy VII.chd', label: 'Disc 2' },
]
const m3u = buildPsxM3u(entries)
assert.equal(m3u, `${entries[0].filename}\n${entries[1].filename}\n`, '核心清单只写原始相对文件路径，不写非标准 pipe 标签')
assert.deepEqual(parsePsxM3u(m3u).map(item => item.filename), entries.map(item => item.filename))
assert.equal(isPsxM3uUrl('https://assets.example/set/discs.m3u?romv=0123456789abcdef0123456789abcdef'), true)
assert.equal(canStreamPsxM3u('psx', 'https://assets.example/set/discs.m3u?romv=0123456789abcdef0123456789abcdef'), true)
assert.equal(canStreamPsxM3u('psp', 'https://assets.example/set/discs.m3u?romv=0123456789abcdef0123456789abcdef'), false)
assert.equal(psxCoreForTransfer('psx', 'mednafen_psx', 'https://assets.example/set/discs.m3u?romv=x'), PSX_CHD_COMPAT_CORE)
assert.throws(() => parsePsxM3u('../secret.chd\ndisc-2.chd'), /同目录 CHD/)
assert.throws(() => parsePsxM3u('disc-1.chd\ndisc-1.CHD'), /重复引用/)
assert.throws(() => buildPsxM3u(Array.from({ length: PSX_M3U_MAX_DISCS + 1 }, (_, i) => ({ filename: `disc-${i}.chd`, label: '' }))), /2–8/)

const encoder = new TextEncoder()
const manifestUrl = 'https://assets.example/roms/psx/game.set-123/discs.m3u?romv=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const manifestTag = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const discTags = [
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccccccccc',
]
const manifestBody = encoder.encode(m3u)
const discBytes = [0x31, 0x42].map((fill, index) => {
  const bytes = new Uint8Array(PSX_RANGE_BYTES * 2).fill(fill)
  bytes.set(encoder.encode('MComprHD'), 0)
  bytes.set([0, 0, 0, 124, 0, 0, 0, 5], 8)
  bytes.set(encoder.encode(index ? 'cdfl' : 'cdzl'), 16)
  return bytes
})
const calls = []
const fetcher = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (url.pathname.endsWith('.m3u')) {
    assert.equal(method, 'GET')
    return new Response(manifestBody, { status: 200, headers: { ETag: `"${manifestTag}"`, 'Content-Length': String(manifestBody.length), 'Content-Type': 'audio/x-mpegurl' } })
  }
  const discIndex = url.pathname.includes('Disc%202') || url.pathname.includes('Disc 2') ? 1 : 0
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ETag: `"${discTags[discIndex]}"`, 'Content-Length': String(discBytes[discIndex].length) } })
  }
  const range = new Headers(init.headers).get('Range')
  const match = /^bytes=(\d+)-(\d+)$/.exec(range || '')
  assert.ok(match, 'CHD 只应使用 HTTP Range 请求')
  const start = Number(match[1])
  const end = Number(match[2])
  calls.push({ discIndex, start, end })
  const bytes = discBytes[discIndex].slice(start, end + 1)
  return new Response(bytes, {
    status: 206,
    headers: {
      ETag: `"${discTags[discIndex]}"`,
      'Content-Length': String(bytes.length),
      'Content-Range': `bytes ${start}-${end}/${discBytes[discIndex].length}`,
    },
  })
}

const media = await preparePsxRangePlaylist(manifestUrl, new AbortController().signal, fetcher)
assert.equal(media.multiDisc, true)
assert.equal(media.name, 'discs.m3u')
assert.equal(media.heads.length, 2)
assert.equal(media.size, 8 * 1024 * 1024)
assert.ok(media.startupBytes < media.size, '开局只读清单和每张盘的必要首块，不把整套盘报成已下载')
assert.ok(calls.some(call => call.discIndex === 0 && call.start === PSX_RANGE_BYTES), '第一张盘预热尾块')
assert.ok(!calls.some(call => call.discIndex === 1 && call.start > 0), '非当前盘只探首块，切盘后按需读取')

const nodes = new Map()
const fs = {
  writeFile(path, bytes) {
    const node = { usedBytes: bytes.length, stream_ops: { read: () => 0 } }
    nodes.set(path, { bytes: new Uint8Array(bytes), node })
  },
  lookupPath(path) {
    const item = nodes.get(path)
    if (!item) throw new Error(`missing ${path}`)
    return { node: item.node }
  },
}
media.install(fs, class {})
assert.equal(new TextDecoder().decode(nodes.get('/discs.m3u').bytes), m3u)
assert.equal(nodes.get(`/${entries[0].filename}`).node.usedBytes, 4 * 1024 * 1024)
assert.equal(nodes.get(`/${entries[1].filename}`).node.usedBytes, 4 * 1024 * 1024)
for (const [index, entry] of entries.entries()) {
  const out = new Uint8Array(120)
  const count = nodes.get(`/${entry.filename}`).node.stream_ops.read({}, out, 0, out.length, 0)
  assert.equal(count, out.length)
  assert.equal(out[100], index ? 0x42 : 0x31, '两张盘各自读回自己的 Range 缓存')
}
media.dispose()

const runtimeSource = readFileSync(fileURLToPath(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url)), 'utf8')
const adminSource = readFileSync(fileURLToPath(new URL('../src/admin/GameForm.tsx', import.meta.url)), 'utf8')
const ejsRuntime = readFileSync(fileURLToPath(new URL('../public/emulatorjs/emulator.min.js', import.meta.url)), 'utf8')
const pcsxWasm = execFileSync('7z', ['x', '-so', fileURLToPath(new URL('../public/emulatorjs/cores/pcsx_rearmed-wasm.data', import.meta.url)), 'pcsx_rearmed_libretro.wasm'], { maxBuffer: 64 * 1024 * 1024 })
assert.match(runtimeSource, /preparePsxRangePlaylist\(/, '播放器接入 M3U Range 预备')
assert.match(runtimeSource, /preparedPsxRange\?\.multiDisc\s*\?\s*PSX_CHD_COMPAT_CORE/, '多盘组固定选 codec 完整的 PCSX 核心')
assert.match(runtimeSource, /streaming:\s*true/, 'Range 进度标记为流式而非整盘已下载')
assert.match(adminSource, /upload 双盘 \/ 多盘组|上传双盘 \/ 多盘组/, '后台提供多盘上传入口')
assert.ok(ejsRuntime.includes('getDiskCount()>1') && ejsRuntime.includes('"m3u"===this.fileName.split'), 'EmulatorJS 包含 M3U 盘片切换菜单')
assert.ok(pcsxWasm.includes(Buffer.from('.m3u')) && pcsxWasm.includes(Buffer.from('SET_DISK_CONTROL_EXT_INTERFACE')), '发布的 PCSX wasm 支持 M3U 与 libretro 扩展盘片控制接口')

console.log('✅ PS1 多盘清单校验、逐盘强版本 Range、内存预算和后台入口回归通过')
