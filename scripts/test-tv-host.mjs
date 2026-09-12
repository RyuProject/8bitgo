/**
 * TV 子域规则的单元测试。跑：npm run test:tv-host
 *
 * 这一套规则前后端都要认（见 shared/tv-host.js 的文件头）：服务端据此发 301、
 * 决定 SSR 渲哪一页，客户端据此决定 `/` 挂哪个路由。算错的后果分三档：
 *
 *   · 跳错   -> 死循环或 404
 *   · 渲错   -> 服务端渲 TV 页、客户端 hydrate 成首页，页面闪一下再变（只有一句含糊的警告）
 *   · 跳多了 -> 把 TV 页自己的 js / wasm / 字体也跳走，页面直接起不来
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TV_ROUTE,
  isTvHost,
  joinLangPath,
  splitLangPath,
  tvHostOf,
  tvRedirect,
  tvRenderPath,
} from '../shared/tv-host.js'

const SITE = 'https://8bitgo.com'
let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}
const redirect = (hostname, pathname, siteOrigin = SITE) => tvRedirect({ hostname, pathname, siteOrigin })
const render = (hostname, pathname, siteOrigin = SITE) => tvRenderPath({ hostname, pathname, siteOrigin })

console.log('\n── 主域上的 /tv 搬到子域 ──')

check('/tv → https://tv.8bitgo.com/', () => {
  assert.deepEqual(redirect('8bitgo.com', '/tv'), { origin: 'https://tv.8bitgo.com', path: '/' })
})

check('带语言前缀的跟着搬，前缀保留', () => {
  for (const lang of ['ja', 'en', 'zh-Hant', 'de']) {
    assert.deepEqual(
      redirect('8bitgo.com', `/${lang}/tv`),
      { origin: 'https://tv.8bitgo.com', path: `/${lang}` },
      lang,
    )
  }
})

check('⚠️ 从 www 打进来的 /tv 也一步到位（不是先跳裸域再跳子域）', () => {
  /*
    链式 301 要多一个往返，而且 Google 只跟有限几跳 —— url-normalize 整个文件
    的核心就是「一个请求最多吃一次 301」。这条规则对**任何**非 TV 主机都成立。
  */
  assert.deepEqual(redirect('www.8bitgo.com', '/tv'), { origin: 'https://tv.8bitgo.com', path: '/' })
})

console.log('\n── 子域上的地址只留一个 ──')

check('子域上的 /tv 是重复地址，去掉（同主机跳，不跨域）', () => {
  assert.deepEqual(redirect('tv.8bitgo.com', '/tv'), { origin: '', path: '/' })
  assert.deepEqual(redirect('tv.8bitgo.com', '/ja/tv'), { origin: '', path: '/ja' })
})

check('⚠️ 子域上别的路径一律不跳 —— 跳了会把自己的 js / wasm / 字体跳没', () => {
  /*
    这条是刻意的，别「顺手补全」成把非 TV 路径都跳回主域：
    /assets/*.js、/emulatorjs/*.wasm、/fonts/*.woff2 会变成跨域 301，
    字体和 wasm 还要撞 CORS，TV 页直接起不来。重复内容交给 canonical 和 robots。
  */
  for (const p of ['/', '/ja', '/games/contra', '/assets/index-abc.js', '/emulatorjs/emulator.min.js', '/fonts/x.woff2']) {
    assert.equal(redirect('tv.8bitgo.com', p), null, p)
  }
})

console.log('\n── 子域上渲哪一页 ──')

check('子域的根（和各语言根）渲 TV 页', () => {
  assert.equal(render('tv.8bitgo.com', '/'), TV_ROUTE)
  assert.equal(render('tv.8bitgo.com', '/ja'), `/ja${TV_ROUTE}`)
  assert.equal(render('tv.8bitgo.com', '/zh-Hant'), `/zh-Hant${TV_ROUTE}`)
})

check('⚠️ 子域上的其它路径照常渲染它自己（不是全站都变成 TV 页）', () => {
  assert.equal(render('tv.8bitgo.com', '/games/contra'), null)
  assert.equal(render('tv.8bitgo.com', '/ja/games/contra'), null)
})

