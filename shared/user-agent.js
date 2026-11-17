/**
 * User-Agent 粗粒度归类（浏览器 + 大版本 / 系统 / 设备类型）。
 *
 * 服务端用它给启动诊断包打环境标签（原始 UA 不落库，见 server/src/startup-diagnostics.js）；
 * 浏览器用它判断「AI 临时修补（shared/hotfix.js）的作用范围管不管我」。
 * 两边必须是同一套规则：服务端按「Chrome 132 / Android 12」聚出故障、AI 据此把修补限定在
 * Chrome + Android，浏览器要按同样的判断认出自己，修补才落得到真正出事的那批人身上。
 */

/**
 * 从 User-Agent 归出「浏览器 + 大版本」「系统」「设备类型」三个粗粒度字段，原始 UA 不落库。
 * 顺序有讲究：Edge / Opera / 三星 / 微信 的 UA 里都带 Chrome，Chrome 的 UA 里又带 Safari。
 */
export function classifyUserAgent(ua = '') {
  const s = String(ua)
  const major = (re) => s.match(re)?.[1] ?? ''
  let browser = 'Other'
  let version = ''
  const rules = [
    ['WeChat', /MicroMessenger\/(\d+)/],
    ['QQ', /\bQQ(?:Browser)?\/(\d+)/],
    ['UC', /UCBrowser\/(\d+)/],
    // 国内手机自带 / 应用内浏览器都是 Chromium 改的，UA 照样写 Chrome/xxx，不先认出来就一律成了「Chrome」，
    // 内存不足这类按浏览器分的故障就查不清（2026-11-14 大陆 Chrome 114 / Android 12《拳皇97》）
    ['Quark', /Quark\/(\d+)/],
    ['Huawei Browser', /HuaweiBrowser\/(\d+)/],
    ['Mi Browser', /MiuiBrowser\/(\d+)/],
    ['OPPO Browser', /(?:HeyTapBrowser|OppoBrowser)\/(\d+)/],
    ['vivo Browser', /VivoBrowser\/(\d+)/],
    ['Baidu', /(?:baiduboxapp|BaiduBrowser)\/(\d+)/],
    ['360', /QihooBrowser\/(\d+)/],
    ['Sogou', /SogouMobileBrowser\/(\d+)/],
    ['Samsung', /SamsungBrowser\/(\d+)/],
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /(?:OPR|Opera)\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    // 其它 App 内嵌的 Android WebView（抖音、B 站 …）：UA 带「; wv)」
    ['Android WebView', /; wv\).*?Chrome\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+)[\d.]* (?:Mobile\/\w+ )?Safari\//],
  ]
  for (const [name, re] of rules) {
    const v = major(re)
    if (v) {
      browser = name
      version = v
      break
    }
  }
  if (browser === 'Other' && /AppleWebKit/.test(s) && /\b(?:iPhone|iPad|iPod)\b/.test(s)) browser = 'iOS WebView'

  let os = 'Other'
  const ios = s.match(/\b(?:iPhone|iPad|iPod)\b.*? OS (\d+)/)
  const android = s.match(/Android (\d+)/)
  if (ios) os = `iOS ${ios[1]}`
  else if (android) os = `Android ${android[1]}`
  else if (/Windows NT/.test(s)) os = 'Windows'
  else if (/CrOS/.test(s)) os = 'ChromeOS'
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS'
  else if (/Linux/.test(s)) os = 'Linux'

  const device = /\b(?:iPad|Tablet)\b/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))
    ? 'tablet'
    : /Mobi|iPhone|iPod|Android/.test(s) ? 'mobile' : 'desktop'
  return { browser: version ? `${browser} ${version}` : browser, os, device }
}

/** 「Chrome 132」→「Chrome」，「Huawei Browser 17」→「Huawei Browser」；修补按浏览器家族限定，不钉大版本 */
export function browserFamily(browser = '') {
  return String(browser).replace(/\s+\d+$/, '').trim() || 'Other'
}

/** 「Android 12」→「Android」，「iOS 18」→「iOS」 */
export function osFamily(os = '') {
  return String(os).replace(/\s+\d+$/, '').trim() || 'Other'
}
