/**
 * 只认麻将面板、没有摇杆模式的 MAME 街机 romset。
 *
 * 为什么要单独一张表：这类机台（IGS 的《龙虎争霸》《龙虎榜》《龙虎大满贯》《星运满贯》…）
 * 实机上就是一块麻将键盘 —— 14 张手牌各一颗键（A–N），再加吃 / 碰 / 杠 / 听 / 胡、
 * 押注、得分、比倍、大、小。MAME 只从**键盘**读这些输入（inpttype.ipp 的 IPT_MAHJONG_*
 * 默认都是 KEYCODE_*，没有任何手柄默认值），而本站给 EmulatorJS 的键盘默认走「键盘 → RetroPad」
 * 那一路：WASD 变摇杆、J/K 变按键 1/2 —— 进到牌局以后一张牌都打不出去，只剩投币和开始能用
 * （2026-11-19《龙虎争霸1》lhzb 实测）。
 *
 * 名单不是猜的：对着 MAME 0.289 的 src/mame/igs/{igs017,igs011,igs_m027,igs_m036}.cpp，
 * 把 INPUT_PORTS 沿 PORT_INCLUDE 展开，只留「麻将键无条件存在、也没有 IPT_JOYSTICK」的机台。
 * 靠 DIP 在摇杆 / 麻将之间切换的（sdmg2、mgcs、tarzan、lhzb3sjb…，IGS_MAHJONG_MATRIX_CONDITIONAL）
 * **故意不收**：它们出厂是摇杆档，按麻将面板接管反而会把能玩的游戏弄坏。
 *
 * 只对 mame-current 有意义（FBNeo 没有 IGS017 / IGS011 / IGS027 这几块板子）。
 */

/** @type {readonly string[]} */
export const MAME_MAHJONG_PANEL_SETS = Object.freeze([
  // igs017.cpp —— 龙虎争霸 / 龙虎争霸 2
  'lhzb', 'lhzba', 'lhzb2', 'lhzb2a', 'lhzb2b', 'lhzb2c',
  // igs011.cpp —— 龙虎榜系列、星运满贯
  'lhb', 'lhbv33c', 'dbc', 'ryukobou', 'lhb2', 'lhb3', 'lhb2cpgs', 'nkishusp', 'xymg', 'xymga',
  // igs_m027.cpp —— 龙虎争霸 III、龙虎大满贯
  'lhzb3', 'lhzb3106c5m', 'lhdmg', 'lhdmgp', 'lhdmgp200c3m',
])

const SETS = new Set(MAME_MAHJONG_PANEL_SETS)

/**
 * 对象 key / URL / 文件名 → romset 短名。`roms/arcade/lhzb.zip.8bg?romv=x` → `lhzb`
 * （历史 8BG 容器 `<原 key>.8bg` 与 `.zip` 两层后缀都要剥，和服务端 romsetNameFromKey 一致）
 * @param {string | null | undefined} key
 */
export function romsetFromKey(key) {
  const file = String(key ?? '').split(/[?#]/)[0].split('/').pop() ?? ''
  return file.replace(/\.8bg$/i, '').replace(/\.(zip|7z)$/i, '').trim().toLowerCase()
}

/** @param {string | null | undefined} romset 短名或带路径 / 扩展名的文件名 */
export function isMahjongPanelRomset(romset) {
  return SETS.has(romsetFromKey(romset))
}
