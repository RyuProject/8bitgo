/**
 * 浏览器语言自动跳转的回归测试。
 *
 *   npm run test:lang
 *
 * 两件事：
 *
 *   一、把 index.html 头部那段内联脚本抠出来，在 node:vm 里真的跑一遍
 *       （造假的 location / navigator / localStorage），断言它跳到哪、跳不跳。
 *       测的是**线上真正执行的那份代码**，不是照着它另写一遍。
 *
 *   二、逐个语言标记比对内联脚本和 src/config/languages.ts 的 matchBrowserLang()。
 *       内联脚本必须内联（要在首屏绘制前跑完），所以规则不可避免地存在两份 ——
 *       这一步就是防止改了一处忘了另一处。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(fileURLToPath(new URL(f, root)), 'utf8')

/* ---------- 抠出 index.html 里那段脚本 ---------- */

const html = read('index.html')
const inline = html.match(/<script>\s*\(function \(\) \{[\s\S]*?\}\)\(\)\s*<\/script>/)
assert.ok(inline, '❌ index.html 里找不到语言跳转脚本 —— 是不是被删了或改了写法？')
const SCRIPT = inline[0].replace(/^<script>/, '').replace(/<\/script>$/, '')

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/**
 * 跑一次脚本，返回它把浏览器带去了哪。
 * @returns {string|null} location.replace 的目标；null = 没跳
 */
function run({ path = '/', search = '', hash = '', langs = [], saved = null, ua = UA_CHROME } = {}) {
  let target = null
  const ctx = createContext({
    location: {
      pathname: path,
      search,
      hash,
      replace: (url) => {
        target = url
      },
    },
    navigator: { languages: langs, language: langs[0] || '', userAgent: ua },
    localStorage: {
      getItem: (k) => (k === '8bitgo.lang' ? saved : null),
    },
  })
  runInContext(SCRIPT, ctx)
  return target
}

/* ---------- 把 matchBrowserLang 从 TS 里读出来（不引 TS 工具链） ---------- */

const ts = read('src/config/languages.ts')
const fnSrc = ts.slice(ts.indexOf('export function matchBrowserLang'))
const body = fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 3)
// 去掉类型标注，剩下的就是能直接跑的 JS
const asJs = body
  .replace('export function matchBrowserLang(tags: readonly string[]): Lang | null', 'function matchBrowserLang(tags)')
  .replace(/'zh-Hans'|'zh-Hant'/g, (m) => m)
const SIMPLE_MATCH = JSON.parse(ts.match(/SIMPLE_MATCH[^=]*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'))
const matchCtx = createContext({ SIMPLE_MATCH, String })
runInContext(asJs, matchCtx)
const matchBrowserLang = matchCtx.matchBrowserLang

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

console.log('一、跳不跳')

check('简体中文浏览器进裸首页 -> 不跳（简体本来就是裸路径）', () => {
  assert.equal(run({ path: '/', langs: ['zh-CN', 'zh'] }), null)
})
check('英语浏览器进裸首页 -> /en', () => {
  assert.equal(run({ path: '/', langs: ['en-US', 'en'] }), '/en')
})
check('日语浏览器进 /games/contra -> /ja/games/contra', () => {
  assert.equal(run({ path: '/games/contra', langs: ['ja-JP'] }), '/ja/games/contra')
})
check('查询串和锚点原样带过去', () => {
  assert.equal(run({ path: '/games', search: '?q=魂斗罗&page=2', hash: '#top', langs: ['de'] }), '/de/games?q=魂斗罗&page=2#top')
})

console.log('\n二、什么时候不该动')

check('URL 已带语言前缀 -> 一律不动（外链 / 搜索结果进来的）', () => {
  for (const p of ['/ja/games', '/en', '/zh-Hant/blog/x']) {
    assert.equal(run({ path: p, langs: ['de'] }), null, `${p} 被改了`)
  }
})
check('/admin -> 不动', () => {
  assert.equal(run({ path: '/admin/games', langs: ['ja'] }), null)
})
check('爬虫 -> 不动（保住每种语言各自被收录）', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    'Mozilla/5.0 (compatible; YandexBot/3.0)',
  ]
  for (const ua of bots) assert.equal(run({ path: '/', langs: ['en'], ua }), null, ua.slice(0, 40))
})
check('真实浏览器 UA 不会被当成爬虫误伤', () => {
  const reals = [
    UA_CHROME,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  ]
  for (const ua of reals) assert.equal(run({ path: '/', langs: ['en'], ua }), '/en', ua.slice(0, 40))
})

