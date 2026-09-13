/**
 * 后台「当前生效配置」那一页的自检。
 *
 * 盯三件「错了也看不出来」的事：
 *
 *   1. ⚠️⚠️ **密钥的值绝不出服务端**。这一页的响应会进浏览器、进截图、进工单。
 *      漏一个就是把生产密钥贴到了一个不该有它的地方，而界面上看不出任何异常 ——
 *      它只是多了一个字段。
 *   2. ⚠️ **清单必须和代码真实读取的变量一一对应**。这一页存在的全部意义是
 *      「我到底配了什么」，清单漏一个，那个变量就永远不会被人看见 ——
 *      SUBMIT_GAME_TO_EMAIL 当初就是这么漏掉的，只不过漏在 .env 里。
 *      漂移测试认四种读法，光认 `env.X` 会漏掉 trimEnv('X') 那种（实测漏过 3 个）。
 *   3. **这一页是只读的**，而且不能被非 admin 读到。
 *
 * 用法：cd server && npm run test:config
 */
import assert from 'node:assert/strict'
import express from 'express'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

process.env.ADMIN_TOKEN = 'test-admin-token-value'
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef'

const { ENV_MANIFEST, specOf, envGroups } = await import('../src/config-manifest.js')
const { effectiveConfig, configChecks, configDigest, fingerprint, CHECKS } = await import(
  '../src/config-report.js'
)
const { adminConfigRouter } = await import('../src/routes/admin-config.js')

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/* ---------- 源码扫描器（漂移测试用） ---------- */

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const SHAPE = /^[A-Z][A-Z0-9_]{2,}$/

/**
 * 扫出 server/src 里**真的读了**哪些环境变量，以及在哪个文件。
 *
 * ⚠️ 四种读法都要认。只认 `env.X` 的话会漏掉间接读取 ——
 * routes/auth.js 里是 `trimEnv('MICROSOFT_CLIENT_ID')`，
 * routes/submit-game.js 里是 `envMb('SUBMIT_ROM_MAX_FILE_MB', 20)`，
 * 这两处一共 3 个变量，2026-09-13 第一版正则一个都没看见。
 */
const META_FILES = ['config-report.js', 'config-manifest.js']

function scanEnvUsage(root = SRC) {
  const out = new Map()
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!p.endsWith('.js')) continue
      /*
        ⚠️ 跳过这两个**元层**文件。

        config-report.js 里的体检规则会读一堆环境变量（`truthy(env.TURN_PROBE_INSECURE_TLS)`
        之类），但那是在**检查**它们，不是在消费它们。不排除的话，这个扫描器会
        把「读取位置」记成 config-report.js —— 取决于目录遍历顺序，
        谁排在前面就算谁的（实测：TURN_PROBE_INSECURE_TLS 被记到了 config-report.js 名下，
        因为 c 排在 t 前面）。那样清单里的 file 会指向一个对排查毫无用处的位置。

        代价是：只被体检规则提到、却没有任何真实消费者的变量会「消失」——
        而那正是对的，它本来就不是一个配置项。下面那条「清单里的每一项代码里真的读了」
        会把这种情况抓出来。
      */
      if (META_FILES.includes(n)) continue
      const code = stripComments(readFileSync(p, 'utf8'))
      const add = (k) => {
        if (SHAPE.test(k) && !out.has(k)) out.set(k, relative(root, p))
      }
      for (const m of code.matchAll(/(?:process\.)?env\.([A-Za-z_$][\w$]*)/g)) add(m[1])
      for (const m of code.matchAll(/(?:process\.)?env\[\s*['"]([^'"]+)['"]/g)) add(m[1])
      for (const m of code.matchAll(/\b\w*[Ee]nv\w*\(\s*['"]([^'"]+)['"]/g)) add(m[1])
    }
  }
  walk(root)
  return out
}

/* ---------- 一份「什么都配了」的假 env，用来验脱敏 ---------- */

