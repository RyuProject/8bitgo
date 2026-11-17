/** HTML5 游戏绑定的是网页入口，不是按扩展名交给模拟器识别的 ROM。 */
export function normalizeHtml5Entry(value: string): string {
  const entry = value.trim()
  if (!entry || /^https?:\/\//i.test(entry)) return entry
  if (entry.startsWith('//')) return `https:${entry}`
  if (entry.startsWith('/')) return entry
  const scheme = entry.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]
  // my-game.example:8443 是带端口的裸域名，不能误认成自定义协议。
  if (scheme && !scheme.includes('.')) return entry

  const host = entry.split(/[/?#]/, 1)[0] ?? ''
  // 把常见的裸域名补成 HTTPS；像 html5/<slug>/index.html 这样的存储 key 留给表单校验拦下。
  if ((host.includes('.') && !/\.(?:html?|zip|8bg|nes|gba|gbc|sfc|smc|iso|chd)$/i.test(host)) || /^localhost(?::\d+)?$/i.test(host)) {
    return `https://${entry}`
  }
  return entry
}

/** 是否已经是可直接导航的网页地址（含本站内置页的站内路径）。 */
export function isHtml5EntryUrl(value: string): boolean {
  const entry = normalizeHtml5Entry(value)
  if (html5EntryProblem(entry)) return false
  return /^https?:\/\//i.test(entry) || (entry.startsWith('/') && !entry.startsWith('//'))
}

/** 返回不适合作为 HTML5 网页入口的原因；同源绝对路径只用于本站内置游戏。 */
export function html5EntryProblem(value: string): string | null {
  const entry = normalizeHtml5Entry(value)
  if (!entry) return null
  if (/\.8bg(?:$|[?#])/i.test(entry)) return 'HTML5 游戏需要网页入口，不能填写 .8bg 容器下载地址'
  if (entry.startsWith('/') && !entry.startsWith('//')) return null

  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return 'HTML5 游戏请填写完整网址（例如 https://game.example.com/），不能填写 ROM 存储 key'
  }
  if (url.protocol !== 'https:') return 'HTML5 游戏网址必须使用 HTTPS，才能安全嵌入 8BitGo'
  if (url.username || url.password) return 'HTML5 游戏网址不能包含账号或密码'
  if (/\.8bg$/i.test(url.pathname)) return 'HTML5 游戏需要网页入口，不能填写 .8bg 容器下载地址'
  return null
}