console.log('\n三、用户自己选过的语言优先')

check('选过英语 + 日语浏览器 -> 听用户的，去 /en', () => {
  assert.equal(run({ path: '/', langs: ['ja-JP'], saved: 'en' }), '/en')
})
check('选过简体 + 英语浏览器 -> 不跳（尊重他选的母语站）', () => {
  assert.equal(run({ path: '/', langs: ['en-US'], saved: 'zh-Hans' }), null)
})
check('localStorage 里是垃圾值 -> 忽略，退回按浏览器语言', () => {
  assert.equal(run({ path: '/', langs: ['ja'], saved: 'klingon' }), '/ja')
})
check('隐私模式下 localStorage 抛异常 -> 不白屏，照常按浏览器语言', () => {
  let target = null
  const ctx = createContext({
    location: { pathname: '/', search: '', hash: '', replace: (u) => (target = u) },
    navigator: { languages: ['ja'], language: 'ja', userAgent: UA_CHROME },
    localStorage: {
      getItem: () => {
        throw new Error('SecurityError')
      },
    },
  })
  runInContext(SCRIPT, ctx)
  assert.equal(target, '/ja')
})

console.log('\n四、匹配规则（内联脚本 vs matchBrowserLang，逐个对）')

/** 语言标记 -> 期望的站点语言；null = 站点不支持，应该兜底到英语 */
const CASES = [
  [['zh-CN'], 'zh-Hans'],
  [['zh'], 'zh-Hans'],
  [['zh-SG'], 'zh-Hans'],
  [['zh-Hans-CN'], 'zh-Hans'],
  [['zh-TW'], 'zh-Hant'],
  [['zh-HK'], 'zh-Hant'],
  [['zh-MO'], 'zh-Hant'],
  [['zh-Hant-TW'], 'zh-Hant'],
  [['zh-Hans-HK'], 'zh-Hans'], // 简繁标注比地区码权威
  [['en-US'], 'en'],
  [['en-GB'], 'en'],
  [['ja-JP'], 'ja'],
  [['de-AT'], 'de'],
  [['fr-CA'], 'fr'],
  [['es-MX'], 'es'],
  [['it-CH'], 'it'],
  [['pt-BR'], null],
  [['ru'], null],
  [['ko-KR'], null],
  [['ar'], null],
  [['ru', 'ko', 'ja'], 'ja'], // 按偏好顺序取第一个能对上的
  [['pt-BR', 'en-US'], 'en'],
  [[''], null],
  [[], null],
]

for (const [tags, expected] of CASES) {
  const label = tags.length ? tags.join(', ') : '(空)'
  check(`${label} -> ${expected ?? '兜底 en'}`, () => {
    assert.equal(matchBrowserLang(tags), expected, `matchBrowserLang 给的是 ${matchBrowserLang(tags)}`)
    // 内联脚本的结果只能从「跳去哪」反推：兜底和 en 都会跳 /en，简体则不跳
    const want = expected === null ? '/en' : expected === 'zh-Hans' ? null : '/' + expected
    assert.equal(run({ path: '/', langs: tags }), want, '内联脚本和 matchBrowserLang 不一致')
  })
}

console.log('\n五、和配置文件的一致性')

check('内联脚本里的语言列表 = LANGUAGES 里的 8 种', () => {
  const inScript = JSON.parse(SCRIPT.match(/var CODES = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  const inConfig = [...ts.matchAll(/\{ code: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(inScript, inConfig, '加了新语言但忘了改 index.html')
})
check('内联脚本的默认语言 / 兜底语言 = 配置里的 DEFAULT_LANG / FALLBACK_LANG', () => {
  assert.equal(SCRIPT.match(/var DEFAULT_LANG = '([^']+)'/)[1], ts.match(/DEFAULT_LANG: Lang = '([^']+)'/)[1])
  assert.equal(SCRIPT.match(/var FALLBACK_LANG = '([^']+)'/)[1], ts.match(/FALLBACK_LANG: Lang = '([^']+)'/)[1])
})
check('seo.ts 的 x-default 指向 FALLBACK_LANG（和跳转兜底一致）', () => {
  assert.match(read('src/services/seo.ts'), /\['x-default', absoluteUrl\(localizedPath\(barePath, FALLBACK_LANG\)\)\]/)
})

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 个用例未通过`)
process.exit(failed === 0 ? 0 : 1)
