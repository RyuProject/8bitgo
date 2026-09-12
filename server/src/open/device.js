/**
 * 设备码流程（RFC 8628）的待授权表。
 *
 * ## 为什么是这套流程
 *
 * 开放平台原本只设计了两条取令牌的路：`client_credentials`（应用级，背后没有用户）
 * 和 OIDC 授权码 + PKCE（用户级，要浏览器跳转）。而**设备上没有浏览器** ——
 * 一台 ESP32 做的掌机既弹不出授权页，也接不住回调地址。
 * 设备码流程就是为这种东西定的：设备显示一串码，用户在手机上打开一个页面输进去、
 * 点同意；设备这边一直轮询，直到拿到令牌。
 *
 * ## ⚠️ 存在内存里
 *
 * 这张表是 `Map`，和 live.js 的房间、rateLimit.js 的桶一样 —— 进程一重启就没了，
 * 多进程部署也不共享。对这件事来说可以接受：一条待授权记录的寿命只有 15 分钟，
 * 重启后设备重新要一串码就是了（轮询会收到 `expired_token`，这是协议里的正常分支）。
 * **但如果哪天这个服务要跑多个实例，这里必须先换成库或 Redis** ——
 * 症状是「码输进去显示成功，设备那边一直等」，因为两边落在不同进程上。
 *
 * 纯逻辑 + 一个 Map，没有外部依赖，可以在 node 里直接跑测试。
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** 一串码能活多久。RFC 建议给用户足够时间掏出手机，又不能长到让码有被猜中的价值 */
export const DEVICE_CODE_TTL_SEC = 900
/** 设备该隔多久轮询一次（回给设备的 interval） */
export const DEVICE_POLL_INTERVAL_SEC = 5
/** 待授权记录的总量上限。防止有人拿一把 key 狂建记录把内存撑爆 */
export const MAX_PENDING = 500

/**
 * 用户码的字母表。**刻意挑过**：
 *   · 去掉元音（A/E/I/O/U）—— 随机串不会拼出脏话，也不会拼出让人误会的单词
 *   · 去掉长得像的 0/O、1/I/L —— 用户是照着小屏幕念出来手打的，认错一个字符就白输一遍
 * 剩 28 个字符 × 8 位 ≈ 3.8e11 种，配上 15 分钟窗口和输码接口的限流，够用。
 */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'
const USER_CODE_LEN = 8

