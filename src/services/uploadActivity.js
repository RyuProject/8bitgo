/**
 * 后台游戏编辑器共用的上传 / 转码活动账本。
 *
 * @typedef {{ id: number, label: string }} UploadActivity
 * @typedef {{ active: readonly UploadActivity[], started: number, failures: number }} UploadActivitySnapshot
 * @typedef {{ failureIsFatal?: boolean }} UploadActivityOptions
 */

const listeners = new Set()
let nextId = 1
/** @type {UploadActivitySnapshot} */
let snapshot = { active: [], started: 0, failures: 0 }
let notifyTimer = null

function publish(next) {
  snapshot = next
  if (!listeners.size) return
  // 多 SWF 包会逐个写入数百个小对象；限频通知避免每个分片 / 文件都重绘整张编辑表单。
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    listeners.forEach((listener) => listener())
  }, 120)
}

/** @returns {UploadActivitySnapshot} */
export function getUploadActivity() {
  return snapshot
}

/** @param {() => void} listener */
export function subscribeUploadActivity(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** @param {string} label @returns {(failed?: boolean) => void} */
export function beginUploadActivity(label) {
  const id = nextId++
  publish({
    ...snapshot,
    active: [...snapshot.active, { id, label }],
    started: snapshot.started + 1,
  })
  let ended = false
  return (failed = false) => {
    if (ended) return
    ended = true
    publish({
      ...snapshot,
      active: snapshot.active.filter((task) => task.id !== id),
      failures: snapshot.failures + Number(failed),
    })
  }
}

/** @template T @param {string} label @param {() => Promise<T>} task @param {UploadActivityOptions} [options] @returns {Promise<T>} */
export async function trackUploadActivity(label, task, { failureIsFatal = true } = {}) {
  const finish = beginUploadActivity(label)
  try {
    return await task()
  } catch (error) {
    finish(failureIsFatal)
    throw error
  } finally {
    finish()
  }
}
