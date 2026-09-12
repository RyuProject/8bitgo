/**
 * 邮箱格式校验。**先判长度，再跑正则** —— 顺序是这个文件存在的唯一理由。
 *
 * ## 为什么不能直接 `EMAIL_RE.test(x)`
 *
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` 对**不匹配的长串**是灾难性回溯：
 * 形如 `a@` + `a.`×N + `@b` 的输入里，第二个 `@` 让末尾的 `[^\s@]+$` 永远走不到 `$`，
 * 引擎要把中间那两段的所有切分方式都试一遍，代价随长度平方增长。实测这条正则：
 *
 *     4 KB → 5 ms    16 KB → 83 ms    31 KB → 329 ms    63 KB → 1294 ms
 *
 * 而注册 / 登录 / 发验证码这几条**都是未认证**的，请求体上限是 4MB ——
 * 外推是小时级。Node 单线程，这期间全站 API、SSR、socket.io 信令、SSE 全停。
 * 也就是说：**一条未认证请求就能把整个进程挂住**。
 *
 * 长度那一道把输入压到 254 字节以内（RFC 5321 对邮件地址的上限），
 * 最坏情况从小时级回到微秒级。正则本身不动 —— 改写成线性的版本要重新论证它认什么、
 * 拒什么，而长度闸是零风险的。
 *
 * ⚠️ 新增任何一处邮箱校验，**都从这里 import**，别再写一遍 `EMAIL_RE.test(...)`。
 * 漏掉长度那一道的话，症状不是「校验松了」，是「服务器被一条请求打死」。
 */

/** RFC 5321 §4.5.3.1.3：整个地址最长 254 字节 */
export const EMAIL_MAX = 254

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 是不是一个能用的邮箱地址。
 * @param {unknown} raw 原始输入（会先 String 化，不 trim —— 调用方自己决定要不要 trim）
 */
export function isEmail(raw) {
  const s = String(raw ?? '')
  // ⚠️ 这一行必须在 test 之前。理由见文件头，不是风格问题
  if (!s || s.length > EMAIL_MAX) return false
  return EMAIL_RE.test(s)
}

/** 规整成可比对的形式：去首尾空白 + 转小写。不合法返回空串 */
export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  return isEmail(s) ? s : ''
}