/** 每个密钥一个**可识别且互不相同**的值：漏出去时能一眼认出是哪一个 */
const SECRETS = ENV_MANIFEST.filter((s) => s.kind === 'secret')
const fakeEnv = { JWT_SECRET: 'jwtkey-jwtkey-jwtkey-jwtkey' }
for (const s of ENV_MANIFEST) {
  fakeEnv[s.name] = s.kind === 'secret' ? `LEAK-${s.name}-LEAK` : `plain-${s.name}`
}
fakeEnv.JWT_SECRET = 'LEAK-JWT_SECRET-LEAK'

console.log('\n一、⚠️⚠️ 密钥的值绝不出服务端')

await check('响应里找不到任何一个密钥的原文', () => {
  const blob = JSON.stringify(effectiveConfig(fakeEnv))
  const leaked = SECRETS.filter((s) => blob.includes(fakeEnv[s.name]))
  assert.deepEqual(
    leaked.map((s) => s.name),
    [],
    `这些密钥的值出现在了响应里：${leaked.map((s) => s.name).join(', ')}`,
  )
  // 反证：非密钥项的值**应该**在里面，否则上面那条断言是空的
  assert.ok(blob.includes('plain-PUBLIC_SITE_URL'), '非密钥项也没输出 —— 上面那条断言等于没测')
})

await check('密钥项只有 length / fingerprint 三个字段，没有 value', () => {
  const all = effectiveConfig(fakeEnv).groups.flatMap((g) => g.items)
  for (const item of all.filter((i) => i.kind === 'secret')) {
    assert.ok(!('value' in item), `${item.name} 带了 value 字段`)
    assert.equal(typeof item.length, 'number', `${item.name} 没给长度`)
  }
  assert.ok(all.some((i) => i.kind === 'secret'), '一个密钥都没有，这条断言是空的')
})

await check('⚠️ 指纹是 HMAC —— 没有 JWT_SECRET 时宁可不给，也不退回成裸哈希', () => {
  /*
    裸哈希对高熵密钥是安全的，对**低熵**密钥不是：一个 8 位纯数字的数据库口令
    只有 1e8 种可能，拿着截断哈希在笔记本上几秒就能撞出来。
    而「JWT_SECRET 还没配」的机器，恰恰最可能是其它密钥也很弱的那台。
  */
  assert.equal(fingerprint('19970604', ''), '', '没有 HMAC 密钥时仍然给出了指纹')
  const a = fingerprint('19970604', 'key-one')
  const b = fingerprint('19970604', 'key-two')
  assert.ok(a && b && a !== b, '换了 HMAC 密钥指纹却没变 —— 那说明根本没用上 key')
  assert.equal(a, fingerprint('19970604', 'key-one'), '同值同密钥的指纹必须稳定，否则没法比对')
  assert.notEqual(a, fingerprint('19970605', 'key-one'), '不同值撞出了同一个指纹')
})

await check('configDigest 不含任何密钥内容（换密钥不该改变配置指纹）', () => {
  const a = configDigest({ ...fakeEnv })
  const b = configDigest({ ...fakeEnv, ADMIN_TOKEN: 'LEAK-ADMIN_TOKEN-LEAK-but-different' })
  assert.equal(a, b, '换一个密钥的值就把配置指纹改了 —— 说明密钥值进了摘要')
  const c = configDigest({ ...fakeEnv, PUBLIC_SITE_URL: 'https://other.example' })
  assert.notEqual(a, c, '换了非密钥项的值，指纹却没变 —— 那这个摘要什么也没在摘')
  const d = configDigest({ ...fakeEnv, ADMIN_TOKEN: '' })
  assert.notEqual(a, d, '密钥从「配了」变成「没配」，指纹必须变（配没配本身是配置的一部分）')
})

console.log('\n二、⚠️ 清单必须和代码真实读取的变量一一对应')

