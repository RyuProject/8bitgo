#!/usr/bin/env node
/**
 * 弹幕**收发接线**的回归测试。跑：npm run test:live-chat
 *
 * 要守的一句话：**观众发一条弹幕，主播和所有观众都得看见。**
 *
 * 这条链路横跨五个文件，而且每一节断掉都是**静默**的 —— 没有报错、没有控制台、
 * 界面上只是「安静」，而「安静」和「没人说话」长得一模一样：
 *
 *   观众 liveChat() ─emit─> 服务端 chat ─nsp.to(room)─> ┬─> 主播 broadcast.onChat  ─┐
 *                                                      └─> 观众 liveview.onChat   ─┴─> chat.push
 *                                                                                      │
 *                                                        liveChatOn && <LiveChatLane> ─┘
 *
 * 出过的事故：
 *   1. 2026-09-10 分享标签页那条开播路径没接 onChat —— 那位主播看不到任何弹幕，
 *      连自己发的都看不到（见下面「没有本地回显」那条）。观众侧一切正常，
 *      所以主播只会以为「没人说话」。
 *   2. 服务端要是写成 socket.to(room)，发弹幕的人自己就被排除在外。
 *
 * 纯 node，只读源码，不需要浏览器。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
/** 去掉注释再断言 —— 不然把说明文字里的字面量当成了代码 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

/* ---------------- 一、服务端：广播给整个房间，主播也在房间里 ---------------- */

check('⚠️ 弹幕要广播给整个房间，不能漏掉发送者自己', () => {
  const src = code('server/src/live.js')
  assert.match(
    src,
    /nsp\.to\(room\.id\)\.emit\('chat'/,
    "弹幕必须 nsp.to(room.id)：写成 socket.to(room.id) 就把发送者自己排除了，" +
      '而客户端不做本地回显 —— 他会看到自己那条消息凭空消失',
  )
  assert.ok(
    !/socket\.to\([^)]*\)\.emit\('chat'/.test(src),
    "socket.to(...).emit('chat') 会跳过发送者自己",
  )
})

check('⚠️ 主播必须真的在房间里（不然 nsp.to(room) 送不到他）', () => {
  const src = code('server/src/live.js')
  const i = src.indexOf('function bindHost')
  assert.ok(i > 0, '找不到 bindHost')
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10))
  assert.match(body, /socket\.join\(room\.id\)/, '主播不 join 房间，弹幕、viewers、live-ended 全收不到')
  /*
    「每一条主播入口都过 bindHost」是这一条成立的前提。
    room.hostSocketId 的赋值点就是主播身份的唯一来源：它只许出现在 bindHost 里，
    多一处就是一条绕过 join 的旁路（开播成功、画面照推、只是没有弹幕）。
  */
  const assigns = [...src.matchAll(/room\.hostSocketId = (\S+)/g)].map((m) => m[1])
  assert.deepEqual(
    assigns.sort(),
    ['null', 'socket.id'],
    '除了 bindHost 里那一处和「主播走了」置空，不该有别的地方认主播 —— 那会绕过 socket.join',
  )
})

check('观众 join 房间（watch）', () => {
  const src = code('server/src/live.js')
  const i = src.indexOf("socket.on('watch'")
  assert.ok(i > 0, '找不到 watch')
  assert.match(src.slice(i, i + 3000), /socket\.join\(room\.id\)/)
})

/* ---------------- 二、客户端：两个角色各自的**收**弹幕入口 ---------------- */

