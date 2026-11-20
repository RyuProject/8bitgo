// 本站 Google 登录前端（src/services/auth.ts 的 googleClientId / loginWithGoogle）的回归。不联网。
//
// 2026-11-20：线上包里没有 VITE_GOOGLE_CLIENT_ID（从没进过 .env.production），服务端却早就配了
// GOOGLE_CLIENT_ID —— Google 按钮一直报「管理员尚未配置」。现在前端没有构建期值时向
// /api/auth/google/config 要。这里守：构建期值优先、服务端值整页复用、网络失败可重试、
// 服务端说没配就明确提示，以及 One Tap 不弹时按钮不会永远停在「处理中」。
//
// 登录窗口改用 Google 官方按钮（renderButton）后再守：GIS 只 initialize 一次且开 FedCM 按钮模式、
// 宽度夹在 GIS 认的 200～400、界面语言按站点语言、凭证交给栈顶那一方（One Tap 进行中时归它）、
// 卸载后不再收凭证、加载失败返回 null 让备用按钮留着，且下次还能重试。
import assert from 'node:assert/strict'

const API = 'https://api.test'
globalThis.__viteEnv = { VITE_API_URL: API }

const store = new Map()
const memoryStorage = () => ({
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
})
globalThis.window = globalThis
globalThis.localStorage = memoryStorage()
globalThis.sessionStorage = memoryStorage()
globalThis.addEventListener ??= () => {}
globalThis.dispatchEvent ??= () => true

/* ---------- 假的 GIS：document 里插 <script> 就当加载完成 ---------- */
let promptBehaviour = 'skip'
let initialized = null
let initializeCalls = 0
let scriptsAppended = 0
let gisFails = false
let lastButton = null
let renderNothing = false
globalThis.document = {
  createElement: () => ({}),
  head: {
    appendChild(s) {
      scriptsAppended += 1
      if (gisFails) {
        queueMicrotask(() => s.onerror?.())
        return
      }
      globalThis.google = {
        accounts: {
          id: {
            initialize: (o) => {
              initializeCalls += 1
              initialized = o
            },
            renderButton: (el, o) => {
              lastButton = o
              if (!renderNothing) el.replaceChildren({ tagName: 'IFRAME' })
            },
            prompt: (listener) => {
              const moment = (type, extra = {}) => ({ getMomentType: () => type, ...extra })
              if (promptBehaviour === 'skip') listener?.(moment('skipped'))
              // 旧模式（不走 FedCM）：没显示只发 display 时刻
              else if (promptBehaviour === 'not-displayed') listener?.(moment('display', { isNotDisplayed: () => true }))
              else if (promptBehaviour === 'dismissed') listener?.(moment('dismissed', { getDismissedReason: () => 'cancel_called' }))
              else if (promptBehaviour === 'credential') {
                // FedCM 下拿到凭证时先回 callback，再报一个 credential_returned 的 dismissed —— 后者不能把成功改成失败
                initialized.callback({ credential: 'header.payload.sig' })
                listener?.(moment('dismissed', { getDismissedReason: () => 'credential_returned' }))
              }
            },
          },
        },
      }
      queueMicrotask(() => s.onload?.())
    },
  },
}

