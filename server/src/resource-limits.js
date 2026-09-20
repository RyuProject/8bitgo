/**
 * 数值型环境变量的统一入口。
 *
 * ── 为什么不能直接写 `Number(process.env.X || 默认)` ──────────────
 *
 * 那种写法在填错时**静默失去保护**：`FLASH_SAVE_TOTAL_MAX_BYTES=abc` → `Number('abc')` 是 NaN，
 * 而所有配额比较（`size > 上限`）碰到 NaN 一律为 false —— 于是「打错一个字母」等于「关掉限额」，
 * 日志里一个字都没有。换成 `1e12` 这种「合法但离谱」的值同理。
 *
 * 这里的做法：非法值**夹到最近的合法边界**或退回默认值，并且**每次都出声**。
 * 报错比静默好，但「按默认值继续跑」比两者都好 —— 默认值本来就是安全的那一档，
 * 保护不会因为我们退回它而消失。
 *
 * ⚠️ 和审计包给出的版本有一处**刻意**的差别：那边遇到非法值直接抛异常让进程起不来。
 * 这台 Express 同时扛着整站，配额填错属于「某个功能配置有误」，不该演成整站 502；
 * 而且崩溃循环往往要等下一次部署才被发现，warn 反而更快被人看到。
 */
export function envNumber(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  const raw = process.env[name]
  if (raw == null || String(raw).trim() === '') return fallback

  const value = Number(raw)
  if (!Number.isFinite(value)) {
    warn(name, `不是数字（${JSON.stringify(String(raw))}）`, fallback)
    return fallback
  }

  /*
    默认按整数用（字节数、条数、并发数）；J2ME 那几个 MB 值是 `integer: false`，
    因为「0.5MB」是真的有人会写的配置。
    取整一律**向下**：四舍五入会把限额放大，那就不是「收紧」了。
  */
  const normalized = integer ? Math.floor(value) : value
  if (normalized < min) {
    warn(name, `${normalized} 小于下限 ${min}`, min)
    return min
  }
  if (normalized > max) {
    warn(name, `${normalized} 超过上限 ${max}`, max)
    return max
  }
  return normalized
}

function warn(name, why, effective) {
  console.warn(`[config] ${name} ${why}，本次按 ${effective} 生效（检查一下服务器上的环境变量）`)
}
