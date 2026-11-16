#!/usr/bin/env node
/**
 * 从随仓库发布的 `pcsx_rearmed` 核心派生 `pcsx_rearmed-lowmem`：只改 WASM 内存的起步页数。
 *
 * 2026-11-16 大陆 Chrome 132 / Windows 64 位、8GB、8 核《生化危机 3：最终逃脱》（诊断包 #780 / #783）：
 * 4 次开局全部在核心 instantiate 时报 `Out of memory: Cannot allocate Wasm memory for new instance`。
 * 取证：EmulatorJS 发布的 pcsx_rearmed（core build 2.0.2）在 memory section 里声明起步 8192 页 = 512 MiB、
 * 上限 32768 页 = 2 GiB，V8 实例化时要一次性提交这 512 MiB；而这个核心的静态数据只到 0.58 MB、
 * 栈顶初值约 5.4 MB —— 剩下五百多 MB 全是预留堆，胶水层又带完整的按需增长（`growMemory` +
 * `_emscripten_resize_heap`，上限 2 GiB）。所以这份内存不是核心的硬需求，而是构建时写死的起步值。
 *
 * 低内存版：
 *   - WASM 代码、数据段、胶水 JS、core.json / build.json / license.txt **逐字节不变**，只把 memory section
 *     的起步页数改小（LEB128 等长改写，section 长度不变）。即时存档格式因此与默认 pcsx_rearmed 完全一致；
 *   - 起步之外的内存由核心按需增长，和 fbneo-lowmem 在线上已验证的路径一样；
 *   - 两个包（WebGL2 版与 legacy 版）都派生；报告 options.defaultWebGL2 跟源报告保持一致。
 *
 * 不重编核心：上游 EmulatorJS/pcsx_rearmed 的构建链需要 emsdk + RetroArch 分支，重编出来的就是另一份
 * 二进制，存档 / 兼容性都要重新验收；这里只动一个常数，验收面最小。
 *
 * 用法：node scripts/build-pcsx-lowmem-core.mjs [--initial-mib 64]
 * 需要本机有 7z / 7zz。产物：cores/pcsx_rearmed-lowmem{,-legacy}-wasm.data、reports/ 与 metadata/ 下的
 * pcsx_rearmed-lowmem.json，并重生成 src/emulator/ejsCoreVersionsData.ts。回归：npm run test:psx-lowmem。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cores = join(root, 'public', 'emulatorjs', 'cores')
const SOURCE_CORE = 'pcsx_rearmed'
const TARGET_CORE = 'pcsx_rearmed-lowmem'
const WASM_PAGE = 65536
/** 源包声明的起步 / 上限页数；上游换了构建这两个数就会变，宁可当场停下重新取证 */
const EXPECTED_SOURCE_MIN_PAGES = 8192
const EXPECTED_SOURCE_MAX_PAGES = 32768
/** 静态区（数据段 + 栈）之上至少留这么多给 dlmalloc 起步，免得一开局就得扩容 */
const HEAP_HEADROOM_BYTES = 16 * 1024 * 1024
const MEMBERS = ['pcsx_rearmed_libretro.js', 'pcsx_rearmed_libretro.wasm', 'build.json', 'core.json', 'license.txt']
const sevenZip = existsSync('/opt/homebrew/bin/7zz') || existsSync('/usr/local/bin/7zz') ? '7zz' : '7z'

function parseArgs(argv) {
  const args = { initialMib: 64 }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--initial-mib') args.initialMib = Number(argv[++i])
    else throw new Error(`未知参数：${argv[i]}`)
  }
  if (!Number.isInteger(args.initialMib) || args.initialMib < 16 || args.initialMib >= 512) {
    throw new Error('--initial-mib 必须是 16～511 之间的整数')
  }
  return args
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function readUleb(buf, offset) {
  let value = 0
  let shift = 0
  const start = offset
  for (;;) {
    if (offset >= buf.length) throw new Error('WASM 被截断（LEB128）')
    const byte = buf[offset++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: offset, length: offset - start }
    shift += 7
  }
}

