/**
 * 音频探针的回归测试。
 *
 * 盯的是这件事：EmulatorJS / Ruffle 都是自己 `new AudioContext()`，不交出任何节点 ——
 * 不装探针的话，录像和直播**一律是静音的**，而界面照样显示「直播中」，
 * 观众以为是自己静音了。探针的活儿是：把「直接接到扬声器」的那一路旁路一份出来。
 *
 * 三条硬要求，每一条错了都是线上静默失败：
 *   1. 只旁路直接接到 destination 的那一路（中间节点也采 = 同一条声音收好几遍）
 *   2. 旁路点自己**不能**接到 destination（接了 = 玩家听到双份声音）
 *   3. 任何一步失败都不能影响游戏本身（最坏结果只能是「没声音」）
 *
 * 跑：npm run test:audio-tap
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const { installAudioTap } = await import(fileURLToPath(new URL('../src/emulator/audioTap.ts', import.meta.url)))

let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

/* ---------------- 假的 Web Audio ---------------- */

/** 记下每一次 connect：[从, 到] */
let connections = []

class FakeAudioNode {
  constructor(name) {
    this.name = name
  }
  connect(dest) {
    connections.push([this.name, dest?.name ?? String(dest)])
    return dest
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor() {
    super('gain')
  }
}

class FakeAudioContext {
  constructor(opts) {
    this.opts = opts
    this.destination = new FakeAudioNode('destination')
    FakeAudioContext.created.push(this)
  }
  createGain() {
    return new FakeGainNode()
  }
}
FakeAudioContext.created = []

/** 造一个「iframe 的 window」 */
function makeRealm({ gainThrows = false, noAudioContext = false, noNodeProto = false } = {}) {
  class Ctx extends FakeAudioContext {
    createGain() {
      if (gainThrows) throw new Error('nope')
      return super.createGain()
    }
  }
  const win = {}
  if (!noAudioContext) win.AudioContext = Ctx
  if (!noNodeProto) win.AudioNode = FakeAudioNode
  return win
}

const reset = () => {
  connections = []
  FakeAudioContext.created = []
}

/* ---------------- 跑 ---------------- */

console.log('── 正常情况 ──')
{
  reset()
  const win = makeRealm()
  const tap = installAudioTap(win)
  ok(tap.ctx === null && tap.node === null, '装的时候还没有上下文，探针是空的')

  // 引擎起来了，自己 new 一个
  const ctx = new win.AudioContext()
  ok(tap.ctx === ctx, '⭐ 引擎建的第一个 AudioContext 被认了下来')
  ok(tap.node instanceof FakeGainNode, '旁路点是一个 GainNode')
  ok(
    !connections.some(([, to]) => to === 'destination' && connections.length === 0),
    '建旁路点的时候没有乱接线',
  )

  // 引擎把一条声音接到扬声器
  const src = new win.AudioNode('oscillator')
  src.connect(ctx.destination)
  ok(
    connections.some(([from, to]) => from === 'oscillator' && to === 'destination'),
    '原来那一路照旧接到扬声器（游戏还有声音）',
  )
  ok(
    connections.some(([from, to]) => from === 'oscillator' && to === 'gain'),
    '⭐ 同一条声音额外旁路了一份到探针上（录像/直播才有声音）',
  )
  ok(
    !connections.some(([from]) => from === 'gain'),
    '⭐ 旁路点自己不往 destination 接 —— 接了玩家就会听到双份声音',
  )
}

console.log('\n── 只旁路「直接接到扬声器」的那一路 ──')
{
  reset()
  const win = makeRealm()
  const tap = installAudioTap(win)
  const ctx = new win.AudioContext()

  // 一条中间链路：osc → filter → destination
  const osc = new win.AudioNode('oscillator')
  const filter = new win.AudioNode('filter')
  osc.connect(filter)
  filter.connect(ctx.destination)

  const tapped = connections.filter(([, to]) => to === 'gain').map(([from]) => from)
  ok(tapped.length === 1 && tapped[0] === 'filter', '⭐ 只采最后那一级，中间节点不重复采')
  ok(!tapped.includes('oscillator'), 'osc → filter 那一段没有被旁路')
}

console.log('\n── 只认第一个上下文 ──')
{
  reset()
  const win = makeRealm()
  const tap = installAudioTap(win)
  const first = new win.AudioContext()
  const second = new win.AudioContext()
  ok(tap.ctx === first, '第二个上下文不会顶掉第一个')
  const src = new win.AudioNode('osc2')
  src.connect(second.destination)
  ok(!connections.some(([, to]) => to === 'gain'), '接到别的上下文的扬声器上不会被误采')
}

console.log('\n── 失败一律降级成「没声音」，不能影响游戏 ──')
{
  // 这个 realm 根本没有 AudioContext
  reset()
  const bare = makeRealm({ noAudioContext: true })
  const t1 = installAudioTap(bare)
  ok(t1.ctx === null && t1.node === null, '没有 AudioContext 时原样返回空探针，不抛')

  // 有 AudioContext 但没有 AudioNode.prototype
  reset()
  const noProto = makeRealm({ noNodeProto: true })
  const t2 = installAudioTap(noProto)
  ok(t2.ctx === null, '拿不到 AudioNode.prototype 时也不装，不抛')
  ok(noProto.AudioContext.name !== 'TappedAudioContext', '⭐ 装不成就别动人家的构造函数')

  // createGain 抛了
  reset()
  const bad = makeRealm({ gainThrows: true })
  const t3 = installAudioTap(bad)
  const ctx = new bad.AudioContext()
  ok(t3.ctx === ctx, '上下文照认')
  ok(t3.node === null, 'createGain 抛了就没有旁路点')
  const src = new bad.AudioNode('osc')
  src.connect(ctx.destination)
  ok(
    connections.some(([from, to]) => from === 'osc' && to === 'destination'),
    '⭐ 没有旁路点时，游戏自己的声音一点没受影响',
  )
}

console.log('\n── 装两次不会叠加 ──')
{
  reset()
  const win = makeRealm()
  installAudioTap(win)
  const tap2 = installAudioTap(win)
  const ctx = new win.AudioContext()
  const src = new win.AudioNode('osc')
  src.connect(ctx.destination)
  const toGain = connections.filter(([, to]) => to === 'gain')
  ok(toGain.length <= 1, '⭐ 同一条声音不会因为装了两次而被采两遍')
  ok(tap2.ctx === ctx || tap2.ctx === null, '第二个探针要么认同一个上下文、要么空着，不会乱')
}

console.log(`\n✅ 音频探针测试通过（${n} 项）`)
