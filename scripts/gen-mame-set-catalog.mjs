#!/usr/bin/env node
/**
 * 从 MAME 官方源码生成「FBNeo 没有、只能交给 mame-current 跑」的街机 romset 指纹表
 * （src/lib/mameSetCatalogData.ts）。第一批是 Sega Model 2（Dead or Alive、VR 战士 2、
 * Daytona USA、死亡之屋 …），FBNeo 索引里一个都没有。
 *
 * ── 为什么要从源码生成，而不是手抄 / 只认文件名 ──────────────────
 *   1. MAME 的 ROM_START 是这些板子唯一权威清单；克隆集的 ROM_START 本身就是完整清单
 *      （共用 ROM 重复列出），按 set 逐项比 CRC 就能判定 ZIP 里有没有一套完整的 set。
 *   2. 网上常见的是 **merged 包**：父集 doa.zip 里同时装着 doa / doab / doaa / doaab / doaae
 *      五个 set，克隆集里和父集同 CRC 的 ROM 只存一份、用父集的文件名（doaae 的
 *      mpr-19318.10 在包里叫 mpr-19318.11）。所以匹配必须看 CRC + 长度，不能看文件名。
 *   3. 板载设备也有自己的 ROM（Model 2A 的 Sega Billboard → segabill.zip / epr-18022.ic2）。
 *      MAME 找设备 ROM 的顺序是 [设备短名, 游戏 set, 父集 …]，缺了就是
 *      「required files are missing」。生成器沿机台配置把设备一路解析下去，
 *      连「这台机器把 I/O 板默认 BIOS 换成了哪一版」（set_default_bios_tag）也算进去。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *   node scripts/gen-mame-set-catalog.mjs <MAME 源码根目录> [--revision <git-sha>] [--drivers sega/model2.cpp,...]
 *
 * 源码树至少要有 src/mame（驱动所在目录 + src/mame/shared）、src/devices、src/emu：
 * 设备类型（DEFINE_DEVICE_TYPE）要在这三处解析。不想拉整个仓库可以稀疏克隆：
 *   git clone --depth 1 --branch mame0289 --filter=blob:none --sparse https://github.com/mamedev/mame
 *   git -C mame sparse-checkout set --no-cone 'src/mame/sega/*' 'src/mame/shared/*' \
 *       'src/devices/**' 'src/emu/*.cpp' 'src/emu/*.h'
 *
 * ⚠️ 核心（mame-current）的 MAME 版本变了要重新生成，并核对 MAME_SET_CATALOG_REVISION：
 *    MAME 偶尔会给 ROM 改名、改 CRC 或给设备加 ROM。
 * ⚠️ 遇到认不出的设备宏会直接失败，而不是当成「没有 ROM」—— 漏一颗设备 ROM，
 *    后台就会放行一份开局必报缺文件的包。确属无 ROM 的宏族加进 ROMLESS_MACROS 并写明依据。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** 收录哪些驱动；board() 把 GAME 宏里的 state 类名翻成后台 / 玩家看的板子名 */
const DRIVERS = {
  'sega/model2.cpp': {
    board(stateClass) {
      if (stateClass.startsWith('model2o')) return 'Sega Model 2'
      if (stateClass.startsWith('model2a')) return 'Sega Model 2A-CRX'
      if (stateClass.startsWith('model2b')) return 'Sega Model 2B-CRX'
      if (stateClass.startsWith('model2c')) return 'Sega Model 2C-CRX'
      throw new Error(`model2.cpp 出现了不认识的 state 类：${stateClass}`)
    },
  },
}

/**
 * 不是用 DEFINE_DEVICE_TYPE 直接定义、而是由宏批量生成的设备类型。
 * 只有在「生成它们的源文件里根本没有 device_rom_region」时才允许当成无 ROM —— 生成器会核对。
 */
const ROMLESS_MACROS = [
  // DECLARE_SERIAL_EEPROM_DEVICE / DEFINE_SERIAL_EEPROM_DEVICE 批量生成的串行 EEPROM
  { pattern: /^EEPROM_\w+$/, verify: 'src/devices/machine/eepromser.cpp' },
]

