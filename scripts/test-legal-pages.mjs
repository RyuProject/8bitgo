/**
 * 服务条款 / 隐私政策的回归测试。跑：npm run test:legal
 *
 * 这份测试存在的理由，和别的测试不太一样。
 *
 * 隐私政策不是文案，是**对代码行为的陈述**。文案写完就不会再有人看，而代码每周都在改 ——
 * 于是隐私政策的自然结局是「越来越像一份善意的谎言」：某天有人加了一个第三方脚本、
 * 某天有人把一张表的字段从哈希改成明文，政策一个字都没动。政策写得比代码好看，
 * 比根本不写更糟：不写只是缺失，写错是虚假陈述。
 *
 * 所以第五节（披露对账）是这份测试的主体：每一条都是「代码里确实这么干」的**探针**
 * 加上「正文里必须提到」的**关键词**，两边都要成立。
 *
 *   探针不成立 -> 代码变了，政策可能留着一条已经不真实的披露；
 *   关键词缺失 -> 代码在做这件事，但政策没说。
 *
 * 两个方向都算失败。修法是去读那条 fact 的 what 字段，判断到底哪边该改。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (f) => readFileSync(path.join(root, f), 'utf8')

let n = 0
const check = (name, fn) => {
  n++
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

const { termsZhHans, privacyZhHans } = await import('../src/locales/legal/zh-Hans.ts')
const { termsZhHant, privacyZhHant } = await import('../src/locales/legal/zh-Hant.ts')
const { termsEnglish, privacyEnglish } = await import('../src/locales/legal/en.ts')

const DOCS = {
  'terms/zh-Hans': termsZhHans,
  'terms/zh-Hant': termsZhHant,
  'terms/en': termsEnglish,
  'privacy/zh-Hans': privacyZhHans,
  'privacy/zh-Hant': privacyZhHant,
  'privacy/en': privacyEnglish,
}

/** 一份文档的全部可读文本（导语 + 每节标题 + 每节正文） */
const textOf = (d) => [d.intro, ...d.sections.flatMap((s) => [s.title, s.body])].join('\n')

console.log('\n一、结构')

check('六份文档都齐全，且每份都有节', () => {
  for (const [k, d] of Object.entries(DOCS)) {
    assert.ok(d, `${k} 没导出`)
    assert.ok(d.sections.length >= 15, `${k} 只有 ${d.sections.length} 节 —— 是不是写漏了`)
  }
})

check('锚点 id 合法且在同一份文档里不重复', () => {
  for (const [k, d] of Object.entries(DOCS)) {
    const ids = d.sections.map((s) => s.id)
    for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${k} 的 id「${id}」不合法`)
    assert.equal(new Set(ids).size, ids.length, `${k} 有重复 id：${ids.filter((x, i) => ids.indexOf(x) !== i)}`)
  }
})

check('⭐ 三种语言的 id 集合完全一致（锚点会被外部引用，不能各语言不同）', () => {
  for (const kind of ['terms', 'privacy']) {
    const base = DOCS[`${kind}/zh-Hans`].sections.map((s) => s.id)
    for (const lang of ['zh-Hant', 'en']) {
      assert.deepEqual(
        DOCS[`${kind}/${lang}`].sections.map((s) => s.id),
        base,
        `${kind} 的 ${lang} 版 id 顺序或集合和简体不一致 —— #dmca 这种锚点被外部引用后会 404`,
      )
    }
  }
})

check('每节都有标题和正文，没有占位空壳', () => {
  for (const [k, d] of Object.entries(DOCS)) {
    for (const s of d.sections) {
      assert.ok(s.title.trim().length > 1, `${k}#${s.id} 没标题`)
      assert.ok(s.body.trim().length > 80, `${k}#${s.id} 正文只有 ${s.body.trim().length} 字 —— 像是占位`)
    }
  }
})

check('最后更新是合法日期，且不在未来', () => {
  const today = new Date().toISOString().slice(0, 10)
  for (const [k, d] of Object.entries(DOCS)) {
    assert.match(d.updated, /^\d{4}-\d{2}-\d{2}$/, `${k} 的 updated 不是 YYYY-MM-DD`)
    assert.equal(new Date(d.updated + 'T00:00:00Z').toISOString().slice(0, 10), d.updated, `${k} 的 updated 是个不存在的日期`)
    assert.ok(d.updated <= today, `${k} 的 updated（${d.updated}）在未来 —— 生效日期不能往后写`)
  }
})

console.log('\n二、renderMarkdown 的两个坑')

