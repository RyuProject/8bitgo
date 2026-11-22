#!/usr/bin/env node
/**
 * EmulatorJS 引擎报错归因（src/emulator/ejsEngineErrors.ts）：
 *   - 核心下载失败要分清「包体已在流后失速」（线路通、慢，留在原线路续传）与 HTTP 错误 / 没拿到响应（退回同源）；
 *     2026-11-19～20 大陆五份 fbneo-legacy-wasm.data 现场：以前一律标线路坏，重试退回 Cloudflare 必然再失败；
 *   - 本地化的引擎报错（「启动游戏失败」）与英文原句归同一类；
 *   - 播放器把「已出画面后再崩」标成运行中崩溃，不与启动失败混在一组（2026-11-21《黄金太阳》）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { coreDownloadFailureCause, normalizeEngineText } from '../src/emulator/ejsEngineErrors.ts'

const CORE = '[log] [EJS Core] Downloading core: fbneo-legacy-wasm.data'

// 包体失速 → XHR 兜底也失速：保留线路
{
  const cause = coreDownloadFailureCause([
    '[log] [EJS Core] Downloading core: old-wasm.data',
    '[error] Download failed in onComplete: Download failed: Error: HTTP 502',
    CORE,
    '[warn] [EJS Download] 20 秒没有新数据，中止：fbneo-legacy-wasm.data',
    '[warn] [EJS Download] response stream read failed AbortError: signal is aborted without reason',
    '[warn] [EJS Download] 改用 XHR arraybuffer 重新下载：fbneo-legacy-wasm.data',
    '[error] Download failed in onComplete: Download failed: Error: XHR fallback stalled after AbortError: signal is aborted without reason',
  ])
  assert.equal(cause.bodyStalled, true)
  assert.equal(cause.httpError, false, '上一次核心下载留下的 HTTP 502 不能串进本次判断')
  assert.match(cause.detail, /^Error: XHR fallback stalled after AbortError/)
  assert.ok(cause.detail.length <= 160)
}

// XHR 兜底网络错误（读流时被我们自己的失速中止触发）：仍算包体在流过
{
  const cause = coreDownloadFailureCause([
    CORE,
    '[error] Download failed in onComplete: Download failed: Error: XHR fallback network error after AbortError: The user aborted a request.',
  ])
  assert.equal(cause.bodyStalled, true)
}

// HTTP 错误：线路本身有问题，退回同源
{
  const cause = coreDownloadFailureCause([CORE, '[error] Download failed in onComplete: Download failed: Error: HTTP 504'])
  assert.deepEqual(cause, { detail: 'Error: HTTP 504', bodyStalled: false, httpError: true })
}

// 失速后 XHR 拿到截断 / 错误页：按响应异常处理，不保留线路
{
  const cause = coreDownloadFailureCause([
    CORE,
    '[warn] [EJS Download] 20 秒没有新数据，中止：fbneo-legacy-wasm.data',
    '[error] Download failed in onComplete: Download failed: Error: XHR fallback incomplete response: HTTP 200, received 121000 bytes, expected at least 2000000 / 8000000 (text/html)',
  ])
  assert.equal(cause.httpError, true)
  assert.equal(cause.bodyStalled, false)
}

// 连响应头都没等到（30 秒头超时）/ fetch TypeError：不是包体失速
for (const reason of ['AbortError: signal is aborted without reason', 'TypeError: Failed to fetch']) {
  const cause = coreDownloadFailureCause([CORE, `[error] Download failed in onComplete: Download failed: ${reason}`])
  assert.equal(cause.bodyStalled, false, reason)
  assert.equal(cause.httpError, false, reason)
}

// 没有任何上下文时不崩
assert.deepEqual(coreDownloadFailureCause([]), { detail: '', bodyStalled: false, httpError: false })
console.log('✓ 核心下载失败分清包体失速 / HTTP 错误 / 没拿到响应')

// 本地化报错归一
assert.equal(normalizeEngineText('启动游戏失败'), 'Failed to start game')
assert.equal(normalizeEngineText('ゲームの開始に失敗しました'), 'Failed to start game')
assert.equal(normalizeEngineText('显卡驱动已过时'), 'Outdated graphics driver')
assert.equal(normalizeEngineText('[FBNeo] Romset is unknown'), '[FBNeo] Romset is unknown')
console.log('✓ 本地化引擎报错按英文原句分类')

// 接线：适配器用这两个函数，核心下载失败按包体失速决定 keepEdge
const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
assert.match(adapter, /const low = normalizeEngineText\(line\)\.toLowerCase\(\)/, 'engineErrorScope 先归一本地化文本')
assert.match(
  adapter,
  /error downloading core\\s\*\\\(\/i\.test\(line\)\) \{\s*const cause = coreDownloadFailureCause\(errorTap\?\.lines \?\? \[\]\)[\s\S]{0,700}failLoad\(fmt\(rt\.ejsEngineError, \{ msg \}\), 'runtime', \{ keepEdge: cause\.bodyStalled \}\)/,
  '核心下载失败：runtime（不换 ROM），包体失速时保留加速线路',
)
// NotReadableError 的核心响应仍由前面那条 config 分支先接走
assert.ok(
  adapter.indexOf("nativeBlobReadError && /error downloading core") < adapter.indexOf('const cause = coreDownloadFailureCause('),
  'NotReadableError 分支必须排在通用核心下载失败之前',
)
const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /reportStartupFailure\(ready \? `运行中崩溃（已出画面）：\$\{reason\}` : reason\)/)
console.log('✓ 适配器 / 播放器接线')
