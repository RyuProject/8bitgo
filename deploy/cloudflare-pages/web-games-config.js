/**
 * 六个独立 Cloudflare Pages 项目的唯一配置来源。
 *
 * 入口仍保留 `/web/<游戏>/`，不是为了迁就 Pages，而是这些上游产物内部有大量
 * 根绝对路径。保留路径可以避免重写压缩后的脚本，也让源站与 Pages 能平滑回退。
 */
export const WEB_GAME_PAGES = Object.freeze({
  pvz: Object.freeze({
    project: '8bitgo-pvz',
    domain: 'pvz.8bitgo.com',
    sourceDir: 'PvZ',
    entry: '/web/PvZ/cn/',
    title: 'Plants vs. Zombies',
    runtime: '',
    isolated: false,
    html: [
      ['index.html', ''],
      ['cn/index.html', 'body.game-mode canvas#canvas'],
      ['en/index.html', 'body.game-mode canvas#canvas'],
    ],
  }),
  diablo: Object.freeze({
    project: '8bitgo-diablo',
    domain: 'diablo.8bitgo.com',
    sourceDir: 'diablo',
    entry: '/web/diablo/',
    title: 'Diablo',
    runtime: 'diablo',
    isolated: false,
    html: [['index.html', '#root > *']],
  }),
  minecraft: Object.freeze({
    project: '8bitgo-minecraft',
    domain: 'minecraft.8bitgo.com',
    sourceDir: 'Minecraft',
    entry: '/web/Minecraft/',
    title: 'Minecraft · Eaglercraft 1.8',
    runtime: '',
    isolated: false,
    html: [['eaglercraft/index.html', 'body#game_frame > *']],
  }),
  celeste: Object.freeze({
    project: '8bitgo-celeste',
    domain: 'celeste.8bitgo.com',
    sourceDir: 'celeste',
    entry: '/web/celeste/',
    title: 'Celeste · Webleste',
    runtime: 'celeste',
    isolated: true,
    html: [['index.html', '#app > *']],
  }),
  terraria: Object.freeze({
    project: '8bitgo-terraria',
    domain: 'terraria.8bitgo.com',
    sourceDir: 'terraria',
    entry: '/web/terraria/',
    title: 'Terraria',
    runtime: 'terraria',
    isolated: true,
    html: [['index.html', '#app > *']],
  }),
})

export function webGamePage(name) {
  return Object.prototype.hasOwnProperty.call(WEB_GAME_PAGES, name)
    ? WEB_GAME_PAGES[name]
    : undefined
}
