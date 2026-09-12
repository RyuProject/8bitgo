/**
 * 站内消息（IM）接入的结构性回归测试。跑：npm run test:im-client
 *
 * 这一份**不测 UI、也不连腾讯** —— 那需要真账号和真 WebSocket，跑不进 CI。
 * 它盯的是七件「改一行就坏、而且坏了很难看出来」的事，全部靠读源码断言：
 *
 *   1. SDK 只能动态 import。写成顶层 import，700 KB 会静默进主包 ——
 *      没登录的访客也要下载，而且没有任何报错提示你。
 *   2. 密钥不能出现在前端任何地方。
 *   3. 签发接口只认 req.user.id，不认请求参数（认了就等于把主密钥开放出去）。
 *   4. 被踢下线不能自动重连（会和另一个标签页无限互踢）。
 *   5. 未读数只能转发 SDK 报的总数，不能自己 +1。
 *   6. 抽屉的 role="dialog" 必须是条件挂载（常驻会让模拟器的滚动守卫永久失效）。
 *   7. 严格模式下的注销要判「当前这个是不是我」。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (f) => readFileSync(path.join(root, f), 'utf8')
/** 去注释再扫：注释里引用一段代码或写着「不要这么做」会让朴素的 grep 误判 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

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

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const CLIENT = 'src/services/imClient.ts'
const PANEL = 'src/components/im/ImPanel.tsx'
const ROUTE = 'server/src/routes/im.js'
const client = read(CLIENT)
const clientCode = strip(client)

console.log('\n一、SDK 不能进主包')

check('⭐ imClient.ts 里 SDK 只有动态 import 和纯类型 import', () => {
  // 顶层值导入会让 @tencentcloud/chat 进主包。这个仓库的 test-bundle-split.mjs
  // 刻意不跟随动态 import（那正是分包点），所以它抓不到这个错 —— 只能在这里抓。
  const valueImports = [...clientCode.matchAll(/^import\s+(?!type\b)[^\n]*?from\s+'@tencentcloud\/chat'/gm)]
  assert.deepEqual(
    valueImports.map((m) => m[0]),
    [],
    '出现了顶层值导入 —— 700 KB 会静默进主包，没有任何报错提示你',
  )
  assert.match(clientCode, /import type\s+\w+\s+from\s+'@tencentcloud\/chat'/, '类型导入不见了？')
  assert.match(clientCode, /await import\('@tencentcloud\/chat'\)/, '找不到动态 import')
})

check('⭐ 除 imClient.ts 外，没有别的文件引用这个包', () => {
  const bad = []
  for (const f of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, f)
    if (rel === CLIENT) continue
    if (/@tencentcloud\/chat/.test(strip(readFileSync(f, 'utf8')))) bad.push(rel)
  }
  assert.deepEqual(bad, [], 'SDK 的引用点必须只有一处，否则分包边界会漏')
})

check('包版本钉死，不用 ^ 或 ~', () => {
  // 这个 SDK 的小版本里改过事件语义（未读总数口径、KICKED_OUT 的子类型），
  // 而 imClient.ts 对那些语义是有依赖的。升级要人看着升。
  const pkg = JSON.parse(read('package.json'))
  const v = pkg.dependencies?.['@tencentcloud/chat']
  assert.ok(v, 'package.json 的 dependencies 里没有 @tencentcloud/chat')
  assert.match(v, /^\d+\.\d+\.\d+$/, `版本必须是精确值，现在是 ${v}`)
  assert.ok(
    existsSync(path.join(root, 'node_modules/@tencentcloud/chat/package.json')),
    'node_modules 里没装 —— 在你自己的机器上跑一次 npm install',
  )
  const installed = JSON.parse(read('node_modules/@tencentcloud/chat/package.json')).version
  assert.equal(installed, v, `装的是 ${installed}，package.json 写的是 ${v}`)
})

check('分包测试会盯住这个包（将来有人写成静态 import 时能红两次）', () => {
  assert.match(read('scripts/test-bundle-split.mjs'), /@tencentcloud\/chat/, 'test-bundle-split.mjs 的重量级清单里没有它')
})

console.log('\n二、密钥不能出现在前端')

check('⭐ 前端源码里没有 SecretKey 相关的任何痕迹', () => {
  const bad = []
  for (const f of [...walk(path.join(root, 'src')), path.join(root, 'index.html')]) {
    if (!existsSync(f)) continue
    const src = readFileSync(f, 'utf8')
    // 连变量名都不该出现在前端 —— 出现了说明有人想从 import.meta.env 里读它
    if (/TENCENT_IM_SECRET_KEY|SDKSecretKey/i.test(src)) bad.push(path.relative(root, f))
  }
  assert.deepEqual(bad, [], '密钥只能留在 server/.env，前端连名字都不该提')
})

check('⭐ 没有任何 VITE_ 前缀的 IM 密钥变量（那种会被打进 JS 包）', () => {
  for (const f of ['.env.development', '.env.production', 'src/vite-env.d.ts']) {
    if (!existsSync(path.join(root, f))) continue
    const src = read(f)
    assert.ok(!/VITE_[A-Z_]*(?:SECRET|USERSIG|USER_SIG)/i.test(src), `${f} 里出现了 VITE_ 前缀的密钥变量`)
  }
})

check('server/.env 没被 git 跟踪（例子文件里必须是空值）', () => {
  const example = read('server/.env.example')
  for (const key of ['TENCENT_IM_SDK_APPID', 'TENCENT_IM_SECRET_KEY']) {
    assert.match(example, new RegExp(`^${key}=\\s*$`, 'm'), `.env.example 里 ${key} 必须留空`)
  }
})

console.log('\n三、签发接口')

const route = strip(read(ROUTE))

/**
 * 只取签发那一段。
 *
 * 以前这里是全文查的，因为 im.js 里只有 /sig 一个 handler。加了「按邮箱找人」之后
 * 全文查会误伤：那条接口**本来就要**读 req.body.email。
 * 所以按 handler 切段 —— 规则没有放松，只是落到了它真正该管的那一段上。
 */
