/**
 * 站点公告条（首页搜索框与横幅之间那一条）的数据形状与清洗规则。
 *
 * 前后端共用一份、纯函数、零依赖 —— 理由和 shared/dosbox-config.js 一样：
 * 这里全是「改了看不出问题」的判断（什么时候该显示、文本怎么清洗），
 * 放在路由或组件里就只能靠肉眼看线上。回归：`npm run test:site-notice`。
 *
 * ## 两种颜色，两种语气
 *
 *   warn  黄色 —— **提示**：站点近期有波动、某个功能正在测试
 *   error 红色 —— **Sorry**：站长自己动了什么，导致玩不了 / 进不来
 *
 * 颜色本身只是显示层的事（谁黄谁红在组件里定），这一层只管
 * 「这一条算不算数、文本长什么样」。
 *
 * ## 为什么清洗要这么严
 *
 * 文本是**管理员手输**的，而它要画进一条**固定高度**的横条里：
 *   · 换行会把横条顶成两行，把下面整屏内容推走；
 *   · 一串空格能把字推出可视区，看着像条空白；
 *   · 贴一整篇文章进来，首页第一屏就只剩这条公告。
 * 所以控制字符与所有连续空白折叠成一个空格，超长按**码点**截断
 * （按码点而不是按 UTF-16 码元，否则一个 emoji 会被劈成半个，渲染出替换符）。
 */

/** 有哪几种语气。`off` 不在其中 —— 关掉用 enabled 表达，别把「没有颜色」混进来 */
export const NOTICE_LEVELS = ['warn', 'error']
/** 管理员没选等级时的兜底。站长的第一反应是「提示」而不是「道歉」 */
export const NOTICE_LEVEL_DEFAULT = 'warn'
/**
 * 文本上限。
 *
 * 160 是按**横条能显示的长度**定的：手机上（375px 宽、14px 字）一行大约 24 个字，
 * 160 个字上下就是 6~7 行 —— 已经超出「一条公告」该有的样子了。
 * 真需要写这么多的时候，该做的是发一篇文章，不是把首页撑开。
 */
export const NOTICE_TEXT_MAX = 160

const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/g

/** 把管理员输入的文本压成一条能画在单行里的字符串 */
export function cleanNoticeText(raw) {
  const s = String(raw ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const points = Array.from(s)
  return points.length <= NOTICE_TEXT_MAX ? s : points.slice(0, NOTICE_TEXT_MAX).join('')
}

/**
 * 管理员提交的那一份 → 能存进库的那一份。**不抛异常**，一律给出可用的结果。
 *
 * 两条规则值得说明：
 *   · 等级不合法就退回 warn，而不是报错 —— 存下去的意义是「公告能显示」，
 *     为一个枚举值把管理员的整条公告丢掉是本末倒置（前端本来就只会发这两个值）。
 *   · 文本为空就等于关掉。空了还 enabled:true 的话，前台得自己判一次空字符串，
 *     两处判断迟早会不一致；这里直接把它收敛成一个状态。
 */
export function sanitizeNotice(input) {
  const level = NOTICE_LEVELS.includes(input?.level) ? input.level : NOTICE_LEVEL_DEFAULT
  const text = cleanNoticeText(input?.text)
  return { level, text, enabled: input?.enabled !== false && text !== '' }
}

/**
 * 库里那一份 → 前台能画的那一份。**任何一处不成立就返回 null**（整条不画）。
 *
 * 不抛异常：公告是装饰性的，格式不对（旧版本存的、人手改库改坏的）时
 * 该做的是「这一条不显示」，不是让首页跟着白屏。
 */
export function visibleNotice(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.enabled === false) return null
  if (!NOTICE_LEVELS.includes(raw.level)) return null
  const text = cleanNoticeText(raw.text)
  if (!text) return null
  return { level: raw.level, text }
}
