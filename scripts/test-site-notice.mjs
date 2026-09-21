#!/usr/bin/env node
/**
 * 首页公告条的回归测试。跑：`npm run test:site-notice`
 *
 * 这块的失败方式也都挺安静的：
 *   · 文本没清干净 → 管理员贴一篇带换行的东西进来，首页第一屏被顶开；
 *   · 可见性判断写错 → 关掉了还在显示（或者反过来，出事了却没显示）；
 *   · 位置挪了 → 公告跑到横幅下面，「进门第一眼」这个前提就没了；
 *   · 后台接口忘了要权限 → 任何登录用户都能以站点名义发一句话。
 * 所以纯函数逐条钉，接线按源码形状钉（和 test-jspi-flag 同一套做法）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  NOTICE_TEXT_MAX,
  cleanNoticeText,
  sanitizeNotice,
  visibleNotice,
} from '../shared/site-notice.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }

console.log('── 文本清洗 ──')
{
  ok(cleanNoticeText('  机房  维护\n\n今晚  ') === '机房 维护 今晚', '⭐ 换行与连续空格折叠成一个空格，首尾去掉')
  ok(cleanNoticeText('a\u0000b\u2028c') === 'a b c', '控制字符与被当成换行的两个 Unicode 分隔符也折叠掉')
  ok(cleanNoticeText(null) === '' && cleanNoticeText(undefined) === '', 'null / undefined 得到空串（不是 "null"）')
  {
    // 上限按**码点**算：按 UTF-16 码元切会把一个 emoji 劈成半个，渲染出替换符
    const emoji = '🎮'.repeat(NOTICE_TEXT_MAX + 5)
    const cut = cleanNoticeText(emoji)
    ok(Array.from(cut).length === NOTICE_TEXT_MAX && !cut.includes('\ufffd'), `⭐ 超长按码点截断到 ${NOTICE_TEXT_MAX}，没有劈开 emoji`)
  }
}

console.log('\n── 写入前的合法化（sanitizeNotice）──')
{
  ok(sanitizeNotice({ level: '怪东西', text: 'hi' }).level === 'warn', '等级不合法就退回 warn，而不是把整条公告丢掉')
  ok(sanitizeNotice({ level: 'error', text: '   ' }).enabled === false, '文本为空 = 关掉（不留下一条 enabled 的空公告）')
  ok(sanitizeNotice({ level: 'error', text: '崩了', enabled: false }).enabled === false, '显式关掉时保留文本 —— 下次开回来不用重打')
  ok(sanitizeNotice({ level: 'error', text: '崩了' }).enabled === true, '有文本且没显式关掉 = 发布')
  ok(sanitizeNotice(null).text === '' && sanitizeNotice(null).enabled === false, 'null 输入不抛异常')
  ok(Array.from(sanitizeNotice({ text: 'x'.repeat(999) }).text).length === NOTICE_TEXT_MAX, '写入也截断，库里不会躺着一条超长公告')
}

console.log('\n── 前台可见性（visibleNotice）──')
{
  ok(visibleNotice(null) === null, '没有公告 → null')
  ok(visibleNotice('字符串') === null, '形状不对（手工改库改坏）→ null，不让首页跟着白屏')
  ok(visibleNotice({ level: 'off', text: 'x' }) === null, '等级不合法 → null（off 不是合法等级，关闭只由 enabled 表达）')
  ok(visibleNotice({ level: 'warn', text: 'x', enabled: false }) === null, '关掉 → null')
  ok(visibleNotice({ level: 'warn', text: '   ' }) === null, '空文本 → null')
  {
    const good = visibleNotice({ level: 'error', text: ' 抱歉\n是我搞坏的 ', enabled: true, 别的字段: 1 })
    assert.deepEqual(good, { level: 'error', text: '抱歉 是我搞坏的' })
    ok(true, '⭐ 正常的一条：只带 level + text，且文本已清洗（多余的字段不进前台）')
    ok(!('enabled' in good), '前台拿不到 enabled —— 开关是后台的事')
  }
}

console.log('\n── 接线（按源码形状）──')
{
  const home = read('src/pages/HomePage.tsx')
  const at = (needle) => home.indexOf(needle)
  ok(
    at('<HomeHeading') < at('<NoticeBar') && at('<NoticeBar') < at('<HomeBanner'),
    '⭐ 公告条夹在标题与横幅之间（需求就是「搜索框和 banner 之间」，挪到横幅下面就白做了）',
  )

  const index = read('server/src/index.js')
  ok(index.includes("app.use('/api/site-notice', siteNoticeRouter)"), '公开读挂在 /api/site-notice')
  ok(index.includes("app.use('/api/admin/site-notice', adminSiteNoticeRouter)"), '后台读写挂在 /api/admin/site-notice')

  const route = read('server/src/routes/site-notice.js')
  {
    // 公开的那条绝不能要权限（否则首页 SSR 拿不到），后台那两条绝不能不要权限
    const guards = route.match(/requireAbility\('site:manage'\)/g) ?? []
    ok(guards.length === 2, `⭐ 后台两条接口都要 site:manage（实际 ${guards.length} 处）—— 少了任何一处，任何人都能以站点名义发公告`)
    ok(route.includes('CACHE.notice'), '公开读用 CACHE.notice（短缓存，见下一条）')
  }

  const cache = read('server/src/cache.js')
  {
    const m = cache.match(/notice:\s*'([^']+)'/)
    const smax = m ? Number(/s-maxage=(\d+)/.exec(m[1])?.[1] ?? 0) : 0
    ok(m && smax > 0 && smax <= 60, `⭐ 公告的 s-maxage 必须很短（实际 ${smax}s）—— 这条的用途就是「出事了立刻说」，5 分钟等于错过唯一需要它的时刻`)
  }

  const content = read('server/src/content.js')
  ok(content.includes('loadVisibleNotice'), '⭐ 首页数据里带公告（SSR 出来就有，前端不用再发一个请求）')
  ok(/return \{[\s\S]*?\n\s*notice,/.test(content), '首页回包里有 notice 字段')

  /*
    ⚠️ 这一条替代的是**本地跑不了的集成测试**：公告的写路径要真连上 MySQL 才验得了
    （`npm run test:db` 那类），而本机只有一条到库的 SSH 隧道，平时是断的。
    连不上时最可能翻车的不是逻辑，而是**列名对不上**（改名时只改了 SQL 或只改了 schema），
    那种错误在开发机上永远复现不了，一上线就是「保存失败」。所以这里做一次静态交叉核对：
    site-settings.js 里 SQL 用到的每一个列名，都必须真的在 schema 的建表语句里。
  */
  {
    const repo = read('server/src/site-settings.js')
    const ddl = read('server/schema-v2.sql').match(/CREATE TABLE IF NOT EXISTS site_settings \(([\s\S]*?)\) ENGINE/)[1]
    const declared = new Set(
      ddl
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0]?.replace(/`/g, '').toLowerCase())
        .filter((name) => name && !name.startsWith('primary')),
    )
    const used = new Set()
    for (const m of repo.matchAll(/INSERT INTO site_settings\s*\(([^)]+)\)/g)) {
      m[1].split(',').forEach((c) => used.add(c.trim().replace(/`/g, '').toLowerCase()))
    }
    for (const m of repo.matchAll(/SELECT\s+([a-z_,\s]+?)\s+FROM site_settings/gi)) {
      m[1].split(',').forEach((c) => used.add(c.trim().toLowerCase()))
    }
    const missing = [...used].filter((c) => !declared.has(c))
    ok(used.size > 0 && missing.length === 0, `⭐ SQL 用到的列（${[...used].join(', ')}）都在表定义里（缺：${missing.join(', ') || '无'}）`)
  }

  const tabs = read('src/admin/AdminLayout.tsx')
  ok(tabs.includes("to: '/admin/notice'"), '后台导航里有「公告」')
  ok(read('src/AppRoutes.tsx').includes('path="notice"'), '后台路由注册了 /admin/notice')

  ok(read('server/schema-v2.sql').includes('site_settings'), 'schema 里有 site_settings 表')
  ok(read('server/scripts/migrate.mjs').includes("hasTable('site_settings')"), '⭐ 迁移里有这张表 —— 少了它，后台保存会直接 500')

  /*
    ⚠️ 这个仓库有 6 份 schema / install SQL，加表时**只改 schema-v2.sql 是不够的**
    （docs/open-platform.md 把它列成过上线检查项，AGENTS §2.15 也记着一次真实事故：
    `saves` 当年只写在一个文件里，按另一份建的新库压根没有它）。

    判据用「家族」而不是「名单」：**文件里有没有 platform_bios**。有就是 v2 家族
    （schema-v2 / schema-d1 / 8bitgo-v2-install），新加的 v2 表都必须同步过去；
    没有的那两份 `8bitgo-setup*.sql` 是 v1 结构，不该被要求跟着长。
  */
  const SCHEMA_FILES = [
    'server/schema-v2.sql',
    'server/schema-d1.sql',
    'server/8bitgo-v2-install.sql',
  ]
  for (const file of SCHEMA_FILES) {
    const sql = read(file)
    ok(
      sql.includes('site_settings'),
      `⭐ ${file} 里也有 site_settings（v2 家族的三份 schema 都要同步，漏一份就有一种建库路径没有这张表）`,
    )
  }
}

console.log(`\n${fail ? '❌' : '✅'} 公告条：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
