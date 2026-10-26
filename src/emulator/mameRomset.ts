/**
 * MAME（mame-current）和 FBNeo 一样「文件名即身份」：核心按 romset 文件名挑驱动。
 * 但上传时文件名常常不标准——明星三缺一（IGS027A 的 mxsqy102tw 驱动）被存成了 mxsqy.zip，
 * MAME 按名字找 `mxsqy` 驱动压根不存在，于是落到主菜单。这里在交给引擎前把内层文件名
 * 纠正成 MAME 认得的 romset 名（只改 EJS_gameName，即引擎写进虚拟文件系统的文件名），
 * 不影响 RomData（mame-current 不认 FBNeo .dat，能力边界见 arcadeCore.ts）。
 * 键是上传文件名剥扩展名后的短名，值是 MAME 真实 romset 短名；以后再有这类错名游戏往里加即可。
 */
export const MAME_ROMSET_ALIASES: Record<string, string> = {
  mxsqy: 'mxsqy102tw',
}
/** MAME 机器短名的硬约束：小写字母、数字、下划线，最长 16 个字符。不满足的名字一定找不到驱动 */
const MAME_SHORTNAME = /^[a-z0-9_]{1,16}$/
/**
 * 把内容文件名纠正成 MAME 认得的 romset 名。
 *
 * 除了别名表，还要兜住**一定不可能是驱动名**的上传名（2026-10-26《铁拳》）：对象存储里是
 * `tekken-root-flat.zip`，MAME 找名叫 `tekken-root-flat` 的机器 —— 带连字符的短名根本不存在，
 * retro_load_game 失败，玩家看到的是 RetroArch 的「Quick Menu / No Items」，核心一个字的
 * 报错都不打（stderr 为空，FATAL_PHRASES 无从命中）。同一个包改名 `tekken.zip` 实测 60fps 正常跑。
 *
 * 规则只在名字**不合法**时介入：取第一段合法片段（`tekken-root-flat` → `tekken`、
 * `Tekken (World).zip` → `tekken`）。合法的名字原样保留 —— 克隆集 `tekkenac` 之类不能被「纠正」。
 * 文件系统区分大小写而核心按小写短名找 rompath，所以大写也一并转小写。
 */
export function canonicalMameRomset(name: string): string {
  const short = name.replace(/\.[^.]*$/, '')
  const ext = name.slice(short.length) || '.zip'
  const canonical = MAME_ROMSET_ALIASES[short] ?? MAME_ROMSET_ALIASES[short.toLowerCase()]
  if (canonical) return `${canonical}.zip`
  if (MAME_SHORTNAME.test(short)) return name
  const lower = short.toLowerCase()
  if (MAME_SHORTNAME.test(lower)) return `${lower}${ext.toLowerCase()}`
  const head = lower.split(/[^a-z0-9_]+/).find(Boolean)
  return head && MAME_SHORTNAME.test(head) ? `${head}${ext.toLowerCase()}` : name
}
