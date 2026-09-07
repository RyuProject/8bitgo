// robots.txt 的规则测试。跑：npm run test:robots
//
// 存在的理由（2026-09-06 的事故）：
// 老版本写着 `Disallow: /*/me`，本意是挡住 /en/me 这类个人中心。
// 但 robots.txt 的 `*` 匹配任意字符（**含 /**），整条规则又是**前缀匹配**，
// 于是它展开成「/ + 任意 + /me」—— `/games/metal-slug-3` 里的 `/games/me`
// 正好命中，全站 6 款《合金弹头》× 8 种语言 = 48 个已在 sitemap 里的 URL
// 被自家 robots.txt 挡住。`/*/admin`、`/*/login` 是同一个雷。
//
// 下面用的是 RFC 9309（Google 现行实现）的裁决规则：
//   匹配到的规则里**路径最长的那条**说了算，长度相同时 Allow 优先。
// 纯 node，无依赖，Linux / macOS 都能跑。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_DEFAULT_LANGUAGE, SITE_LANGUAGES } from '../shared/site-languages.js'
import { normalizeUrl } from '../server/src/url-normalize.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ROBOTS = path.join(root, 'public/robots.txt')
const text = readFileSync(ROBOTS, 'utf8')

/** 解析出 User-agent: * 那一组的 Allow / Disallow */
function parseRules(src) {
  const rules = []
  let inStar = false
  for (const raw of src.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const ua = /^User-agent\s*:\s*(\S+)$/i.exec(line)
    if (ua) {
      inStar = ua[1] === '*'
      continue
    }
    const rule = /^(Allow|Disallow)\s*:\s*(\S*)$/i.exec(line)
    if (rule && inStar) rules.push({ allow: rule[1].toLowerCase() === 'allow', pattern: rule[2] })
  }
  return rules
}

const RULES = parseRules(text)

function patternMatches(pattern, url) {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const re = new RegExp(
    '^' + body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''),
  )
  return re.test(url)
}

/** 返回 { allowed, rule }：命中的最长规则说了算，等长 Allow 优先 */
function decide(url) {
  let best = null
  for (const r of RULES) {
    if (!patternMatches(r.pattern, url)) continue
    const len = r.pattern.length
    if (!best || len > best.len || (len === best.len && r.allow)) best = { ...r, len }
  }
  return { allowed: best ? best.allow : true, rule: best?.pattern ?? '(无规则命中)' }
}

const langPrefixes = SITE_LANGUAGES.map((l) => (l.code === SITE_DEFAULT_LANGUAGE ? '' : `/${l.code}`))

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function assertAllowed(url) {
  const { allowed, rule } = decide(url)
  assert.ok(allowed, `${url} 应当可抓，却被 "${rule}" 挡住了`)
}
function assertBlocked(url) {
  const { allowed } = decide(url)
  assert.ok(!allowed, `${url} 应当被挡住，实际放行`)
}

check('语言前缀取自 shared/site-languages.js，且简体中文是裸路径', () => {
  assert.ok(langPrefixes.includes(''), '默认语言必须是裸路径')
  assert.equal(langPrefixes.length, SITE_LANGUAGES.length)
})

check('内容页一律可抓 —— 尤其是 me / admin / login 开头的 slug', () => {
  // 这几条就是当年被 /*/me、/*/admin、/*/login 误伤的形状，一条都不能再中
  const paths = [
    '/games/metal-slug-3',
    '/games/metal-slug-x-super-vehicle-001',
    '/games/mega-man-2',
    '/games/admiral-quest',
    '/games/logic-puzzle',
    '/platforms/megadrive',
    '/genres/mecha',
    '/blog/memory-card-guide',
    '/collections/42',
    '/games',
    '/platforms',
    '/genres',
    '/developers',
    '/blog',
    '/about',
    '/play-local',
    '/',
  ]
  for (const prefix of langPrefixes) for (const p of paths) assertAllowed(prefix + (p === '/' ? '' : p) || '/')
})

check('平台页 / 类型页的分页可抓（深层游戏靠它被发现）', () => {
  for (const prefix of langPrefixes) {
    assertAllowed(`${prefix}/platforms/nes?page=2`)
    assertAllowed(`${prefix}/genres/rpg?page=5`)
  }
})

