/**
 * 从构建出的 index.html 推出 Early Hints 用的 `Link` 响应头。
 *
 * Cloudflare 的 Early Hints 只做一件事：把源站 200 HTML 上的 `Link: rel=preload / preconnect`
 * 记下来，下次有人请求同一个 URL 时，在等源站（或边缘缓存）的空档先回一个 103。
 * 中国大陆访客被分到 LAX，首字节动辄 1.5 秒以上；这段时间浏览器本来只能干等，
 * 有了 103 就能先把入口 JS、CSS 和首屏字体拉下来。
 *
 * 为什么从模板里解析、而不是写死：资源文件名带内容哈希，每次构建都变。
 * 写死的 Link 在下一次构建后就指向已删除的文件 —— 103 照发，浏览器白下一个 404。
 *
 * 只挑关键路径上的几项，不照搬模板里的整串 modulepreload：
 *   - 103 里的每一项都和 HTML 抢同一条连接，挑多了反而拖慢 HTML 本身；
 *   - Cloudflare 只认 preload / preconnect，modulepreload 会被丢掉，
 *     所以模块脚本改用 `rel=preload; as=script; crossorigin`，凭证模式与
 *     `<script type="module" crossorigin>` 一致，浏览器能命中同一份预载。
 */

/** 模板里体积最大、又在首屏关键路径上的那个 vendor 块；其余小块交给 HTML 里的 modulepreload */
const VENDOR_CHUNK = /\/assets\/react-vendor-[^/]+\.js$/

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return match ? match[1] : ''
}

/**
 * @param {string} html 构建后的 index.html
 * @returns {string} 逗号分隔的 Link 头；模板里没有构建产物（开发态）时返回空串
 */
export function earlyHintLinks(html) {
  const links = []
  const tags = String(html || '').match(/<(?:link|script)\b[^>]*>/gi) ?? []

  for (const tag of tags) {
    if (/\brel\s*=\s*"preconnect"/i.test(tag)) {
      const href = attr(tag, 'href')
      if (/^https:\/\//i.test(href)) links.push(`<${href}>; rel=preconnect`)
    }
  }
  for (const tag of tags) {
    const href = attr(tag, 'href')
    if (/\brel\s*=\s*"stylesheet"/i.test(tag) && href.startsWith('/assets/')) {
      links.push(`<${href}>; rel=preload; as=style; crossorigin`)
    }
  }
  for (const tag of tags) {
    // nomodule 的 legacy 入口只给老浏览器，现代浏览器预载它就是白下
    if (!/^<script\b/i.test(tag) || !/\btype\s*=\s*"module"/i.test(tag)) continue
    const src = attr(tag, 'src')
    if (src.startsWith('/assets/')) links.push(`<${src}>; rel=preload; as=script; crossorigin`)
  }
  for (const tag of tags) {
    const href = attr(tag, 'href')
    if (/\brel\s*=\s*"modulepreload"/i.test(tag) && VENDOR_CHUNK.test(href)) {
      links.push(`<${href}>; rel=preload; as=script; crossorigin`)
    }
  }
  for (const tag of tags) {
    const href = attr(tag, 'href')
    if (/\brel\s*=\s*"preload"/i.test(tag) && attr(tag, 'as') === 'font' && href.startsWith('/fonts/')) {
      const type = attr(tag, 'type')
      links.push(`<${href}>; rel=preload; as=font${type ? `; type="${type}"` : ''}; crossorigin`)
    }
  }

  // 只有 preconnect 说明模板里没有任何构建产物，这时整条头都不发
  return links.some((link) => link.includes('rel=preload')) ? links.join(', ') : ''
}
