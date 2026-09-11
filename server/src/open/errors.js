/**
 * 开放平台的错误体形状（OAuth 风格，RFC 6749 §5.2）。**纯函数、零依赖**，可以直接跑测试。
 *
 * ## 为什么要单独一个文件
 *
 * `/api/open/*` 的错误体和站内的**不是一套**：站内回 `{ error: '中文一句话' }`，
 * 开放平台回 `{ error: <RFC 的错误码>, error_description, error_uri }` ——
 * 接入方用的是现成的 OAuth 客户端库，它只认前一种里的 `error` 码。
 *
 * 路由里那些错误走的是 `routes/open.js` 的 `fail()`，形状一直是对的。
 * 但**请求体解析失败的那些到不了路由**：`express.json` 挂在全局（`index.js`），
 * 畸形 JSON / 超限在进 openRouter 之前就 `next(err)` 了，最后落到全局错误处理里，
 * 回一句站内风格的 `{"error":"请求格式不正确"}`。
 * 第三方的 OAuth 库拿到它只会报「无法解析的响应」—— 真正的原因一个字都没传达到。
 *
 * 所以全局错误处理要认一下路径，开放平台那部分按这里的形状回。
 * 判断和形状放在这儿而不是写在 index.js 里，是为了能被测试真的跑一遍。
 */

/** 开放平台的路径前缀。**带尾斜杠**：否则 `/api/opensomething` 也会被算进来 */
export const OPEN_PATH_PREFIX = '/api/open/'

/** 这个请求是不是打在开放平台上的。传 `req.originalUrl` 或 `req.path` 都行 */
export function isOpenPath(pathOrUrl) {
  return String(pathOrUrl ?? '').startsWith(OPEN_PATH_PREFIX)
}

/**
 * 把一个中间件抛出来的错误翻成开放平台的错误体。
 *
 * 只处理「还没进路由就失败了」这一类 —— 实际上就是 body-parser 的三种：
 * 超限（413）、畸形（400）、字符集不认识（415）。别的错误一律按服务器错误处理，
 * **不把 err.message 透出去**（那里面可能有栈、有内部路径）。
 *
 * @param {any} err 中间件抛出的错误
 * @param {string} [siteUrl] 站点地址，用来拼 error_uri。给不出来就不带这个字段 ——
 *                           **不编一个假地址**，那比没有更糟
 * @returns {{ status: number, body: { error: string, error_description: string, error_uri?: string } }}
 */
export function openErrorFor(err, siteUrl) {
  const raw = Number(err?.status || err?.statusCode || 0)
  const tooLarge = err?.type === 'entity.too.large' || raw === 413

  let status = 500
  let error = 'server_error'
  let description = '服务器内部错误'

  if (tooLarge) {
    status = 413
    error = 'invalid_request'
    description = '请求体过大'
  } else if (raw >= 400 && raw < 500) {
    status = raw
    error = 'invalid_request'
    description = '请求体无法解析'
  }

  const body = { error, error_description: description }
  const base = String(siteUrl ?? '').replace(/\/+$/, '')
  if (base) body.error_uri = `${base}/developers/docs/errors#${error}`
  return { status, body }
}

/**
 * 开放平台的错误处理中间件。**挂在站内那个之前。**
 *
 * 为什么做成工厂而不是让 index.js 自己写一个 if：
 * index.js 里那份是**跑不到测试的**（要 import 整个 index.js 就得连库、得 listen），
 * 于是「守卫还在不在、排在第几位」只能靠 grep 源码确认 —— 而 grep 拦不住
 * `if (false && …)` 这类改法。做成一个具名函数之后，测试挂的是**同一个函数**，
 * 函数体里的任何改动都会被真的跑到；index.js 那边只剩「挂了没有、挂在哪一位」
 * 这两件事要靠源码断言，而那两件恰好是 grep 拦得住的。
 *
 * @param {() => string} siteUrl 取站点地址的函数（不是字符串 —— publicSiteUrl 读的是
 *                               运行时环境，在模块加载那一刻取会拿到空值）
 */
export function openErrorMiddleware(siteUrl) {
  return (err, req, res, next) => {
    if (!isOpenPath(req?.originalUrl || req?.path)) return next(err)
    let base = ''
    try {
      base = siteUrl?.() ?? ''
    } catch {
      /* 取不到就不带 error_uri，别因为拼个链接把错误处理本身搞挂 */
    }
    const { status, body } = openErrorFor(err, base)
    if (status >= 500) console.error('[open api error]', err)
    res.status(status).json(body)
  }
}
