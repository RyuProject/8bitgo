/**
 * PPSSPP 的 v128 invoke 跳板。
 *
 * 2026-11-15 QQ Browser 21《初音未来：歌姬计划》玩到 879 秒报
 * `TypeError: type incompatibility when transforming from/to JS`。取证（v22/v23 同一份 Wasm）：
 * Wasm 只有两个 JS 导入签名带 v128 —— `invoke_iiViijjji` / `invoke_iiViijjjij`，调用点全部在同一个
 * 函数里，它引用 "Pause button" / "Circle button" / "Fast-forward button" 等字符串，对应
 * UI/GamepadEmu.cpp 的 GamepadEmuView 构造函数（PPSSPP 自带的屏幕触控按键，表索引 2612 / 2613
 * 是 addBoolButton / addPSPButton 两个 lambda）。JS-API 规定 v128 不能跨 Wasm/JS 边界，任何浏览器
 * 调到这两个导入都会抛这个 TypeError，与 QQ 内核无关；桌面 SDL 构建 ShowTouchControls 默认关闭，
 * 只有玩家在 PPSSPP 菜单里打开「屏幕触控」（或旧存的配置里开着）时才会走到，所以表现为玩到一半崩。
 *
 * 不重编核心的修法：这两个 invoke_ 只是「按表索引调函数，C++ 异常时 setThrew」。用一个几十字节的
 * Wasm 模块实现同签名的导出，内部 call_indirect，Wasm→Wasm 调用不经过 JS，v128 照常传递。
 * 它导入一张 JS 创建的表，主模块实例化后把主表内容抄进去（每个线程各一次）。代价：被调函数抛
 * C++ 异常时不再在这一层 setThrew，而是交给更外层的 invoke_ —— 这里被调的是按钮构造，异常只可能
 * 是 bad_alloc，原本整局也救不回来；而原来连正常调用都必崩。
 */

const VALTYPES = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' }
const VALCODES = Object.fromEntries(Object.entries(VALTYPES).map(([code, name]) => [name, Number(code)]))
export const SIMD_TRAMPOLINE_MARKER = '__8bitgoSimdTrampolines'

const reader = (bytes) => {
  let p = 0
  return {
    get pos() { return p },
    set pos(value) { p = value },
    byte: () => bytes[p++],
    u32() {
      let result = 0
      let shift = 0
      let b
      do {
        b = bytes[p++]
        result |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      return result >>> 0
    },
    name() {
      const length = this.u32()
      const text = new TextDecoder().decode(bytes.subarray(p, p + length))
      p += length
      return text
    },
  }
}

/** 读出 Wasm 的类型表和函数导入（只认 MVP 值类型 + v128；其它类型直接报错，不猜）。 */
export function readWasmFunctionImports(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view[0] !== 0 || view[1] !== 0x61 || view[2] !== 0x73 || view[3] !== 0x6d) throw new Error('不是 Wasm 文件')
  const r = reader(view)
  r.pos = 8
  const types = []
  const imports = []
  const valtype = () => {
    const code = r.byte()
    const name = VALTYPES[code]
    if (!name) throw new Error(`未知值类型 0x${code.toString(16)}`)
    return name
  }
  const limits = () => {
    const flags = r.u32()
    r.u32()
    if (flags & 1) r.u32()
  }
  while (r.pos < view.length) {
    const id = r.byte()
    const size = r.u32()
    const end = r.pos + size
    if (id === 1) {
      const count = r.u32()
      for (let i = 0; i < count; i++) {
        if (r.byte() !== 0x60) throw new Error('类型段含非函数类型')
        const params = Array.from({ length: r.u32() }, valtype)
        const results = Array.from({ length: r.u32() }, valtype)
        types.push({ params, results })
      }
    } else if (id === 2) {
      const count = r.u32()
      for (let i = 0; i < count; i++) {
        const module = r.name()
        const field = r.name()
        const kind = r.byte()
        if (kind === 0) imports.push({ module, field, ...types[r.u32()] })
        else if (kind === 1) { r.byte(); limits() }
        else if (kind === 2) limits()
        else if (kind === 3) { r.byte(); r.byte() }
        else if (kind === 4) { r.byte(); r.u32() }
        else throw new Error(`未知导入种类 ${kind}`)
      }
      return imports
    }
    r.pos = end
  }
  return imports
}

/**
 * 找出签名里带 v128 的 JS 导入，并在胶水里核对它们都是 invoke_ 包装（只有这种语义可以换成
 * call_indirect 跳板）。返回 [{ field, params, results, glueName }]。
 */
export function findV128InvokeImports(wasmBytes, glue) {
  const found = []
  for (const entry of readWasmFunctionImports(wasmBytes)) {
    if (![...entry.params, ...entry.results].includes('v128')) continue
    const match = glue.match(new RegExp(`[{,]${entry.field.replace(/[$]/g, '\\$')}:(invoke_[A-Za-z]+)[,}]`))
    if (!match) throw new Error(`v128 导入 ${entry.module}.${entry.field} 在胶水里找不到对应的 invoke_ 包装；不要盲目替换`)
    if (entry.params[0] !== 'i32') throw new Error(`${match[1]} 第一个参数不是表索引`)
    const body = glue.match(new RegExp(`function ${match[1]}\\(index,[^)]*\\)\\{var sp=stackSave\\(\\);try\\{return getWasmTableEntry\\(index\\)\\(`))
      || glue.match(new RegExp(`function ${match[1]}\\(index,[^)]*\\)\\{var sp=stackSave\\(\\);try\\{getWasmTableEntry\\(index\\)\\(`))
    if (!body) throw new Error(`${match[1]} 不是标准的 Emscripten invoke 包装`)
    found.push({ field: entry.field, params: entry.params, results: entry.results, glueName: match[1] })
  }
  return found
}