check('⚠️ 正文里没有缩进的列表/标题行（缩进会让整块退化成一个塞满 br 的段落）', () => {
  // renderMarkdown 的判断全部锚在行首（/^[-*]\s+/、/^#{1,3}\s+/、/^>\s?/），
  // 而 block.trim() 只去掉整块两端的空白 —— 中间各行的缩进它不管。
  for (const [k, d] of Object.entries(DOCS)) {
    for (const s of [{ id: '(intro)', body: d.intro }, ...d.sections]) {
      for (const [i, line] of s.body.split('\n').entries()) {
        assert.ok(!/^[ \t]+[-*][ \t]+/.test(line), `${k}#${s.id} 第 ${i + 1} 行是缩进的列表项：${JSON.stringify(line)}`)
        assert.ok(!/^[ \t]+#{1,3}[ \t]+/.test(line), `${k}#${s.id} 第 ${i + 1} 行是缩进的标题：${JSON.stringify(line)}`)
        assert.ok(!/^[ \t]+>/.test(line), `${k}#${s.id} 第 ${i + 1} 行是缩进的引用：${JSON.stringify(line)}`)
      }
    }
  }
})

check('⚠️ 正文里没有站内 Markdown 链接（会绕过 router，把读者掉到简体版）', () => {
  // renderMarkdown 输出的是原生 <a href>，不走 react-router；而语言前缀是路由的
  // basename —— 在 /ja/terms 里点 href="/privacy" 会跳到简体中文那份。
  // 只允许 https:// 和 mailto:。
  for (const [k, d] of Object.entries(DOCS)) {
    for (const s of [{ id: '(intro)', body: d.intro }, ...d.sections]) {
      for (const m of s.body.matchAll(/\]\(([^)]+)\)/g)) {
        assert.match(m[1], /^(https:\/\/|mailto:)/, `${k}#${s.id} 有站内链接 ${m[1]} —— 换成只写文档名字`)
      }
    }
  }
})

check('⚠️ 同一块里不能混着列表行和普通行 —— 会静默退化成一个段落', () => {
  /*
    renderMarkdown 的判断是 lines.every(...)：一块里只要有一行不是列表项，
    整块就落到最后那个 <p> 分支，列表符号原样显示、每行之间塞一个 <br>。
    不报错，只是排版悄悄坏掉 —— 法律文本里最容易犯的就是在列表后面直接跟一句说明。
    正确写法是空一行，让它成为独立的块。
  */
  const kind = (l) =>
    /^[-*]\s+/.test(l) ? 'ul' : /^\d+\.\s+/.test(l) ? 'ol' : /^>\s?/.test(l) ? 'quote' : /^#{1,3}\s+/.test(l) ? 'h' : 'p'
  for (const [k, d] of Object.entries(DOCS)) {
    for (const s of [{ id: '(intro)', body: d.intro }, ...d.sections]) {
      for (const block of s.body.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
        const lines = block.trim().split('\n').filter(Boolean)
        if (lines.length < 2) continue
        const kinds = new Set(lines.map(kind))
        if (kinds.size === 1) continue
        // 标题块只有一行，走不到这里；剩下的混合一律是笔误
        assert.fail(
          `${k}#${s.id} 有一块混着 ${[...kinds].join(' + ')}：\n` +
            lines.map((l) => '      ' + l.slice(0, 60)).join('\n') +
            `\n    -> 列表和说明文字之间要空一行`,
        )
      }
    }
  }
})

