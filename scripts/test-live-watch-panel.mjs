#!/usr/bin/env node
/**
 * 观众端观看 UI 的回归测试。跑：npm run test:watch-panel
 *
 * 2026-09-11 站长指定的观看版面：
 *   「观众端清除最右侧的内容（平台卡/评分/评论），然后右侧放现在观看的联机+观众，
 *     下面放弹幕，然后弹幕历史记录（临时存储，关播后清除所有记录。限制 100 条）」
 *
 * 这一整块的失败方式**都是安静的**：面板不出现、历史不滚、补历史一次性糊满屏、
 * 或者同一件事出现两个输入框 —— 没有一种会抛错。所以每条都得钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KEEP, appendChat } from '../src/emulator/liveChatStore.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 读源码并**先剥掉注释** —— 否则「注释里提到了」会被当成「代码里做了」 */
const code = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

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

const msg = (id, extra = {}) => ({ id, at: 1, host: false, text: `t${id}`, ...extra })

console.log('一、弹幕历史的上限与去重')

check('上限就是站长定的 100 条', () => {
  assert.equal(KEEP, 100)
})

check('超过上限时丢**最旧**的那些', () => {
  let list = []
  for (let i = 0; i < KEEP + 30; i++) list = appendChat(list, msg(String(i)))
  assert.equal(list.length, KEEP, `留了 ${list.length} 条`)
  assert.equal(list[0].id, '30', '丢的不是最旧的那一批')
  assert.equal(list[list.length - 1].id, String(KEEP + 29), '最新的一条被丢了')
})

check('⚠️ 按 id 去重（补历史和新消息会撞）', () => {
  /*
    进房时服务端补 30 条环形缓冲，而这几条里很可能已经有一条刚刚作为新消息到过。
    不去重的话历史面板里会出现成对的重复，而且飘幕那边也会把它再飞一遍。
  */
  let list = appendChat([], msg('a'))
  list = appendChat(list, msg('a'))
  assert.equal(list.length, 1)
  const same = appendChat(list, msg('a'))
  assert.equal(same, list, '撞 id 时应当原样返回，不产生新数组（省一次重渲染）')
})

console.log('二、补历史不能飞')

check('⚠️ 飘幕只飞没有 history 标记的', () => {
  const src = code('src/emulator/LiveChat.tsx')
  assert.match(src, /const flyable = fresh\.filter\(\(m\) => !m\.history\)/, '飘幕没有过滤补历史那一批')
  assert.match(src, /if \(!flyable\.length\) return/, '过滤完没用上')
})

check('⚠️ 补历史那批照样要进 seen', () => {
  /*
    不进的话，它们会在每一次 messages 变化时重新被算成「新的」——
    于是每来一条新弹幕就连带把三十条历史再飞一遍。
    判据：加进 seen 的必须是 fresh（全量），不是 flyable（过滤后的）。
  */
  const src = code('src/emulator/LiveChat.tsx')
  assert.match(src, /for \(const m of fresh\) seen\.current\.add\(m\.id\)/, 'seen 收的不是全量 fresh')
})

check('⚠️ liveview 把 ack 里的历史接回来，并打上 history 标记', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.match(src, /info\.chat/, 'ack 里那批历史又被丢掉了')
  assert.match(src, /history: true/, '接回来了但没打标记 —— 三十条会一次性起飞')
})

console.log('三、观众名单')

check('⚠️ liveview 把名单报上去（不是只报人数）', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.match(src, /live\.onRoster\?\.\(/, 'viewers 事件里的 list 没人接')
  assert.match(src, /live\.onViewers\?\.\(/, '人数那一路不能顺手删掉：观众席徽章只要那个数')
})

check('播放器把名单接进 state 并交给面板', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /onRoster: setLiveRoster/, '没接')
  assert.match(src, /roster=\{liveRoster\}/, '接了但没给面板')
})

check('⚠️ 联机名单只在主播真开了联机房时才订阅', () => {
  /*
    无条件订阅 = 每个观众页多开一条 SSE。每 IP 的并发流是有上限的（见 sseGuard），
    而绝大多数直播压根没有联机房 —— 那是纯白付。
  */
  const src = code('src/emulator/LiveWatchPanel.tsx')
  assert.match(src, /if \(!netplayRoomId\) return/, '没有提前退出，等于无条件订阅')
})

console.log('四、面板怎么挂进右栏')

check('⚠️ 用 portal，不是把播放器搬过去', () => {
  /*
    面板要的名单/人数/弹幕/发送句柄全在 EmulatorPlayer 的 state 里。
    真把播放器挪进右栏的话它会被卸载重建 —— 对观众就是当场断流。
  */
  const src = code('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /createPortal\(/, '没用 portal')
  assert.match(src, /livePanelSlot,\s*\)/, 'portal 的目标不是详情页给的那个节点')
})

check('⚠️ 挂载点用 state + 回调 ref，不能用 useRef', () => {
  /*
    useRef 挂上之后**不会触发重渲染**，播放器那边会一直看到 null，面板永远不出现。
    这是 portal 目标最经典的一个坑。
  */
  const src = code('src/pages/GameDetailPage.tsx')
  assert.match(src, /useState<HTMLElement \| null>\(null\)/, '挂载点不是 state')
  assert.match(src, /ref=\{setLivePanelSlot\}/, '没有用回调 ref 把节点交出去')
})

check('⚠️ 看直播时右栏整块换掉（平台卡/评分/评论不画）', () => {
  const src = code('src/pages/GameDetailPage.tsx')
  assert.match(src, /\{watchLayout \? \(/, '右栏没有按 watchLayout 分支')
  const at = src.indexOf('{watchLayout ? (')
  const aside = src.lastIndexOf('<aside', at)
  assert.ok(aside > 0 && aside < at, '那个分支不在 <aside> 里')
})

check('⚠️ 面板开着时画面下方那条输入框不画（同一件事不能有两个入口）', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /chatBarOn && !fullscreen && !playMode && !watchPanelOn/, '两个输入框会同时出现')
})

check('⚠️ 面板只对观众开（主播端一个像素都不动）', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  assert.match(src, /const watchPanelOn = Boolean\(livePanelSlot\) && Boolean\(session\?\.live\)/, '面板的开关判据不对')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