const sigSeg = route.slice(route.indexOf("imRouter.get('/sig'"), route.indexOf("imRouter.post('/lookup'"))

check('⭐ userID 只取 req.user.id，不接受任何请求参数', () => {
  // 这是整个接入里最要紧的一条。如果允许调用方指定 userID，这个接口就等于
  // 把主密钥的能力原样开放出去 —— 任何人都能签一份别人的 sig 然后读对方的会话。
  assert.ok(sigSeg.length > 200, '切段失败 —— handler 名字改了？')
  assert.match(sigSeg, /String\(req\.user\.id\)/, '没有从 req.user.id 取')
  assert.ok(!/req\.(query|body|params)/.test(sigSeg), '签发接口里出现了 req.query / req.body / req.params')
})

check('⭐ 找人接口的请求体里只允许有 email', () => {
  // 同一条铁律在这条接口上的形态：身份仍然只能来自 req.user.id，
  // 请求体只准携带「要查谁」，不准携带「我是谁」。
  /*
    只切 /lookup 自己那一段（到下一个 imRouter 声明为止）。
    切到文件末尾的话，它下面的 POST /peers 会被算进来 ——
    那条接口合法地读 req.body?.ids，于是这条断言会误报。真踩过。
  */
  const at = route.indexOf("imRouter.post('/lookup'")
  const nextAt = route.indexOf('imRouter.', at + 20)
  const seg = nextAt > at ? route.slice(at, nextAt) : route.slice(at)
  const bodyReads = [...seg.matchAll(/req\.body\??\.?\w*/g)].map((m) => m[0])
  assert.deepEqual([...new Set(bodyReads)], ['req.body?.email'], `请求体里还读了别的：${bodyReads.join(', ')}`)
  assert.ok(!/req\.(query|params)/.test(seg), '找人接口里出现了 req.query / req.params')
})

check('整个路由挂了 requireUser', () => {
  assert.match(route, /imRouter\.use\(requireUser\)/)
})

