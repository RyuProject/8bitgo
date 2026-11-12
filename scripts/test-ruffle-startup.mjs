/**
 * Flash 冷启动的并行链与诊断（2026-11-11 大陆四局 Flash 慢启动）。
 *
 *   1. Ruffle 核心（core JS + wasm）必须在挂载时就和 SWF 并行进 HTTP 缓存：Ruffle 自己只在
 *      load() 里取核心，而 load() 要等 SWF 下完，不预热就是串行。
 *   2. 8BG 的 Zstd 解码器 wasm 必须在下载开始时就取，不能等 ROM 下完、解包时才 init()。
 *   3. 适配器必须把启动阶段写进诊断包，并登记 iframe 的 performance：ruffle.js / 核心都在
 *      iframe 里下，外层看不到。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRomPackUrl } from '../src/emulator/romLoader.ts'
import { warmRuffleCore } from '../src/emulator/prewarm.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

console.log('── 8BG 地址识别 ──')
assert.equal(isRomPackUrl('https://cn-assets.8bitgo.com/roms/flash/fireboy.zh-Hans.swf.8bg?romv=abc'), true)
assert.equal(isRomPackUrl('/roms/flash/a.SWF.8BG#x'), true)
assert.equal(isRomPackUrl('https://assets.8bitgo.com/roms/flash/a.swf?next=b.8bg'), false, '查询串里的 .8bg 不算')
assert.equal(isRomPackUrl('https://assets.8bitgo.com/roms/flash/a.swf'), false)

console.log('── Zstd 解码器与 ROM 并行取 ──')
const loader = read('src/emulator/romLoader.ts')
const warmAt = loader.indexOf('if (isRomPackUrl(game)) prewarmRomPackDecoder(game)')
assert.ok(warmAt > 0, 'loadGameBytes 见到 .8bg 地址必须先预热解码器')
assert.ok(warmAt < loader.indexOf('await (await fetchBlobWithProgress(game'), '解码器预热必须在 ROM 下载之前发起')
const romPack = read('src/services/romPack.ts')
assert.match(romPack, /export function prewarmRomPackDecoder\(url\?: string\)/)
assert.match(romPack, /if \(zstdReady === pending\) zstdReady = null/, 'init 失败不能把解码器永久钉在 rejected')

console.log('── Ruffle 核心预热（真实 fetch 路径）──')
const realFetch = globalThis.fetch
const requests = []
const body = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); c.close() } })
globalThis.fetch = async (url) => {
  requests.push(String(url))
  if (String(url).endsWith('bootstrap.json')) {
    return new Response(JSON.stringify({
      version: 'x',
      bootstrap: { modern: ['core.ruffle.a.js', 'aaa.wasm'], fallback: ['core.ruffle.b.js', 'bbb.wasm'] },
    }), { status: 200 })
  }
  return new Response(body(), { status: 200 })
}
try {
  const base = 'https://cn.example.test/_cn/ruffle/v9/'
  const warm = await warmRuffleCore(base)
  assert.ok(warm.wasm === 'aaa.wasm' || warm.wasm === 'bbb.wasm', '必须选出一套核心')
  await warm.done
  const variantJs = warm.wasm === 'aaa.wasm' ? 'core.ruffle.a.js' : 'core.ruffle.b.js'
  assert.deepEqual(new Set(requests), new Set([`${base}bootstrap.json`, `${base}${variantJs}`, `${base}${warm.wasm}`]),
    '只预热一套核心，不能把两份 wasm 都拉下来')
  const before = requests.length
  assert.equal(await warmRuffleCore(base), warm, '同一条线路一页只预热一次')
  assert.equal(requests.length, before)

  // 清单取不到：不抛错、不卡住，并允许下次再试
  globalThis.fetch = async () => new Response('nope', { status: 404 })
  const failed = await warmRuffleCore('https://other.test/ruffle/')
  assert.equal(failed.wasm, null)
  await failed.done
  let retried = 0
  globalThis.fetch = async () => { retried++; return new Response('nope', { status: 404 }) }
  await warmRuffleCore('https://other.test/ruffle/')
  assert.equal(retried, 1, '失败的预热不能被缓存成永远不再尝试')
} finally {
  globalThis.fetch = realFetch
}

console.log('── 适配器：挂载即预热、阶段进诊断包 ──')
const adapter = read('src/emulator/adapters/ruffle.ts')
const mountAt = adapter.indexOf('export function mount(')
const warmCall = adapter.indexOf('void warmRuffleCore(ruffleRoot)')
assert.ok(warmCall > mountAt, '挂载时必须预热 Ruffle 核心')
assert.ok(warmCall < adapter.indexOf("script.src = `${ruffleRoot}ruffle.js`"), '核心预热不能等到 ruffle.js 之后')
assert.ok(warmCall < adapter.indexOf('const gameBytes = loadGameBytes('), '核心预热要和 SWF 下载同时开始')
assert.match(adapter, /stopFramePerf = watchFramePerformance\(win\)/, 'iframe 里的核心下载必须进诊断包')
assert.match(adapter, /registerDiagnosticSnapshot\(/, '打包时要给出卡在哪一步')
for (const stage of ['播放壳就绪', '取 ruffle.js', 'ruffle.js 已加载', '等 SWF 与存档会话', 'Ruffle load()', '等元数据', '可以玩了']) {
  assert.ok(adapter.includes(`markStage('${stage}'`), `缺少启动阶段「${stage}」`)
}
const destroyAt = adapter.indexOf('    destroy() {')
assert.ok(adapter.indexOf('stopFramePerf?.()', destroyAt) < adapter.indexOf('iframe.remove()', destroyAt),
  '销毁时必须先拍下 iframe 的网络记录再移除 iframe')
assert.ok(adapter.indexOf('stopSnapshot()', destroyAt) > destroyAt, '销毁时必须注销现场快照')

console.log('✅ Flash 冷启动：核心与解码器并行预热、启动阶段诊断通过')
