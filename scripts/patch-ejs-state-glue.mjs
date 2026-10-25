#!/usr/bin/env node
/**
 * 修补自建核心 melonDS DS（`melondsds`）的 EmulatorJS 即时存档胶水（Beetle PS1 同病，见下）。
 *
 * 两个核心都链接了 EmulatorJS RetroArch 1eb5edf，它的 `save_state_info()`（tasks/task_save.c）
 * 把说明写进**栈上的局部数组** `char state_data[300]` 再返回其地址，而胶水 EmulatorJSGetState
 * 又拿这个地址去 `_free(info)`，同时 `_free(data)`（data 是 Uint8Array 视图，实际等于 free(0)），
 * 真正 malloc 出来的序列化缓冲从不释放：
 *
 *   - 释放栈地址会破坏分配器；
 *   - 每存一次就漏一整份快照（melonDS DS 实测 19,744,168 字节），自动存档、开局探测都会
 *     不断吃掉 wasm 堆，直到内存不足；
 *   - 失败分支（核心尚未就绪、内容没加载）的说明在 JS 读到时已被覆盖，控制台出现
 *     「Failed to save state! 댟」这种乱码，并用 console.error 报成红色错误。
 *
 * 本脚本只替换胶水 JS（wasm 原样保留）：
 *   v2：先复制状态、只释放真正 malloc 的 dataStart，不再 free 说明字符串；
 *   v3：失败说明不是可打印 ASCII 时改成固定文字，并降为 console.warn。
 *
 * Beetle PS1 的两个包已由 patch-psx-save-state.mjs 打过 v2，且被 check-emulatorjs 按
 * Range 实玩验收过的 sha256 锁定，这里**不再改它**；PS1 开局也已不调用 getState。
 * 要给 PS1 上 v3，必须先重做浏览器实玩验收，再同步 check-emulatorjs 的锁定值。
 *
 * melonDS DS 的包字节变了，还要同步：核心报告 sha256、NDS_MODERN_CORE_BUILD、
 * EJS_CACHE_GENERATION、EJS_RUNTIME_GENERATION（与 build-melondsds-core.mjs 的换代规则一致），
 * 最后运行 `npm run ejsmeta` 同步 metadata。需要本机有 7z / 7zz。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const cores = join(root, 'public/emulatorjs/cores')
const GLUE_VERSION = 'v3'

const TARGETS = [{ archive: 'melondsds-wasm.data', core: 'melondsds' }]

export const OLD_FREE =
  'const data=HEAPU8.subarray(dataStart,dataStart+size);_free(info);_free(data);return new Uint8Array(data)'
export const FIXED_FREE =
  'const data=new Uint8Array(HEAPU8.subarray(dataStart,dataStart+size));_free(dataStart);return data'
export const OLD_FAIL =
  'if(state[2]!=="1"){console.error("Failed to save state!",state[0]);throw new Error(state[0])}'
export const FIXED_FAIL = String.raw`if(state[2]!=="1"){const reason=/^[\x20-\x7e]{1,120}$/.test(state[0]||"")?state[0]:"State is not available yet";console.warn("Failed to save state!",reason);throw new Error(reason)}`

const sevenZip = existsSync('/opt/homebrew/bin/7zz') || existsSync('/usr/local/bin/7zz') ? '7zz' : '7z'

function run(args, cwd) {
  execFileSync(sevenZip, args, { cwd, stdio: 'inherit' })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 返回 null 表示已是最新胶水、未改包 */
