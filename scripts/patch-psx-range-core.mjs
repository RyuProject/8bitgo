/**
 * 官方 Emscripten 构建把 cdimagecache 固定为 true，Beetle 打开 CHD 时会 malloc + 读完整盘。
 * 本脚本只给已取证的这一版核心关闭 CDIF_Open 的缓存参数；核心一升级，指纹不符就停止，
 * 必须回到上游源码把 libretro.cpp 的 EMSCRIPTEN 默认值改为 false 后重建。
 * 需要本地安装 7zz；产物本身随仓库提交，线上构建不运行本脚本。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const archive = join(root, 'public/emulatorjs/cores/mednafen_psx_hw-wasm.data')
const originalHash = 'ec7e83ffafbaec18b8cb0b6695cf09e512b806160321c39cf57b3b05bbed3a13'
const patchedHash = 'af9c5162312f80d2c1d94b29856944b38c40156827ce85a953d22a20330dda41'

function run(args, cwd) {
  const result = spawnSync('7zz', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`7zz 执行失败：${result.stderr || result.stdout || result.error}`)
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function uleb(bytes, start) {
  let value = 0
  let shift = 0
  let at = start
  while (true) {
    const byte = bytes[at++]
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return [value, at]
    shift += 7
    if (shift > 35) throw new Error('WASM ULEB 损坏')
  }
}
function encode(value) {
  const output = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value) byte |= 0x80
    output.push(byte)
  } while (value)
  return Buffer.from(output)
}
function patchWasm(wasm) {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm)).filter(item => item.kind === 'function').length
  if (imports !== 488) throw new Error('核心导入函数数目已变，不能沿用旧补丁')
  const codeIndex = 1365 - imports
  let at = 8
  const sections = [wasm.subarray(0, 8)]
  let patched = false
  while (at < wasm.length) {
    const id = wasm[at++]
    const [size, payloadStart] = uleb(wasm, at)
    const payloadEnd = payloadStart + size
    if (id !== 10) sections.push(wasm.subarray(at - 1, payloadEnd))
    else {
      let [count, bodyAt] = uleb(wasm, payloadStart)
      const bodies = [wasm.subarray(payloadStart, bodyAt)]
      for (let index = 0; index < count; index++) {
        const [length, bodyStart] = uleb(wasm, bodyAt)
        const bodyEnd = bodyStart + length
        if (index !== codeIndex) bodies.push(wasm.subarray(bodyAt, bodyEnd))
        else {
          let [localCount, instructions] = uleb(wasm, bodyStart)
          while (localCount--) {
            ;[, instructions] = uleb(wasm, instructions)
            instructions++
          }
          // local 2 是 CDIF_Open 的 image_memcache。只清这一位，不动 CHD 解码和其它核心。
          const body = Buffer.concat([
            wasm.subarray(bodyStart, instructions),
            Buffer.from([0x41, 0x00, 0x21, 0x02]),
            wasm.subarray(instructions, bodyEnd),
          ])
          bodies.push(encode(body.length), body)
          patched = true
        }
        bodyAt = bodyEnd
      }
      const payload = Buffer.concat(bodies)
      sections.push(Buffer.from([id]), encode(payload.length), payload)
    }
    at = payloadEnd
  }
  if (!patched) throw new Error('核心目标函数缺失')
  const result = Buffer.concat(sections)
  new WebAssembly.Module(result)
  if (sha(result) !== patchedHash) throw new Error('补丁结果指纹不符')
  return result
}

const temp = mkdtempSync(join(tmpdir(), '8bitgo-psx-core-'))
try {
  run(['x', '-y', `-o${temp}`, archive])
  const wasmPath = join(temp, 'mednafen_psx_hw_libretro.wasm')
  const wasm = readFileSync(wasmPath)
  const hash = sha(wasm)
  if (hash === patchedHash) {
    console.log('PS1 Range 核心补丁已存在')
    process.exit(0)
  }
  if (hash !== originalHash) throw new Error(`核心已变化，拒绝盲打补丁：${hash}`)
  writeFileSync(wasmPath, patchWasm(wasm))
  const output = join(temp, 'patched.data')
  const files = readdirSync(temp).filter(name => name !== 'patched.data')
  run(['a', '-t7z', '-mx=7', output, ...files], temp)
  renameSync(output, archive)
  console.log('PS1 Range 核心已关闭整盘预缓存')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
