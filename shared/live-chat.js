/**
 * 直播弹幕的**共用规则**：长度上限、清洗、限流参数。
 *
 * 放在 shared/ 是因为服务端和前端必须用同一份 —— 前端按它截断、按它禁用发送按钮，
 * 服务端按它做最终裁决。各写一份的结果是「前端让你发、服务端悄悄丢掉」，
 * 用户只看到弹幕没出来，什么提示都没有。
 *
 * 必须是 .js（server/ 不过 TS 编译），前端要 import 就得配一份手写的 .d.ts。
 */

/** 一条弹幕最多几个字符（按**码点**算，不是 UTF-16 长度，免得把 emoji 劈成两半） */
export const CHAT_MAX_LENGTH = 60

/** 房间里保留多少条历史。中途进来的观众能看到这些；再多没意义 —— 弹幕是当下的东西 */
export const CHAT_HISTORY_SIZE = 30

/** 同一个连接两条弹幕之间至少隔多久 */
export const CHAT_MIN_INTERVAL_MS = 1200

/**
 * 短时间内最多攒几条（令牌桶的桶容量）。
 * 只卡间隔的话，攒够时间一次性倒出来照样是刷屏；只卡总量则正常聊天会被误伤。
 */
export const CHAT_BURST = 4

/** 控制字符，外加 U+2028 / U+2029 这两个会被当成换行的 Unicode 分隔符 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/g

/**
 * 清洗一条弹幕。返回空串 = 这条不该发出去。
 *
 * 三件事，缺一不可：
 *  1. **去掉控制字符**。留着的话弹幕能顶出多行、把画面糊掉，进日志也很难看。
 *  2. **所有空白折成一个空格**：连打一百个换行是最省事的刷屏手法，而长度检查拦不住它。
 *  3. **按码点截断**。String.slice 会把一个 emoji 从中间切开，留下半个代理对 ——
 *     渲染成问号方块不说，JSON 里也是个不合法的字符串。
 */
export function sanitizeChatText(raw) {
  const s = typeof raw === 'string' ? raw : ''
  const collapsed = s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  const points = Array.from(collapsed)
  return points.length <= CHAT_MAX_LENGTH ? collapsed : points.slice(0, CHAT_MAX_LENGTH).join('')
}

/** 弹幕长度（码点数）。前端用它显示剩余字数，和上面的截断是同一套算法 */
export function chatTextLength(raw) {
  return Array.from(typeof raw === 'string' ? raw : '').length
}