const root = process.argv[2]
if (!root || root.startsWith('-') || !existsSync(join(root, 'src/mame'))) {
  console.error('用法：node scripts/gen-mame-set-catalog.mjs <MAME 源码根目录> [--revision <git-sha>] [--drivers sega/model2.cpp]')
  process.exit(2)
}
function argValue(flag) {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? String(process.argv[at + 1] ?? '').trim() : ''
}
let revision = argValue('--revision')
if (!revision) {
  try { revision = execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() } catch { revision = 'unknown' }
}
const driverList = (argValue('--drivers') || Object.keys(DRIVERS).join(','))
  .split(',').map((value) => value.trim().replace(/^src\/mame\//, '')).filter(Boolean)
for (const driver of driverList) {
  if (!DRIVERS[driver]) throw new Error(`没有为 ${driver} 配置板子名映射（DRIVERS）；先在脚本里登记再生成`)
}

// ── 源码预处理 ──────────────────────────────────────────────

/** 去掉注释但保留字符串；`'` 只有前面不是字母数字时才算字符字面量（避开 C++14 数字分隔符） */
function stripComments(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '"' || (c === "'" && !/[0-9A-Za-z_]/.test(src[i - 1] ?? ''))) {
      out += c
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') out += src[i++]
        out += src[i++]
      }
      out += src[i] ?? ''
      continue
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i++
      }
      i++
      continue
    }
    out += c
  }
  return out
}

const sourceCache = new Map()
function loadSource(file) {
  if (sourceCache.has(file)) return sourceCache.get(file)
  const raw = stripComments(readFileSync(file, 'utf8')).replace(/\\\r?\n/g, ' ')
  const macros = new Map()
  for (const m of raw.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(.*)$/gm)) {
    if (/\bROM[X]?_\w+\s*\(/.test(m[2])) macros.set(m[1], m[2])
  }
  const text = raw.replace(/^[ \t]*#.*$/gm, '')
  const result = { file, text, macros }
  sourceCache.set(file, result)
  return result
}

function expandMacros(body, macros, depth = 0) {
  if (!macros.size || depth > 8) return body
  let changed = false
  const out = body.replace(/\b[A-Za-z_]\w*\b/g, (word) => {
    const value = macros.get(word)
    if (value == null) return word
    changed = true
    return ` ${value} `
  })
  return changed ? expandMacros(out, macros, depth + 1) : out
}

/** 从 `(` 开始取一层括号内的参数（顶层逗号切分，尊重嵌套与字符串） */
function callArgs(text, open) {
  let depth = 0
  let current = ''
  const args = []
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      current += text.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '(') {
      depth++
      if (depth === 1) continue
    } else if (c === ')') {
      depth--
      if (depth === 0) {
        if (current.trim() || args.length) args.push(current.trim())
        return { args, end: i + 1 }
      }
    } else if (c === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += c
  }
  throw new Error('括号不配对')
}

const unquote = (value) => {
  const m = /^"([^"]*)"$/.exec(String(value ?? '').trim())
  return m ? m[1] : null
}

function parseNumber(value) {
  const v = String(value ?? '').trim()
  if (/^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v, 16)
  if (/^\d+$/.test(v)) return Number(v)
  // 0x20000*2 之类的简单表达式
  if (/^[0-9a-fx*+\s]+$/i.test(v)) {
    try { return Number(Function(`"use strict";return (${v})`)()) } catch { return 0 }
  }
  return 0
}

function bracedBody(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  throw new Error('花括号不配对')
}

// ── ROM 块 ──────────────────────────────────────────────────

function parseRomBlocks(source) {
  const blocks = new Map()
  for (const m of source.text.matchAll(/\bROM_START\s*\(\s*(\w+)\s*\)([\s\S]*?)\bROM_END\b/g)) {
    blocks.set(m[1], parseRomBlock(expandMacros(m[2], source.macros), `${basename(source.file)}:${m[1]}`))
  }
  return blocks
}