function patchArchive({ archive: name, core }) {
  const archive = join(cores, name)
  if (!existsSync(archive)) throw new Error(`缺少核心包：${archive}`)
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-state-glue-'))
  try {
    run(['x', '-bd', '-y', `-o${temp}`, archive], temp)
    const glueName = `${core}_libretro.js`
    const gluePath = join(temp, glueName)
    let glue = readFileSync(gluePath, 'utf8')
    const start = glue.indexOf('function EmulatorJSGetState(){')
    const end = glue.indexOf('function EmulatorJSGetMemoryData', start)
    if (start < 0 || end < 0) throw new Error(`${name} 找不到 EmulatorJSGetState 胶水`)
    let state = glue.slice(start, end)
    const before = state
    if (!state.includes(FIXED_FREE)) {
      if (state.split(OLD_FREE).length !== 2) throw new Error(`${name} 的存档释放胶水形态变了，拒绝盲改`)
      state = state.replace(OLD_FREE, FIXED_FREE)
    }
    if (!state.includes(FIXED_FAIL)) {
      if (state.split(OLD_FAIL).length !== 2) throw new Error(`${name} 的存档失败分支形态变了，拒绝盲改`)
      state = state.replace(OLD_FAIL, FIXED_FAIL)
    }
    if (state === before) {
      console.log(`[skip] ${name} 已是 ${GLUE_VERSION} 胶水`)
      return null
    }
    glue = glue.slice(0, start) + state + glue.slice(end)
    writeFileSync(gluePath, glue)
    const members = ['build.json', 'core.json', 'license.txt', glueName, `${core}_libretro.wasm`]
    for (const member of members) {
      if (!existsSync(join(temp, member))) throw new Error(`${name} 打包前缺少 ${member}`)
    }
    const output = join(temp, name)
    run(['a', '-bd', '-t7z', '-mx=9', output, ...members], temp)
    copyFileSync(output, `${archive}.next`)
    renameSync(`${archive}.next`, archive)
    const hash = sha256(archive)
    console.log(`[done] ${name} ${hash}`)
    return hash
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function updateReport(core, extra = {}) {
  const reportPath = join(cores, `reports/${core}.json`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  report.saveStateGlue = GLUE_VERSION
  report.patch = String(report.patch ?? '')
    .split(';').map((part) => part.trim()).filter((part) => part && !/^emulatorjs-save-state-glue-v\d+$/.test(part))
    .concat(`emulatorjs-save-state-glue-${GLUE_VERSION}`)
    .join('; ')
  Object.assign(report, extra)
  writeFileSync(reportPath, report.core === 'melondsds' ? `${JSON.stringify(report, null, 2)}\n` : `${JSON.stringify(report)}\n`)
}

function replaceConst(file, re, next, label) {
  const path = join(root, file)
  const source = readFileSync(path, 'utf8')
  const current = source.match(re)
  if (!current) throw new Error(`${file} 里找不到 ${label}`)
  const value = typeof next === 'function' ? next(current[1]) : next
  if (value === current[1]) return
  writeFileSync(path, source.replace(re, (m) => m.replace(current[1], value)))
  console.log(`[cache] ${label} ${current[1]} -> ${value}`)
}

/** 换代规则与 build-melondsds-core.mjs 一致：带上新 SHA 前缀，并把胶水代次写进尾缀 */
function bumpGenerations(melondsSha) {
  const glueTag = (value) => value.replace(/[-.]psxstate\d+|[-.]stateglue\d+/g, '')
  replaceConst('src/emulator/paths.ts', /export const EJS_RUNTIME_GENERATION = '([^']*)'/, (current) => {
    const base = melondsSha ? current.replace(/-melondsds-[a-f0-9]{8}/, `-melondsds-${melondsSha.slice(0, 8)}`) : current
    return `${glueTag(base)}-stateglue3`
  }, 'EJS_RUNTIME_GENERATION')
  replaceConst('src/emulator/adapters/emulatorjs.ts', /const EJS_CACHE_GENERATION = '([^']*)'/, (current) => {
    const base = melondsSha ? current.replace(/\.melondsds-core-[a-f0-9]{8}/, `.melondsds-core-${melondsSha.slice(0, 8)}`) : current
    return `${glueTag(base)}.stateglue3`
  }, 'EJS_CACHE_GENERATION')
  if (melondsSha) {
    replaceConst('src/emulator/ndsCorePreference.ts', /export const NDS_MODERN_CORE_BUILD = '([^']*)'/, melondsSha.slice(0, 16), 'NDS_MODERN_CORE_BUILD')
  }
}

const results = new Map(TARGETS.map((target) => [target.archive, patchArchive(target)]))
let changed = false
const melondsSha = results.get('melondsds-wasm.data')
if (melondsSha) {
  updateReport('melondsds', { sha256: melondsSha })
  changed = true
}
if (changed) {
  bumpGenerations(melondsSha ?? null)
  execFileSync('node', [join(root, 'scripts/sync-emulatorjs-core-metadata.mjs')], { stdio: 'inherit' })
}
console.log(changed ? '核心胶水已更新：记得一起提交 .data、reports/metadata 与换代常量' : '无需修改')