function readSleb32(buf, offset) {
  let result = 0
  let shift = 0
  let byte
  do {
    byte = buf[offset++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  if (shift < 32 && (byte & 0x40)) result |= ~0 << shift
  return { value: result, next: offset }
}

/** 按指定字节数写 ULEB128（不足的用续位填充），用于等长改写，section 长度不用动。 */
function encodeUlebPadded(value, length) {
  const out = []
  for (let i = 0; i < length; i++) {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (i < length - 1) byte |= 0x80
    out.push(byte)
  }
  if (value !== 0) throw new Error('新页数放不进原 LEB128 宽度')
  return Buffer.from(out)
}

/**
 * 解析 WASM：memory section 的位置与数值、数据段最远到哪、全局 0（栈指针）的初值。
 * 只认这份核心的形态（memory 在本模块定义、单块内存、数据段都是 active + i32.const 偏移）。
 */
export function inspectWasm(buf) {
  if (buf.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('不是 WASM 文件')
  let offset = 8
  let memory = null
  let dataEnd = 0
  let stackPointer = null
  while (offset < buf.length) {
    const id = buf[offset++]
    const size = readUleb(buf, offset)
    offset = size.next
    const end = offset + size.value
    if (id === 2) {
      // import section：确认内存不是从外面导入的（导入的话改这里没用）
      let p = offset
      const count = readUleb(buf, p); p = count.next
      for (let i = 0; i < count.value; i++) {
        for (let k = 0; k < 2; k++) { const len = readUleb(buf, p); p = len.next + len.value }
        const kind = buf[p++]
        if (kind === 0) p = readUleb(buf, p).next
        else if (kind === 1) { p++; const f = buf[p++]; p = readUleb(buf, p).next; if (f & 1) p = readUleb(buf, p).next }
        else if (kind === 2) throw new Error('核心的内存是导入的，不能在 memory section 里改起步页数')
        else if (kind === 3) p += 2
        else if (kind === 4) { p++; p = readUleb(buf, p).next }
      }
    } else if (id === 5) {
      let p = offset
      const count = readUleb(buf, p); p = count.next
      if (count.value !== 1) throw new Error(`预期 1 块内存，实际 ${count.value}`)
      const flags = buf[p++]
      const min = readUleb(buf, p)
      p = min.next
      const max = flags & 1 ? readUleb(buf, p) : null
      memory = { flags, minPages: min.value, minOffset: min.next - min.length, minLength: min.length, maxPages: max?.value ?? null }
    } else if (id === 6) {
      let p = offset
      const count = readUleb(buf, p); p = count.next
      if (count.value > 0) {
        p += 2 // valtype + mut
        if (buf[p] === 0x41) stackPointer = readSleb32(buf, p + 1).value
      }
    } else if (id === 11) {
      let p = offset
      const count = readUleb(buf, p); p = count.next
      for (let i = 0; i < count.value; i++) {
        const flag = readUleb(buf, p); p = flag.next
        if (flag.value === 1) throw new Error('出现 passive 数据段，静态区上界算不准')
        if (flag.value === 2) p = readUleb(buf, p).next
        if (buf[p] !== 0x41) throw new Error('数据段偏移不是 i32.const，静态区上界算不准')
        const at = readSleb32(buf, p + 1)
        p = at.next
        if (buf[p++] !== 0x0b) throw new Error('数据段偏移表达式异常')
        const len = readUleb(buf, p); p = len.next + len.value
        dataEnd = Math.max(dataEnd, (at.value >>> 0) + len.value)
      }
    }
    offset = end
  }
  if (!memory) throw new Error('WASM 里没有 memory section')
  if (stackPointer === null) throw new Error('读不到栈指针初值（全局 0）')
  return { memory, dataEnd, stackPointer: stackPointer >>> 0 }
}

/**
 * 只读 memory section 的起步 / 上限页数（给预检表核对所有核心用；别的核心可能有 passive 数据段，
 * inspectWasm 会拒绝它们）。内存从外面导入时读 import 里的限值。
 */
export function readWasmMemoryLimits(buf) {
  if (buf.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('不是 WASM 文件')
  let offset = 8
  while (offset < buf.length) {
    const id = buf[offset++]
    const size = readUleb(buf, offset)
    offset = size.next
    const end = offset + size.value
    if (id === 2) {
      let p = offset
      const count = readUleb(buf, p); p = count.next
      for (let i = 0; i < count.value; i++) {
        for (let k = 0; k < 2; k++) { const len = readUleb(buf, p); p = len.next + len.value }
        const kind = buf[p++]
        if (kind === 0) p = readUleb(buf, p).next
        else if (kind === 1) { p++; const f = buf[p++]; p = readUleb(buf, p).next; if (f & 1) p = readUleb(buf, p).next }
        else if (kind === 2) {
          const flags = buf[p++]
          const min = readUleb(buf, p)
          const max = flags & 1 ? readUleb(buf, min.next) : null
          return { minPages: min.value, maxPages: max?.value ?? null }
        } else if (kind === 3) p += 2
        else if (kind === 4) { p++; p = readUleb(buf, p).next }
      }
    } else if (id === 5) {
      let p = offset
      p = readUleb(buf, p).next
      const flags = buf[p++]
      const min = readUleb(buf, p)
      const max = flags & 1 ? readUleb(buf, min.next) : null
      return { minPages: min.value, maxPages: max?.value ?? null }
    }
    offset = end
  }
  throw new Error('WASM 里没有内存声明')
}

/** 胶水层必须带按需增长；否则起步页数改小就是把核心饿死。 */
export function assertGrowableGlue(glue) {
  for (const needle of ['growMemory=size=>', 'wasmMemory.grow(', '_emscripten_resize_heap=requestedSize=>', 'getHeapMax=()=>2147483648']) {
    if (!glue.includes(needle)) throw new Error(`胶水层缺少「${needle}」，不能确认核心会按需增长内存`)
  }
}

export function lowerInitialPages(wasm, initialPages) {
  const info = inspectWasm(wasm)
  const { memory } = info
  if (memory.minPages !== EXPECTED_SOURCE_MIN_PAGES || memory.maxPages !== EXPECTED_SOURCE_MAX_PAGES) {
    throw new Error(`源核心的内存声明变了：起步 ${memory.minPages} 页、上限 ${memory.maxPages} 页（预期 ${EXPECTED_SOURCE_MIN_PAGES} / ${EXPECTED_SOURCE_MAX_PAGES}），请重新取证`)
  }
  const staticTop = Math.max(info.dataEnd, info.stackPointer)
  if (initialPages * WASM_PAGE < staticTop + HEAP_HEADROOM_BYTES) {
    throw new Error(`起步 ${initialPages} 页装不下静态区 ${staticTop} 字节 + 16MiB 起步堆`)
  }
  const out = Buffer.from(wasm)
  encodeUlebPadded(initialPages, memory.minLength).copy(out, memory.minOffset)
  const after = inspectWasm(out)
  if (after.memory.minPages !== initialPages || after.memory.maxPages !== EXPECTED_SOURCE_MAX_PAGES) {
    throw new Error('改写后的 memory section 读回来不对')
  }
  if (!WebAssembly.validate(out)) throw new Error('改写后的 WASM 没通过 WebAssembly.validate')
  return { wasm: out, staticTop }
}

function run(args, cwd) {
  execFileSync(sevenZip, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}

function deriveArchive(variant, initialPages) {
  const source = join(cores, `${SOURCE_CORE}${variant}-wasm.data`)
  const target = join(cores, `${TARGET_CORE}${variant}-wasm.data`)
  if (!existsSync(source)) throw new Error(`缺少源核心包：${source}`)
  const temp = mkdtempSync(join(tmpdir(), '8bitgo-pcsx-lowmem-'))
  try {
    run(['x', '-bd', '-y', `-o${temp}`, source], temp)
    for (const member of MEMBERS) {
      if (!existsSync(join(temp, member))) throw new Error(`${source} 里缺少 ${member}`)
    }
    assertGrowableGlue(readFileSync(join(temp, 'pcsx_rearmed_libretro.js'), 'utf8'))
    const wasmPath = join(temp, 'pcsx_rearmed_libretro.wasm')
    const original = readFileSync(wasmPath)
    const { wasm, staticTop } = lowerInitialPages(original, initialPages)
    writeFileSync(wasmPath, wasm)
    const output = join(temp, 'out.7z')
    run(['a', '-bd', '-t7z', '-mx=9', output, ...MEMBERS], temp)
    renameSync(output, target)
    const bytes = readFileSync(target)
    return {
      file: `${TARGET_CORE}${variant}-wasm.data`,
      sha256: sha256(bytes),
      sourceFile: `${SOURCE_CORE}${variant}-wasm.data`,
      sourceSha256: sha256(readFileSync(source)),
      sourceWasmSha256: sha256(original),
      wasmSha256: sha256(wasm),
      staticTopBytes: staticTop,
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function main() {
  const { initialMib } = parseArgs(process.argv)
  const initialPages = (initialMib * 1024 * 1024) / WASM_PAGE
  const variants = ['', '-legacy'].map((variant) => deriveArchive(variant, initialPages))
  const sourceReport = JSON.parse(readFileSync(join(cores, 'reports', `${SOURCE_CORE}.json`), 'utf8'))
  const report = {
    core: TARGET_CORE,
    buildStart: sourceReport.buildStart,
    buildEnd: sourceReport.buildEnd,
    options: sourceReport.options ?? {},
    derivedFrom: SOURCE_CORE,
    derivation: 'wasm memory section initial pages only; code, data, glue and save-state format unchanged',
    sha256: variants[0].sha256,
    variants,
    memory: {
      initialBytes: initialPages * WASM_PAGE,
      maximumBytes: EXPECTED_SOURCE_MAX_PAGES * WASM_PAGE,
      sourceInitialBytes: EXPECTED_SOURCE_MIN_PAGES * WASM_PAGE,
      allowMemoryGrowth: true,
    },
  }
  writeFileSync(join(cores, 'reports', `${TARGET_CORE}.json`), `${JSON.stringify(report, null, 2)}\n`)
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-emulatorjs-core-metadata.mjs')], { stdio: 'inherit' })
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-ejs-core-versions.mjs')], { stdio: 'inherit' })
  console.log(`✔ ${TARGET_CORE}：起步 ${initialMib} MiB（源核心 ${EXPECTED_SOURCE_MIN_PAGES * WASM_PAGE / 1048576} MiB），静态区 ${(variants[0].staticTopBytes / 1048576).toFixed(2)} MB`)
  console.log(`  记得同步 src/emulator/psxLowmem.ts 的 PSX_LOWMEM_BUILD = '${variants[0].sha256.slice(0, 8)}'`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
