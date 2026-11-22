/**
 * 少数 Flash 游戏在初始化时间轴里会做很重的同步工作；只给逐款验证过的游戏放宽脚本预算，
 * 避免把全站默认值调高后，让真正死循环的其它 SWF 长时间占住浏览器主线程。
 */
export function ruffleMaxExecutionDuration(gameSlug?: string): number | undefined {
  if (gameSlug === 'grindcraft') return 60
  return undefined
}
