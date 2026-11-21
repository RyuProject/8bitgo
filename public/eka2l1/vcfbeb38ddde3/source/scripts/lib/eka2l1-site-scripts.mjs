/**
 * EKA2L1-WEB 运行时里随附的本站脚本：完整构建（build-eka2l1-web.mjs）、只换前端的重新打包
 * （repackage-eka2l1-web.mjs）和发布检查（check-eka2l1-web.mjs）共用这一份清单。
 *
 * 每个脚本都要：发布一份到 js/、在 index.html 的 </body> 前加载、作为对应源码再放一份到 source/scripts/，
 * 并在 SOURCE.md 里写明它做了什么（AGPL-3.0 要求随包提供修改说明）。
 */
export const EKA2L1_SITE_SCRIPTS = Object.freeze([
  {
    source: 'scripts/eka2l1-default-firmware.js',
    published: 'js/8bitgo-default-firmware.js',
    sourceCopy: 'source/scripts/eka2l1-default-firmware.js',
    doc: '8BitGo 还附带 `source/scripts/eka2l1-default-firmware.js`：从本站游戏页进入时，若当前浏览器尚无设备则先安装后台配置的 N-Gage QD ROM，再把选中的游戏包导入本机；`.n-gage` 包放入 E:\\n-gage，需在 Games 应用中完成安装。已有设备不会被默认固件覆盖；导入内容只保存在玩家自己的浏览器存储中。',
  },
  {
    source: 'scripts/eka2l1-ngage-card.js',
    published: 'js/8bitgo-ngage-card.js',
    sourceCopy: 'source/scripts/eka2l1-ngage-card.js',
    doc: '8BitGo 还附带 `source/scripts/eka2l1-ngage-card.js`：在「安装」菜单和设备设置里增加「导入 N-Gage 卡带转储（.zip）」。它按上游桌面版 `install_ngage_game_card` 的规则在浏览器里解开第一代 N-Gage 游戏卡带的目录转储，逐个核对 CRC-32 后复制到 E 盘（同一 UID 的两个版本只注册能加载的那个，System/Libs 另复制进游戏目录），再刷新页面让应用列表重新扫描。卡带内容只保存在玩家自己的浏览器存储中。',
  },
])

/** 在 </body> 前补上还没加载的本站脚本，按清单顺序 */
export function injectSiteScripts(html) {
  let out = html
  for (const script of EKA2L1_SITE_SCRIPTS) {
    if (out.includes(script.published)) continue
    if (!out.includes('</body>')) throw new Error('index.html 缺少 </body>，无法加载本站脚本')
    out = out.replace('</body>', `<script src="${script.published}"></script>\n</body>`)
  }
  return out
}
