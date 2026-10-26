#!/usr/bin/env node
/**
 * 修补自建核心 melonDS DS（`melondsds`）与当前版 MAME（`mame-current`）的 EmulatorJS 即时存档胶水
 * （Beetle PS1 同病，见下）。
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
 * mame-current（2026-10-26，《铁拳》）：同一个 RetroArch，胶水是**未压缩排版**的 Emscripten 输出
 *（带空格换行），整句匹配不上，所以用空白不敏感的正则替换成同样的修正语句。线上实测开局探测
 * 打出「Failed to save state! invalid core option save-save-interval. This is not an error.\n\nt an error.」
 * —— 正是栈上说明被覆盖后的残片。
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
/*
  --archives-only [--cores-dir <dir>]：只改核心包、不碰报告和换代常量。
  给「本机 7z 压不动 242MB 的 MAME wasm、换到大机器上重打包」用：那边改完包拷回来，
  再在仓库里不带参数跑一次 —— 包已是新胶水会跳过，但报告还没标 v3，照样补报告 + 换代。
*/
const argv = process.argv.slice(2)
const archivesOnly = argv.includes('--archives-only')
const coresDirArg = argv.indexOf('--cores-dir')
const cores = coresDirArg >= 0 ? argv[coresDirArg + 1] : join(root, 'public/emulatorjs/cores')
const GLUE_VERSION = 'v3'

const TARGETS = [
  { archive: 'melondsds-wasm.data', core: 'melondsds' },
  { archive: 'mame-current-wasm.data', core: 'mame-current' },
  { archive: 'mame-current-legacy-wasm.data', core: 'mame-current' },
]

export const OLD_FREE =
  'const data=HEAPU8.subarray(dataStart,dataStart+size);_free(info);_free(data);return new Uint8Array(data)'
export const FIXED_FREE =
  'const data=new Uint8Array(HEAPU8.subarray(dataStart,dataStart+size));_free(dataStart);return data'
export const OLD_FAIL =
  'if(state[2]!=="1"){console.error("Failed to save state!",state[0]);throw new Error(state[0])}'
export const FIXED_FAIL = String.raw`if(state[2]!=="1"){const reason=/^[\x20-\x7e]{1,120}$/.test(state[0]||"")?state[0]:"State is not available yet";console.warn("Failed to save state!",reason);throw new Error(reason)}`
/** 未压缩排版的同一段（mame-current）：空白不敏感，替换成上面同样的修正语句 */
const OLD_FREE_PRETTY = /const data = HEAPU8\.subarray\(dataStart, dataStart \+ size\);\s*_free\(info\);\s*_free\(data\);\s*return new Uint8Array\(data\);/
const OLD_FAIL_PRETTY = /if \(state\[2\] !== "1"\) \{\s*console\.error\("Failed to save state!", state\[0\]\);\s*throw new Error\(state\[0\]\);\s*\}/

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
  if (!existsSync(archive)) {
    if (archivesOnly) return null
    throw new Error(`缺少核心包：${archive}`)
  }
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-state-glue-'))
  try {
    run(['x', '-bd', '-y', `-o${temp}`, archive], temp)
    const glueName = `${core}_libretro.js`
    const gluePath = join(temp, glueName)
    let glue = readFileSync(gluePath, 'utf8')
    const start = glue.indexOf('function EmulatorJSGetState(){')
    const pretty = start < 0
    const begin = pretty ? glue.indexOf('function EmulatorJSGetState() {') : start
    const end = glue.indexOf('function EmulatorJSGetMemoryData', begin)
    if (begin < 0 || end < 0) throw new Error(`${name} 找不到 EmulatorJSGetState 胶水`)
    let state = glue.slice(begin, end)
    const before = state
    const swap = (fixed, old, oldPretty, what) => {
      if (state.includes(fixed)) return
      const hits = pretty ? (state.match(new RegExp(oldPretty.source, 'g')) ?? []).length : state.split(old).length - 1
      if (hits !== 1) throw new Error(`${name} 的存档${what}胶水形态变了，拒绝盲改`)
      // 替换串用函数给出，避免 FIXED_FAIL 里的 $ 被当成替换模式
      state = state.replace(pretty ? oldPretty : old, () => (pretty ? `${fixed};` : fixed))
    }
    swap(FIXED_FREE, OLD_FREE, OLD_FREE_PRETTY, '释放')
    swap(FIXED_FAIL, OLD_FAIL, OLD_FAIL_PRETTY, '失败分支')
    if (state === before) {
      console.log(`[skip] ${name} 已是 ${GLUE_VERSION} 胶水`)
      return null
    }
    glue = glue.slice(0, begin) + state + glue.slice(end)
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
function bumpGenerations(melondsSha, mameChanged) {
  const glueTag = (value) => value.replace(/[-.]psxstate\d+|[-.]stateglue\d+|[-.]mameglue\d+/g, '')
  const mameTag = (sep) => (mameChanged ? `${sep}mameglue3` : '')
  replaceConst('src/emulator/paths.ts', /export const EJS_RUNTIME_GENERATION = '([^']*)'/, (current) => {
    const base = melondsSha ? current.replace(/-melondsds-[a-f0-9]{8}/, `-melondsds-${melondsSha.slice(0, 8)}`) : current
    return `${glueTag(base)}-stateglue3${mameTag('-')}`
  }, 'EJS_RUNTIME_GENERATION')
  replaceConst('src/emulator/adapters/emulatorjs.ts', /const EJS_CACHE_GENERATION = '([^']*)'/, (current) => {
    const base = melondsSha ? current.replace(/\.melondsds-core-[a-f0-9]{8}/, `.melondsds-core-${melondsSha.slice(0, 8)}`) : current
    return `${glueTag(base)}.stateglue3${mameTag('.')}`
  }, 'EJS_CACHE_GENERATION')
  if (melondsSha) {
    replaceConst('src/emulator/ndsCorePreference.ts', /export const NDS_MODERN_CORE_BUILD = '([^']*)'/, melondsSha.slice(0, 16), 'NDS_MODERN_CORE_BUILD')
  }
}

const results = new Map(TARGETS.map((target) => [target.archive, patchArchive(target)]))
if (archivesOnly) {
  console.log('只改了核心包；回到仓库里不带参数再跑一次，补报告与换代常量')
  process.exit(0)
}
const report = (core) => JSON.parse(readFileSync(join(cores, `reports/${core}.json`), 'utf8'))
let changed = false
// 包可能是在别处改好再拷回来的（--archives-only）：以报告是否已标 v3 为准，而不只看这次改没改包
const mameChanged = Boolean(results.get('mame-current-wasm.data') || results.get('mame-current-legacy-wasm.data')) ||
  report('mame-current').saveStateGlue !== GLUE_VERSION
if (mameChanged) {
  updateReport('mame-current')
  changed = true
}
const melondsActual = sha256(join(cores, 'melondsds-wasm.data'))
const melondsSha = results.get('melondsds-wasm.data') ?? (report('melondsds').sha256 !== melondsActual ? melondsActual : null)
if (melondsSha) {
  updateReport('melondsds', { sha256: melondsSha })
  changed = true
}
if (changed) {
  bumpGenerations(melondsSha ?? null, mameChanged)
  execFileSync('node', [join(root, 'scripts/sync-emulatorjs-core-metadata.mjs')], { stdio: 'inherit' })
}
console.log(changed ? '核心胶水已更新：记得一起提交 .data、reports/metadata 与换代常量' : '无需修改')