await check('server/src 里读的每一个变量，清单里都有', () => {
  const used = scanEnvUsage()
  const missing = [...used.keys()].filter((k) => !specOf(k))
  assert.deepEqual(missing, [], `代码里读了但清单里没有：${missing.join(', ')} —— 这几项永远不会显示在后台`)
})

await check('清单里的每一项，代码里真的读了（或明确标了是脚本专用）', () => {
  const used = scanEnvUsage()
  const SCRIPT_ONLY = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NICKNAME']
  const dead = ENV_MANIFEST.map((s) => s.name).filter(
    (n) => !used.has(n) && !SCRIPT_ONLY.includes(n),
  )
  assert.deepEqual(dead, [], `清单里有但代码不读：${dead.join(', ')} —— 后台会显示一个不存在的开关`)
})

await check('清单记的读取位置没有漂（文件被挪走会红）', () => {
  const used = scanEnvUsage()
  const wrong = []
  for (const [name, file] of used) {
    const spec = specOf(name)
    if (spec && spec.file !== file) wrong.push(`${name}: 清单说 ${spec.file}，实际在 ${file}`)
  }
  assert.deepEqual(wrong, [], wrong.join('；'))
})

await check('⚠️ 扫描器认得出间接读法（只认 env.X 会漏掉这几个）', () => {
  const used = scanEnvUsage()
  // trimEnv('X') —— routes/auth.js；envMb('X', n) —— routes/submit-game.js
  for (const k of ['MICROSOFT_CLIENT_ID', 'APPLE_PRIVATE_KEY_PATH', 'SUBMIT_ROM_MAX_FILE_MB']) {
    assert.ok(used.has(k), `扫描器漏了 ${k} —— 间接读法那几条正则失效了`)
  }
})

await check('⚠️ 扫描器会剥注释（注释里提到的变量不算数）', () => {
  const used = scanEnvUsage()
  // mail.js 的注释里有一句 `env.EMAIL.send()`。它不是配置项。
  assert.ok(!used.has('EMAIL'), '把注释里的 env.EMAIL 当成了真的配置项')
})