check('没配置时回 501，且响应体里不带配置细节', () => {
  // 501 而不是 500：语义是「服务端没启用这个功能」，前端据此保持占位面板。
  assert.match(route, /status\(501\)/, '没配置应该回 501')
  // 只查**响应体**。变量名出现在 console.warn 里是对的（那是服务器日志，
  // 正是运维要看的东西）；出现在 json() 里就是把服务端配置状态告诉了任何人。
  const bodies = [...route.matchAll(/\.json\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(bodies.length, '找不到任何 json() 响应')
  for (const b of bodies) {
    assert.ok(!/TENCENT_|SECRET|secretKey/i.test(b), `响应体里带了配置细节：${b}`)
  }
  // 反过来，日志里**应该**说清是哪两个变量没配，否则运维只能猜
  assert.match(route, /console\.warn\([^)]*TENCENT_IM_SDK_APPID/, '日志里应该点名是哪个变量没配')
})

check('⚠️ 签发接口有按账号的限流，且 take() 的返回值用对了', () => {
  /*
    take() 返回的是 { ok, retryAfter } 对象，不是布尔。
    写成 `if (!take(...))` 的话对象恒为真，限流**静默失效** —— 我自己就先写错了一次。
  */
  assert.match(route, /take\(`im:sig:\$\{req\.user\.id\}`/, '没有按账号限流')
  assert.match(route, /if \(!gate\.ok\)/, '限流的返回值用错了（take 返回对象不是布尔）')
  assert.ok(!/if \(!take\(/.test(route), '出现了 `if (!take(...))` —— 那样限流恒不触发')
  assert.match(route, /status\(429\)/)
  assert.match(route, /Retry-After/, '429 应该带 Retry-After')
})

check('已挂到 /api/im 上', () => {
  const idx = strip(read('server/src/index.js'))
  assert.match(idx, /app\.use\('\/api\/im', imRouter\)/)
})

console.log('\n四、被踢下线不能自动重连')

check('⭐ KICKED_OUT 只对 USERSIG_EXPIRED 自动重连，其余进 kicked 状态等用户点', () => {
  /*
    腾讯控制台的「Web 端最大在线实例数」默认是 1 —— 同一账号开第二个标签页会踢掉第一个。
    这个站用户开多标签是常态。如果收到 KICKED_OUT 就无脑重登，两个标签会互相踢来踢去、
    无限循环，每轮一次 login 请求，很快撞上腾讯的频率限制。
  */
  // 精确切出这个处理器：从它开始，到紧跟其后的 syncProfile 定义为止。
  // 边界必须钉住 —— 早先这里切到文件末尾，把别处合法的 ensureImStarted 也算了进来，
  // 测试自己误报。
  const start = clientCode.indexOf('E.KICKED_OUT')
  const end = clientCode.indexOf('async function syncProfile', start)
  assert.ok(start > 0, '找不到 KICKED_OUT 的处理器')
  assert.ok(end > start, '找不到 syncProfile —— 文件结构变了，这条断言的边界要重新定')
  const seg = clientCode.slice(start, end)

  assert.match(seg, /KICKED_OUT_USERSIG_EXPIRED/, '没有单独处理 sig 过期')
  assert.match(seg, /setState\('kicked'/, '没有 kicked 状态')

  // 自动重连只允许出现在 sig 过期那一支里
  const split = seg.indexOf("setState('kicked'")
  assert.match(seg.slice(0, split), /ensureImStarted/, 'sig 过期那一支应该自动重连')
  assert.ok(!/ensureImStarted/.test(seg.slice(split)), '被踢的那一支不能自动重连')

  // 而且被踢时要**先改状态再拆**：teardown 里 logout + destroy 是两个网络往返，
  // 那段时间 UI 还显示 ready 的话，用户在里面打的字是静默失败
  const kickBranch = seg.slice(split)
  assert.ok(
    kickBranch.indexOf("setState('kicked'") < kickBranch.indexOf('teardown'),
    '被踢时必须先 setState 再 teardown',
  )
})

check('kicked 状态在界面上有出路（一句说明 + 一颗重连按钮）', () => {
  const p = read(PANEL)
  assert.match(p, /t\.im\.kickedHint/, '没有向用户解释为什么被踢')
  assert.match(p, /imReconnect/, '没有重连按钮')
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja']) {
    assert.match(read(`src/locales/${lang}.ts`), /kickedHint:/, `${lang} 少了 kickedHint`)
  }
})

console.log('\n五、未读数只转发，不自己算')

check('⭐ setImUnread 的唯一来源是 SDK 报的未读总数', () => {
  // 参数里有嵌套括号（Number(e.data)），所以不能用 /\(([^)]*)\)/ —— 那会切成
  // `Number(e.data`。数括号取到配平为止。
  const calls = []
  for (let i = clientCode.indexOf('setImUnread('); i >= 0; i = clientCode.indexOf('setImUnread(', i + 1)) {
    let depth = 0
    let j = i + 'setImUnread'.length
    const from = j + 1
    for (; j < clientCode.length; j++) {
      if (clientCode[j] === '(') depth++
      else if (clientCode[j] === ')' && --depth === 0) break
    }
    calls.push(clientCode.slice(from, j).trim())
  }
  // 允许两种：转发事件里的总数，和退出时清零
  const allowed = new Set(['Number(e.data)', '0'])
  for (const c of calls) {
    assert.ok(allowed.has(c), `setImUnread(${c}) 不在允许的形式里 —— 断线重连后本地累加值一定是错的`)
  }
  assert.ok(calls.includes('Number(e.data)'), '没有转发 SDK 的未读总数')
  assert.match(clientCode, /TOTAL_UNREAD_MESSAGE_COUNT_UPDATED/, '没监听未读总数事件')
  assert.ok(!/unread\s*\+\+|unread\s*\+=/.test(clientCode), '出现了本地自增')
})

console.log('\n六、抽屉不能踩到模拟器的滚动守卫')

check('⭐ role="dialog" 是条件挂载，不是常驻', () => {
  /*
    emulator/scrollGuard.ts 用 document.querySelector('[role="dialog"]') 判断
    「页面上是不是开着模态框」，开着就整套让位（方向键交还给页面）。
    抽屉是**一直挂在 DOM 里**的（靠 transform 滑出），如果 role 常驻，
    那个守卫就永久失效 —— 玩游戏按方向键会滚动页面，而且没人会想到是聊天面板干的。
  */
  // 去注释：文件顶上那段说明里就写着 role="dialog"，直接扫会误判
  const p = strip(read(PANEL))
  assert.match(p, /role=\{open \? 'dialog' : undefined\}/, 'role 必须跟着 open 走')
  assert.ok(!/role="dialog"/.test(p), '出现了写死的 role="dialog"')
  // 守卫那边的判断没变过吧
  assert.match(read('src/emulator/scrollGuard.ts'), /querySelector\('\[role="dialog"\]'\)/, '守卫的判断方式变了，上面这条要重新想')
})

check('⭐ 首次打开之前不渲染内容（否则「正在连接…」会 SSR 进每一个页面）', () => {
  /*
    抽屉是一直挂着的（靠 transform 滑出）。如果内容也一直渲染，那么 state 初值
    'off' 会让它渲染出「正在连接…」—— 而这段 HTML 会被 SSR 进**每一个页面**，
    爬虫在每个页面的正文里都能读到它。所以要有一个只从 false 变 true 的 mounted 闸门。
  */
  const p = strip(read(PANEL))
  assert.match(p, /const \[mounted, setMounted\] = useState\(false\)/, '没有 mounted 闸门')
  assert.match(p, /\{mounted && \(/, 'mounted 没有真的用来门控内容')
  // 闸门只能被置 true，不能被置回 false（否则收起时内容会突然消失）
  assert.ok(!/setMounted\(false\)/.test(p), 'mounted 不该被置回 false')
  // 连接状态那句文案必须在闸门里面，不能漏在外面
  const gate = p.indexOf('{mounted && (')
  assert.ok(p.indexOf('StatusBody') > gate, 'StatusBody 渲染在闸门之外')
})

check('抽屉不去改 body 的 overflow（仓库里已经有两份互相冲突的滚动锁）', () => {
  assert.ok(!/body\.style\.overflow/.test(strip(read(PANEL))), '又加了一份滚动锁')
})

console.log('\n七、竞态防护（那个跨账号漏洞）')

/*
  ⚠️ 这一节的断言只查「防护接上了没有」。**真正的行为验证在
  scripts/test-im-session.mjs**（在 node 里真起异步、真中途换人）。

  为什么要这么分：第一版把两条防护写在 imClient 里，测试用正则查它们的
  代码形状 —— 形状在、但两条都能绕过，于是一个跨账号冒充漏洞被测试盖住了。
  形状断言只能防「有人把它删了」，防不住「它本来就是错的」。所以逻辑搬进了
  零依赖的 imSession.ts，那边能真的跑。
*/

check('⭐ 连接走 imSession 的 startOnce，不再自己攥一个 promise', () => {
  assert.match(clientCode, /startOnce\(user\.id,/, '没有走 startOnce')
  assert.ok(
    !/\blet starting\b/.test(clientCode),
    '又出现了自己管理的 starting —— 那正是跨账号冒充的成因，交给 imSession',
  )
})

check('⭐ 每跨一个 await 都问一次 isStale —— 守卫必须紧贴下一行', () => {
  /*
    ⚠️ 这条断言改过两次，两次都因为写法太松而漏掉变异，记下来免得有人又改回去：

      v1「至少 5 处 isStale」—— 一共 6 处，删掉一处还剩 5，绿。计数挡不住
         「少了关键的那一处」，而漏掉哪一处决定了漏掉什么后果。
      v2「锚点之后 220 字内有 isStale」—— 窗口太宽，会把 catch 里那处算进来，
         于是删掉 try 之前那处照旧是绿的。

    现在要求守卫是锚点的**紧邻下一行**。少一处的后果：那一段之后的赋值会在
    「已经登出 / 已经换人」之后照旧执行 —— 那就是跨账号冒充漏洞的成因。
  */
  const GUARD = String.raw`\n\s*if \(isStale\(epoch\)\) return false`
  const adjacent = (anchorRe, why) =>
    assert.match(clientCode, new RegExp(anchorRe + GUARD), `${why}之后紧邻的那一行必须是 isStale 守卫`)

  adjacent(String.raw`if \(chat\) await teardown\(\)`, '拆掉旧连接')
  adjacent(String.raw`\} catch \(e\) \{`, '取 sig 的 catch 开头')
  // 取 sig 的 try/catch 收尾。用它前一句（catch 里写 error 状态那一行）当锚点 ——
  // 光写 `^\s*\}$` 的话要 m 标志，而且大括号到处都是，容易匹配到别的地方
  adjacent(
    String.raw`setStateIf\(epoch, 'error', e instanceof Error \? e\.message : String\(e\)\)\n\s*return false\n\s*\}`,
    '取 sig 的 try/catch 收尾',
  )
  adjacent(String.raw`const mod = await import\('@tencentcloud/chat'\)`, '下 SDK 分包')

  // login 之后那道守卫形状不同（要 teardown），单独一条断言查，见下
  assert.match(clientCode, /userSig: sig\.userSig \}\)/, '找不到 login 调用')
})

check('⭐ login 之后发现已作废时，必须把已经建立的连接拆掉 —— 而且只拆自己那一个', () => {
  // 光把 chat 置空没用：SDK 按 SDKAppID 缓存实例，而那条连接已经登录成功了
  assert.match(
    clientCode,
    /if \(isStale\(epoch\)\) \{\s*await teardownOwn\(created\)/,
    'login 之后那道守卫必须 await teardownOwn(created)，不能只 return',
  )
  /*
    ⚠️⚠️ 这里**不能**是全局的 teardown()。它拆的是模块级的 `chat`，而这一代作废时
    `chat` 很可能已经是**新一代**的连接了。2026-09-12 查出的致命形状：

      A 登录 → login 在飞 → A 登出 → B 登录并连上（ready）
      → 几百毫秒后 A 那次 login 才结算 → 这一行把 **B 正用着的连接**拆了
      → setStateIf 因为 stale 被忽略，状态纹丝不动停在 ready

    结果是 imState() === 'ready' 但 chat === null：面板显示在线、发消息报未连接、
    顶栏退回占位、回到前台的自检因为「已经是 ready」直接跳过 —— 不刷新页面永远回不来。
  */
  assert.doesNotMatch(
    clientCode,
    /if \(isStale\(epoch\)\) \{\s*await teardown\(\)/,
    '作废分支拆的是全局 chat —— 会把新一代活着的连接一起拆掉',
  )
})

check('⭐ 连接失败的 catch 也只拆自己那一代的实例', () => {
  const i = clientCode.indexOf("console.warn('[im] 连接失败：'")
  assert.ok(i > 0, '找不到连接失败的 catch（改了日志文案的话这条断言也要跟着改）')
  const body = clientCode.slice(i, i + 240)
  assert.match(body, /await teardownOwn\(created\)/, '连接失败没有拆掉自己那一代的实例')
  assert.doesNotMatch(body, /await teardown\(\)\s/, '连接失败拆的是全局 chat —— 理由同上一条')
})

check('⚠️ 自动路径必须过节流，手动路径不受它管', () => {
  // 自动的三条：空闲首连、回到前台自检、sig 过期
  const autos = [...clientCode.matchAll(/ensureImStarted\(\{ auto: true \}\)/g)].length
  assert.ok(autos >= 3, `只有 ${autos} 处自动调用带了 auto 标记，应当至少 3 处（空闲 / 回前台 / sig 过期）`)
  assert.match(
    clientCode,
    /if \(options\.auto && !autoRetryAllowed\(\)\) return Promise\.resolve\(false\)/,
    'ensureImStarted 里没有那道 auto 节流 —— 调用方各判各的挡不住（ImPanel 那个 effect 就是从旁边绕过去的）',
  )
  // imReconnect 是用户明确点的，绝不能带 auto
  const i = clientCode.indexOf('export async function imReconnect')
  assert.ok(i > 0, '找不到 imReconnect')
  assert.doesNotMatch(clientCode.slice(i, i + 500), /auto: true/, '手点「重新连接」被套上了节流')
})

check('⚠️ connecting 有看门狗兜底（否则它是个没有出口的状态）', () => {
  assert.match(clientCode, /armReadyWatchdog\(epoch\)/, 'login 之后没有武装看门狗')
  assert.match(clientCode, /clearReadyWatchdog\(\)/, '没有清看门狗的地方')
  const i = clientCode.indexOf('function armReadyWatchdog')
  assert.ok(i > 0, '找不到看门狗')
  const body = clientCode.slice(i, i + 400)
  assert.match(body, /imState\(\) !== 'connecting'/, '看门狗没有确认自己还在 connecting 上')
  assert.match(body, /setStateIf\(epoch, 'error'\)/, "超时之后必须转成 error —— 那是唯一有出口的失败态")
})

check('⚠️ 被踢下线不清未读数（那会告诉用户「没有新消息」）', () => {
  const i = clientCode.indexOf('function retractOpener')
  assert.ok(i > 0, '找不到 retractOpener')
  assert.doesNotMatch(
    clientCode.slice(i, i + 200),
    /setImUnread\(0\)/,
    'retractOpener 又开始清未读了 —— 被踢时红点会跟着消失，用户以为没有新消息',
  )
  // 但「换了人」这两处必须清
  assert.match(clientCode, /export async function imStop[\s\S]{0,260}setImUnread\(0\)/, '登出没清未读')
  assert.match(clientCode, /if \(chat\) setImUnread\(0\)/, '换账号没清未读')
})

check('⭐ 拆连接时逐个 off()（create 是按 SDKAppID 缓存实例的）', () => {
  /*
    SDK 源码：`if(o&&Fr[o])return Fr[o]` —— destroy() 没走完就再 create 会拿到
    同一个事件发射器，处理器翻倍且没有句柄再也解不掉。
  */
  assert.match(clientCode, /handlers\.push\(\[event, fn\]\)/, '没有把 handler 存起来')
  assert.match(clientCode, /c\.off\(event, fn\)/, 'teardown 里没有 off()')
})

check('boundUserId 记的是服务端签发用的那个 id，不是前端缓存的', () => {
  // 前端缓存的 user.id 在 hydrateAuth 落地前可能是 localStorage 里的旧值，
  // 而这个字段正是换账号判断要比对的东西
  assert.match(clientCode, /boundUserId = sig\.userId/)
  assert.ok(!/boundUserId = user\.id/.test(clientCode), 'boundUserId 不该取前端缓存的 id')
})

check('registerImPanel 注销时判「当前这个是不是我」（严格模式 effect 跑两遍）', () => {
  assert.match(clientCode, /if \(panelOpener === fn\) panelOpener = null/)
})

check('退出登录会收掉连接，且**等 authReady 之后**再判', () => {
  const p = strip(read(PANEL))
  assert.match(p, /useAuthReady/, '没用 useAuthReady —— 只判 !user 会在每次页面加载时误判成已登出')
  assert.match(p, /if \(!authReady \|\| user\) return/, '登出分支没有先等 authReady')
  assert.match(p, /imStop\(\)/)
})

console.log('\n八、未连接不许假成功')

check('⭐ sendImText 没连上时抛，不返回 null', () => {
  // 第一版返回 null，调用方当成功 —— 气泡去掉「发送中」变成正常时间戳，
  // 其实一个字节都没走
  assert.match(clientCode, /export class ImNotConnectedError/, '没有专门的未连接错误')
  const fn = clientCode.slice(clientCode.indexOf('export async function sendImText'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /throw new ImNotConnectedError\(\)/, 'sendImText 未连接时应该抛')
  assert.ok(!/return null/.test(body), 'sendImText 不该返回 null')
})

check('拉取类接口未连接时也抛（断线不能渲染成「还没有消息」）', () => {
  for (const name of ['listImConversations', 'listImMessages']) {
    const fn = clientCode.slice(clientCode.indexOf(`export async function ${name}`))
    assert.match(fn.slice(0, 400), /throw new ImNotConnectedError\(\)/, `${name} 未连接时应该抛`)
  }
  assert.match(strip(read(PANEL)), /instanceof ImNotConnectedError/, 'UI 没有区分「断线」和「空」')
})

console.log('\n九、抽屉的几个硬伤')

check('⭐ 收到新消息不能整体替换消息数组（会毁掉翻过的历史）', () => {
  const p = strip(read(PANEL))
  assert.match(p, /function appendNew\(/, '没有 appendNew —— 整体替换会让翻过的历史当场消失')
  assert.ok(!/setItems\(page\.items\)/.test(p), '出现了整体替换 setItems(page.items)')
  // 只有首屏（prev 为空）才允许直接用整页
  assert.match(p, /prev\.length \? appendNew\(prev, page\.items\) : page\.items/)
})

check('⭐ 乐观消息和服务端消息分开存（否则刷新会把它冲掉且永不回来）', () => {
  const p = strip(read(PANEL))
  assert.match(p, /const \[pending, setPending\] = useState<ImMessage\[\]>\(\[\]\)/, '没有独立的 pending')
  assert.ok(!/setItems\(\(prev\) => \[\.\.\.prev, optimistic\]\)/.test(p), '乐观消息又塞进 items 了')
})

check('发送失败不许用旧文本覆盖输入框', () => {
  const p = strip(read(PANEL))
  assert.ok(!/setDraft\(body\)/.test(p), '失败时又把旧文本写回输入框了（会覆盖用户新打的字）')
  assert.match(p, /t\.im\.retry/, '失败的气泡上应该有重试')
})

check('⭐ 关着的抽屉必须 inert（否则里面的控件还在 Tab 顺序里）', () => {
  // 只有 aria-hidden + pointer-events-none 挡不住键盘：读屏拒绝念、Tab 却能进去，
  // 就是 axe 的 aria-hidden-focus 违规
  const p = strip(read(PANEL))
  assert.match(p, /inert=\{!open\}/, '没有 inert')
  assert.ok(!/aria-hidden=\{!open\}/.test(p), 'inert 已经覆盖了辅助技术，别再叠 aria-hidden')
})

check('打开进焦点、关闭还焦点', () => {
  const p = strip(read(PANEL))
  assert.match(p, /returnFocus/, '关闭时没有把焦点还给打开它的按钮')
  assert.match(p, /\.focus\?\.\(\)/, '打开时没有把焦点移进面板')
})

check('⚠️ Esc 也要判输入法组字（不判会毁掉中日文用户的草稿）', () => {
  const p = strip(read(PANEL))
  const esc = p.slice(p.indexOf("e.key !== 'Escape'"))
  assert.match(esc.slice(0, 300), /e\.isComposing/, 'Esc 分支没判 isComposing')
})

check('翻历史的滚动还原用 layout effect，不用 rAF', () => {
  // rAF 和 React 的提交是竞态：抢在提交之前跑就读不到新插入的节点，
  // 差值算成 0，把用户甩到最顶
  const p = strip(read(PANEL))
  assert.match(p, /anchor\.current = \{ h: el\.scrollHeight, top: el\.scrollTop \}/, '没记锚点')
  assert.match(p, /el\.scrollHeight - a\.h \+ a\.top/, '还原公式漏了点击前的 scrollTop')
  assert.ok(!/requestAnimationFrame\(\(\) => \{\s*if \(el\)/.test(p), '还在用 rAF 还原滚动')
})

check('已读上报不跟着消息条数抖（第一版一次会话要写 40 多次）', () => {
  const p = strip(read(PANEL))
  assert.ok(!/\[open, conv\.id, items\.length\]/.test(p), 'items.length 又进了已读上报的依赖数组')
  assert.match(p, /\[open, conv\.id, incoming\]/, '已读上报应该只跟着「有新消息到过」走')
})

check('昵称只在变了才同步给腾讯（SDK_READY 每次重连都会再来一次）', () => {
  assert.match(clientCode, /if \(key === syncedProfile\) return/)
})

check('不可达的 unavailable 分支已经删掉', () => {
  // 501 时从来不会 publishOpener、requestImDm 也返回 false，抽屉根本打不开 ——
  // 那种情况用户看到的是 ChatButton 自己的状态面板（见 test:im-topbar）
  const raw = read(PANEL)
  assert.ok(!/🚧/.test(strip(raw)), 'unavailable 那段死代码还在')
  /*
    ⚠️ 第二条断言要在**没去注释**的原文里找。以前它扫的是 strip 之后的源码，
    而 strip 把注释全删了 —— 那条 `|unavailable` 的或分支之所以一直绿，
    纯粹是因为当时代码里恰好有个 `state === 'unavailable'` 的条件表达式。
    2026-09-12 那个条件被拆走之后，这条就露馅了：它其实从来没在验证「注释里有说明」。
  */
  assert.match(raw, /没有[^\n]{0,12}unavailable[^\n]{0,8}分支/, '至少要在注释里说明为什么没有这个分支')
})

console.log('\n十、后台也要能收到消息')

check('⭐ 标题未读数（后台标签页唯一看得到的通道）', () => {
  assert.match(clientCode, /document\.title = want/, '没有把未读数写进标题')
  // seo.ts 每次换页都会整条重写 document.title，会把前缀冲掉
  assert.match(clientCode, /MutationObserver/, '没有盯住 <title> 被 seo.ts 重写')
  assert.match(clientCode, /if \(document\.title !== want\) document\.title = want/, '缺了防死循环的那道判断')
})

check('回到前台时自检，但不打断 SDK 自己的重连', () => {
  assert.match(clientCode, /visibilitychange/)
  const seg = clientCode.slice(clientCode.indexOf('visibilitychange'))
  // ready / connecting 不能动（SDK 有自己的重连），kicked / unavailable 要用户决定
  for (const s of ['ready', 'connecting', 'kicked', 'unavailable']) {
    assert.match(seg.slice(0, 600), new RegExp(`'${s}'`), `前台自检漏了 ${s} 这个状态`)
  }
})

check('连接不依赖抽屉开着（空闲时就连，抽屉只是视图）', () => {
  assert.match(clientCode, /export function startImWhenIdle/)
  assert.match(strip(read(PANEL)), /if \(myId\) startImWhenIdle\(\)/, '登录后没有安排连接')
})

check('⚠️ 安排连接的 effect 依赖的是 user?.id，不是 user 对象', () => {
  /*
    useCurrentUser 每次 notify 都返回**新对象**（收藏一个游戏、开一局游戏都会触发）。
    依赖写成 `[user]` 的话这个 effect 跟着乱跑，每次都重新排一次连接尝试 ——
    AUTO_RETRY_MS 的节流整个被绕过去，后端出错时能把 30 次/小时的 sig 额度烧光。
  */
  const p = strip(read(PANEL))
  const i = p.indexOf('startImWhenIdle()')
  assert.ok(i > 0, '找不到安排连接那一处')
  const tail = p.slice(i, i + 120)
  assert.match(tail, /\}, \[myId\]\)/, '依赖数组不是 [myId]')
  assert.doesNotMatch(tail, /\}, \[user\]\)/, '依赖又写回了 user 对象')
})

console.log('\n十一、按邮箱找人')

const panelCode = strip(read(PANEL))

check('⭐ 服务端的中文报错不能直接渲染（站里有八种语言）', () => {
  // 服务端只会说中文。UI 必须按 code 查本地文案表，
  // 把 ApiError.message 直接显示出来，法语用户会收到一句中文
  assert.match(panelCode, /const lookupText = useCallback\(/, '没有 code -> 文案的映射')
  assert.match(panelCode, /setLookupError\(lookupText\(/, '报错不是经 lookupText 出来的')
  const bad = panelCode.match(/setLookupError\([^)\n]*\.message/)
  assert.equal(bad, null, `把服务端原话直接渲染了：${bad?.[0]}`)
  // 服务端将来多回一个 code，漏掉的话用户会看到一句空白红字
  const seg = panelCode.slice(panelCode.indexOf('const lookupText'))
  assert.match(seg.slice(0, 900), /default:/, 'lookupText 少了 default 分支')
})

check('⭐ 每一个 code 都要有对应的文案分支', () => {
  const seg = panelCode.slice(panelCode.indexOf('const lookupText'), panelCode.indexOf('const startByEmail'))
  for (const code of ['bad_email', 'self', 'not_found', 'unusable', 'rate_limited']) {
    assert.match(seg, new RegExp(`case '${code}'`), `没处理 ${code}`)
  }
})

check('⭐ 请求体里只有邮箱，一个字段都不多', () => {
  // 多带一个 userId / selfId，服务端那条「身份只取 req.user.id」的铁律就等于被绕开了
  assert.match(clientCode, /api\.post<ImPeer>\('\/api\/im\/lookup', \{ email: addr \}\)/, '请求形状变了')
  const seg = clientCode.slice(clientCode.indexOf('export async function lookupImUserByEmail'))
  assert.ok(!/req|selfId|userId|token/.test(seg.slice(0, seg.indexOf('} catch'))), '请求里混进了身份字段')
})

check('邮箱在前端也要 trim + 转小写（和服务端 normalizeLookupEmail 同一套）', () => {
  const seg = clientCode.slice(clientCode.indexOf('export async function lookupImUserByEmail'))
  assert.match(seg.slice(0, 400), /\.trim\(\)\.toLowerCase\(\)/, '没规范化就发出去了')
})

check('⭐ 关闭 / 登出要把找人那一行复位', () => {
  // 不复位的话，下次打开会看到一个上次输了一半的邮箱和一句旧报错；
  // 登出不复位更糟 —— 换个账号登进来，别人的邮箱还留在框里
  const close = panelCode.slice(panelCode.indexOf('const doClose = useCallback'))
  const closeBody = close.slice(0, close.indexOf('}, ['))
  for (const call of ['setComposeOpen(false)', "setEmailDraft('')", "setLookupError('')"]) {
    assert.ok(closeBody.includes(call), `doClose 里少了 ${call}`)
  }
  const out = panelCode.slice(panelCode.indexOf('void imStop()') - 400, panelCode.indexOf('void imStop()'))
  for (const call of ['setComposeOpen(false)', "setEmailDraft('')"]) {
    assert.ok(out.includes(call), `登出分支里少了 ${call}`)
  }
})

check('⭐ Esc 一次只退一层：会话 -> 找人行 -> 关面板', () => {
  assert.match(
    panelCode,
    /if \(active\) setActive\(null\)\s*else if \(composeOpen\) setComposeOpen\(false\)\s*else doClose\(\)/,
    'Esc 的退出顺序变了 —— 写成并列 if 会一次退两层',
  )
  // composeOpen 不进依赖数组的话，闭包里永远是 false，那一层等于不存在
  assert.match(panelCode, /\}, \[open, active, composeOpen, doClose\]\)/, 'Esc 的依赖数组漏了 composeOpen')
})

check('⭐ 输入框必须关掉自动填充', () => {
  // 浏览器在这里最想填的是**用户自己的**邮箱，而那恰好是唯一一个填了必然报错的地址
  const seg = panelCode.slice(panelCode.indexOf('ref={emailRef}'), panelCode.indexOf('className="h-9 min-w-0'))
  /*
    数一遍再看值，而不是只判「有没有出现过 off」。

    变异校验里试过「保留 off、再补一条 autoComplete="email"」：
    JSX 里后写的那条生效，浏览器照样会去填用户自己的邮箱 ——
    而只判存在的断言对此全绿。
  */
  const auto = [...seg.matchAll(/autoComplete="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(auto, ['off'], `autoComplete 不是唯一的 off：${JSON.stringify(auto)}`)
  assert.match(seg, /autoCapitalize="none"/, '手机键盘会把首字母大写')
})

check('⭐ 组字期间的 Enter 不能当提交（中日文用户每打一个词都会误触）', () => {
  const seg = panelCode.slice(panelCode.indexOf('ref={emailRef}'))
  assert.match(seg.slice(0, 1400), /e\.key === 'Enter' && !e\.nativeEvent\.isComposing/, 'Enter 没判 isComposing')
})

check('没连上时不给这个入口（查得到人，却会栽进一个连不上的会话）', () => {
  assert.match(panelCode, /\{state === 'ready' && \(\s*<button/, '顶栏那颗按钮没有按连接状态收起')
  assert.match(panelCode, /state === 'ready' && !active && composeOpen &&/, '输入行没有按连接状态收起')
})

console.log('\n十二、昵称的权威源是我们的库，不是腾讯')

check('⭐ 会话列表用我们库里的昵称**覆盖**腾讯那份，不是「腾讯为空才填」', () => {
  /*
    这是 2026-09-08 那个真实 bug 的守卫：
    583476160@qq.com 注册 -> nicknameFromEmail() 把昵称切成 `583476160` ->
    那个值被推给腾讯 -> 用户改成 `LL` -> 对方的聊天窗标题一直是 `583476160`。

    关键在**覆盖 vs 兜底**：改过昵称的情况下腾讯那份**不是空的，是旧的**。
    写成 `c.nick || p.nickname` 就完全修不到这个 bug（而且看起来很合理）。
  */
  assert.match(clientCode, /await resolvePeers\(/, '会话列表没有解析昵称')
  assert.match(
    clientCode,
    /nick: p\.nickname \|\| c\.nick/,
    '覆盖方向错了 —— 必须是「我们的库优先」，写成 c.nick || p.nickname 修不到改名这种情况',
  )
  assert.match(clientCode, /avatar: p\.avatar \|\| c\.avatar/, '头像的覆盖方向也要一致')
})

check('⭐ 昵称解析是装饰步骤，失败不能拖垮会话列表', () => {
  const seg = clientCode.slice(clientCode.indexOf('async function resolvePeers'))
  const body = seg.slice(0, seg.indexOf('\n}'))
  assert.match(body, /catch/, 'resolvePeers 没有兜住异常 —— 后端 429 一次抽屉就整块变「连接失败」')
  assert.ok(!/throw/.test(body), 'resolvePeers 里不该抛 —— 它只是把名字变好看')
})

check('⭐ peer 资料要缓存，否则每条新消息都多一次请求', () => {
  // 会话列表每来一条消息就刷一次，不缓存的话 /api/im/peers 会被打成筛子
  assert.match(clientCode, /const peerCache = new Map</, '没有缓存')
  assert.match(clientCode, /peerCache\.get\(id\)/, '没查缓存')
  assert.match(clientCode, /peerCache\.set\(/, '没写缓存')
  // 换账号时必须清掉，否则会把上一个账号看到的名字带过来
  const td = clientCode.slice(clientCode.indexOf('async function teardown'))
  assert.match(td.slice(0, td.indexOf('\n}')), /peerCache\.clear\(\)/, 'teardown 没清缓存')
})

check('⭐ 改完资料要重新推给腾讯（syncProfile 只挂在 SDK_READY 上）', () => {
  assert.match(clientCode, /export function syncImProfile/, '没暴露重新同步的入口')
  const seg = panelCode.slice(panelCode.indexOf('const myNick'))
  assert.match(seg.slice(0, 400), /if \(myNick\) syncImProfile\(\)/, '资料变了没有重新同步')
  /*
    依赖数组必须是 nickname / avatar 两个**值**。
    用 user 对象的话：useCurrentUser 每次 notify 都返回新引用
    （收藏、金币变动都触发），这个 effect 会空跑很多次。
  */
  assert.match(seg.slice(0, 400), /\}, \[myNick, myAvatar\]\)/, '依赖数组不是那两个值')
})

console.log('\n十三、2026-09-10 那一轮体检修掉的三件事')

check('⭐ 私信必须有长度上限（腾讯 12000 字节，而 SDK 自己不检查）', () => {
  /*
    没有这道闸时的症状：粘一篇长文进去 → 腾讯服务端回 80002
    （ERR_SVR_COMM_BODY_SIZE_LIMIT，SDK 源码里那张错误码表就有它）→
    气泡显示「发送失败」+ 一颗**永远失败**的重试按钮（内容没变，每次都被拒）。
  */
  assert.match(clientCode, /export const IM_TEXT_MAX/, '没有上限常量')
  const seg = clientCode.slice(clientCode.indexOf('export async function sendImText'))
  assert.match(
    seg.slice(0, 600),
    /Array\.from\(body\)\.length > IM_TEXT_MAX/,
    'sendImText 没拦超长 —— 按码点算，别用 String.length（emoji 会被算成两个）',
  )
  assert.match(panelCode, /maxLength=\{IM_TEXT_MAX\}/, '输入框没有 maxLength，用户打得进去才是问题的起点')
})

check('⭐ 对方给的显示名要清洗（腾讯那份是对方浏览器写的，我们校验不到）', () => {
  assert.match(clientCode, /function cleanPeerText/, '缺少清洗')
  const seg = clientCode.slice(clientCode.indexOf('function cleanPeerText'))
  const body = seg.slice(0, seg.indexOf('\n}'))
  assert.match(body, /replace\(CONTROL_CHARS/, '换行能把会话列表那一行顶成两行')
  assert.match(body, /slice\(0, max\)/, '一个 500 字节的昵称在标题栏里就是一整块黑条')
})

check('⭐ 自动重连要有节流，手点「重新连接」不受它管', () => {
  /*
    两条自动路径原来都是「想连就连」：
      · KICKED_OUT + USERSIG_EXPIRED —— 签名要是当场就过期（钟差 / TTL 配小了），这是死循环；
      · visibilitychange —— 后端正在 500 时，来回切几下标签页就是几十个请求。
    而 /api/im/sig 有 30 次/小时的限流 —— 「兜底」最终是把用户的额度烧光再卡在 error。
  */
  assert.match(clientCode, /const AUTO_RETRY_MS/, '没有节流常量')
  /*
    ⚠️ 2026-09-12：这道闸从**调用方**挪进了 ensureImStarted（`{ auto: true }`）。
    原因是挡不住 —— ImPanel 里那个 `useEffect(..., [user])` 直接调 startImWhenIdle，
    从两个调用方的旁边绕了过去，而 useCurrentUser 每次收藏 / 开游戏都换新对象。
    闸装在入口才是唯一挡得住的位置；这两条断言现在验的是「调用方有没有诚实地标上 auto」。
  */
  const expired = clientCode.slice(clientCode.indexOf('KICKED_OUT_USERSIG_EXPIRED'))
  assert.match(
    expired.slice(0, 400),
    /await ensureImStarted\(\{ auto: true \}\)/,
    'sig 过期那条路没标成自动（会绕过节流）',
  )
  const vis = clientCode.slice(clientCode.indexOf('function wireVisibility'))
  assert.match(vis.slice(0, 600), /ensureImStarted\(\{ auto: true \}\)/, '回到前台那条路没标成自动')
  // 手点的那颗按钮必须无视节流，否则「刚才自动试过一次」会让它点了没反应
  const rc = clientCode.slice(clientCode.indexOf('export async function imReconnect'))
  assert.match(rc.slice(0, 400), /lastAutoRetry = 0/, '手动重连没把节流清掉')
  // 连上就归零：之后真的掉线该立刻重连
  const ready = clientCode.slice(clientCode.indexOf('on(E.SDK_READY'))
  assert.match(ready.slice(0, 300), /lastAutoRetry = 0/, 'SDK_READY 没把节流归零')
})

console.log(`\n✅ IM 接入结构检查：${n} 项通过`)