check('⚠️ 观众侧要有收弹幕的入口', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  const i = src.search(/\bs\.on\('chat'/)
  assert.ok(i > 0, "liveview 里没有 s.on('chat') —— 观众连别人的弹幕都看不到")
  assert.match(src.slice(i, i + 200), /live\.onChat\?\.\(/, '收到要往上报，否则收了也没人显示')
})

check('⚠️ 主播侧要有收弹幕的入口', () => {
  const src = code('src/emulator/broadcast.ts')
  const i = src.search(/\bsocket\.on\('chat'/)
  assert.ok(i > 0, "broadcast 里没有 socket.on('chat') —— 主播看不到观众的弹幕")
  assert.match(src.slice(i, i + 200), /options\.onChat\?\.\(/, '收到要往上报')
})

check('⚠️ 两个角色的入口必须接到同一份弹幕状态', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  // 观众：liveview 的 LiveSession
  assert.match(src, /onChat: chat\.push/, '观众那一路没把 onChat 接到 chat.push')
  // 主播：LiveControls → Broadcast
  assert.match(src, /onChat=\{chat\.push\}/, '主播那一路（LiveControls）没把 onChat 接到 chat.push')
})

/*
  ⚠️ 「主播那两条开播路径的回调集合必须一致」由 test:coop-seat 守着
  （onChat 在那条断言里被单独点名）。这里不重复。
*/

/* ---------------- 三、显示：两个角色都要画弹幕层 ---------------- */

check('⚠️ 弹幕层的显示条件必须同时覆盖主播和观众', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  const m = src.match(/const liveChatOn = ([^\n]+)/)
  assert.ok(m, '找不到 liveChatOn')
  assert.match(m[1], /liveSession/, '少了 liveSession：主播收得到弹幕但一条都不画')
  assert.match(m[1], /session\?\.live/, '少了 session.live：观众一条都不画')
  assert.match(
    src,
    /\{liveChatOn && <LiveChatLane/,
    '弹幕层要按 liveChatOn 画；换成任何单角色的条件都会让另一个角色瞎掉',
  )
})

check('⚠️ 弹幕层要画在画面容器里（全屏 / 沉浸式也得看得见）', () => {
  const src = read('src/emulator/EmulatorPlayer.tsx')
  const lane = src.indexOf('<LiveChatLane')
  /*
    ⚠️ 别把整串条件写死当锚点：09-11 那条条件加了 `!watchPanelOn`（观众端输入框搬去
    右栏面板了），写死的锚点当场对不上，而这条断言真正要钉的是**先后顺序**，不是条件长什么样。
  */
  const bar = src.indexOf('{chatBarOn && ')
  assert.ok(lane > 0 && bar > 0, '找不到弹幕层 / 输入框')
  assert.ok(
    lane < bar,
    '弹幕层跑到输入框那个 !fullscreen && !playMode 的条件里去了 —— 全屏一开弹幕就整块消失',
  )
})

/* ---------------- 四、发：两个角色都要能发，而且没有本地回显 ---------------- */

check('⚠️ 发弹幕两个角色各走各的句柄，都没有就禁用输入框', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  const i = src.indexOf('onSend={')
  assert.ok(i > 0, '找不到 onSend')
  const seg = src.slice(i, i + 400)
  assert.match(seg, /liveSession\s*\n?\s*\?\s*\(text\) => liveSession\.sendChat\(text\)/, '主播走推流会话')
  assert.match(seg, /handle\?\.liveChat/, '观众走 liveview 的 handle')
  assert.match(seg, /:\s*null/, '两个都没有要传 null —— 让人打完一段字再说发不出去是最差的一种')
})

check('⚠️ 不许本地回显（这就是漏接 onChat 会连自己的话都看不到的原因）', () => {
  const src = code('src/emulator/EmulatorPlayer.tsx')
  const i = src.indexOf('onSend={')
  const seg = src.slice(i, i + 400)
  assert.ok(
    !seg.includes('chat.push'),
    '发的时候顺手 push 了一条：顺序就变成本地的，每个人看到的排序都不一样；' +
      '而且它会盖住「收不到」这个故障 —— 自己看得见，观众全都收不到',
  )
  const lv = code('src/emulator/adapters/liveview.ts')
  const j = lv.indexOf('liveChat(text: string)')
  assert.ok(j > 0, '找不到 liveChat')
  const body = lv.slice(j, j + 400)
  // 发出去就完事（真正的 emit 在 chatSend.ts 里，见 test:chat-send），等服务端广播回来再显示
  assert.match(body, /sendChatWithAck\(socket, text\)/)
  assert.ok(!/onChat/.test(body), 'liveChat 里不该自己调 onChat —— 那是本地回显')
})

check('发弹幕不带房间号（房间从 membership 认）', () => {
  // 两条发送路径现在共用 chatSend.ts 那一处 emit（行为测试见 npm run test:chat-send）
  const cs = code('src/emulator/chatSend.ts')
  const j = cs.indexOf("socket.emit('chat'")
  assert.ok(j > 0, '找不到 emit')
  assert.match(
    cs.slice(j, j + 140),
    /socket\.emit\('chat', \{ text: clean \}/,
    '客户端指定房间号是个跨房间注入的口子',
  )
})

/* ---------------- 五、飘幕本身：三个会把弹幕钉死在画面上的坑 ---------------- */

check('⚠️ 看过的 id 不能只增不减', () => {
  const src = code('src/emulator/LiveChat.tsx')
  assert.match(src, /SEEN_MAX/, 'seen 集合没有上限 —— 一场六小时的直播就是几万个 id 挂在内存里')
  assert.match(
    src,
    /seen\.current = new Set\(\[\.\.\.messages\.map/,
    '修剪要保留「还可能再见到」的那些（手上这一批 + 正在飞的），别整个清空',
  )
})

check('⚠️ 下场不能只靠 animationend', () => {
  const src = code('src/emulator/LiveChat.tsx')
  /*
    animationend 在几种情况下**不会来**：系统开了「减少动态效果」、扩展 / 用户样式表
    把 animation 关了、后台标签页被冻住之后回来。那时弹幕就一动不动地糊在画面上。
  */
  assert.match(src, /ANIM_GRACE_MS/, '没有兜底闹钟')
  assert.match(src, /timers\.current\.set\(m\.id, window\.setTimeout/, '加入时要同时上闹钟')
  assert.match(src, /onAnimationEnd=\{\(\) => drop\(m\.id\)\}/, '正常那条路也要走同一个 drop')
  // 卸载要把闹钟全清掉，否则它们会对着已经没了的组件 setState
  assert.match(src, /for \(const timer of pending\.values\(\)\) window\.clearTimeout\(timer\)/)
})

check('⚠️ 「减少动态效果」要整条关掉横向飘动', () => {
  const src = code('src/emulator/LiveChat.tsx')
  /*
    横穿画面的文字对前庭敏感的人是明确的触发源 —— 顶栏那条走马灯（.im-marquee）
    早就为此关掉了，而糊在游戏画面上、同屏 8 条的弹幕比它强烈得多。
  */
  assert.match(src, /usePrefersReducedMotion/, '没有读系统的减少动态效果开关')
  assert.match(src, /reduced \? LANES : FLYING_MAX/, '不飘的时候要减少同屏条数，否则几条静止的会叠在一起')
  assert.match(src, /reduced \? 'max-w-full truncate' : '\[animation:var\(--animate-danmaku\)\]'/)
  assert.match(src, /STATIC_MS/, '不飘就得靠闹钟撤掉，否则永远留在画面上')
})

check('时长的种子不能算出 NaN', () => {
  const src = code('src/emulator/LiveChat.tsx')
  // id 只有一个字符时 charCodeAt(1) 是 NaN，喂进 --danmaku-dur 就是个非法值
  assert.match(src, /\(m\.id\.charCodeAt\(0\) \|\| 0\) \+ \(m\.id\.charCodeAt\(1\) \|\| 0\)/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