await check('没有重复条目，分组都不为空', () => {
  const names = ENV_MANIFEST.map((s) => s.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  assert.deepEqual(dup, [], `清单里有重复：${dup.join(', ')}`)
  for (const g of envGroups()) {
    assert.ok(ENV_MANIFEST.some((s) => s.group === g), `分组 ${g} 是空的`)
  }
})

console.log('\n三、来源判定：空串等于没配')

await check('⚠️ 空串算「用默认值」，不算「配了」', () => {
  /*
    代码里一律是 `env.X || 默认值`，所以 `X=` 和整行删掉**行为完全一样**。
    这一页要是把空串显示成「已配置」，会让人以为自己配过了 —— 而那正是要防的误判。
  */
  const r = effectiveConfig({ PUBLIC_SITE_URL: '', ADMIN_TOKEN: '   ' })
  const items = r.groups.flatMap((g) => g.items)
  assert.equal(items.find((i) => i.name === 'PUBLIC_SITE_URL').source, 'default')
  assert.equal(items.find((i) => i.name === 'ADMIN_TOKEN').source, 'default', '只有空白也该算没配')
  const r2 = effectiveConfig({ PUBLIC_SITE_URL: 'https://x.example' })
  assert.equal(
    r2.groups.flatMap((g) => g.items).find((i) => i.name === 'PUBLIC_SITE_URL').source,
    'env',
  )
})

await check('counts 和实际条目对得上', () => {
  const r = effectiveConfig({ PUBLIC_SITE_URL: 'https://x.example', PORT: '8788' })
  assert.equal(r.counts.total, ENV_MANIFEST.length)
  assert.equal(r.counts.set, 2, `counts.set 是 ${r.counts.set}，应该是 2`)
  assert.equal(r.counts.set + r.counts.default, r.counts.total)
  const shown = r.groups.flatMap((g) => g.items).length
  assert.equal(shown, ENV_MANIFEST.length, '有条目在分组时丢了')
})

await check('长值会被截断（这一页是用来扫一眼的，不是读全文的）', () => {
  const long = 'x'.repeat(500)
  const r = effectiveConfig({ ALLOWED_ORIGINS: long })
  const item = r.groups.flatMap((g) => g.items).find((i) => i.name === 'ALLOWED_ORIGINS')
  assert.ok(item.value.length < 220, `没截断，长度 ${item.value.length}`)
  assert.ok(item.value.includes('共 500 字符'), '截断了却没说原来多长')
})

console.log('\n四、体检：每条规则都要能命中、也要能不命中')

await check('一份干净的配置应该零告警', () => {
  const clean = {
    ALLOWED_ORIGINS: 'https://8bitgo.com',
    PUBLIC_SITE_URL: 'https://8bitgo.com',
    ADMIN_AUTH_DISABLED: '0',
    JWT_SECRET: 'a'.repeat(64),
    ADMIN_TOKEN: 'b'.repeat(32),
    PLAY_HASH_SECRET: 'c'.repeat(64),
    RESEND_API_KEY: 'd'.repeat(32),
    SUBMIT_GAME_TO_EMAIL: 'me@8bitgo.com',
    OPEN_JWT_PRIVATE_KEY_PATH: '/srv/open-jwt.pem',
    OPEN_ROM_SECRET: 'e'.repeat(32),
    OPEN_EMBED_SECRET: 'f'.repeat(32),
  }
  assert.deepEqual(configChecks(clean).map((c) => c.id), [], '干净配置也在报警')
})

await check('⚠️ 每一条规则都至少能被某份配置命中（没有恒假的死规则）', () => {
  /*
    一条恒假的规则比没有规则更糟：它让人以为这件事**被检查过了**。
    所以这里逐条构造一份会命中它的 env。
  */
  const CASES = {
    'admin-auth-disabled': { ADMIN_AUTH_DISABLED: '1', I_KNOW_ADMIN_AUTH_IS_DISABLED: '1' },
    'cors-wildcard': {},
    'secret-reuse': { JWT_SECRET: 'same-value-here-32-chars-long!!', ADMIN_TOKEN: 'same-value-here-32-chars-long!!' },
    'weak-secret': { ADMIN_TOKEN: '19970604' },
    'submit-email-missing': {},
    'play-hash-coupled': { JWT_SECRET: 'x'.repeat(40) },
    'open-platform-off': {},
    'open-rom-off': { OPEN_JWT_PRIVATE_KEY_PATH: '/srv/k.pem' },
    'mock-endpoint': { RESEND_API_BASE: 'http://127.0.0.1:9' },
    'turn-insecure-tls': { TURN_PROBE_INSECURE_TLS: '1' },
    'no-mail-channel': {},
    'seed-creds-left': { ADMIN_PASSWORD: 'hunter2hunter2hunter2' },
    'site-url-missing': {},
  }
  const ids = CHECKS.map((c) => c.id)
  assert.deepEqual(
    ids.filter((id) => !(id in CASES)),
    [],
    '有新规则没写命中用例 —— 补一个，否则它可能恒假而没人知道',
  )
  for (const [id, env] of Object.entries(CASES)) {
    const hit = configChecks(env).some((c) => c.id === id)
    assert.ok(hit, `规则 ${id} 构造了应该命中的配置却没命中 —— 它可能恒假`)
  }
})

await check('⚠️ ADMIN_AUTH_DISABLED 那条看的是**两道闸都开**（只开一道时后台其实是安全的）', () => {
  // auth.js 里 ADMIN_AUTH_DISABLED 要配合 I_KNOW_... 才真的生效。
  // 只看前一个的话，会对一台其实安全的机器狂报「后台裸奔」—— 报错报错了，比不报还糟。
  const onlyOne = configChecks({ ADMIN_AUTH_DISABLED: '1' }).map((c) => c.id)
  assert.ok(!onlyOne.includes('admin-auth-disabled'), '只开一道闸就报了「后台裸奔」')
  const both = configChecks({ ADMIN_AUTH_DISABLED: '1', I_KNOW_ADMIN_AUTH_IS_DISABLED: '1' }).map((c) => c.id)
  assert.ok(both.includes('admin-auth-disabled'), '两道闸都开了反而不报')
})

await check('⚠️ 路径型变量归 config 不归 secret（否则会被当成弱密钥狂报）', () => {
  /*
    这条原来写的是「weak-secret 规则里跳过 *_PATH」，而那个跳过分支**永远走不到** ——
    因为 *_PATH 那两个的 kind 本来就是 config，规则只遍历 secret。
    变异测试实测：把那个跳过删掉，测试照样全绿。死代码 + 空断言，两个一起删了。
    真正该钉的不变量是**分类本身**：路径不是密钥，它是「去哪儿找密钥」。
  */
  const paths = ENV_MANIFEST.filter((s) => s.name.endsWith('_PATH'))
  assert.ok(paths.length >= 2, `只找到 ${paths.length} 个路径型变量，断言的前提没了`)
  for (const s of paths) {
    assert.equal(s.kind, 'config', `${s.name} 被归成了密钥 —— 它是路径，会被弱密钥规则误报`)
  }
  // 而真的短密钥要报
  assert.ok(
    configChecks({ ADMIN_TOKEN: 'short' }).some((c) => c.id === 'weak-secret'),
    '短密钥没被报出来 —— 上面那条反证不成立',
  )
  assert.ok(
    !configChecks({ OPEN_JWT_PRIVATE_KEY_PATH: '/k.pem' }).some((c) => c.id === 'weak-secret'),
    '一个文件路径被当成了弱密钥',
  )
})

await check('一条规则写崩了不会把整页带下去', () => {
  const boom = { get ALLOWED_ORIGINS() { throw new Error('炸') } }
  assert.doesNotThrow(() => configChecks(boom))
})

console.log('\n四之二、启动自检：开放平台那几张表')

await check('⚠️ 开放平台查的每一张 oauth_* 表，schema-check 都盯着', async () => {
  /*
    为什么单独钉这个：开放平台是靠 .env 里的 OPEN_JWT_PRIVATE_KEY 开关的，
    而那个开关和**建表**是两件事。只配了密钥、没跑 migrate 的状态下——
    /v1/health 正常、/v1/games 正常、/.well-known/jwks.json 也正常，
    看起来「开起来了」——但 /open 控制台一点「创建应用」就 500，
    取令牌永远 invalid_client。查的人会去翻密钥、翻 scope、翻 bcrypt，
    因为「其它都好的」。

    schema-check 在启动时就会把缺表说清楚并给出 `npm run migrate`，
    但前提是那张表在它的清单里。这条测试保证清单不落后于代码。
  */
  const fs = await import('node:fs')
  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'))

  /** 开放平台那几个文件里真的查了哪些 oauth_* 表 */
  const used = new Set()
  /*
    ⚠️ 扫**整个 server/src**，别手写文件清单。
    第一版只列了 routes/ 里那几个，结果只扫出 2 张 —— 因为 SQL 其实写在
    open/apps-repo.js 里。手写清单和代码一样会漂，而且漂了之后这条测试
    只会变得更宽松（扫不到就不检查），不会变红。
  */
  const walkSrc = (d, acc = []) => {
    for (const n of fs.readdirSync(d)) {
      const fp = join(d, n)
      if (fs.statSync(fp).isDirectory()) walkSrc(fp, acc)
      else if (fp.endsWith('.js') && !fp.endsWith('schema-check.js')) acc.push(fp)
    }
    return acc
  }
  for (const fp of walkSrc(SRC)) {
    const src = stripComments(fs.readFileSync(fp, 'utf8'))
    for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+`?(oauth_[a-z_]+)`?/gi)) used.add(m[1].toLowerCase())
  }
  assert.ok(used.size >= 4, `只扫出 ${used.size} 张 oauth_* 表，正则漂了`)

  const checkSrc = read('../src/schema-check.js')
  const watched = new Set(
    [...checkSrc.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1]),
  )
  const blind = [...used].filter((t) => !watched.has(t)).sort()
  assert.deepEqual(
    blind, [],
    `这些表开放平台会查，但 schema-check 没盯着：${blind.join(', ')} —— ` +
      '缺了它们的库启动时不会有任何提示，只会在建应用时 500',
  )
})

