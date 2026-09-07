/**
 * J2ME 这条路的第一份测试（2026-09-07）。
 *
 *   npm run test:j2me
 *
 * 之前这条路**一个测试都没有** —— 而它是全站唯一「不需要登录、还往磁盘写文件」的
 * 公开端点所在，也是唯一一条要把播放地址压成纯文件名的加载链。
 *
 * 只测能纯 node 测的三块（都不碰 DOM、不连库、不联网）：
 *   一、URL 规则（src/emulator/j2meUrl.ts）—— 含那条**曾经是死代码**的跨源判定
 *   二、文件名正则（server/src/j2me.js 的 SAFE_NAME / TMP_NAME）—— 路径穿越那道闸
 *   三、上传限流的额度算术（真的 rateLimit.js）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildJ2meUrl, isCrossOriginBase, j2meFileName } from '../src/emulator/j2meUrl.ts'
import { take } from '../server/src/rateLimit.js'

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

console.log('一、URL 规则')

check('播放地址压成纯文件名，查询串和 hash 都要剥掉', () => {
  assert.equal(j2meFileName('https://r2.example.com/roms/java/snake.jar'), 'snake.jar')
  // 全站别的平台靠 ?romv=<etag> 换缓存，而 freej2me 只能吃纯名字 —— 必须剥掉，
  // 不剥的话拼出来是 /jar/snake.jar%3Fromv%3D… 永远 404
  assert.equal(j2meFileName('https://r2.example.com/roms/java/snake.jar?romv=abc123'), 'snake.jar')
  assert.equal(j2meFileName('/j2me/jar/snake.jar#frag'), 'snake.jar')
  assert.equal(j2meFileName('snake.jar'), 'snake.jar')
  // 中文名要原样留着，编码交给 buildJ2meUrl
  assert.equal(j2meFileName('https://x/roms/java/贪吃蛇.jar?v=1'), '贪吃蛇.jar')
})

check('jar 模式与 app 模式分流（.zip 走 app 且要去后缀）', () => {
  assert.equal(buildJ2meUrl('/j2me/', 'snake.jar'), '/j2me/run.html?jar=snake.jar')
  assert.equal(buildJ2meUrl('/j2me/', 'pack.zip'), '/j2me/run.html?app=pack')
  // 大小写不敏感 —— 后缀是玩家的文件名带来的，不能假设小写
  assert.equal(buildJ2meUrl('/j2me/', 'PACK.ZIP'), '/j2me/run.html?app=PACK')
  // 只去**末尾**那个 .zip，名字里带 zip 字样的不许被吃掉
  assert.equal(buildJ2meUrl('/j2me/', 'zipzap.jar'), '/j2me/run.html?jar=zipzap.jar')
})

check('名字要 encode —— 空格和中文不 encode 会把 query 拼坏', () => {
  assert.equal(buildJ2meUrl('/j2me/', 'my game.jar'), '/j2me/run.html?jar=my%20game.jar')
  assert.equal(buildJ2meUrl('/j2me/', '贪吃蛇.jar'), `/j2me/run.html?jar=${encodeURIComponent('贪吃蛇.jar')}`)
  // & 不 encode 会凭空多出一个查询参数
  assert.ok(buildJ2meUrl('/j2me/', 'a&b.jar').endsWith('?jar=a%26b.jar'))
})

console.log('\n二、⚠️ 跨源判定（这一条原来是死代码，跨源部署必然 120 秒超时）')

/*
  病因：原来靠「读 iframe.contentDocument 会不会抛异常」来判跨源。
  可跨源时它按规范**返回 null，不抛** —— 那个 catch 从来没为跨源命中过，
  判定函数永远返回 false（「文档还没建好，下一轮再看」），
  于是轮询永远等不到画面，两分钟后一律报「起不来」。
  现在从地址上算，确定、可测、不依赖异常。
*/
const ORIGIN = 'https://8bitgo.com'

check('相对路径（默认部署）判同源', () => {
  assert.equal(isCrossOriginBase('/j2me/', ORIGIN), false)
  assert.equal(isCrossOriginBase('j2me/', ORIGIN), false)
  assert.equal(isCrossOriginBase('/static/j2me/', ORIGIN), false)
})

check('同一域名写成绝对地址也是同源', () => {
  assert.equal(isCrossOriginBase('https://8bitgo.com/j2me/', ORIGIN), false)
})

check('⭐ 别的域名 / 协议 / 端口都要判成跨源', () => {
  assert.equal(isCrossOriginBase('https://cdn.example.com/j2me/', ORIGIN), true)
  // 协议不同就是不同 origin（http vs https）
  assert.equal(isCrossOriginBase('http://8bitgo.com/j2me/', ORIGIN), true)
  // 端口不同同理
  assert.equal(isCrossOriginBase('https://8bitgo.com:8443/j2me/', ORIGIN), true)
  // 协议相对地址：跟着页面的协议走，但域名变了
  assert.equal(isCrossOriginBase('//cdn.example.com/j2me/', ORIGIN), true)
  // 子域名不算同源
  assert.equal(isCrossOriginBase('https://www.8bitgo.com/j2me/', ORIGIN), true)
})