check('正文的小标题从 ### 起（## 会和组件渲染的节标题撞层级）', () => {
  for (const [k, d] of Object.entries(DOCS)) {
    for (const s of d.sections) {
      for (const line of s.body.split('\n')) {
        assert.ok(!/^##[^#]/.test(line), `${k}#${s.id} 用了 ## —— 节标题已经是 h2，正文里请用 ###`)
        assert.ok(!/^#[^#]/.test(line), `${k}#${s.id} 用了 # —— 请用 ###`)
      }
    }
  }
})

console.log('\n三、这两页必须可收录')

check('LegalDoc 不传 noindex，且钉了 canonicalPath', () => {
  // 先去注释：文件顶上那段说明里就写着「不用 noindex」，直接扫会误判
  const src = stripComments(read('src/pages/LegalDoc.tsx'))
  assert.ok(!/noindex/.test(src), 'LegalDoc 真的传了 noindex —— 应用商店和第三方登录的审核抓不到就等于没有')
  assert.match(src, /canonicalPath: path/, 'canonicalPath 没钉住')
})

check('/terms 和 /privacy 已经不是「即将上线」占位页', () => {
  const routes = read('src/AppRoutes.tsx')
  const soon = routes.match(/const COMING_SOON_ROUTES = \[[\s\S]*?\]/)[0]
  for (const p of ['/terms', '/privacy']) {
    assert.ok(!soon.includes(p), `${p} 还挂在 COMING_SOON_ROUTES 里`)
    assert.ok(routes.includes(`path="${p}"`), `${p} 没注册真实路由`)
  }
  assert.ok(!read('src/pages/ComingSoonPage.tsx').includes("'/terms'"), 'ComingSoonPage 里还留着 /terms 的条目')
})

check('⚠️ 两个页面是静态 import —— lazy 会把 SSR 打挂', () => {
  // AppRoutes.tsx 顶部那段注释：renderToString 是同步的，碰上没解析完的 lazy 直接抛。
  // 前台页面一律静态 import。
  const routes = read('src/AppRoutes.tsx')
  for (const name of ['TermsPage', 'PrivacyPage']) {
    assert.match(routes, new RegExp(`^import \\{ ${name} \\} from '@/pages/${name}'$`, 'm'), `${name} 不是静态 import`)
    assert.ok(!new RegExp(`lazyNamed[^\\n]*${name}`).test(routes), `${name} 用了 lazyNamed`)
  }
})

check('静态 sitemap 里有这两页（8 种语言各一条）', () => {
  const gen = read('scripts/gen-sitemap.mjs')
  for (const p of ['/terms', '/privacy']) {
    assert.match(gen, new RegExp(`add\\('${p}'`), `gen-sitemap.mjs 里没有 add('${p}')`)
  }
  const xml = read('public/sitemap-static.xml')
  for (const p of ['/terms', '/privacy']) {
    const hits = xml.match(new RegExp(`<loc>[^<]*${p}</loc>`, 'g')) ?? []
    assert.equal(hits.length, 8, `sitemap-static.xml 里 ${p} 有 ${hits.length} 条，应该是 8 条（跑 npm run sitemap 重新生成）`)
  }
})

check('页脚和登录弹窗里的链接指向的就是这两页', () => {
  // 这两处是「为什么必须有真内容」的起因：登录弹窗那句「登录即表示同意…」
  // 链的就是 /terms 和 /privacy，落在占位页上等于没有可依据的条款。
  const nav = read('src/components/layout/nav.ts')
  assert.match(nav, /to: '\/terms'/)
  assert.match(nav, /to: '\/privacy'/)
  const modal = read('src/components/auth/AuthModal.tsx')
  assert.match(modal, /to="\/terms"/)
  assert.match(modal, /to="\/privacy"/)
})

console.log('\n四、第三方主机的白名单（加了新脚本必须先更新政策）')

/**
 * index.html 里出现的外部主机 -> 政策里必须提到的说法。
 *
 * 这张表是**穷举**的：index.html 里出现任何一个不在表里的主机，这条测试就红。
 * 目的是让「顺手加一个 CDN 脚本」这件事，必须先把政策改了才能过测试。
 */
const HOSTS = {
  'fonts.googleapis.com': { zh: 'Google Fonts', en: 'Google Fonts' },
  'fonts.gstatic.com': { zh: 'Google Fonts', en: 'Google Fonts' },
  'lf1-cdn-tos.bytegoofy.com': { zh: '字节跳动', en: 'ByteDance' },
}

check('⭐ index.html 里的每个外部主机都在披露白名单里，而且政策真提到了', () => {
  const html = read('index.html')
  const own = /(^|\.)8bitgo\.com$/
  const found = new Set(
    [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()).filter((h) => !own.test(h)),
  )
  for (const h of found) {
    assert.ok(
      HOSTS[h],
      `index.html 里出现了没有披露的外部主机「${h}」。` +
        `加第三方资源之前，先在隐私政策的第三方一节写清它拿到什么，再把它加进这张表。`,
    )
  }
  for (const [h, say] of Object.entries(HOSTS)) {
    assert.ok(found.has(h), `白名单里的「${h}」在 index.html 里已经不存在了 —— 去掉它，同时把政策里那一段删掉`)
    assert.ok(textOf(privacyZhHans).includes(say.zh), `隐私政策（简体）没提到 ${h} 对应的「${say.zh}」`)
    assert.ok(textOf(privacyEnglish).includes(say.en), `隐私政策（英文）没提到 ${h} 对应的「${say.en}」`)
  }
})

console.log('\n五、披露对账：代码在做的事，政策必须说到')

/**
 * 每条：probe = 「代码里确实这么干」的证据；say = 「正文里必须出现」的关键词。
 *
 * 关键词故意选得**短而稳**（术语、键名、域名），不选整句 —— 否则改一次措辞就红，
 * 测试会被当成噪音关掉。
 *
 * 一个关键词里可以用「|」分隔若干写法，命中任意一个就算过。这是为简繁准备的：
 * 同一件事在简体是「字节跳动」，繁体是「字節跳動」，不值得为此把 say 拆成
 * 三份语言各写一遍（37 条 × 3 = 111 行几乎完全重复的东西，没人会去维护）。
 *
 * anyOf: true 是另一层 —— 整条 say 里**任意一个**关键词命中即可，
 * 用于「同一件事有几种完全不同的说法」的场合。默认是每个关键词都必须命中。
 *
 * where 指定这条披露必须落在哪一节。**这个字段不是可选的锦上添花** ——
 * 一开始没有它，于是「把第三方一节里的『字节跳动』改成『某搜索引擎』」这个变异
 * 没被抓到：政策别处（搜索引擎站点验证那一段）还留着「字节跳动」四个字，
 * 全文搜索就蒙过去了。披露必须出现在**读者会去读的那一节**才算披露。
 */
const FACTS = [
  {
    id: 'bytedance-push',
    where: 'third-parties',
    doc: 'privacy',
    what: '每次页面加载和站内换页，都会把当前网址提交给字节跳动；没有开关也没有同意环节',
    probe: ['index.html', 'bytegoofy'],
    say: { zh: ['字节跳动|字節跳動'], en: ['ByteDance'] },
  },
  {
    id: 'autoinclude-spa',
    where: 'third-parties',
    doc: 'privacy',
    what: '上面那条在单页路由切换时会**再推一次**，不只首屏',
    probe: ['src/services/autoInclude.ts', 'pathname'],
    say: { zh: ['每次切换页面|每次切換頁面'], en: ['every in-site page change'] },
  },
  {
    id: 'google-fonts',
    where: 'third-parties',
    doc: 'privacy',
    what: '英文字体从 Google 加载，等于每次页面加载都给 Google 一次 IP + UA',
    probe: ['index.html', 'fonts.googleapis.com'],
    say: { zh: ['Google Fonts'], en: ['Google Fonts'] },
  },
  {
    id: 'anon-ip-plaintext',
    where: 'ip',
    doc: 'privacy',
    what: '匿名评分把评分人的 IP 明文存进数据库，没有 TTL 也没有清理任务',
    probe: ['server/schema-v2.sql', 'anon_ip'],
    say: { zh: ['明文'], en: ['in the clear'] },
  },
  {
    id: 'play-identity-hmac',
    where: 'ip',
    doc: 'privacy',
    what: '游玩计数/浏览量用 HMAC 把 IP 或用户 ID 单向哈希后长期保存，注销也不删',
    probe: ['server/src/playcount.js', 'createHmac'],
    say: { zh: ['HMAC'], en: ['HMAC'] },
  },
  {
    id: 'auto-broadcast',
    where: 'broadcast',
    doc: 'privacy',
    what: '「玩就是播」：游玩会话默认创建公开直播房间，退出只能靠 localStorage 里那个开关',
    probe: ['src/emulator/LiveControls.tsx', '8bit.live.private'],
    say: { zh: ['8bit.live.private', '默认开启|預設開啟'], en: ['8bit.live.private', 'on by default'] },
  },
  {
    id: 'whole-tab-capture',
    where: 'broadcast',
    doc: 'privacy',
    what: '不支持区域采集的浏览器上，广播出去的是整个标签页',
    probe: ['src/emulator/LiveControls.tsx', 'ropTo'],
    say: { zh: ['整个标签页|整個分頁'], en: ['the entire tab'] },
  },
  {
    id: 'webrtc-ip',
    where: 'broadcast',
    doc: 'privacy',
    what: '音视频点对点直连，对端能拿到你的 IP',
    probe: ['server/src/live.js', 'RTC'],
    say: { zh: ['WebRTC'], en: ['WebRTC'] },
  },
  {
    id: 'stun-fallback',
    where: 'third-parties',
    doc: 'privacy',
    what: '未配置时打洞回退到 Google 和 Twilio 的公共 STUN',
    probe: ['server/src/routes/ice.js', 'twilio'],
    say: { zh: ['Twilio'], en: ['Twilio'] },
  },
  {
    id: 'dos-peer-server',
    where: 'third-parties',
    doc: 'privacy',
    what: 'DOS 联机默认用第三方 net.dos.zone 作为对等服务器',
    probe: ['src/emulator/adapters/jsdos.ts', 'net.dos.zone'],
    say: { zh: ['net.dos.zone'], en: ['net.dos.zone'] },
  },
  {
    id: 'jwt-localstorage',
    where: 'account-data',
    doc: 'privacy',
    what: '登录令牌放在 localStorage（不是 HttpOnly Cookie），有效期 30 天',
    probe: ['src/services/api.ts', '8bitgo.token'],
    say: { zh: ['30 天', 'HttpOnly'], en: ['30 days', 'HttpOnly'] },
  },
  {
    id: 'no-cookies',
    where: 'browser-storage',
    doc: 'privacy',
    what: '全站不下发 Cookie —— 这条是「没有做」，所以探针反过来：一旦有人开始下发就该红',
    probe: null,
    negProbe: [
      ['server/src', /res\.cookie\(|['"]Set-Cookie['"]/],
      ['src', /document\.cookie\s*=/],
    ],
    say: { zh: ['不设置任何 Cookie|不設定任何 Cookie'], en: ['sets no cookies'] },
  },
  {
    id: 'birth-date',
    where: 'birth-date',
    doc: 'privacy',
    what: '收集完整出生日期，且写一次锁定、用户自己改不了',
    probe: ['server/schema-v2.sql', 'birth_date'],
    say: { zh: ['出生日期'], en: ['date of birth'] },
  },
  {
    id: 'resend',
    where: 'third-parties',
    doc: 'privacy',
    what: '验证码、注销确认、投稿都经 Resend 发出，Resend 拿到收件地址和正文',
    probe: ['server/src/mail.js', 'api.resend.com'],
    say: { zh: ['Resend'], en: ['Resend'] },
  },
  {
    id: 'comment-country',
    where: 'ugc',
    doc: 'privacy',
    what: '评论会永久记下发表时的国家/地区，并且**公开显示**',
    probe: ['server/src/routes/comments.js', 'cf-ipcountry'],
    say: { zh: ['国家/地区|國家/地區'], en: ['country or region'] },
  },
  {
    id: 'public-collections',
    where: 'ugc',
    doc: 'privacy',
    what: '合集一律公开，没有「仅自己可见」',
    probe: ['server/src/routes/collections.js', '一律公开'],
    say: { zh: ['一律公开|一律公開'], en: ['without exception'] },
  },
  {
    id: 'public-diag',
    where: 'ip',
    doc: 'privacy',
    what: '/api/diag 无需登录，会把调用者自己的 IP 链和设备信息回显出来',
    probe: ['server/src/routes/diag.js', 'cfConnectingIp'],
    say: { zh: ['/api/diag'], en: ['/api/diag'] },
  },
  {
    id: 'local-rom-filename',
    where: 'saves',
    doc: 'privacy',
    what: '自己上传的 ROM 的云存档标识里带着那个文件的文件名',
    probe: ['server/src/routes/saves.js', 'local:'],
    say: { zh: ['文件名|檔名'], en: ['filename'] },
  },
  {
    id: 'submit-emails-you',
    where: 'ugc',
    doc: 'privacy',
    what: '投稿会把你的昵称、邮箱、用户 ID 和上传的文件一起邮件发给运营者',
    probe: ['server/src/routes/submit-game.js', 'replyTo'],
    say: { zh: ['用户 ID|使用者 ID'], en: ['user ID'] },
  },
  {
    id: 'self-delete',
    where: 'rights',
    doc: 'privacy',
    what: '有自助注销（邮件验证码 + 级联删除）',
    probe: ['server/src/routes/me.js', 'DELETE FROM users'],
    say: { zh: ['注销账号|註銷帳號'], en: ['Close your account'] },
  },
  {
    id: 'adult-gate-18',
    where: 'eligibility',
    doc: 'terms',
    what: '成人分级游戏要求登录 + 服务器端 18 岁校验',
    probe: ['shared/age.js', '18'],
    say: { zh: ['18'], en: ['18'] },
  },
  {
    id: 'save-quota',
    where: 'saves',
    doc: 'terms',
    what: '云存档配额：单个 4MB、200 个、合计 64MB',
    probe: ['server/src/routes/saves.js', '200'],
    say: { zh: ['200 个存档|200 個存檔'], en: ['200 saves'] },
  },
]

check('披露表本身没有重复 id', () => {
  const ids = FACTS.map((f) => f.id)
  assert.equal(new Set(ids).size, ids.length)
})

for (const f of FACTS) {
  check(`${f.id} —— ${f.what}`, () => {
    // 1. 代码里这件事还成立吗
    if (f.probe) {
      const [file, needle] = f.probe
      assert.ok(
        read(file).includes(needle),
        `探针失效：${file} 里找不到「${needle}」。代码可能已经改了 —— ` +
          `去核对隐私政策里对应那一段还成不成立，别让政策留着一条假披露。`,
      )
    }
    for (const [dir, re] of f.negProbe ?? []) {
      const hits = walk(path.join(root, dir)).filter((p) => re.test(stripComments(readFileSync(p, 'utf8'))))
      assert.deepEqual(
        hits.map((p) => path.relative(root, p)),
        [],
        `政策里写着「${f.what}」，但代码里已经不是这样了`,
      )
    }
    // 2. 政策正文说到了吗 —— 只看 where 指定的那一节
    for (const [lang, doc, key] of [
      ['zh-Hans', DOCS[`${f.doc}/zh-Hans`], 'zh'],
      ['zh-Hant', DOCS[`${f.doc}/zh-Hant`], 'zh'],
      ['en', DOCS[`${f.doc}/en`], 'en'],
    ]) {
      let text = textOf(doc)
      if (f.where) {
        const sec = doc.sections.find((x) => x.id === f.where)
        assert.ok(sec, `${f.doc}/${lang} 里没有 #${f.where} 这一节 —— 是 where 写错了还是节被删了`)
        text = sec.title + '\n' + sec.body
      }
      const words = f.say[key]
      /** 一个关键词里的「|」是「任意一种写法都算」（主要为简繁两套用词） */
      const hit = (w) => w.split('|').some((alt) => text.includes(alt))
      if (f.anyOf) {
        assert.ok(words.some(hit), `${f.doc}/${lang} 里一个都没提到：${words.join(' / ')}`)
      } else {
        for (const w of words) assert.ok(hit(w), `${f.doc}/${lang} 里没提到「${w.split('|').join(' 或 ')}」`)
      }
    }
  })
}

console.log('\n六、条款里那几条不能少的')

check('运营主体、准据法、语言优先、联系邮箱都写了', () => {
  for (const [lang, key] of [['zh-Hans', 'zh'], ['zh-Hant', 'zh'], ['en', 'en']]) {
    const text = textOf(DOCS[`terms/${lang}`])
    const must =
      key === 'zh'
        ? [['个人', '個人'], ['马来西亚', '馬來西亞'], ['以简体中文版本为准', '以簡體中文版本為準'], ['yeahcore@yeah.net']]
        : [['individual'], ['Malaysia'], ['Simplified Chinese version prevails'], ['yeahcore@yeah.net']]
    for (const alts of must) {
      assert.ok(alts.some((w) => text.includes(w)), `terms/${lang} 里缺：${alts.join(' / ')}`)
    }
  }
})

check('版权下架流程独立成节，且列了要素清单', () => {
  for (const lang of ['zh-Hans', 'zh-Hant', 'en']) {
    const s = DOCS[`terms/${lang}`].sections.find((x) => x.id === 'dmca')
    assert.ok(s, `terms/${lang} 没有 #dmca 一节`)
    const items = s.body.split('\n').filter((l) => /^\d+\.\s/.test(l))
    assert.ok(items.length >= 5, `terms/${lang} 的下架要素清单只有 ${items.length} 条`)
  }
})

check('G 币明确写了无现金价值、不可购买、不退款', () => {
  for (const [lang, key] of [['zh-Hans', 'zh'], ['zh-Hant', 'zh'], ['en', 'en']]) {
    const s = DOCS[`terms/${lang}`].sections.find((x) => x.id === 'coins')
    const must =
      key === 'zh' ? [['现金价值', '現金價值'], ['购买', '購買'], ['退款']] : [['no cash value'], ['no way to buy'], ['not refundable']]
    for (const alts of must) assert.ok(alts.some((w) => s.body.includes(w)), `terms/${lang}#coins 里缺：${alts.join(' / ')}`)
  }
})

/* ---------------- 小工具 ---------------- */

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释再扫 —— 否则注释里引用一段旧代码就会误判 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

console.log(`\n✅ 服务条款 / 隐私政策：${n} 项检查通过`)
