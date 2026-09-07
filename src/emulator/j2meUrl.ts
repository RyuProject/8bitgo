/**
 * J2ME（freej2me-web）那几条 URL 规则，单独成文件是为了能被单测直接 import ——
 * adapters/j2me.ts 里全是 DOM 和 iframe，测试没法碰。
 *
 * 回归：`npm run test:j2me`。
 */

/**
 * 从播放地址里取出文件名。
 *
 * freej2me-web 的加载路径是 `cheerpjWebRoot + "/jar/" + 名字` **硬拼**出来的
 * （web/src/main.js:328-334），所以我们只能给它一个纯文件名，不能给完整 URL、
 * 不能给 blob:、也不能带查询串 —— 带上 `?romv=…` 的话拼出来是
 * `/jar/snake.jar%3Fromv%3D…`，永远 404。
 *
 * ⚠️ 代价要知道：正式 ROM 地址上那个 `?romv=<etag>` 缓存戳**在这里被丢掉了**。
 * 所以「重传了 ROM 但玩家还拿到旧包」这件事在 J2ME 上不能靠 URL 解决，
 * 只能靠代理那一层做条件请求（见 server/src/j2me.js 的 j2meJarProxy）。
 */
export function j2meFileName(url: string): string {
  const clean = String(url).split(/[?#]/)[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/**
 * 拼出 run.html 的地址。`.zip` 走 app 模式（预打包存档包），其余按 jar 模式。
 *
 * 两个模式的取法不一样（同上那段源码）：
 *   ?jar=<文件名>   → <J2ME_PATH>jar/<文件名>
 *   ?app=<app_id>   → <J2ME_PATH>apps/<app_id>.zip     ← 所以要把 .zip 后缀去掉
 */
export function buildJ2meUrl(base: string, name: string): string {
  const runHtml = `${base}run.html`
  if (name.toLowerCase().endsWith('.zip')) {
    return `${runHtml}?app=${encodeURIComponent(name.replace(/\.zip$/i, ''))}`
  }
  return `${runHtml}?jar=${encodeURIComponent(name)}`
}

/**
 * J2ME 资源是不是**跨源**。挂载时算一次。
 *
 * ── 为什么必须这么算，不能靠「读 contentDocument 会不会抛」──────────
 * 原来的就绪判定是这样的：试着读 `iframe.contentDocument`，读到了就轮询
 * `#display` 有没有从 `display:none` 变可见；`catch` 到异常就认为「跨源、读不到」，
 * 退回「iframe load 即就绪」的老行为。
 *
 * **那个 catch 永远不会命中。** 跨源时 `iframe.contentDocument` 按规范
 * **返回 null，不抛异常**。于是那一支走的是「doc 还没建好，下一轮再看」——
 * 判定函数永远返回 false，轮询永远等不到画面，**120 秒后一律报「起不来」**。
 * 也就是说：把 `VITE_J2ME_PATH` 指到别的域名，J2ME 就是必然超时失败，
 * 而代码里那条「跨源就退回老行为」的退路是彻底的死代码（2026-09-07 查出）。
 *
 * 现在改成从**地址**上判断，确定、可测、不依赖异常：
 * 把 base 按当前页面地址解析出来，比 origin。
 *
 * @param base       VITE_J2ME_PATH 的值（可能是 `/j2me/`、`//cdn/j2me/`、
 *                   或 `https://cdn.example.com/j2me/`）
 * @param pageOrigin 当前页面的 origin（`location.origin`）
 */
export function isCrossOriginBase(base: string, pageOrigin: string): boolean {
  try {
    return new URL(String(base), pageOrigin).origin !== pageOrigin
  } catch {
    /*
      解析不出来（pageOrigin 是 'null' 的沙箱文档、base 是畸形地址）一律当**跨源**。
      往这边偏是刻意的：跨源那一支只是「早一点撤遮罩」，最坏是玩家多看几秒
      CheerpJ 自己的加载框；判成同源则会一路轮询到 120 秒然后报错，
      把一个本来能玩的局判死。宁可放宽。
    */
    return true
  }
}