const uleb = (value) => {
  const out = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return out
}
const str = (text) => {
  const bytes = [...new TextEncoder().encode(text)]
  return [...uleb(bytes.length), ...bytes]
}
const vec = (items) => [...uleb(items.length), ...items.flat()]
const section = (id, body) => [id, ...uleb(body.length), ...body]
const functype = (params, results) => [0x60, ...vec(params.map((t) => [VALCODES[t]])), ...vec(results.map((t) => [VALCODES[t]]))]

/**
 * 生成跳板模块：导入 e.t（funcref 表），对每个 v128 导入导出同名、同签名的函数，
 * 函数体 = 把除表索引外的参数原样压栈 + call_indirect。
 */
export function buildSimdTrampolineModule(entries) {
  if (!entries.length) throw new Error('没有需要跳板的导入')
  const types = []
  for (const entry of entries) {
    types.push(functype(entry.params, entry.results))
    types.push(functype(entry.params.slice(1), entry.results))
  }
  const importSection = vec([[...str('e'), ...str('t'), 0x01, 0x70, 0x00, 0x00]])
  const funcSection = vec(entries.map((_, i) => uleb(i * 2)))
  const exportSection = vec(entries.map((entry, i) => [...str(entry.field), 0x00, ...uleb(i)]))
  const bodies = entries.map((entry, i) => {
    const code = []
    for (let p = 1; p < entry.params.length; p++) code.push(0x20, ...uleb(p))
    code.push(0x20, 0x00, 0x11, ...uleb(i * 2 + 1), 0x00, 0x0b)
    const body = [0x00, ...code]
    return [...uleb(body.length), ...body]
  })
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, importSection),
    ...section(3, funcSection),
    ...section(7, exportSection),
    ...section(10, vec(bodies)),
  ])
}

/** 运行时代码：每个线程建一次跳板实例，替换导入；主模块实例化后把主表抄进跳板的表。 */
export function simdTrampolineRuntime(entries, moduleBytes) {
  const names = JSON.stringify(entries.map((entry) => entry.field))
  return `var ${SIMD_TRAMPOLINE_MARKER}=null;` +
    `function __8bitgoInstallSimdTrampolines(imports){` +
    `try{if(!${SIMD_TRAMPOLINE_MARKER}){var table=new WebAssembly.Table({element:"anyfunc",initial:0});` +
    `var instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([${Array.from(moduleBytes).join(',')}])),{e:{t:table}});` +
    `${SIMD_TRAMPOLINE_MARKER}={table:table,exports:instance.exports,source:null}}` +
    `for(var name of ${names})imports[name]=${SIMD_TRAMPOLINE_MARKER}.exports[name]}` +
    `catch(e){${SIMD_TRAMPOLINE_MARKER}=null;err("[8bitgo] v128 invoke 跳板不可用，屏幕触控按键会在创建时出错: "+e)}}` +
    `function __8bitgoFillSimdTrampolineTable(){var state=${SIMD_TRAMPOLINE_MARKER};` +
    `if(!state||!wasmTable||state.source===wasmTable)return;` +
    `var size=wasmTable.length;if(state.table.length<size)state.table.grow(size-state.table.length);` +
    `for(var i=0;i<size;i++)state.table.set(i,wasmTable.get(i));state.source=wasmTable}`
}

const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} 锚点缺失或不唯一；不要把 v128 跳板套到不同的 Emscripten 输出`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

/** 给胶水装上跳板。幂等：已装过则拒绝（实体目录不可变，不应重复处理同一份文件）。 */
export function installSimdTrampolines(glue, wasmBytes) {
  if (glue.includes(SIMD_TRAMPOLINE_MARKER)) throw new Error('胶水里已经有 v128 跳板')
  const entries = findV128InvokeImports(wasmBytes, glue)
  const moduleBytes = buildSimdTrampolineModule(entries)
  if (!WebAssembly.validate(moduleBytes)) throw new Error('生成的 v128 跳板模块校验失败')
  let out = replaceOnce(glue, 'var wasmImports;function assignWasmImports(){',
    `${simdTrampolineRuntime(entries, moduleBytes)}var wasmImports;function assignWasmImports(){`, 'wasmImports 定义')
  out = replaceOnce(out, 'function getWasmImports(){assignWasmImports();',
    'function getWasmImports(){assignWasmImports();__8bitgoInstallSimdTrampolines(wasmImports);', 'getWasmImports')
  out = replaceOnce(out, 'assignWasmExports(wasmExports);wasmModule=module;',
    'assignWasmExports(wasmExports);__8bitgoFillSimdTrampolineTable();wasmModule=module;', 'receiveInstance')
  return { glue: out, entries, moduleBytes }
}
