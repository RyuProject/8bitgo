/**
 * MAME 里默认按麻将面板收键的街机 romset。
 *
 * 为什么要单独一张表：这类机台（IGS 的《龙虎争霸》《龙虎榜》《龙虎大满贯》《星运满贯》…）
 * 实机上就是一块麻将键盘 —— 14 张手牌各一颗键（A–N），再加吃 / 碰 / 杠 / 听 / 胡、
 * 押注、得分、比倍、大、小。MAME 只从**键盘**读这些输入（inpttype.ipp 的 IPT_MAHJONG_*
 * 默认都是 KEYCODE_*，没有任何手柄默认值），而本站给 EmulatorJS 的键盘默认走「键盘 → RetroPad」
 * 那一路：WASD 变摇杆、J/K 变按键 1/2 —— 进到牌局以后一张牌都打不出去，只剩投币和开始能用
 * （2026-11-19《龙虎争霸1》lhzb 实测）。
 *
 * 名单按 MAME 0.289 的 src/mame/igs/{igs017,igs011,igs_m027,igs_m027_023vid,igs_m036}.cpp
 * 沿 INPUT_PORTS / PORT_INCLUDE 核过实际输入定义。通常只收麻将键无条件
 * 存在的机台；sdmg2 / mxsqy 是可切摇杆的例外：本站默认把 Controls 拨到 Mahjong，
 * 但玩家在引擎菜单保存过 Joystick 时保留普通街机输入，不装麻将键盘桥。两台机器的
 * MAME 出厂档不同，见 MAME_MAHJONG_PANEL_DIP_DEFAULTS。
 * mgcs、tarzan、lhzb3sjb 等其它可切换机型仍不收，不能只看游戏名或「麻将」字样就接管输入。
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
  // igs017.cpp —— 默认麻将面板；玩家改成摇杆档时播放器会退回普通街机输入
  'sdmg2',
  // igs_m027_023vid.cpp —— 明星三缺一；DIP 可切摇杆 / 麻将，本站默认选麻将
  'mxsqy', 'mxsqy102tw',
])

/** @type {Readonly<Record<string, 'Mahjong' | 'Joystick'>>} */
export const MAME_MAHJONG_PANEL_DIP_DEFAULTS = Object.freeze({
  sdmg2: 'Mahjong',
  mxsqy: 'Joystick',
  mxsqy102tw: 'Joystick',
})

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

/** @param {string | null | undefined} romset 短名或带路径 / 扩展名的文件名 */
export function isMahjongPanelDipRomset(romset) {
  return Object.prototype.hasOwnProperty.call(MAME_MAHJONG_PANEL_DIP_DEFAULTS, romsetFromKey(romset))
}

/** @param {string | null | undefined} romset 短名或带路径 / 扩展名的文件名 */
export function mahjongPanelDipDefault(romset) {
  const key = romsetFromKey(romset)
  return Object.prototype.hasOwnProperty.call(MAME_MAHJONG_PANEL_DIP_DEFAULTS, key)
    ? MAME_MAHJONG_PANEL_DIP_DEFAULTS[key]
    : null
}