check('主域的根不受影响（还是首页）', () => {
  assert.equal(render('8bitgo.com', '/'), null)
  assert.equal(render('www.8bitgo.com', '/'), null)
})

console.log('\n── 语言前缀只认整段 ──')

check('⚠️ /january 不是日语页 —— 只认整段，不认前缀', () => {
  /*
    按 startsWith 判语言的写法会把 /january 切成 /nuary：一个真实存在的页面
    变成 404，而且只有名字恰好以语言码开头的那几个会中招。
  */
  assert.deepEqual(splitLangPath('/january'), { lang: '', rest: '/january' })
  assert.deepEqual(splitLangPath('/ja'), { lang: 'ja', rest: '/' })
  assert.deepEqual(splitLangPath('/ja/tv'), { lang: 'ja', rest: '/tv' })
  assert.equal(render('tv.8bitgo.com', '/january'), null)
})

check('拼回来不带多余斜杠（/ja 而不是 /ja/）', () => {
  assert.equal(joinLangPath('ja', '/'), '/ja')
  assert.equal(joinLangPath('', '/'), '/')
  assert.equal(joinLangPath('ja', '/tv'), '/ja/tv')
})

console.log('\n── 安全与兜底 ──')

check('⭐ 陌生 host 一律不跳，目标也永远不会是请求里的 host', () => {
  /*
    开放重定向的经典成因就是把请求 host 拼进跳转目标。这里更进一步：
    不是正牌域名（裸域 / www）就**根本不跳**，所以连拼的机会都没有。
  */
  for (const evil of ['evil.com', 'tv.evil.com', '8bitgo.com.evil.com', '']) {
    assert.equal(redirect(evil, '/tv'), null, `host 是 ${evil} 时不该跳`)
  }
})

check('⭐ 本地开发不会被跳到线上', () => {
  /*
    真会咬人的一条：.env 里配了 PUBLIC_SITE_URL（很常见）时，如果规则写成
    「凡是非 TV 主机都跳」，打开 localhost:5173/tv 就会被 301 到生产子域 ——
    人在调本地，页面跳去了线上。预览域名、内网 IP、健康检查同理。
  */
  for (const dev of ['localhost', '127.0.0.1', '192.168.1.10', 'preview-7.vercel.app']) {
    assert.equal(redirect(dev, '/tv'), null, `${dev} 上不该跳`)
  }
  // 正牌域名才跳
  assert.ok(redirect('8bitgo.com', '/tv'))
  assert.ok(redirect('www.8bitgo.com', '/tv'))
})

check('站点域名畸形 / 缺失时不跳也不抛', () => {
  assert.equal(tvRedirect({ hostname: '8bitgo.com', pathname: '/tv', siteOrigin: '' }), null)
  assert.equal(tvRedirect({ hostname: '8bitgo.com', pathname: '/tv', siteOrigin: '不是地址' }), null)
  assert.equal(tvRenderPath({ hostname: 'tv.8bitgo.com', pathname: '/', siteOrigin: '' }), null)
})

check('换个域名规则照样成立（没把 8bitgo.com 硬编码进去）', () => {
  const other = 'https://example.org'
  assert.equal(tvHostOf('example.org'), 'tv.example.org')
  assert.deepEqual(redirect('example.org', '/tv', other), { origin: 'https://tv.example.org', path: '/' })
  assert.equal(render('tv.example.org', '/', other), TV_ROUTE)
  // 站点本身就是 http 的（本地 / 内网部署）时不要被强行升成 https。
  // host 要和配置里的域名对上才跳 —— 这里 siteOrigin 就是 localhost，所以它是「正牌域名」
  assert.deepEqual(redirect('localhost', '/tv', 'http://localhost:5173'), {
    origin: 'http://tv.localhost',
    path: '/',
  })
})

