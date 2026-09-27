/**
 * 随主站发布的 HTML5 / WebAssembly 游戏入口。
 *
 * 这些不是 R2 里的单文件 ROM，而是各自独立部署的一整套网站。
 * 把入口集中在 shared/，前端的 ROM 解析、隔离页登记和服务端测试才能认同一份事实；
 * 每款游戏使用各自的 Pages 自定义域名；项目自带的 pages.dev 域只作故障排查与回退。
 */
export const BUILTIN_WEB_GAMES = Object.freeze({
  diablo: Object.freeze({
    entry: 'https://diablo.8bitgo.com/web/diablo/',
    title: 'Diablo',
    isolated: false,
  }),
  terraria: Object.freeze({
    entry: 'https://terraria.8bitgo.com/web/terraria/',
    title: 'Terraria',
    // .NET WASM 的 pthread 依赖 SharedArrayBuffer，必须从带 COOP/COEP 的顶层页启动。
    isolated: true,
  }),
  celeste: Object.freeze({
    entry: 'https://celeste.8bitgo.com/web/celeste/',
    title: 'Celeste',
    // 与 terraria 同架构（.NET WASM + FNA + pthread 渲染），同样必须跨源隔离。
    isolated: true,
  }),
  minecraft: Object.freeze({
    entry: 'https://minecraft.8bitgo.com/web/Minecraft/',
    title: 'Minecraft (Eaglercraft 1.8)',
    // EaglercraftX 1.8 常规 JS 客户端是单线程，不依赖 SharedArrayBuffer，
    // 不需要 COOP/COEP 隔离壳；直接 /web/Minecraft 嵌入，同 PvZ / diablo。
    isolated: false,
  }),
  pvz2: Object.freeze({
    entry: '/web/PvZ2',
    title: 'PvZ2 Gardendless',
    // Cocos Creator 导出，单线程 WebGL，不依赖 SharedArrayBuffer / pthread，
    // 不需要 COOP/COEP 隔离壳；整目录自托管到 /web/PvZ2（见 scripts/fetch-pvzge.mjs），
    // 站内用 <base href="/web/PvZ2/"> 解析相对资源（同 PvZ / diablo / minecraft）。
    isolated: false,
  }),
  'gamblers-table': Object.freeze({
    entry: '/web/gamblers-table/',
    title: 'Gamblers Table',
    // Godot 4 Web 导出，单线程（GODOT_THREADS_ENABLED=false），不依赖 SharedArrayBuffer，
    // 不需要 COOP/COEP 隔离壳；整目录自托管到 /web/gamblers-table/（同 diablo / minecraft / pvz2）。
    // 注：Godot 版未实现 8BitGo 存档桥，本作暂无 JSON 云存档（仅本地进度）。
    isolated: false,
  }),
  'plants-vs-zombies': Object.freeze({
    entry: 'https://pvz.8bitgo.com/web/PvZ/cn/',
    title: 'Plants vs. Zombies',
    // PvZ Portable 是单线程 WASM；独立项目仍可在普通播放器 iframe 内运行和交换云存档。
    isolated: false,
  }),
})

export function builtinWebGameFor(slug) {
  if (!slug) return undefined
  return Object.prototype.hasOwnProperty.call(BUILTIN_WEB_GAMES, slug)
    ? BUILTIN_WEB_GAMES[slug]
    : undefined
}
