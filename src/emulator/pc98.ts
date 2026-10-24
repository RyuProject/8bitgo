/**
 * PC-98 在站内仍归属 DOS 分类；这里仅识别其启动软盘格式。
 *
 * 这个小模块刻意不依赖 js-dos 打包器。播放器在选择本地文件时也要判断扩展名，
 * 若从主播放器入口引入 ZIP 读写实现，会让所有平台都多下载一份无关代码。
 */
const PC98_FDI_EXT = /\.fdi$/i

export function isPc98FdiFileName(name: string): boolean {
  const leaf = String(name ?? '').split(/[\\/]/).pop() ?? ''
  return PC98_FDI_EXT.test(leaf)
}
