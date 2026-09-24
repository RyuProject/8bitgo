/**
 * 站内按 HTTP Range 读取、不能再套 ZIP / 8BG 的大光盘平台。
 *
 * 这份名单同时约束探测顺序、后台上传和本地文件选择。漏掉任一处，常见结果是把数 GB
 * 镜像再包一层，播放器无法随机读取，只能整份下载后失败。
 */
export const STREAMING_DISC_PLATFORM_IDS = Object.freeze(['ps2', 'gamecube', 'wii'])

export function isStreamingDiscPlatform(id) {
  return STREAMING_DISC_PLATFORM_IDS.includes(id)
}
