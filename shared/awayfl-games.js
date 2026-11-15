/**
 * AwayFL 在无 WebAssembly 浏览器里可自动接管的 Flash 游戏名单。
 *
 * Shumway 的旧验证只说明 Shumway 的行为，不能证明 AwayFL 能启动或正确处理输入；因此首次接入时名单为空。
 * 候选项需要在 AwayFL 上单独完成标题 → 菜单 → 第一关 → 按键操作验证，并记录目标浏览器与设备后才可放行。
 */
export const AWAYFL_TEST_RESULTS = Object.freeze([
  Object.freeze({ slug: 'fireboy-and-watergirl', status: 'untested', note: 'Shumway 原型曾可玩；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'gold-miner', status: 'untested', note: 'Shumway 原型在开始游戏后失败；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'raiden-x', status: 'untested', note: 'Shumway 原型在开始游戏后失败；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'boxhead-2play', status: 'untested', note: 'Shumway 原型黑屏；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'infectonator', status: 'untested', note: 'Shumway 原型黑屏；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'kingdom-rush', status: 'untested', note: 'Shumway 原型黑屏；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'fireboy-watergirl-2-in-the-light-temple', status: 'untested', note: '同系列候选；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'fireboy-watergirl-3-in-the-ice-temple', status: 'untested', note: '同系列候选；AwayFL 尚未验证。' }),
  Object.freeze({ slug: 'fireboy-watergirl-4-in-the-crystal-temple', status: 'untested', note: '同系列候选；AwayFL 尚未验证。' }),
])

export const AWAYFL_TEST_CANDIDATES = Object.freeze(
  AWAYFL_TEST_RESULTS.filter((game) => game.status === 'untested').map((game) => game.slug),
)
export const AWAYFL_VERIFIED_GAMES = Object.freeze(
  AWAYFL_TEST_RESULTS.filter((game) => game.status === 'verified').map((game) => game.slug),
)

/** @param {string | undefined | null} slug */
export function awayflVerifiedGame(slug) {
  const base = String(slug || '').split('~')[0]
  return AWAYFL_VERIFIED_GAMES.includes(base)
}
