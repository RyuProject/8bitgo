export function findEmscriptenWasmFile(source) {
  const start = source.indexOf('function findWasmBinary(){')
  const end = start < 0 ? -1 : source.indexOf('function getBinarySync', start)
  if (end < 0) throw new Error('js-dos Emscripten 找不到 WASM 文件定位函数')
  const names = new Set([...source.slice(start, end).matchAll(/(?:locateFile|new URL)\("([^\"]+\.wasm)"/g)].map((match) => match[1]))
  if (names.size !== 1) throw new Error(`js-dos Emscripten WASM 定位结果不是唯一的：${[...names].join(', ') || '无'}`)
  return [...names][0]
}

export function createVerifiedInstantiateAsync({ file, bytes, sha256 }) {
  if (!/^[\w.-]+\.wasm$/.test(file) || !Number.isSafeInteger(bytes) || bytes < 8 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('js-dos WASM 完整性配置无效')
  }
  return `var __8bitgoWasmIntegrity=Object.freeze(${JSON.stringify({ file, bytes, sha256 })});\n` +
    `async function instantiateAsync(binary,binaryFile,imports){\n` +
    `var wasmBytes;\n` +
    `if(binary){\n` +
    `wasmBytes=ArrayBuffer.isView(binary)?new Uint8Array(binary.buffer,binary.byteOffset,binary.byteLength):new Uint8Array(binary);\n` +
    `}else{\n` +
    `var response=await fetch(binaryFile,{credentials:"same-origin"});\n` +
    `if(!response.ok)throw new Error("js-dos WASM 请求失败："+response.status);\n` +
    `if(response.body&&typeof response.body.getReader==="function"){\n` +
    `var reader=response.body.getReader();wasmBytes=new Uint8Array(__8bitgoWasmIntegrity.bytes);var loaded=0;\n` +
    `try{for(;;){var part=await reader.read();if(part.done)break;if(!part.value)continue;if(loaded+part.value.byteLength>wasmBytes.byteLength){try{await reader.cancel()}catch{}throw new Error("js-dos WASM 超过可信长度")}wasmBytes.set(part.value,loaded);loaded+=part.value.byteLength}}\n` +
    `catch(error){try{await reader.cancel(error)}catch{}throw error}\n` +
    `if(loaded!==wasmBytes.byteLength)throw new Error("js-dos WASM 下载不完整："+loaded+"/"+wasmBytes.byteLength);\n` +
    `}else{wasmBytes=new Uint8Array(await response.arrayBuffer())}\n` +
    `}\n` +
    `if(wasmBytes.byteLength!==__8bitgoWasmIntegrity.bytes)throw new Error("js-dos WASM 长度不符："+wasmBytes.byteLength+"/"+__8bitgoWasmIntegrity.bytes);\n` +
    `if(!globalThis.crypto||!globalThis.crypto.subtle)throw new Error("浏览器不支持 js-dos WASM SHA-256 校验");\n` +
    `var digest=new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",wasmBytes));\n` +
    `var actual=Array.from(digest,function(value){return value.toString(16).padStart(2,"0")}).join("");\n` +
    `if(actual!==__8bitgoWasmIntegrity.sha256)throw new Error("js-dos WASM SHA-256 不匹配："+__8bitgoWasmIntegrity.file);\n` +
    `return WebAssembly.instantiate(wasmBytes,imports)\n` +
    `}`
}

/** 只替换 Emscripten 自己的单个 WASM 加载函数，不改 Worker 或页面的全局网络 API。 */
export function patchEmscriptenWasmLoader(source, expected) {
  let wasmFile
  try { wasmFile = findEmscriptenWasmFile(source) } catch (error) {
    throw new Error(`js-dos Emscripten WASM 定位结构无效：${error instanceof Error ? error.message : String(error)}`)
  }
  if (wasmFile !== expected.file) {
    throw new Error(`js-dos Emscripten WASM 定位结构与可信清单不符：${expected.file}`)
  }
  const starts = [...source.matchAll(/async function instantiateAsync\(binary,binaryFile,imports\)\{/g)]
  if (starts.length !== 1) throw new Error(`js-dos ${expected.file} 的 instantiateAsync 结构不是唯一的`)
  const start = starts[0].index
  const end = source.indexOf('function getWasmImports', start)
  if (end < 0) throw new Error(`js-dos ${expected.file} 缺少 getWasmImports 边界`)
  const original = source.slice(start, end)
  if (!original.includes('WebAssembly.instantiateStreaming') || !original.includes('instantiateArrayBuffer(binaryFile,imports)')) {
    throw new Error(`js-dos ${expected.file} 的 WASM 加载流程已变化，拒绝套用校验补丁`)
  }
  return source.slice(0, start) + createVerifiedInstantiateAsync(expected) + source.slice(end)
}