/* ---------- 假的后端 ---------- */
let configResponse = { clientId: '111-abc.apps.googleusercontent.com' }
let configFails = false
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  calls.push(`${init.method || 'GET'} ${u}`)
  if (u === `${API}/api/auth/google/config`) {
    if (configFails) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(configResponse), { headers: { 'content-type': 'application/json' } })
  }
  if (u === `${API}/api/auth/google`) {
    const body = JSON.parse(String(init.body || '{}'))
    assert.equal(body.credential, 'header.payload.sig')
    return new Response(JSON.stringify({ token: 'jwt-1', user: { id: 'u_1', email: 'a@b.c', nickname: 'A' } }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  throw new Error(`unexpected fetch ${u}`)
}

const auth = await import('../src/services/auth.ts')
const { getT } = await import('../src/services/i18n.ts')
const T = getT().errors

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }
const configCalls = () => calls.filter((c) => c.endsWith('/api/auth/google/config')).length

// ── 客户端 ID 的来源 ──
globalThis.__viteEnv = { VITE_API_URL: API, VITE_GOOGLE_CLIENT_ID: ' 999-built.apps.googleusercontent.com ' }
assert.equal(await auth.googleClientId(), '999-built.apps.googleusercontent.com')
assert.equal(configCalls(), 0)
ok('构建期 VITE_GOOGLE_CLIENT_ID 优先，不发请求')

globalThis.__viteEnv = { VITE_API_URL: API }
configFails = true
await assert.rejects(auth.googleClientId(), /Failed to fetch/)
configFails = false
assert.equal(await auth.googleClientId(), '111-abc.apps.googleusercontent.com')
assert.equal(await auth.googleClientId(), '111-abc.apps.googleusercontent.com')
assert.equal(configCalls(), 2)
ok('没有构建期值时向服务端要；网络失败不缓存，成功后整页复用')

// ── 登录流程 ──
promptBehaviour = 'skip'
await assert.rejects(auth.loginWithGoogle(), (e) => e.message === T.googleNotShown)
assert.equal(initialized?.client_id, '111-abc.apps.googleusercontent.com')
promptBehaviour = 'not-displayed'
await assert.rejects(auth.loginWithGoogle(), (e) => e.message === T.googleNotShown)
assert.ok(!calls.some((c) => c.endsWith('/api/auth/google')), '没拿到凭证就不该打登录接口')
ok('One Tap 被跳过 / 没显示：立即报错，按钮不会一直停在「处理中」')

promptBehaviour = 'dismissed'
await assert.rejects(auth.loginWithGoogle(), (e) => e.message === T.googleCancelled)
ok('玩家关掉 Google 窗口：按「已取消」报')

promptBehaviour = 'credential'
const user = await auth.loginWithGoogle()
assert.equal(user.id, 'u_1')
assert.ok(calls.some((c) => c === `POST ${API}/api/auth/google`))
ok('拿到凭证：交给 /api/auth/google 换本站会话')

// ── Google 官方按钮 ──
const fakeEl = () => ({
  isConnected: true,
  children: [],
  get firstElementChild() { return this.children[0] ?? null },
  replaceChildren(...nodes) { this.children = nodes },
})
const got = []
const el = fakeEl()
const dispose = await auth.renderGoogleButton(el, { width: 600, lang: 'zh-Hans', onCredential: (c) => got.push(c) })
assert.equal(typeof dispose, 'function')
assert.equal(el.children.length, 1)
assert.equal(lastButton.width, 400)
assert.equal(lastButton.locale, 'zh_CN')
assert.equal(lastButton.type, 'standard')
assert.equal(initializeCalls, 1, 'GIS 的 initialize 整页只调一次，One Tap 与官方按钮共用')
assert.equal(initialized.use_fedcm_for_button, true, '按钮走 FedCM 按钮模式：没登 Google 的人也能登，隔离页不靠弹窗')
ok('官方按钮：宽度封顶 400、语言换成 GIS 写法、initialize 只一次且开 FedCM 按钮模式')

const narrow = fakeEl()
const disposeNarrow = await auth.renderGoogleButton(narrow, { width: 150, lang: 'xx', onCredential: () => {} })
assert.equal(lastButton.width, 200)
assert.equal(lastButton.locale, 'en')
disposeNarrow()
ok('官方按钮：太窄按 200 画、不认识的语言用英文')

initialized.callback({ credential: 'c1' })
assert.deepEqual(got, ['c1'])
promptBehaviour = 'credential'
assert.equal((await auth.loginWithGoogle()).id, 'u_1')
assert.deepEqual(got, ['c1'], 'One Tap 进行中拿到的凭证归 One Tap，不能同时交给官方按钮（会换两次会话）')
initialized.callback({ credential: 'c2' })
assert.deepEqual(got, ['c1', 'c2'], 'One Tap 结束后凭证回到官方按钮')
dispose()
assert.equal(el.children.length, 0)
initialized.callback({ credential: 'c3' })
assert.deepEqual(got, ['c1', 'c2'], '登录窗口关掉后不再收凭证')
assert.equal(initializeCalls, 1)
ok('官方按钮：凭证交给栈顶那一方，卸载后不再收')

const gone = fakeEl()
gone.isConnected = false
assert.equal(await auth.renderGoogleButton(gone, { width: 300, lang: 'en', onCredential: () => {} }), null)
renderNothing = true
assert.equal(await auth.renderGoogleButton(fakeEl(), { width: 300, lang: 'en', onCredential: () => {} }), null)
renderNothing = false
ok('官方按钮：容器已卸载或 GIS 没画出东西时返回 null，备用按钮留着')

// ── 服务端说没配 ──
// 新的模块实例：上一段已经把客户端 ID 缓存在模块里了
const fresh = await import(`../src/services/auth.ts?second=${Date.now()}`)
configResponse = { clientId: null }
const before = scriptsAppended
await assert.rejects(fresh.loginWithGoogle(), (e) => e.message === T.googleNotConfigured)
assert.equal(scriptsAppended, before, '没配就不该去加载 accounts.google.com 的脚本')
assert.equal(await fresh.renderGoogleButton(fakeEl(), { width: 300, lang: 'en', onCredential: () => {} }), null)
assert.equal(scriptsAppended, before, '没配也不该为了画按钮去加载 Google 脚本')
ok('服务端没配 GOOGLE_CLIENT_ID：提示未配置，不加载 Google 脚本')

// ── 脚本加载不出来（大陆网络、隔离页的 COEP）──
const third = await import(`../src/services/auth.ts?third=${Date.now()}`)
configResponse = { clientId: '111-abc.apps.googleusercontent.com' }
delete globalThis.google
gisFails = true
assert.equal(await third.renderGoogleButton(fakeEl(), { width: 300, lang: 'en', onCredential: () => {} }), null)
await assert.rejects(third.loginWithGoogle(), (e) => e.message === T.googleLoadFailed)
gisFails = false
const retried = await third.renderGoogleButton(fakeEl(), { width: 300, lang: 'en', onCredential: () => {} })
assert.equal(typeof retried, 'function', '一次加载失败不能钉死整页：网络恢复后再打开登录窗口要能画出来')
retried()
ok('Google 脚本加载失败：按钮返回 null、One Tap 报加载失败，之后还能重试')

console.log(`\ngoogle login: ${passed} 项通过`)