check('⚠️ host 大小写不影响判定 —— 三条分支都要规整过再比', () => {
  /*
    Host 头的大小写由客户端决定。三处比较（TV 子域、裸域、www）必须**都**用
    规整过的那份；漏掉任何一处的症状都是「某些客户端上这条规则时灵时不灵」。
    真漏过一次：白名单那行第二个比较用的是没规整的原值，于是 WWW.8BITGO.COM/tv 不跳。
  */
  assert.ok(isTvHost('TV.8bitgo.COM', '8bitgo.com'))
  assert.equal(render('TV.8BITGO.COM', '/'), TV_ROUTE)
  assert.equal(redirect('TV.8bitgo.com', '/tv').path, '/')
  assert.deepEqual(redirect('8BitGo.com', '/tv'), { origin: 'https://tv.8bitgo.com', path: '/' })
  assert.deepEqual(redirect('WWW.8BITGO.COM', '/tv'), { origin: 'https://tv.8bitgo.com', path: '/' })
  assert.deepEqual(redirect('  8bitgo.com  ', '/tv'), { origin: 'https://tv.8bitgo.com', path: '/' })
})

console.log('\n── 接线：前后端必须算出同一个答案 ──')

/*
  规则本身上面已经测透了。这一节测的是**它有没有被真的接上** ——
  接错的表现不是报错，是「服务端渲 TV 页、客户端 hydrate 成首页」：
  页面先闪一下 TV 再变回首页，控制台里只有一句含糊的 hydration 警告。
  .tsx 里的 JSX 这套 node 测试加载不了，所以这几条是扫结构。
*/
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

check('⚠️ SSR 算出 tvHost 并传给 render（客户端读 location，服务端只能靠它）', () => {
  const ssr = read('server/src/ssr.js')
  assert.match(ssr, /tvRenderPath\(\{[\s\S]{0,120}hostname: requestHostname\(req\)/, 'ssr.js 没按请求 host 算')
  assert.match(ssr, /render\(\{ url, data, tvHost \}\)/, 'tvHost 没传进 render')
})

check('⚠️ entry-server 在 renderToString 之前同步设好（之后不能有 await）', () => {
  const es = read('src/entry-server.tsx')
  const at = es.indexOf('setSsrTvHost(')
  const rts = es.indexOf('renderToString(')
  assert.ok(at > 0, 'entry-server 没调 setSsrTvHost')
  assert.ok(rts > at, 'setSsrTvHost 排在 renderToString 后面了，这次渲染读到的是上一次的值')
  // 两者之间不许有 await：并发请求会交错，把别人的 host 用到这次渲染上
  assert.ok(!es.slice(at, rts).includes('await'), 'setSsrTvHost 和 renderToString 之间有 await')
})

check('⚠️ 客户端的 / 按 host 分支（不是写死 HomePage）', () => {
  const routes = read('src/AppRoutes.tsx')
  assert.match(routes, /<Route index element=\{onTvHost\(\) \? <TvPage \/> : <HomePage \/>\}/, '首页路由没按 host 分支')
})

console.log('\n── canonical 和 hreflang 不许自相矛盾 ──')

check('⭐ TV 页的 canonical 指子域', () => {
  const tv = read('src/pages/TvPage.tsx')
  assert.match(tv, /canonicalOrigin: tvOrigin\(\)/, 'TV 页没把 canonical 指到子域')
  assert.match(tv, /canonicalPath: '\/'/, "子域上这一页挂在根上，canonicalPath 该写 '/'")
})

check('⭐ canonical / og:url / hreflang 走同一个地址构造器', () => {
  /*
    只换 canonical 不换 hreflang 的话，canonical 说「我在子域」、
    8 条 hreflang 说「我的各语言版本都在主域」—— 自己和自己打架，
    搜索引擎两边都不信。所以三处必须共用同一个函数。
  */
  const seo = read('src/services/seo.ts')
  assert.match(seo, /const canonicalUrl = urlInLang\(lang\)/, 'canonical 没走 urlInLang')
  assert.match(seo, /\['property', 'og:url', canonicalUrl\]/, 'og:url 和 canonical 不是同一个值')
  assert.match(seo, /HREFLANG\[l\.code\], urlInLang\(l\.code\)/, 'hreflang 没走 urlInLang')
  assert.match(seo, /\['x-default', urlInLang\(FALLBACK_LANG\)\]/, 'x-default 没走 urlInLang')
  // 旧写法（直接 absoluteUrl）残留的话，那一处就绕过了 canonicalOrigin
  assert.doesNotMatch(seo, /absoluteUrl\(localizedPath\(barePath/, '还有地方直接用 absoluteUrl 拼 hreflang，绕过了子域')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ TV 子域规则：${pass} 条全过`)
