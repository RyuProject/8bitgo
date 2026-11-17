/**
 * NES 默认运行时只看“格式 / mapper 能否被 jsnes 明确认出”，不再看文件大小。
 *
 * 文件大小不是兼容性信号：NROM 也可能因为训练器或容器变大，复杂 mapper 也可能很小；
 * 更严重的是线上 `.8bg` / ZIP 的 Content-Length 是外层压缩包大小，同一份 ROM 换压缩参数
 * 就会被分到另一个引擎，连带让按运行时隔离的存档看起来消失。
 */
export function preferredNesRuntime({
  jsnesNetplay = false,
  jsnesCompatible,
  webglUnavailable = false,
}: {
  jsnesNetplay?: boolean
  jsnesCompatible?: boolean
  webglUnavailable?: boolean
}): 'jsnes' | 'emulatorjs' {
  // EmulatorJS 因 WebGL / WASM / 浏览器语法能力不可用时，只能先试纯 Canvas 的 jsnes。
  // 即使 mapper 已知不兼容，也不能选回必败的 EmulatorJS；jsnes 的启动检查会交给播放器显示限制。
  if (webglUnavailable) return 'jsnes'
  // jsnes 邀请链接只能由 jsnes 接；但已经明确不支持的 mapper 不能强行钉到必败引擎。
  if (jsnesNetplay && jsnesCompatible !== false) return 'jsnes'
  // 未探明、非 iNES、容器包都走兼容面更宽的 EmulatorJS；后台仍可用 runtime 显式覆盖。
  return jsnesCompatible === true ? 'jsnes' : 'emulatorjs'
}