check('游戏库的干净分页放行，带筛选的组合仍然挡住', () => {
  for (const prefix of langPrefixes) {
    assertAllowed(`${prefix}/games?page=2`)
    assertBlocked(`${prefix}/games?platform=gba&page=2`)
    assertBlocked(`${prefix}/games?genre=rpg`)
    assertBlocked(`${prefix}/games?sort=rating`)
    assertBlocked(`${prefix}/games?q=zelda`)
  }
})

check('站内搜索无限空间不抓', () => {
  assertBlocked('/blog?q=nes')
  assertBlocked('/en/collections?q=x')
})

check('后台 / 个人中心 / 登录页仍然挡住（含全部语言前缀）', () => {
  for (const prefix of langPrefixes) {
    assertBlocked(`${prefix}/admin`)
    assertBlocked(`${prefix}/admin/games`)
    assertBlocked(`${prefix}/me`)
    assertBlocked(`${prefix}/login`)
  }
})

check('没有任何一条规则使用「/*/」这种会吃掉整段路径的通配写法', () => {
  const risky = RULES.filter((r) => !r.allow && /^\/\*\//.test(r.pattern))
  assert.deepEqual(
    risky.map((r) => r.pattern),
    [],
    '`Disallow: /*/xxx` 会命中 /games/xxx… 这类内容页，改成逐语言前缀列全',
  )
})

check('只有一组 User-agent，且是 *（点名放行等于放弃对私密路径的约束）', () => {
  const uas = [...text.matchAll(/^User-agent\s*:\s*(\S+)$/gim)].map((m) => m[1])
  assert.deepEqual(uas, ['*'])
})

check('声明了 sitemap 入口', () => {
  assert.match(text, /^Sitemap:\s*https:\/\/8bitgo\.com\/sitemap\.xml$/m)
})

/* ---------------- URL 归一（尾斜杠 + /index.html） ---------------- */

/** 极简的 req/res 替身，只实现中间件用到的那几个方法 */
function run(method, originalUrl) {
  const out = { nexted: false, status: 0, location: '', headers: {} }
  const req = { method, originalUrl }
  const res = {
    set(h) {
      Object.assign(out.headers, h)
      return res
    },
    redirect(status, location) {
      out.status = status
      out.location = location
    },
  }
  normalizeUrl(req, res, () => {
    out.nexted = true
  })
  return out
}

check('尾斜杠 301 到无斜杠，查询串原样带过去', () => {
  assert.deepEqual(
    [run('GET', '/games/').status, run('GET', '/games/').location],
    [301, '/games'],
  )
  assert.equal(run('GET', '/en/games/metal-slug-3/').location, '/en/games/metal-slug-3')
  assert.equal(run('GET', '/games/?page=2').location, '/games?page=2')
  // 百分号编码不能被重新编码一遍
  assert.equal(run('GET', '/games/?q=%E9%AD%82%E6%96%97%E7%BE%85/').location, '/games?q=%E9%AD%82%E6%96%97%E7%BE%85/')
})

check('不该动的一律放行', () => {
  for (const url of ['/', '/games', '/en/games/metal-slug-3', '/api/games/', '/games?page=2']) {
    assert.ok(run('GET', url).nexted, `${url} 不该被重定向`)
  }
  // 写请求不碰
  assert.ok(run('POST', '/api/games/').nexted)
  assert.ok(run('PUT', '/games/').nexted)
})

check('/index.html 必须 301 到目录本身', () => {
  /*
    这条是 Search Console 报「被 noindex 标记排除」查出来的（2026-09-07，
    示例 URL 是 http://www.8bitgo.com/index.html）。病灶：index.html 是
    dist/client/ 里的真实文件，express.static 的 index:false 只管目录请求，
    显式请求它照样被静态中间件吐出去、绕过 SSR —— 于是首页多一个
    可收录、无 canonical 的副本，而 Google 跑完 JS 又会被 SPA 的 404 页改成 noindex。
  */
  assert.deepEqual([run('GET', '/index.html').status, run('GET', '/index.html').location], [301, '/'])
  assert.equal(run('GET', '/it/index.html').location, '/it')
  assert.equal(run('GET', '/en/games/index.html').location, '/en/games')
  // 查询串照旧原样带过去
  assert.equal(run('GET', '/index.html?utm_source=x').location, '/?utm_source=x')
  // 大小写：固定文件名，不是 slug，所以这一条要归一
  assert.equal(run('GET', '/INDEX.HTML').location, '/')
  // 尾斜杠和 index.html 同时出现时只吃**一次** 301，不要链式跳
  assert.equal(run('GET', '/it/terms/index.html/').location, '/it/terms')
})

check('⚠️ 去 index.html 的正则不能少了两头的锚 —— 少一头就切错别的路径', () => {
  // 少了前面的 (^|/)：/myindex.html 会被切成 /my
  assert.ok(run('GET', '/myindex.html').nexted, '/myindex.html 不该被动')
  assert.ok(run('GET', '/games/myindex.html').nexted)
  // 少了后面的 $：带哈希的产物和别的扩展名会中招
  for (const url of ['/assets/index-abc123.js', '/index.htmlx', '/index.html.bak', '/index.json']) {
    assert.ok(run('GET', url).nexted, `${url} 不该被动`)
  }
  // 开放重定向那道防线不能被新加的这一步绕开
  assert.equal(run('GET', '//evil.com/index.html').location, '/evil.com')
  assert.ok(!run('GET', '//evil.com/index.html').location.startsWith('//'))
})

check('开头的多余斜杠必须折掉 —— 否则就是一个跳到外站的开放重定向', () => {
  for (const url of ['//evil.com/', '///evil.com/', '//evil.com/path/']) {
    const { location } = run('GET', url)
    assert.ok(location.startsWith('/') && !location.startsWith('//'), `${url} → ${location} 是协议相对 URL`)
  }
  assert.equal(run('GET', '//evil.com/').location, '/evil.com')
})

/* ---------------- 爬虫看到的状态码 ---------------- */

const ssrSrc = readFileSync(new URL('../server/src/ssr.js', import.meta.url), 'utf8')

check('SSR 降级返回 503 而不是 200', () => {
  // 降级返回的是空壳（root 里没内容、head 是模板默认值）。用 200 等于告诉爬虫
  // 「这就是这个 URL 的正确内容」，SSR 出问题的那段时间抓到的页面会全部以
  // 千篇一律的标题进索引，恢复后还要等重抓才能纠正。503 = 临时，等会儿再来。
  const branch = ssrSrc.slice(ssrSrc.indexOf('[ssr] 渲染失败'))
  assert.match(branch, /\.status\(503\)/, '降级分支必须回 503')
  assert.doesNotMatch(branch, /\.status\(200\)/, '降级分支不能回 200')
  assert.match(branch, /'Retry-After'/, '503 要带 Retry-After')
  assert.match(branch, /CACHE\.none/, '空壳绝不能进边缘缓存，否则故障恢复后还在发')
})

check('渲染出「页面不存在」时仍然回 404，不是 200', () => {
  // 一律 200 就是软 404：页面上写着 GAME OVER，状态码却告诉爬虫一切正常
  assert.match(ssrSrc, /status\(notFound \? 404 : 200\)/)
})

/* ---------------- 禁抓的地址一律不出现在 href 里 ---------------- */

/*
  src/lib/seoLinks.ts 的 isCrawlableInternal() 决定一个站内目标爬虫能不能进。
  它**不重新实现** robots，只表达同一个意图 —— 而「同一个意图」是最容易悄悄漂的东西：
  哪天 robots.txt 放行了 /games?sort= 之类，代码这边还在藏 href，就白丢内链权重；
  反过来新增一条 Disallow，代码这边不跟就又造出一批可抓的死路。
  所以这里拿上面那个真 robots 模拟器逐条对着核。

  ⚠️ 2026-09-07 把策略从 rel="nofollow" 换成了「根本不出 href」：nofollow 只是
  不传权重，**挡不住发现**，那些 ?q= / ?developer= 照样被 Google 排进抓取队列，
  然后堆在 Search Console 的「已被 robots.txt 屏蔽」里，把真事故盖住
  （09-06 那 48 个《合金弹头》就是这么被埋了一天）。目标是让那一档能归零。
*/
const { isCrawlableInternal } = await import('../src/lib/seoLinks.ts')

check('可抓判据和 robots.txt 的裁决逐条一致', () => {
  const targets = [
    '/games',
    '/games?page=2',
    '/games?q=x',
    '/games?developer=Nintendo',
    '/games?multiplayer=1',
    '/games?coin=1',
    '/games?sort=newest',
    '/games?sort=popular',
    '/games?platform=gba&page=2',
    '/games/metal-slug-3',
    '/genres/action',
    '/platforms/nes?page=2',
    '/collections',
  ]
  for (const to of targets) {
    const allowed = decide(to).allowed
    assert.equal(
      isCrawlableInternal(to),
      allowed,
      `${to}：robots ${allowed ? '放行' : '禁抓'}，而 isCrawlableInternal 说的是相反的`,
    )
  }
})

/** 源码里 idx 这个位置所在的那个 JSX 标签叫什么（往回找最近的 `<`） */
function ownerTagOf(src, idx) {
  const before = src.slice(0, idx)
  const lt = before.lastIndexOf('<')
  return /^<([A-Za-z][\w.]*)/.exec(before.slice(lt))?.[1] ?? '(认不出来)'
}

const tsxFiles = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) tsxFiles(full, out)
    else if (e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/*
  扫描前先把注释剥掉：仓库里有好几处注释在**引用旧写法**
  （EmulatorPlayer / GameDetailPage 里那句「它以前是个跳转链接（to="/games?multiplayer=1"）」），
  不剥的话这个检查会对着注释报错，而注释里那行本来就已经不是代码了。
*/
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
/*
  后台（src/admin/）整个排除：那些页面在 /admin 底下，本身就禁抓，爬虫根本渲染不到，
  里面互相跳的 /admin/xxx 链接不会被任何人发现。这里只管**公开页面**发出去的链接。
*/
const SOURCES = tsxFiles(path.join(root, 'src'))
  .filter((file) => !path.relative(root, file).startsWith(path.join('src', 'admin')))
  .map((file) => ({
    file: path.relative(root, file),
    src: strip(readFileSync(file, 'utf8')),
  }))

check('没有哪个组件把禁抓地址写进 href —— 一律走 InternalLink', () => {
  /*
    冒烟性质的源码扫描。取每一处写死的 to=`…` / to="…"，把 ${} 之前的那一截
    交给 robots 模拟器裁决（查询参数名一定在插值之前，够判了），
    禁抓的必须挂在 <InternalLink> 上 —— 那个组件不发 href，改走客户端跳转。
  */
  const TO = /\bto=(?:\{`([^`]*)`|"([^"]*)")/g
  let blocked = 0
  for (const { file, src } of SOURCES) {
    for (const m of src.matchAll(TO)) {
      const url = (m[1] ?? m[2]).split('${')[0]
      if (!url.startsWith('/')) continue
      if (decide(url).allowed) continue
      /*
        只管带查询串的那一族（/games? 的筛选与搜索）—— InternalLink 就是为它们存在的。
        禁抓的**路径**页（/me、/login）不在此列，这是刻意的：
          · Sidebar 那三处 /me 挂在 `user ? …` 底下，匿名的爬虫根本渲染不到；
          · OAuthCallbackPage 那个 /login 在一个 noindex 的回调页上；
          · 而且它们是玩家会收藏、会开新标签的真实页面，值得保留真链接。
        真要收紧，先去确认爬虫是不是真能看到那一条，别一刀切。
      */
      if (!url.includes('?')) continue
      blocked++
      assert.equal(
        ownerTagOf(src, m.index),
        'InternalLink',
        `${file} 里 to="${url}…" 是 robots 禁抓的地址，却挂在真链接上 —— ` +
          '换成 <InternalLink>（见 src/lib/seoLinks.ts：nofollow 挡不住发现）',
      )
    }
  }
  assert.ok(blocked > 0, '一处禁抓目标都没扫到 —— 正则大概失效了，这个检查等于空转')
})

check('「更多」那一路也走 InternalLink（调用方记不住，得在组件里判）', () => {
  // 首页那几个「更多」当年就是靠调用方自己记才漏的，所以判断收在 SectionHeader 里
  const header = SOURCES.find((f) => f.file.endsWith('SectionHeader.tsx'))
  assert.ok(header, '找不到 SectionHeader.tsx')
  const at = header.src.indexOf('to={moreTo}')
  assert.notEqual(at, -1, 'SectionHeader 不再把 moreTo 传给任何东西了？')
  assert.equal(ownerTagOf(header.src, at), 'InternalLink', 'SectionHeader 的 moreTo 必须走 InternalLink')

  // 而且确实有调用方传了禁抓的地址，否则上面那条是空转
  const blockedMore = SOURCES.flatMap(({ src }) => [...src.matchAll(/\bmoreTo="([^"]*)"/g)])
    .map((m) => m[1])
    .filter((to) => !decide(to).allowed)
  assert.ok(blockedMore.length > 0, '没有任何 moreTo 指向禁抓地址 —— 这条检查等于空转')
})

console.log(`✅ robots.txt / URL 归一 / 爬虫状态码 / 内链不出 href：${passed} 项检查通过`)
