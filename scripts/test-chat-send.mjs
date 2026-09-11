#!/usr/bin/env node
/**
 * 「发一条弹幕并把服务端的答复带回来」的回归测试。跑：npm run test:chat-send
 *
 * 守的是 2026-09-10 查出来的那个静默失效：两条发送路径都只写了
 * `if (socket.connected) socket.emit('chat', {...})` —— 服务端一直在 ack 拒收原因
 * （太快 / 不在房间里 / 房间没了），**一个字都没人看**。
 * 配上「弹幕不做本地回显」，用户看到的就是「我发了，然后什么都没发生」。
 *
 * 这份是**真的跑一遍**（塞一个假 socket 进去），不是 grep 源码。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAT_ACK_TOO_FAST, CHAT_ACK_NO_ROOM, chatSendOutcome } from '../shared/live-chat.js'
import { sendChatWithAck } from '../src/emulator/chatSend.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

/** 假 socket：记下发出去的东西，ack 由用例决定怎么回 */
const fakeSocket = (reply) => {
  const sent = []
  return {
    sent,
    connected: true,
    emit(event, payload, ack) {
      sent.push({ event, payload })
      if (reply !== undefined) queueMicrotask(() => ack(reply))
    },
  }
}

/* ---------------- 一、映射：ack 串 -> 提示哪一类 ---------------- */

await check('ack 为空 = 发出去了', () => {
  assert.equal(chatSendOutcome(null), null)
  assert.equal(chatSendOutcome(undefined), null)
  assert.equal(chatSendOutcome(''), null)
})

await check('⚠️ 「太快」单独成一类（用户能做点什么：等一下）', () => {
  assert.equal(chatSendOutcome(CHAT_ACK_TOO_FAST), 'too-fast')
})

await check('其余拒收对用户是同一件事：这条没发出去', () => {
  for (const err of [CHAT_ACK_NO_ROOM, 'not found', 'empty', 'failed', new Error('x')]) {
    assert.equal(chatSendOutcome(err), 'dropped', `${err} 该归到 dropped`)
  }
})

/* ---------------- 二、三条「没发出去」的路，一条都不能漏 ---------------- */

await check('⚠️ socket 没连上要说一声（原来这里是静静地什么都不做）', async () => {
  assert.equal(await sendChatWithAck(null, '喂'), 'dropped')
  assert.equal(await sendChatWithAck({ connected: false, emit: () => {} }, '喂'), 'dropped')
})

await check('⚠️ ack 说不行就照实报', async () => {
  assert.equal(await sendChatWithAck(fakeSocket(CHAT_ACK_TOO_FAST), '喂'), 'too-fast')
  assert.equal(await sendChatWithAck(fakeSocket(CHAT_ACK_NO_ROOM), '喂'), 'dropped')
})

await check('⚠️ ack 根本不来时要超时（发出去之后断线）', async () => {
  const t0 = Date.now()
  // 没有这个兜底的话，这句 await 永远不会兑现 —— 调用方的「发送中」也就永远不结束
  assert.equal(await sendChatWithAck(fakeSocket(undefined), '喂', 60), 'dropped')
  assert.ok(Date.now() - t0 >= 50, '不该立刻就返回，那是没等 ack')
})

await check('ack 兑现之后超时闹钟不能再改结论', async () => {
  const s = fakeSocket(null)
  assert.equal(await sendChatWithAck(s, '喂', 20), null)
  // 再等一会儿，确认那个 20ms 的闹钟没有把已经兑现的 promise 又叫醒一次（会抛 unhandled）
  await new Promise((r) => setTimeout(r, 60))
})

await check('emit 自己抛了也要兑现（socket 正在被拆）', async () => {
  const s = { connected: true, emit() { throw new Error('closing') } }
  assert.equal(await sendChatWithAck(s, '喂'), 'dropped')
})

/* ---------------- 三、发出去的内容 ---------------- */

await check('⚠️ 请求体里只有 text，绝不带房间号（跨房间注入的口子）', async () => {
  const s = fakeSocket(null)
  await sendChatWithAck(s, '  喂  ')
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].event, 'chat')
  assert.deepEqual(Object.keys(s.sent[0].payload), ['text'])
  assert.equal(s.sent[0].payload.text, '喂', '发出去之前要清洗（和服务端同一份 sanitizeChatText）')
})

await check('清洗之后为空的一律不发', async () => {
  const s = fakeSocket(null)
  assert.equal(await sendChatWithAck(s, '   \n\t  '), 'dropped')
  assert.equal(s.sent.length, 0, '空消息不该占一次限流额度')
})

await check('超长按码点截断，不把 emoji 劈成两半', async () => {
  const s = fakeSocket(null)
  await sendChatWithAck(s, '🎮'.repeat(100))
  assert.ok(!s.sent[0].payload.text.includes('�'))
  assert.equal([...s.sent[0].payload.text].length, 60)
})

/* ---------------- 四、两条发送路径都必须走这里 ---------------- */

await check('⚠️ 主播和观众两条路都走同一份实现（抄两份必然漏掉一条分支）', () => {
  for (const rel of ['src/emulator/broadcast.ts', 'src/emulator/adapters/liveview.ts']) {
    const src = code(rel)
    assert.match(src, /sendChatWithAck\(/, `${rel} 没走 chatSend.ts`)
    assert.ok(
      !/socket\.emit\('chat'/.test(src),
      `${rel} 里还有自己 emit('chat') 的地方 —— 那一条不会等 ack，用户看不到任何提示`,
    )
  }
})

await check('⚠️ 界面要把结果显示出来（不然带回来也白带）', () => {
  const bar = code('src/emulator/LiveChat.tsx')
  assert.match(bar, /tt\.chatTooFast/, '「太快了」那句没有渲染出口')
  assert.match(bar, /tt\.chatDropped/, '「没发出去」那句没有渲染出口')
  assert.match(bar, /role="status"/, '提示要能被读屏播报，且不抢焦点')
  // 失败时把文字还回输入框，但**只在用户还没开始打下一句时**
  assert.match(bar, /setText\(\(cur\) => \(cur \? cur : clean\)\)/, '还字不能盖掉用户新打的内容')
})

await check('八种语言都有这两句', () => {
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'de', 'fr', 'es', 'it']) {
    const src = read(`src/locales/${lang}.ts`)
    for (const key of ['chatTooFast', 'chatDropped']) {
      assert.match(src, new RegExp(`${key}:`), `${lang} 缺 ${key}`)
    }
  }
})

await check('⚠️ ack 的那几个串是前后端共用的常量，不是各写一遍的字面量', () => {
  const server = code('server/src/live.js')
  assert.match(server, /CHAT_ACK_TOO_FAST/, '服务端要用 shared 里的常量')
  assert.ok(
    !/ack\?\.\('too fast'\)/.test(server),
    "服务端还在写字面量 'too fast' —— 改一个字前端的提示就从此不再出现，而且完全静默",
  )
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
