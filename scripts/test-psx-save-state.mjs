#!/usr/bin/env node
/** PS1 自建核心的即时存档胶水回归。见 patch-psx-save-state.mjs。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const cores = join(root, 'public/emulatorjs/cores')

for (const name of ['mednafen_psx-wasm.data', 'mednafen_psx-legacy-wasm.data']) {
  const archive = join(cores, name)
  assert.ok(existsSync(archive), `缺少 PS1 软件核心：${name}`)
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-psx-state-test-'))
  try {
    execFileSync('7z', ['x', '-bd', '-y', `-o${temp}`, archive], { stdio: 'ignore' })
    const glue = readFileSync(join(temp, 'mednafen_psx_libretro.js'), 'utf8')
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
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const report = JSON.parse(readFileSync(join(cores, 'metadata/mednafen_psx.json'), 'utf8'))
assert.match(report.patch ?? '', /save-state-glue-v2/, 'PS1 核心报告必须标记安全存档胶水代次')
assert.equal(report.saveStateGlue, 'v2', 'PS1 核心报告必须声明安全存档胶水版本')
console.log('✓ PS1 即时存档胶水回归通过')
