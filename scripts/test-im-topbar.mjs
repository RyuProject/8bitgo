/**
 * 顶栏那颗聊天按钮「说不说真话」的回归测试。跑：npm run test:im-topbar
 *
 * ## 这套测试是被一次真实的报障逼出来的（2026-09-12）
 *
 * 用户已登录，点顶栏气泡，弹出来的是「站内消息正在做，很快就能在这儿聊天」——
 * 而 IM 早就写完上线了。根因是结构性的：
 *
 *   · 顶栏只知道「opener 有没有注册」（services/im.ts 的 opener）
 *   · 而 opener **只在 SDK_READY 之后**才注册（imClient 的 publishOpener）
 *   · 于是六种状态被压成同一句话：正在连、限流 429、腾讯登录失败、卡在连接中、
 *     被踢下线、后端真的没配 —— 全都长一个样
 *   · 更糟的是「重新连接」那颗按钮只存在于抽屉里，**而抽屉恰恰在连不上时打不开**
 *
 * 用户看到「正在做」就不会再点第二次，也不会来报障 ——
 * **它劝退了唯一能让你发现故障的信号**，这比报一个错糟得多。
 *
 * 所以这里守三件事：
 *   1. 接缝（services/im.ts）能把状态和「怎么重试」带给顶栏，而且仍然**零 import**；
 *   2. 顶栏按状态分文案，连不上时**有一个能点的出口**；
 *   3. 后端没配那一档（unavailable）**不给**重试按钮 —— 给一颗注定失败的按钮，
 *      和给一句假话一样糟。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

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

const seam = strip(read('src/services/im.ts'))
const button = strip(read('src/components/layout/ChatButton.tsx'))
const client = strip(read('src/services/imClient.ts'))

console.log('\n── 接缝：能把真相带上来 ──')

check('⭐ services/im.ts 仍然零 import（要能在 node 里直接跑）', () => {
  assert.doesNotMatch(seam, /^\s*import\s/m, 'im.ts 开始 import 别的模块了 —— 这一层的价值就是没有依赖')
})

check('有状态槽，取值覆盖 imSession 的六种状态', () => {
  assert.match(seam, /export type ImStatus =/, '没有 ImStatus')
  for (const s of ['off', 'connecting', 'ready', 'error', 'kicked', 'unavailable']) {
    assert.match(seam, new RegExp(`'${s}'`), `ImStatus 少了 ${s}`)
  }
  assert.match(seam, /export function setImStatus/, '没有写入口')
  assert.match(seam, /export function getImStatus/, '没有读出口')
})

check('⚠️ opener 变化必须广播（否则连上之后顶栏那一帧不重渲染）', () => {
  const i = seam.indexOf('export function registerImOpener')
  assert.ok(i > 0, '找不到 registerImOpener')
  const body = seam.slice(i, i + 400)
  const emits = [...body.matchAll(/emit\(\)/g)].length
  assert.ok(emits >= 2, `注册和注销都要广播，现在只有 ${emits} 处`)
})

check('有「怎么重试」这个口子（重连不能只存在于抽屉里）', () => {
  assert.match(seam, /export function registerImRetry/, '没有 registerImRetry')
  assert.match(seam, /export function retryIm/, '没有 retryIm')
})

console.log('\n── 实现层把状态镜像上来 ──')

check('imClient 把状态机镜像给接缝，并交出重连', () => {
  assert.match(client, /onImStateChange\(\(\) => setImStatus\(imState\(\)\)\)/, '没有把状态镜像给顶栏')
  assert.match(client, /registerImRetry\(/, '没有把重连交给接缝')
})

check('⚠️ 镜像要先设一次初值（订阅只管之后的变化）', () => {
  const i = client.indexOf('function wireAmbient')
  assert.ok(i > 0, '找不到 wireAmbient')
  const body = client.slice(i, i + 700)
  assert.match(body, /setImStatus\(imState\(\)\)[\s\S]{0,80}onImStateChange/, '只订阅了变化，没有先同步当前值')
})

console.log('\n── 顶栏：每种状态说不同的话 ──')

check('⭐ 按状态分文案，不再只有一句「正在做」', () => {
  for (const key of ['chatConnecting', 'chatOffline', 'chatSoon']) {
    assert.match(button, new RegExp(`t\\.topbar\\.${key}`), `顶栏没有用到 ${key}`)
  }
  assert.match(button, /t\.im\.kickedHint/, '被踢那一档没有把说明显示出来（那句话早就写好了，只是显示不出来）')
})

check('⭐ 连不上 / 被踢时有一颗能点的出口', () => {
  assert.match(button, /t\.topbar\.chatRetry/, '没有重试按钮')
  assert.match(button, /onClick=\{\(\) => retryIm\(\)\}/, '重试按钮没接上 retryIm')
})

check('⚠️ 后端没配（unavailable）不给重试按钮 —— 注定失败的按钮和假话一样糟', () => {
  const i = button.indexOf('t.topbar.chatRetry')
  assert.ok(i > 0, '找不到重试按钮')
  const cond = button.slice(Math.max(0, i - 400), i)
  assert.match(cond, /status === 'error' \|\| status === 'kicked'/, '重试按钮的条件不是只给 error / kicked')
  assert.doesNotMatch(cond, /status === 'unavailable'/, 'unavailable 也画了重试按钮')
})

check('⚠️ 点一下就开始连，别让用户干等 requestIdleCallback 的 8 秒', () => {
  const i = button.indexOf('onClick={() => {')
  assert.ok(i > 0, '找不到按钮的 onClick')
  const body = button.slice(i, i + 900)
  assert.match(body, /if \(status !== 'connecting'\) retryIm\(\)/, '点按钮不会触发连接')
})

check('⚠️ 连上之后要把状态面板关掉（否则抽屉和占位会同时挂着）', () => {
  const i = button.indexOf('if (openIm())')
  assert.ok(i > 0, '找不到 openIm 那一支')
  assert.match(button.slice(i, i + 300), /setPlaceholder\(false\)/, 'openIm 成功时没有关掉状态面板')
})

check('⚠️ 顶栏仍然只认接缝，不许直接 import imClient', () => {
  assert.doesNotMatch(button, /from '@\/services\/imClient'/, '顶栏开始认识 imClient 了 —— 那一层解耦是有意的')
})

console.log('\n── 八种语言 ──')

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'de', 'fr', 'es', 'it']
const valueOf = (src, key) => {
  const m = src.match(new RegExp(`\\n\\s*${key}: (['"])((?:\\\\.|(?!\\1).)*)\\1,`))
  return m ? m[2] : null
}
for (const lang of LANGS) {
  const src = read(`src/locales/${lang}.ts`)
  check(`${lang}：三条新文案都在且非空`, () => {
    for (const k of ['chatConnecting', 'chatOffline', 'chatRetry']) {
      const v = valueOf(src, k)
      assert.ok(v !== null, `缺 ${k}`)
      assert.ok(v.trim().length > 0, `${k} 是空的`)
    }
  })
}

check('⚠️ chatSoon 不能再承诺「马上就好」—— 它现在只用于「后端没配」这一档', () => {
  const zh = read('src/locales/zh-Hans.ts')
  const v = valueOf(zh, 'chatSoon')
  assert.ok(v, 'chatSoon 读不出来了')
  assert.doesNotMatch(v, /正在做|很快|马上/, `chatSoon 还写着「${v}」—— 功能已经上线了，这是假话`)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 顶栏状态：${pass} 条全过`)