check('⭐ 解析不出来时偏向「跨源」，不能偏向「同源」', () => {
  /*
    这个方向是刻意的、不是随手写的：
      判成跨源 → 只是早几秒撤遮罩，玩家多看几秒 CheerpJ 自己的加载框
      判成同源 → 一路轮询到 120 秒然后报「起不来」，把一个本来能玩的局判死
    两边代价不对称，所以拿不准就往跨源偏。
  */
  assert.equal(isCrossOriginBase('/j2me/', 'null'), true)
  assert.equal(isCrossOriginBase('', 'not a url'), true)
})

console.log('\n三、文件名正则：路径穿越那道闸（读 server/src/j2me.js 的源码常量）')

const serverSrc = readFileSync(new URL('../server/src/j2me.js', import.meta.url), 'utf8')
const reOf = (label) => {
  const m = new RegExp(`const ${label} = (/.*?/[a-z]*)\\n`).exec(serverSrc)
  assert.ok(m, `没在 server/src/j2me.js 里找到 ${label}`)
  // eslint-disable-next-line no-eval
  return eval(m[1])
}
const SAFE_NAME = reOf('SAFE_NAME')
const TMP_NAME = reOf('TMP_NAME')

check('⭐ SAFE_NAME 必须挡住路径穿越和分隔符', () => {
  for (const bad of [
    '../../etc/passwd',
    '..%2Fetc%2Fpasswd.jar',
    'a/b.jar',
    'a\\b.jar',
    '/abs.jar',
    'no-ext',
    'x.jar.exe',
    '.jar',
    'a b.jar',
  ]) {
    assert.equal(SAFE_NAME.test(bad), false, `${bad} 不该通过 SAFE_NAME`)
  }
})

check('SAFE_NAME 放行正常的 jar / jad', () => {
  for (const good of ['snake.jar', 'Snake.JAR', 'a-b_c.1.jad', 'tmp-0123456789abcdef0123456789abcdef.jar']) {
    assert.equal(SAFE_NAME.test(good), true, `${good} 该通过 SAFE_NAME`)
  }
})

check('⭐ TMP_NAME 只认「tmp- + 32 位十六进制 + .jar」—— 那个随机名就是删除凭据', () => {
  const ok = 'tmp-0123456789abcdef0123456789abcdef.jar'
  assert.equal(TMP_NAME.test(ok), true)
  // 长度差一位都不行（少一位就把爆破空间砍掉 16 倍）
  assert.equal(TMP_NAME.test('tmp-0123456789abcdef0123456789abcde.jar'), false)
  assert.equal(TMP_NAME.test('tmp-0123456789abcdef0123456789abcdef0.jar'), false)
  // 非十六进制字符不行
  assert.equal(TMP_NAME.test('tmp-0123456789abcdef0123456789abcdeg.jar'), false)
  // 正式 ROM 不能被当成临时文件（否则 release 就能删掉正式 ROM 的缓存路径）
  assert.equal(TMP_NAME.test('snake.jar'), false)
  // 前缀不能被绕过
  assert.equal(TMP_NAME.test('xtmp-0123456789abcdef0123456789abcdef.jar'), false)
})

console.log('\n四、上传限流的额度算术（真的 rateLimit.js）')

check('第 N+1 次才被拒，且给出 retryAfter', () => {
  const key = `test:j2me:${Math.random()}`
  for (let i = 0; i < 10; i++) assert.equal(take(key, 10, 60_000).ok, true, `第 ${i + 1} 次该放行`)
  const over = take(key, 10, 60_000)
  assert.equal(over.ok, false)
  assert.ok(over.retryAfter >= 1, 'retryAfter 要能告诉客户端等多久')
})

check('不同 key 各算各的（按 IP 分维度的前提）', () => {
  const a = `test:j2me:a:${Math.random()}`
  const b = `test:j2me:b:${Math.random()}`
  for (let i = 0; i < 10; i++) take(a, 10, 60_000)
  assert.equal(take(a, 10, 60_000).ok, false)
  assert.equal(take(b, 10, 60_000).ok, true, 'b 不该被 a 影响')
})

console.log('\n五、限流真的接在上传路径上了（源码断言，不是跑接口）')

