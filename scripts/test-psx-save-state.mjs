#!/usr/bin/env node
/** 自建核心（Beetle PS1 / melonDS DS）的即时存档胶水回归。见 patch-ejs-state-glue.mjs。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const cores = join(root, 'public/emulatorjs/cores')

// Beetle PS1 两个包被 check-emulatorjs 按 Range 实玩验收过的 sha256 锁定，只带 v2（修内存泄漏）；
// melonDS DS 额外带 v3（失败说明过滤乱码、降为 warn）。PS1 开局已不再调用 getState，乱码不会在开局出现。
const GLUE = { mednafen_psx: 'v2', melondsds: 'v3' }
for (const [name, core] of [['mednafen_psx-wasm.data', 'mednafen_psx'], ['mednafen_psx-legacy-wasm.data', 'mednafen_psx'], ['melondsds-wasm.data', 'melondsds']]) {
  const archive = join(cores, name)
  assert.ok(existsSync(archive), `缺少自建核心：${name}`)
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-psx-state-test-'))
  try {
    execFileSync('7z', ['x', '-bd', '-y', `-o${temp}`, archive], { stdio: 'ignore' })
    const glue = readFileSync(join(temp, `${core}_libretro.js`), 'utf8')
    const start = glue.indexOf('function EmulatorJSGetState(){')
    const end = glue.indexOf('function EmulatorJSGetMemoryData', start)
    assert.ok(start >= 0 && end > start, `${name} 缺少 EmulatorJSGetState`)
    const state = glue.slice(start, end)
    assert.match(
      state,
      /const data=new Uint8Array\(HEAPU8\.subarray\(dataStart,dataStart\+size\)\);_free\(dataStart\);return data/,
      `${name} 必须先复制即时存档，再释放实际分配的状态缓冲`,
    )
    assert.doesNotMatch(state, /_free\(info\)|_free\(data\)/, `${name} 不能释放说明字符串或 Uint8Array 视图`)
    // save_state_info() 的说明在栈上，失败分支读到的是被覆盖的字节：不能把乱码当错误原因抛给玩家
    if (GLUE[core] === 'v3') assert.match(state, /const reason=\/\^\[\\x20-\\x7e\]\{1,120\}\$\/\.test\(state\[0\]\|\|""\)\?state\[0\]:"State is not available yet";console\.warn\(/, `${name} 失败分支必须过滤乱码说明并降为 warn`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

for (const [core, version] of Object.entries(GLUE)) {
  const report = JSON.parse(readFileSync(join(cores, `metadata/${core}.json`), 'utf8'))
  assert.match(report.patch ?? '', new RegExp(`save-state-glue-${version}`), `${core} 核心报告必须标记安全存档胶水代次`)
  assert.equal(report.saveStateGlue, version, `${core} 核心报告必须声明安全存档胶水版本`)
}
const ndsReport = JSON.parse(readFileSync(join(cores, 'reports/melondsds.json'), 'utf8'))
const { createHash } = await import('node:crypto')
assert.equal(ndsReport.sha256, createHash('sha256').update(readFileSync(join(cores, 'melondsds-wasm.data'))).digest('hex'),
  'melonDS DS 报告的 sha256 必须对应实际发布的包（换代常量都按它推导）')

const adapterSource = readFileSync(join(root, 'src/emulator/adapters/emulatorjs.ts'), 'utf8')
assert.match(
  adapterSource,
  /const skipEagerStateProbe = \(options\.platform === 'psx' && core === PSX_CHD_CORE\) \|\| core === 'melondsds'\s*\n\s*\/\*[\s\S]*?\*\/\s*\n\s*if \(!skipEagerStateProbe\) probeSaveState\(\)\s*\n\s*else probeSaveState\(false, true\)/,
  'Beetle PS1 / melonDS DS 的开机流程不应为探测能力而主动调用 getState()（整机快照 + 乱码失败日志），只问 supportsStates()',
)

console.log('✓ PS1 / NDS 自建核心即时存档胶水回归通过')