/** 生成用户码，形如 `BCDF-GHJK`。中间那道横线只是给人读的，比对时会去掉 */
export function newUserCode() {
  let s = ''
  for (let i = 0; i < USER_CODE_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

/**
 * 把用户输入的码规整成可比对的形式：大写、去掉所有非字母表字符。
 * 用户会打成 `bcdf ghjk`、`BCDF-GHJK`、`bcdfghjk` —— 这三种都该认。
 */
export function normalizeUserCode(raw) {
  const up = String(raw ?? '').toUpperCase()
  let out = ''
  for (const ch of up) if (ALPHABET.includes(ch)) out += ch
  return out
}

/** 设备码：不给人看，所以直接用随机字节 */
function newDeviceCode() {
  return randomBytes(32).toString('base64url')
}

/** 定长比较。用户码是可以一位一位试出来的东西，别给计时侧信道 */
function sameCode(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** deviceCode -> 记录 */
const pending = new Map()

/** 只给测试用：清空 */
export function resetDeviceAuths() {
  pending.clear()
}
export const pendingCount = () => pending.size

/** 清掉过期的。每次写入前顺手做一次，不额外挂定时器 */
export function sweepDeviceAuths(now = Date.now()) {
  for (const [key, row] of pending) if (row.expiresAt <= now) pending.delete(key)
  return pending.size
}

/**
 * 新建一条待授权。
 *
 * @returns {{ deviceCode: string, userCode: string, expiresAt: number } | null}
 *          null = 待授权记录已经到上限（调用方回 slow_down / 稍后再试）
 */
export function createDeviceAuth({ appId, scopes, now = Date.now(), ttlSec = DEVICE_CODE_TTL_SEC }) {
  sweepDeviceAuths(now)
  if (pending.size >= MAX_PENDING) return null
  const deviceCode = newDeviceCode()
  /*
    ⚠️ 用户码要保证**当下不重复**：重了的话第二个人输码会授权给第一台设备。
    活着的记录最多 MAX_PENDING 条，撞上的概率极低，但「极低」不等于不会 ——
    而这件事出一次就是把 A 的账号授权给了 B 的设备。
  */
  const taken = new Set([...pending.values()].map((r) => r.userCodeKey))
  let userCode = newUserCode()
  for (let i = 0; i < 8 && taken.has(normalizeUserCode(userCode)); i++) userCode = newUserCode()
  if (taken.has(normalizeUserCode(userCode))) return null

  pending.set(deviceCode, {
    appId: String(appId),
    scopes: [...(scopes || [])],
    userCode,
    userCodeKey: normalizeUserCode(userCode),
    /** 'pending' | 'approved' | 'denied' */
    state: 'pending',
    userId: '',
    expiresAt: now + ttlSec * 1000,
    /** 上一次轮询的时刻，用来判 slow_down */
    lastPolledAt: 0,
  })
  return { deviceCode, userCode, expiresAt: now + ttlSec * 1000 }
}

/** 按用户输入的码找。找不到 / 过期都返回 null（调用方对外一律同一句话） */
export function findByUserCode(raw, now = Date.now()) {
  const key = normalizeUserCode(raw)
  if (key.length !== USER_CODE_LEN) return null
  for (const row of pending.values()) {
    if (row.expiresAt <= now) continue
    if (sameCode(row.userCodeKey, key)) return row
  }
  return null
}

/**
 * 用户批准。
 *
 * ⚠️ **只有还是 pending 的才能批**：已经批过的再批一次会把 userId 换成另一个人 ——
 * 那正好是「两个人先后输了同一串码」的情形，而设备只该拿到第一个人的授权。
 */
export function approveDeviceAuth(raw, userId, now = Date.now()) {
  const row = findByUserCode(raw, now)
  if (!row || row.state !== 'pending') return false
  row.state = 'approved'
  row.userId = String(userId)
  return true
}

/** 用户拒绝 */
export function denyDeviceAuth(raw, now = Date.now()) {
  const row = findByUserCode(raw, now)
  if (!row || row.state !== 'pending') return false
  row.state = 'denied'
  return true
}

/**
 * 设备来轮询。返回 RFC 8628 §3.5 里那几种结果之一。
 *
 * @returns {{ ok: true, userId: string, scopes: string[] }
 *         | { ok: false, error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant' }}
 */
export function pollDeviceAuth(deviceCode, { appId, now = Date.now(), intervalSec = DEVICE_POLL_INTERVAL_SEC } = {}) {
  const row = pending.get(String(deviceCode || ''))
  /*
    没这条记录、或者拿着别人的应用来兑现 —— 一律 invalid_grant，**同一句话**。
    分开说就等于告诉人「这个 device_code 是存在的，只是不属于你」。
  */
  if (!row || row.appId !== String(appId)) return { ok: false, error: 'invalid_grant' }
  if (row.expiresAt <= now) {
    pending.delete(deviceCode)
    return { ok: false, error: 'expired_token' }
  }
  /*
    轮询太快要回 slow_down（协议规定的），而且**这一次不算数** ——
    不更新 lastPolledAt 的话，一个死循环轮询的设备会永远收到 slow_down，
    它减速之后反而更难恢复。这里的做法是：太快就直接回，时间戳不动，
    下一次只要间隔够了就正常处理。
  */
  if (row.lastPolledAt && now - row.lastPolledAt < intervalSec * 1000) {
    return { ok: false, error: 'slow_down' }
  }
  row.lastPolledAt = now
  if (row.state === 'denied') {
    pending.delete(deviceCode)
    return { ok: false, error: 'access_denied' }
  }
  if (row.state !== 'approved') return { ok: false, error: 'authorization_pending' }
  // 批准的只能兑现一次：令牌发出去之后这条记录就没用了，留着只是给人重放的机会
  pending.delete(deviceCode)
  return { ok: true, userId: row.userId, scopes: [...row.scopes] }
}