function parseRomBlock(body, label) {
  const roms = []
  const disks = []
  const biosOrder = []
  let defaultBios = null
  const re = /\b(ROM_DEFAULT_BIOS|ROM_SYSTEM_BIOS|ROMX?_LOAD\w*|DISK_IMAGE\w*)\s*\(/g
  for (let m; (m = re.exec(body));) {
    const { args, end } = callArgs(body, m.index + m[0].length - 1)
    re.lastIndex = end
    const macro = m[1]
    if (macro === 'ROM_DEFAULT_BIOS') { defaultBios = unquote(args[0]); continue }
    if (macro === 'ROM_SYSTEM_BIOS') { biosOrder.push({ index: Number(args[0]), tag: unquote(args[1]) }); continue }
    if (macro.startsWith('DISK_IMAGE')) { disks.push(unquote(args[0])); continue }
    const name = unquote(args[0])
    if (!name) continue
    const hash = args[3] ?? ''
    const flags = args.slice(4).join(',')
    if (/\bNO_DUMP\b/.test(hash)) continue
    const crc = /\bCRC\(\s*([0-9a-fA-F]{8})\s*\)/.exec(hash)
    if (!crc) throw new Error(`${label}：${name} 没有 CRC（${hash}）`)
    const bios = /\bROM_BIOS\(\s*(\d+)\s*\)/.exec(`${hash},${flags}`)
    roms.push({
      name: name.toLowerCase(),
      crc: crc[1].toLowerCase(),
      size: parseNumber(args[2]),
      bios: bios ? Number(bios[1]) : null,
      optional: /OPTIONAL/.test(macro) || /\bROM_OPTIONAL\b/.test(flags),
    })
  }
  return { roms, disks, biosOrder, defaultBios, label }
}

/** 按选中的 BIOS 取出 MAME 真正要求的 ROM；同名重复（同 CRC）只留一份 */
function requiredRoms(block, biosTag) {
  let biosIndex = null
  if (block.biosOrder.length) {
    const tag = biosTag ?? block.defaultBios ?? block.biosOrder[0].tag
    const hit = block.biosOrder.find((bios) => bios.tag === tag)
    if (!hit) throw new Error(`${block.label}：没有名为 ${tag} 的 BIOS`)
    biosIndex = hit.index
  } else if (biosTag) {
    throw new Error(`${block.label}：设置了 BIOS ${biosTag}，但 ROM 块没有 ROM_SYSTEM_BIOS`)
  }
  const byName = new Map()
  for (const rom of block.roms) {
    if (rom.optional) continue
    if (rom.bios != null && rom.bios !== biosIndex) continue
    const prior = byName.get(rom.name)
    if (prior && prior.crc !== rom.crc) throw new Error(`${block.label}：${rom.name} 出现两个不同 CRC`)
    if (!prior) byName.set(rom.name, rom)
  }
  return [...byName.values()]
}

// ── 机台配置 / 设备解析 ─────────────────────────────────────

function configFunctions(source) {
  const out = new Map()
  const re = /\bvoid\s+(\w+)::(\w+)\s*\(\s*machine_config\s*&\s*config\s*\)\s*(?:const\s*)?\{/g
  for (let m; (m = re.exec(source.text));) {
    const body = bracedBody(source.text, m.index + m[0].length - 1)
    const list = out.get(m[2]) ?? []
    list.push({ cls: m[1], name: m[2], body })
    out.set(m[2], list)
  }
  return out
}

/** 一个配置函数体里按出现顺序列出：调用别的配置函数 / 添加设备 / 移除设备 / 改默认 BIOS */
function configEvents(body, functions) {
  const events = []
  const varTag = new Map()
  const re = /\b([A-Za-z_]\w*)\s*\(/g
  for (let m; (m = re.exec(body));) {
    const id = m[1]
    let parsed
    try { parsed = callArgs(body, m.index + m[0].length - 1) } catch { continue }
    const { args, end } = parsed
    if (args.length === 1 && args[0] === 'config' && functions.has(id)) {
      events.push({ kind: 'call', name: id })
      re.lastIndex = end
      continue
    }
    if (id === 'device_remove' && /config\s*\.\s*$/.test(body.slice(0, m.index))) {
      events.push({ kind: 'remove', tag: normalizeTag(args[0]) })
      re.lastIndex = end
      continue
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(id) && /^config(\s*\.\s*replace\s*\(\s*\))?$/.test(args[0] ?? '')) {
      const tag = normalizeTag(args[1] ?? `${id}#${events.length}`)
      const event = { kind: 'device', macro: id, tag, bios: null }
      events.push(event)
      // `model1io_device &ioboard(SEGA_MODEL1IO(config, "ioboard"));` → 记住变量名
      const decl = /(\w+)\s*&\s*(\w+)\s*\(\s*$/.exec(body.slice(Math.max(0, m.index - 120), m.index))
      if (decl) varTag.set(decl[2], tag)
      // `SEGA_X(config, "t").set_default_bios_tag("b")` 链式写法
      const chained = /^\s*\.\s*set_default_bios_tag\s*\(\s*"([^"]+)"/.exec(body.slice(end))
      if (chained) event.bios = chained[1]
      re.lastIndex = end
      continue
    }
  }
  for (const m of body.matchAll(/\b(\w+)\s*(?:\.|->)\s*set_default_bios_tag\s*\(\s*"([^"]+)"/g)) {
    const tag = varTag.get(m[1]) ?? normalizeTag(m[1])
    const event = [...events].reverse().find((item) => item.kind === 'device' && item.tag === tag)
    if (event) event.bios = m[2]
  }
  return events
}

function normalizeTag(value) {
  const quoted = unquote(value)
  if (quoted != null) return quoted
  return String(value ?? '').trim().replace(/^m_/, '')
}

function pickFunction(functions, cls, name) {
  const list = functions.get(name)
  if (!list?.length) throw new Error(`找不到机台配置 ${cls ?? '?'}::${name}`)
  return list.find((fn) => fn.cls === cls) ?? (list.length === 1 ? list[0] : list[0])
}

/** 把一个机台配置展开成最终的设备表（tag → { macro, bios }） */
function resolveMachineDevices(functions, cls, name) {
  const devices = new Map()
  const visit = (fnCls, fnName, depth) => {
    if (depth > 20) throw new Error(`机台配置递归过深：${fnName}`)
    const fn = pickFunction(functions, fnCls, fnName)
    for (const event of configEvents(fn.body, functions)) {
      if (event.kind === 'call') visit(fn.cls, event.name, depth + 1)
      else if (event.kind === 'remove') devices.delete(event.tag)
      else devices.set(event.tag, { macro: event.macro, bios: event.bios })
    }
  }
  visit(cls, name, 0)
  return devices
}

// 设备类型索引：宏 → { file, cls, shortname, title }
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(cpp|h)$/.test(name)) out.push(path)
  }
  return out
}
const deviceIndex = new Map()
const headerText = new Map()
for (const file of [...walk(join(root, 'src/emu')), ...walk(join(root, 'src/devices')), ...walk(join(root, 'src/mame'))]) {
  const text = readFileSync(file, 'utf8')
  if (file.endsWith('.h')) headerText.set(file, text)
  for (const m of text.matchAll(/\bDEFINE_DEVICE_TYPE(?:_PRIVATE)?\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"/g)) {
    if (!deviceIndex.has(m[1])) deviceIndex.set(m[1], { file, cls: m[2], shortname: m[3], title: m[4] })
  }
}

/** 在头文件 / 源文件里找类声明：返回 { body, base, file }（base 去掉模板参数与命名空间） */
const classCache = new Map()
function classDecl(cls, hintFile) {
  if (classCache.has(cls)) return classCache.get(cls)
  const re = new RegExp(`\\bclass\\s+${cls}\\b\\s*(?:final\\s*)?(?::\\s*public\\s+([\\w:]+))?[^;{]*\\{`)
  const files = [hintFile, ...headerText.keys()].filter(Boolean)
  for (const file of files) {
    const text = file.endsWith('.h') ? headerText.get(file) ?? readFileSync(file, 'utf8') : loadSource(file).text
    const m = re.exec(text)
    if (!m) continue
    const decl = { body: bracedBody(text, m.index + m[0].length - 1), base: m[1] ? m[1].split('::').pop() : null, file }
    classCache.set(cls, decl)
    return decl
  }
  classCache.set(cls, null)
  return null
}

/**
 * 设备 ROM 区域：返回 ROM 块（null = 没有 ROM）。
 *
 * 沿继承链往上找：链上某个类**声明**了 device_rom_region，就必须找到它的实现并解析；
 * 一路都没声明才算没有 ROM。只看「文件里有没有 device_rom_region」会误判 —— 同一个
 * ymopn.cpp 里 YM2608 有内置节奏 ROM，YM3438 没有。
 */
function deviceRomBlock(info) {
  let cls = info.cls
  // device_t 自己的 device_rom_region 是返回 nullptr 的虚函数默认实现，走到它就说明整条链都没有 ROM
  for (let guard = 0; cls && cls !== 'device_t' && guard < 8; guard++) {
    const decl = classDecl(cls, info.file.replace(/\.cpp$/, '.h'))
    const declares = decl ? /\bdevice_rom_region\s*\(\s*\)\s*const/.test(decl.body) : false
    const sources = [info.file, decl?.file && decl.file.replace(/\.h$/, '.cpp')].filter((file) => file && existsSync(file))
    for (const file of sources) {
      const source = loadSource(file)
      const m = new RegExp(`\\b${cls}::device_rom_region\\s*\\(\\s*\\)\\s*const\\s*\\{\\s*return\\s+ROM_NAME\\s*\\(\\s*(\\w+)\\s*\\)`).exec(source.text)
      if (!m) continue
      const block = parseRomBlocks(source).get(m[1])
      if (!block) throw new Error(`${relative(root, file)}：找不到 ROM_START(${m[1]})`)
      return block
    }
    if (declares) {
      throw new Error(`${cls} 声明了 device_rom_region，但没找到形如 return ROM_NAME(x) 的实现；请人工核对后扩展生成器`)
    }
    if (!decl && cls !== info.cls) break
    if (!decl) throw new Error(`找不到设备类 ${cls} 的声明（${relative(root, info.file)}）`)
    cls = decl.base
  }
  return null
}

const deviceRequirementCache = new Map()
/** 设备（含它自己的子设备）要求的 ROM 组：[{ id, shortname, title, roms }] */
function deviceRequirements(macro, bios, stack = []) {
  const key = `${macro}@${bios ?? ''}`
  if (deviceRequirementCache.has(key)) return deviceRequirementCache.get(key)
  if (stack.includes(macro)) return []
  const info = deviceIndex.get(macro)
  if (!info) {
    const romless = ROMLESS_MACROS.find((rule) => rule.pattern.test(macro))
    if (!romless) throw new Error(`认不出设备宏 ${macro}（源码树里没有 DEFINE_DEVICE_TYPE）。确认它没有 ROM 后加进 ROMLESS_MACROS`)
    const verify = join(root, romless.verify)
    if (!existsSync(verify) || /device_rom_region/.test(readFileSync(verify, 'utf8'))) {
      throw new Error(`${macro} 按规则视为无 ROM，但 ${romless.verify} 不存在或含 device_rom_region，不能放行`)
    }
    deviceRequirementCache.set(key, [])
    return []
  }
  const out = []
  const block = deviceRomBlock(info)
  if (block) {
    const roms = requiredRoms(block, bios)
    if (roms.length) {
      const chosen = bios ?? block.defaultBios ?? block.biosOrder[0]?.tag ?? null
      out.push({ id: chosen && block.biosOrder.length > 1 ? `${info.shortname}@${chosen}` : info.shortname, shortname: info.shortname, title: info.title, roms })
    }
  }
  const source = loadSource(info.file)
  const mconfig = new RegExp(`\\bvoid\\s+${info.cls}::device_add_mconfig\\s*\\(\\s*machine_config\\s*&\\s*config\\s*\\)\\s*\\{`).exec(source.text)
  if (mconfig) {
    const body = bracedBody(source.text, mconfig.index + mconfig[0].length - 1)
    const sub = new Map()
    for (const event of configEvents(body, new Map())) {
      if (event.kind === 'device') sub.set(event.tag, event)
      else if (event.kind === 'remove') sub.delete(event.tag)
    }
    for (const event of sub.values()) out.push(...deviceRequirements(event.macro, event.bios, [...stack, macro]))
  }
  deviceRequirementCache.set(key, out)
  return out
}

// ── 输入端口：推断摇杆游戏的动作键数 ───────────────────────

function inputBlocks(source) {
  const blocks = new Map()
  for (const m of source.text.matchAll(/\bINPUT_PORTS_START\s*\(\s*(\w+)\s*\)([\s\S]*?)\bINPUT_PORTS_END\b/g)) blocks.set(m[1], m[2])
  return blocks
}

function evaluatePorts(blocks, name, ports = new Map(), depth = 0) {
  const body = blocks.get(name)
  if (body == null || depth > 10) return ports
  let current = null
  let lastBits = []
  const re = /\b(PORT_INCLUDE|PORT_START|PORT_MODIFY|PORT_BIT|PORT_PLAYER)\s*\(/g
  for (let m; (m = re.exec(body));) {
    const { args, end } = callArgs(body, m.index + m[0].length - 1)
    re.lastIndex = end
    if (m[1] === 'PORT_INCLUDE') evaluatePorts(blocks, args[0], ports, depth + 1)
    else if (m[1] === 'PORT_START') { current = unquote(args[0]); ports.set(current, new Map()); lastBits = [] }
    else if (m[1] === 'PORT_MODIFY') { current = unquote(args[0]); if (!ports.has(current)) ports.set(current, new Map()); lastBits = [] }
    else if (m[1] === 'PORT_BIT' && current) {
      const mask = parseNumber(args[0])
      const type = String(args[2] ?? '').trim()
      lastBits = []
      for (let bit = 0; bit < 32; bit++) {
        if (!(mask & (2 ** bit))) continue
        ports.get(current).set(bit, { type, player: 1 })
        lastBits.push(bit)
      }
    } else if (m[1] === 'PORT_PLAYER' && current) {
      for (const bit of lastBits) ports.get(current).get(bit).player = Number(args[0]) || 1
    }
  }
  return ports
}

const ANALOG = /IPT_(PEDAL|PADDLE|AD_STICK|LIGHTGUN|DIAL|TRACKBALL|POSITIONAL|MOUSE)/
function buttonCount(blocks, inputName) {
  const ports = evaluatePorts(blocks, inputName)
  let joystick = false
  let analog = false
  let maxButton = 0
  for (const bits of ports.values()) {
    for (const { type, player } of bits.values()) {
      if (player !== 1) continue
      if (/IPT_JOYSTICK/.test(type)) joystick = true
      if (ANALOG.test(type)) analog = true
      const button = /^IPT_BUTTON(\d+)$/.exec(type)
      if (button) maxButton = Math.max(maxButton, Number(button[1]))
    }
  }
  if (!joystick || analog || maxButton < 1 || maxButton > 6) return undefined
  return maxButton <= 2 ? 2 : maxButton <= 4 ? 4 : 6
}

// ── 主流程 ──────────────────────────────────────────────────

function statusOf(flags) {
  if (/MACHINE_IS_BIOS_ROOT/.test(flags)) return 'bios'
  if (/MACHINE_NOT_WORKING|MACHINE_MECHANICAL/.test(flags)) return 'not-working'
  if (/MACHINE_NODEVICE_LAN/.test(flags)) return 'needs-link'
  if (/MACHINE_IMPERFECT|MACHINE_UNEMULATED_PROTECTION|MACHINE_NO_SOUND/.test(flags)) return 'imperfect'
  return 'ok'
}

const encodeRoms = (roms) => roms.map((rom) => `${rom.name}:${rom.crc}:${rom.size.toString(16)}`).join(' ')

const rows = []
const devices = new Map()
for (const driver of driverList) {
  const file = join(root, 'src/mame', driver)
  if (!existsSync(file)) throw new Error(`找不到驱动源码 ${file}`)
  const source = loadSource(file)
  const romBlocks = parseRomBlocks(source)
  const functions = configFunctions(source)
  const inputs = inputBlocks(source)
  const re = /^\s*(GAMEL?)\s*\(/gm
  for (let m; (m = re.exec(source.text));) {
    const { args, end } = callArgs(source.text, m.index + m[0].length - 1)
    re.lastIndex = end
    const [year, name, parent, machine, input, stateClass, , , , title, flags = '0'] = args
    const status = statusOf(flags)
    if (status === 'bios') continue
    const block = romBlocks.get(name)
    if (!block) throw new Error(`${driver}：${name} 没有 ROM_START`)
    const roms = requiredRoms(block, null)
    if (!roms.length) throw new Error(`${driver}：${name} 没有可校验的 ROM`)
    const deviceIds = []
    for (const { macro, bios } of resolveMachineDevices(functions, stateClass, machine).values()) {
      for (const requirement of deviceRequirements(macro, bios)) {
        const prior = devices.get(requirement.id)
        if (prior && encodeRoms(prior.roms) !== encodeRoms(requirement.roms)) throw new Error(`设备 ${requirement.id} 出现两份不同的 ROM 清单`)
        devices.set(requirement.id, requirement)
        if (!deviceIds.includes(requirement.id)) deviceIds.push(requirement.id)
      }
    }
    const buttons = buttonCount(inputs, input)
    rows.push({
      r: name,
      p: parent === '0' ? '' : parent,
      t: unquote(title) ?? title,
      y: Number.parseInt(year, 10) || 0,
      b: DRIVERS[driver].board(stateClass),
      s: status,
      ...(buttons ? { k: buttons } : {}),
      v: deviceIds,
      d: block.disks.filter(Boolean),
      f: encodeRoms(roms),
    })
  }
}
rows.sort((a, b) => a.r.localeCompare(b.r))
const deviceRows = [...devices.values()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((device) => ({ i: device.id, n: device.shortname, t: device.title, f: encodeRoms(device.roms) }))

const target = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/mameSetCatalogData.ts')
const body = `/* 自动生成，勿手改：node scripts/gen-mame-set-catalog.mjs <MAME 源码根目录>（见脚本头注释） */
/* eslint-disable */
export const MAME_SET_CATALOG_REVISION = ${JSON.stringify(revision)}
export const MAME_SET_CATALOG_SOURCES: readonly string[] = ${JSON.stringify(driverList)}

export interface MameSetCatalogDeviceRow {
  /** 设备要求的唯一键：短名，或「短名@BIOS」（同一设备不同默认 BIOS 要的 ROM 不同） */
  i: string
  /** MAME 设备短名 = 单独存放时的 ZIP 名（segabill.zip） */
  n: string
  t: string
  /** 空格分隔的 "rom名:crc32:长度(十六进制)" */
  f: string
}

export interface MameSetCatalogRow {
  /** MAME 短名 */
  r: string
  /** 父集短名；空串是父集 */
  p: string
  t: string
  y: number
  /** 板子名（Sega Model 2A-CRX …） */
  b: string
  s: 'ok' | 'imperfect' | 'needs-link' | 'not-working'
  /** 摇杆游戏的动作键数（按 MAME 输入端口推断，映射到本站 2 / 4 / 6）；模拟量操作的游戏不填 */
  k?: 2 | 4 | 6
  /** 需要的设备 ROM（MAME_SET_CATALOG_DEVICES 的 i） */
  v: readonly string[]
  /** 必需 CHD 名 */
  d: readonly string[]
  /** 空格分隔的 "rom名:crc32:长度(十六进制)" */
  f: string
}

export const MAME_SET_CATALOG_DEVICES: readonly MameSetCatalogDeviceRow[] = ${JSON.stringify(deviceRows, null, 0).replace(/\},\{/g, '},\n  {')}

export const MAME_SET_CATALOG: readonly MameSetCatalogRow[] = ${JSON.stringify(rows, null, 0).replace(/\},\{/g, '},\n  {')}
`
writeFileSync(target, body)
console.log(`写入 ${relative(process.cwd(), target)}：${rows.length} 个 set、${deviceRows.length} 组设备 ROM（MAME ${revision}，${driverList.join(', ')}）`)
for (const device of deviceRows) console.log(`  设备 ${device.i}（${device.t}）：${device.f}`)