console.log('\n五、HTTP 层：只读，且只给 admin')

const app = express()
app.use(express.json())
app.use('/api/admin/config', adminConfigRouter)
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const call = (init) => fetch(`${base}/api/admin/config`, init)
const asAdmin = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` }

await check('没有凭证 -> 403', async () => {
  assert.equal((await call()).status, 403)
})

await check('乱填的后台口令 -> 403', async () => {
  assert.equal((await call({ headers: { Authorization: 'Bearer nope' } })).status, 403)
})

await check('后台口令对了 -> 200，而且不许被缓存', async () => {
  const r = await call({ headers: asAdmin })
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('cache-control')), /no-store/)
  const body = await r.json()
  assert.ok(Array.isArray(body.groups) && body.groups.length > 0)
  assert.ok(Array.isArray(body.checks))
  assert.equal(typeof body.uptimeSec, 'number')
})

await check('⚠️⚠️ 真实进程 env 走一遍 HTTP，响应里也不能有密钥原文', async () => {
  // 上面那条测的是纯函数；这条测的是**这条路由真的接出去的字节**
  const blob = await (await call({ headers: asAdmin })).text()
  assert.ok(!blob.includes(process.env.ADMIN_TOKEN), '后台口令出现在了响应体里')
  assert.ok(!blob.includes(process.env.JWT_SECRET), 'JWT_SECRET 出现在了响应体里')
  assert.ok(blob.includes('ADMIN_TOKEN'), '连变量名都没有 —— 上面两条断言是空的')
})

await check('⚠️ 这一页没有写接口（POST / PUT / DELETE 一律不通）', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call({ method, headers: { ...asAdmin, 'Content-Type': 'application/json' }, body: '{}' })
    assert.ok(r.status === 404 || r.status === 405, `${method} 回了 ${r.status}，像是有写接口`)
  }
  const src = stripComments(readFileSync(new URL('../src/routes/admin-config.js', import.meta.url), 'utf8'))
  assert.ok(!/\.(post|put|patch|delete)\s*\(/.test(src), '路由文件里出现了写方法')
})

await check('⚠️ 用的是 requireAdmin，没跟着 ROLE_ABILITIES 那张会变的表走（源码断言）', () => {
  const src = stripComments(readFileSync(new URL('../src/routes/admin-config.js', import.meta.url), 'utf8'))
  assert.ok(src.includes('requireAdmin'), '换成 requireAbility 了 —— 那张表改一行这页就跟着放开')
  assert.ok(!src.includes('requireAbility'), '用了 requireAbility')
})

await check('⚠️ 后台导航和服务端对齐：配置页标了 adminOnly（源码断言）', () => {
  const layout = readFileSync(new URL('../../src/admin/AdminLayout.tsx', import.meta.url), 'utf8')
  const tab = layout.slice(layout.indexOf("to: '/admin/config'"))
  assert.ok(tab.slice(0, 120).includes('adminOnly'), '导航没标 adminOnly，志愿者会看到一个点进去 403 的入口')
  assert.ok(
    /adminOnly\s*\|\|\s*me\?\.role === 'admin'/.test(layout),
    'adminOnly 标了但过滤那行没用上它',
  )
})

server.close()
console.log(failed ? `\n❌ ${failed} 条失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
