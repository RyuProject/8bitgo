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
  for (const line of text.split('\n')) {
    if (!/^\s*imgmount\b/i.test(line) || !/\.cue\b/i.test(line)) continue
    const match = /^\s*imgmount\s+[a-z]\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(line)
    if (!match) throw new Error(`CUE 挂载命令格式无效：${line.trim()}`)
    const cuePath = (match[1] ?? match[2] ?? match[3]).replace(/\\/g, '/').replace(/^\.\//, '')
    // 浏览器里的 DOSBox-X 只能看见 ZIP 解出来的虚拟文件；站长电脑上的 D:\\ 路径线上不存在。
    if (cuePath.startsWith('/') || cuePath.includes(':') || cuePath.split('/').includes('..')) {
      throw new Error(`CUE 镜像必须填写 ZIP 内的相对路径，不能填写电脑本地路径：${cuePath}`)
    }
  }
  return text
}
