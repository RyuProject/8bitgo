/**
 * GBA 低能力浏览器的运行时选择。
 *
 * mGBA 有 HLE BIOS，但它仍需要 WebAssembly；当浏览器只有 WebGL 缺失时，本站的
 * Canvas 2D WebGL1 兼容层可以保留 mGBA 路径，避免转入必须配置专有 GBA BIOS 的 IodineGBA。
 * 没有 WebAssembly 时才用 IodineGBA；这条退路仍需管理员提供合法来源的 BIOS。
 */
export type GbaFallbackRuntime = 'emulatorjs' | 'iodinegba'

export function gbaFallbackRuntime({
  webglUnavailable,
  wasmUnavailable,
  runtimeOverride,
}: {
  webglUnavailable?: boolean
  wasmUnavailable?: boolean
  runtimeOverride?: string | null
}): GbaFallbackRuntime | null {
  if (wasmUnavailable) return 'iodinegba'
  if (!webglUnavailable) return null
  // 管理员明确固定 IodineGBA 时保留配置；否则 mGBA 的 HLE BIOS 可免去站点分发固件。
  return runtimeOverride === 'iodinegba' ? 'iodinegba' : 'emulatorjs'
}
