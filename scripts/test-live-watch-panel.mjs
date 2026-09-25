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

console.log('五、公开边界与直播大厅意图')

check('⚠️ 默认开播，但玩家的不公开选择必须长期保存', () => {
  const src = code('src/emulator/LiveControls.tsx')
  assert.match(src, /const PRIVATE_KEY = '8bit\.live\.private'/, '没有保存玩家的不公开选择')
  assert.match(src, /useState\(readPrivate\)/, '没在开播前读取玩家的不公开选择')
  assert.match(src, /function readPrivate[\s\S]*?catch\s*{\s*return false/, '本地存储不可用时没有回到默认开播')
  assert.match(src, /writePrivate\(next\)/, '点「不公开」后没有记住选择')
})

check('⚠️ 直播大厅不能混入没有观众席的云端房', () => {
  const src = code('src/pages/RoomsPage.tsx')
  assert.match(src, /all\.filter\(\(room\) => room\.kind !== 'cloud'\)/, '云端房会把「观看」变成加入对局')
})

check('⚠️ 从直播大厅点 P2P 房必须强制进观众席', () => {
  const page = code('src/pages/RoomsPage.tsx')
  const card = code('src/components/game/RoomCard.tsx')
  assert.match(page, /<RoomCard room=\{room\} watchOnly=\{live\}/, '直播页没有把观看意图交给房间卡')
  assert.match(card, /\(full \|\| watchOnly\) && watchable/, '有空位的 P2P 房仍会把观众送进玩家席')
})

check('⚠️ 主播回来后只有真的收到画面才可以报正在观看', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  const at = src.indexOf("s.on('host-back'")
  assert.ok(at > 0, '找不到 host-back 恢复处理')
  const body = src.slice(at, at + 900)
  assert.match(body, /connected && gotFrame/, '只看 ICE connected 会把无帧黑屏误报成正在观看')
  assert.match(body, /if \(connected\) armRewatch\(FIRST_OFFER_MS\)/, '连着但没帧时没有恢复闹钟')
  assert.match(body, /else void rewatch\(\)/, '旧连接已经断开时没有立即重建')
})

check('⚠️ watch 临时失败后必须继续重试，且恢复请求不能并发', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.match(src, /const transient = msg === 'watch timeout'[\s\S]*?'already watching'/, '首次 ack 丢失仍会被当成永久失败')
  assert.match(src, /lastWatchRetryable &&[\s\S]*?armRewatch\(FIRST_OFFER_MS\)/, '临时失败后没有重新上闹钟')
  assert.match(src, /recoveryInFlight/, '多个恢复来源仍会并发发 watch')
  assert.match(src, /localCandidateTypes\.clear\(\)/, '换连接后仍沿用上一轮 ICE 候选做诊断')
})

check('⚠️ 手动分享选择器迟到时不能在离页后偷偷开播', () => {
  /*
    getDisplayMedia 的选择器可以挂很久。期间组件卸载 / 玩家点关播后，Promise 仍会兑现；
    两个 await（拿到屏幕流、建好 Broadcast）之后都必须核对代次，且 stop 要先作废旧代次。
  */
  const src = code('src/emulator/LiveControls.tsx')
  assert.match(src, /const manualAttemptRef = useRef\(0\)/, '没有手动分享代次，无法识别迟到结果')
  const stopAt = src.indexOf('const stop = useCallback')
  const manualAt = src.indexOf('const startManual = async')
  assert.ok(stopAt > 0 && manualAt > stopAt, '找不到停播或手动开播流程')
  assert.match(src.slice(stopAt, manualAt), /manualAttemptRef\.current \+= 1/, '停播没有作废仍在等待的授权')
  const manual = src.slice(manualAt, src.indexOf('const available', manualAt))
  assert.match(manual, /const attempt = \+\+manualAttemptRef\.current/, '手动分享没有领取独立代次')
  assert.ok((manual.match(/attempt !== manualAttemptRef\.current/g) ?? []).length >= 2, '拿流和开房后没有分别拦迟到结果')
  assert.match(manual, /b\.stop\(\)/, '迟到但已经建好的直播房没有拆掉')
  assert.match(manual, /for \(const tr of stream\.getTracks\(\)\) tr\.stop\(\)/, '迟到的屏幕共享轨没有停止')
  const listenAt = manual.indexOf("tr.addEventListener('ended'")
  const startAt = manual.indexOf('const b = await startBroadcast')
  assert.ok(listenAt > 0 && listenAt < startAt, 'ended 监听挂得太晚：握手期间停止共享会留下黑屏房')
  assert.match(manual, /for \(const tr of stream\.getVideoTracks\(\)\)/, '音频轨单独结束不应该连视频直播一起关掉')
  assert.match(manual, /getVideoTracks\(\)\.some\(\(track\) => track\.readyState === 'live'\)/, '开房后没有复核视频轨仍然存活')
})

check('观众端不会永久卡在 disconnected，视频轨单独 ended 也会自愈', () => {
  const src = code('src/emulator/adapters/liveview.ts')
  assert.match(src, /DISCONNECTED_GRACE_MS/, '没有 disconnected 恢复宽限')
  assert.match(src, /next\.connectionState !== 'disconnected'[\s\S]*?void rewatch\(\)/, '宽限到期后没有重新 watch')
  assert.match(src, /track\.onended = \(\) =>[\s\S]*?void rewatch\(\)/, '媒体轨结束后仍只等 ICE failed')
})

check('生产构建期间不拆掉正在看播用的旧入口和哈希资源', () => {
  const vite = code('vite.config.ts')
  const ssr = code('server/src/ssr.js')
  assert.match(vite, /emptyOutDir: false/, 'Vite 仍会在现场构建前清空 dist\/client')
  assert.match(ssr, /if \(template !== null\) return template/, 'index.html 短暂不存在时 SSR 不会使用已缓存的完整模板')
})

check('播放器代码块加载时有可见、可读屏的状态，不再只剩黑框', () => {
  const src = code('src/emulator/PlayerChunk.tsx')
  assert.match(src, /role="status"/, '加载占位没有状态语义')
  assert.match(src, /aria-live="polite"/, '读屏不会获知播放器正在加载')
  assert.match(src, /t\.player\.statusLoading/, '加载占位仍只有一个难以察觉的小圆圈')
})

check('侧边栏有独立直播入口', () => {
  const src = code('src/components/layout/nav.ts')
  assert.match(src, /to: '\/rooms\?live=1'/, '直播大厅仍然只能靠猜网址进入')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
