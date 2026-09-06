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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_DEFAULT_LANGUAGE, SITE_LANGUAGES } from '../shared/site-languages.js'
import { normalizeTrailingSlash } from '../server/src/url-normalize.js'

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

/* ---------------- 尾斜杠归一 ---------------- */

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
  normalizeTrailingSlash(req, res, () => {
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

check('开头的多余斜杠必须折掉 —— 否则就是一个跳到外站的开放重定向', () => {
  for (const url of ['//evil.com/', '///evil.com/', '//evil.com/path/']) {
    const { location } = run('GET', url)
    assert.ok(location.startsWith('/') && !location.startsWith('//'), `${url} → ${location} 是协议相对 URL`)
  }
  assert.equal(run('GET', '//evil.com/').location, '/evil.com')
})

console.log(`✅ robots.txt / URL 归一：${passed} 项检查通过`)
