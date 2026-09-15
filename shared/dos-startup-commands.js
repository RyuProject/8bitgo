/**
 * 后台与播放器用同一套规则，避免多行命令在保存后才被浏览器拒绝。
 * 这段文本只能进入 [autoexec]，不能通过新节标题改写其他 DOSBox 配置。
 */
export function normalizeDosStartupCommands(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  if (text.length > 4096) throw new Error('DOS 启动前命令过长（上限 4096 字符）')
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('DOS 启动前命令包含无效控制字符')
  if (text.split('\n').some((line) => /^\s*\[[^\]]+\]\s*$/.test(line))) {
    throw new Error('DOS 启动前命令不能填写 [autoexec] 等配置节')
  }
  if (text.split('\n').some((line) => /^\s*(?:mount\s+c\b|c:\s*$)/i.test(line))) {
    throw new Error('播放器已经挂载 C 盘并切换到 C:，启动前命令不要重复填写 mount c 或 c:')
  }
  return text
}
