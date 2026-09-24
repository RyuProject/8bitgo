/**
 * 随主站发布的 HTML5 / WebAssembly 游戏入口。
 *
 * 这两款不是 R2 里的单文件 ROM，而是 `public/web/<name>/` 下的一整套网站。
 * 把入口集中在 shared/，前端的 ROM 解析、隔离页登记和服务端测试才能认同一份事实；
 * 否则后台忘记手填 ROM 地址时，明明文件已经部署，详情页仍会说“没有在线版本”。
 */
export const BUILTIN_WEB_GAMES = Object.freeze({
  diablo: Object.freeze({
    entry: '/web/diablo',
    title: 'Diablo',
    isolated: false,
  }),
  terraria: Object.freeze({
    entry: '/web/terraria',
    title: 'Terraria',
    // .NET WASM 的 pthread 依赖 SharedArrayBuffer，必须从带 COOP/COEP 的顶层页启动。
    isolated: true,
  }),
  celeste: Object.freeze({
    entry: '/web/celeste',
    title: 'Celeste',
    // 与 terraria 同架构（.NET WASM + FNA + pthread 渲染），同样必须跨源隔离。
    isolated: true,
  }),
  minecraft: Object.freeze({
    entry: '/web/Minecraft',
    title: 'Minecraft (Eaglercraft 1.8)',
    // EaglercraftX 1.8 常规 JS 客户端是单线程，不依赖 SharedArrayBuffer，
    // 不需要 COOP/COEP 隔离壳；直接 /web/Minecraft 嵌入，同 PvZ / diablo。
    isolated: false,
  }),
})

export function builtinWebGameFor(slug) {
  if (!slug) return undefined
  return Object.prototype.hasOwnProperty.call(BUILTIN_WEB_GAMES, slug)
    ? BUILTIN_WEB_GAMES[slug]
    : undefined
}