/**
 * ⚠️ 源码断言必须**先剥注释**再搜。
 *
 * 第一版直接在裸源码上 `doesNotMatch(/writeFileSync/)`，当场被自己打败 ——
 * j2me.js 的注释里写着「原来是 writeFileSync，最大 20MB 的同步写会……」，
 * 而那正是解释这次改动**为什么**要做的那句话。同理 `max-age=86400`。
 *
 * 也就是说：越是把病因写清楚的代码，这种裸文本断言越容易误报。剥掉注释再看。
 * 剥法保守（只去 /* *​/ 块和整行 //），不去行尾注释 —— 够用，且不会误伤
 * 字符串里的 `https://`。
 */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
const serverCode = codeOnly(serverSrc)

check('⭐ uploadJar 里有按 IP 和全站两道闸', () => {
  assert.match(serverCode, /j2me:up:ip:/, '缺按 IP 那道')
  assert.match(serverCode, /j2me:up:global/, '缺全站兜底那道')
  assert.match(serverCode, /isMeaningfulIp/, '拿不到真实 IP 时必须跳过按 IP 那道，否则误伤真实用户')
})

check('⭐ 限流必须在 assertJarBuffer 之前 —— 否则最贵的一步被白用', () => {
  const up = serverCode.slice(serverCode.indexOf('export async function uploadJar'))
  const body = up.slice(0, up.indexOf('\n}\n'))
  const atLimit = body.indexOf('j2me:up:global')
  const atValidate = body.indexOf('assertJarBuffer')
  assert.ok(atLimit > 0 && atValidate > 0, '两处都得在 uploadJar 里')
  assert.ok(atLimit < atValidate, '限流要排在 JAR 校验前面（那一步要走完整个 ZIP 中央目录）')
})

check('⭐ 20MB 的写不能是同步的（这台进程同时在跑 SSR 和 socket.io）', () => {
  assert.doesNotMatch(serverCode, /writeFileSync/, '临时 jar 必须用异步 writeFile')
  assert.match(serverCode, /await writeFile\(/)
})

check('⭐ 代理不能强缓存一天（重传 ROM 后玩家会一直拿旧包）', () => {
  assert.doesNotMatch(serverCode, /max-age=86400/, '强缓存一天 + 丢掉 ?romv= 戳 = 旧包最多留一天')
  assert.match(serverCode, /must-revalidate/)
  assert.match(serverCode, /if-none-match/, '要把条件请求转给上游，否则每次重验都得回源整包')
  assert.match(serverCode, /status === 304/, '304 要在 upstream.ok 判断之前处理，不能给它带 body')
})

console.log('\n六、适配器的 ready / error 契约（源码断言）')

/**
 * 这两条是这一轮改动里最要紧、又最难在纯 node 里跑起来的两处（要 iframe / CheerpJ）。
 * 所以用剥完注释的源码来盯住它们的**形状**：断言弱，但比没有强，而且能挡住
 * 「后人重构时顺手把早退删了」这一类回归。真正的行为验证只能在浏览器里做。
 */
const adapterCode = codeOnly(readFileSync(new URL('../src/emulator/adapters/j2me.ts', import.meta.url), 'utf8'))

check('⭐ 就绪之后 iframe 报 error 必须早退 —— onReady 之后的 onError 等于拆会话', () => {
  const at = adapterCode.indexOf("addEventListener('error'")
  assert.ok(at > 0, '找不到 iframe 的 error 监听')
  const handler = adapterCode.slice(at, at + 400)
  const guard = handler.indexOf('readySent')
  const report = handler.indexOf('onError')
  assert.ok(guard > 0, 'error 处理里没有 readySent 早退')
  assert.ok(report > 0 && guard < report, 'readySent 的早退必须排在 onError 之前')
})

check('⭐ 跨源部署要直接 sendReady，不能进轮询 —— 那条路以前一路轮到超时', () => {
  assert.match(adapterCode, /isCrossOriginBase\(/, '跨源判定没接上，displayShown() 只会一直抛跨源异常')
  const at = adapterCode.indexOf('if (crossOrigin)')
  assert.ok(at > 0, '缺跨源分支')
  const branch = adapterCode.slice(at, at + 200)
  assert.ok(branch.indexOf('sendReady()') > 0, '跨源分支里必须直接 sendReady()')
  assert.ok(
    branch.indexOf('sendReady()') < (branch.indexOf('setInterval') + 1 || 1e9),
    '跨源时不该再进轮询',
  )
})

check('⭐ sendReady 要同时兜住 onStart —— 只发 onReady 的话计次和状态机会缺一拍', () => {
  const at = adapterCode.indexOf('const sendReady =')
  assert.ok(at > 0)
  const body = adapterCode.slice(at, at + 400)
  assert.ok(body.includes('onReady'), 'sendReady 里缺 onReady')
  assert.ok(body.includes('onStart'), 'sendReady 里缺 onStart')
})

console.log(failed ? `\n${failed} 项失败` : `\nJ2ME 测试全部通过 ✅`)
process.exit(failed ? 1 : 0)
