/**
 * 顶部加载进度条的状态源（YouTube 顶上那种细条）。
 *
 * 为什么要自己写：本项目用的是 <BrowserRouter>（不是 data router），
 * react-router 的 useNavigation() 用不上；而且真正花时间的也不是路由切换本身，
 * 是切完之后去拉 /api/page 的那一下。所以进度得由「取数」来驱动。
 *
 * 计数是引用式的：同时有多个请求在飞时只显示一根条，最后一个结束才收尾。
 */
import { useSyncExternalStore } from 'react'

export interface ProgressSnapshot {
  /** 0–1。到 1 之后会停留一小会儿再淡出 */
  value: number
  visible: boolean
}

const HIDDEN: ProgressSnapshot = { value: 0, visible: false }

/**
 * 起步前的静默期。比这更快返回的请求根本不显示条 —— 一闪而过比不显示更晃眼。
 * 注意别设太大：设成 150ms 以上的话，服务器快一点的站内跳转就再也看不到条了，
 * 用户点下去会觉得「没反应」。
 */
const SHOW_DELAY = 80
/**
 * 一旦露面，至少停留这么久再收尾。
 * 没有这条，一个 90ms 的请求会让条刚出现就消失，比不出现还难看。
 */
const MIN_VISIBLE = 260
/** 没结束前每隔多久往前爬一次 */
const TRICKLE_EVERY = 220
/** 请求没回来之前最多爬到这里，剩下的留给「真的完成」 */
const CEILING = 0.9
/**
 * 满格之后停留多久再淡出，让人看得见「满了」而不是凭空消失。
 * 必须大于 .progress-bar 的 width transition（200ms）：淡出时会把宽度过渡摘掉，
 * 摘早了那一下没跑完的动画会直接跳到 100%，在还看得见的时候闪一下。
 */
const HOLD_AT_FULL = 220
/** 淡出时长，必须和 .progress-bar 的 opacity transition 对齐 */
const FADE_OUT = 260

let pending = 0
let shownAt = 0
let snapshot: ProgressSnapshot = HIDDEN
const listeners = new Set<() => void>()

let showTimer: ReturnType<typeof setTimeout> | null = null
let trickleTimer: ReturnType<typeof setInterval> | null = null
let completeTimer: ReturnType<typeof setTimeout> | null = null
let fadeTimer: ReturnType<typeof setTimeout> | null = null
let resetTimer: ReturnType<typeof setTimeout> | null = null

function clear(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) clearTimeout(timer)
  return null
}

/** useSyncExternalStore 要求快照引用在没变化时保持稳定，所以只在真的变了时才换对象 */
function emit(next: ProgressSnapshot) {
  if (next.value === snapshot.value && next.visible === snapshot.visible) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** 越接近封顶爬得越慢：请求越久，条越像「还在动，但快到了」 */
function trickle() {
  const remaining = CEILING - snapshot.value
  if (remaining <= 0.002) return
  emit({ visible: true, value: snapshot.value + Math.max(0.004, remaining * 0.22) })
}

function startTrickle() {
  if (!trickleTimer) trickleTimer = setInterval(trickle, TRICKLE_EVERY)
}

function stopTrickle() {
  if (trickleTimer) clearInterval(trickleTimer)
  trickleTimer = null
}

/** 收尾：走到满格 → 停一下 → 淡出 → 归零 */
function complete() {
  completeTimer = null
  emit({ visible: true, value: 1 })
  fadeTimer = setTimeout(() => {
    fadeTimer = null
    emit({ visible: false, value: 1 })
  }, HOLD_AT_FULL)
  resetTimer = setTimeout(() => {
    resetTimer = null
    emit(HIDDEN)
  }, HOLD_AT_FULL + FADE_OUT)
}

function finish() {
  stopTrickle()
  // 还没露面就结束了（请求比 SHOW_DELAY 还快）：撤掉计划，一帧都不闪
  if (showTimer) {
    showTimer = clear(showTimer)
    return
  }
  if (!snapshot.visible) return
  const remaining = MIN_VISIBLE - (Date.now() - shownAt)
  if (remaining > 0) {
    completeTimer = setTimeout(complete, remaining)
    return
  }
  complete()
}

/**
 * 开始一次加载，返回结束回调。回调可以重复调用（只有第一次算数），
 * 免得 then / catch / 组件卸载各来一次把计数扣穿。
 */
export function startPageLoad(): () => void {
  if (typeof window === 'undefined') return () => {}
  pending += 1
  if (pending === 1) {
    // 上一根条还没收完就又开始了（连点两个链接就是这样）：
    // 取消收尾、接着用同一根条继续爬，而不是闪一下重来
    completeTimer = clear(completeTimer)
    fadeTimer = clear(fadeTimer)
    resetTimer = clear(resetTimer)
    if (snapshot.visible && snapshot.value < 1) {
      startTrickle()
    } else {
      if (snapshot.value !== 0) emit(HIDDEN)
      showTimer = setTimeout(() => {
        showTimer = null
        shownAt = Date.now()
        emit({ visible: true, value: 0.08 })
        startTrickle()
      }, SHOW_DELAY)
    }
  }
  let settled = false
  return () => {
    if (settled) return
    settled = true
    pending = Math.max(0, pending - 1)
    if (pending === 0) finish()
  }
}

/** 语法糖：把一个 promise 的生命周期挂到进度条上 */
export function trackPageLoad<T>(promise: Promise<T>): Promise<T> {
  const done = startPageLoad()
  return promise.finally(done)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useProgress(): ProgressSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => HIDDEN,
  )
}

/** 仅供测试：把内部状态清干净 */
export function __resetProgress() {
  pending = 0
  shownAt = 0
  stopTrickle()
  showTimer = clear(showTimer)
  completeTimer = clear(completeTimer)
  fadeTimer = clear(fadeTimer)
  resetTimer = clear(resetTimer)
  emit(HIDDEN)
}
