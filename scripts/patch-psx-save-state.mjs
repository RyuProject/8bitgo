#!/usr/bin/env node
/**
 * 修补自建 Beetle PS1 核心的 EmulatorJS 存档胶水。
 *
 * 2026-10-20 打出来的 `mednafen_psx` 仍链接了旧版 RetroArch 的
 * `EmulatorJSGetState()`：它把 `save_state_info()` 返回的说明字符串当作堆内存释放，
 * 又在复制前释放状态缓冲。前一次探测就可能破坏分配器；真正点保存时，核心会把被踩坏的
 * 说明字符串解成类似「댟」的乱码，并报 `Failed to save state!`。
 *
 * 新版 EmulatorJS/RetroArch 已改成「先复制、只释放真正 malloc 的 dataStart」，
 * 但 Range 实测通过的软件 PS1 wasm 本身不需要重编。这里仅替换两个 7z 包里的 JS
 * 胶水，保留经过实玩验证的 wasm 与关闭整盘 CHD 预缓存的补丁。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const cores = join(root, 'public/emulatorjs/cores')
const variants = ['mednafen_psx-wasm.data', 'mednafen_psx-legacy-wasm.data']
const members = ['mednafen_psx_libretro.js', 'mednafen_psx_libretro.wasm', 'build.json', 'core.json', 'license.txt']

const oldGlue =
  'const data=HEAPU8.subarray(dataStart,dataStart+size);_free(info);_free(data);return new Uint8Array(data)'
const fixedGlue =
  'const data=new Uint8Array(HEAPU8.subarray(dataStart,dataStart+size));_free(dataStart);return data'

function count(source, needle) {
  return source.split(needle).length - 1
}

function run(file, args, cwd) {
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}

function patchArchive(name) {
  const archive = join(cores, name)
  if (!existsSync(archive)) throw new Error(`缺少 PS1 核心包：${archive}`)
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-psx-state-'))
  try {
    run('7z', ['x', '-bd', '-y', `-o${temp}`, archive], temp)
    const gluePath = join(temp, 'mednafen_psx_libretro.js')
    let glue = readFileSync(gluePath, 'utf8')
    const stateStart = glue.indexOf('function EmulatorJSGetState(){')
    const stateEnd = glue.indexOf('function EmulatorJSGetMemoryData', stateStart)
    if (stateStart < 0 || stateEnd < 0) throw new Error(`${name} 找不到 EmulatorJSGetState 胶水`)
    const stateFunction = glue.slice(stateStart, stateEnd)
    if (stateFunction.includes(fixedGlue)) {
      console.log(`[skip] ${name} 已使用安全的 PS1 存档胶水`)
      return createHash('sha256').update(readFileSync(archive)).digest('hex')
    }
    if (count(stateFunction, oldGlue) !== 1) {
      throw new Error(`${name} 的旧存档胶水形态发生变化，拒绝盲改`)
    }
    glue = glue.replace(oldGlue, fixedGlue)
    writeFileSync(gluePath, glue)
    for (const member of members) {
      if (!existsSync(join(temp, member))) throw new Error(`${name} 打包前缺少 ${member}`)
    }
    const output = join(temp, name)
    run('7z', ['a', '-bd', '-t7z', '-mx=9', output, ...members], temp)
    copyFileSync(output, `${archive}.next`)
    renameSync(`${archive}.next`, archive)
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
    console.log(`[done] ${name} ${hash}`)
    return hash
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const hashes = variants.map((name) => patchArchive(name))
// 这份标记是缓存换代和回归的依据。它写在 reports，随后由 ejsmeta 同步为运行时读取的 metadata。
const reportPath = join(cores, 'reports/mednafen_psx.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
if (report.saveStateGlue !== 'v2') {
  report.saveStateGlue = 'v2'
  report.patch = `${report.patch ?? ''}; emulatorjs-save-state-glue-v2`.replace(/^;\s*/, '')
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`)
  console.log('[report] 已标记 PS1 安全存档胶水 v2；运行 npm run ejsmeta 同步运行时报告')
}
console.log(`PS1 save-state core hashes: ${hashes.join(', ')}`)
