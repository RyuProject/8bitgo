/**
 * 会出现在公开 URL 里的平台与类型 id。
 *
 * 和 shared/site-languages.js 同一个道理：前端路由、构建期 sitemap、**后端实时
 * sitemap** 三处都要用同一份 id 和同一套「哪些页面该被收录」的规则。
 * 各抄一份的后果已经真实发生过一次 —— 平台页和类型页原来只在构建期烘进
 * sitemap-static.xml，之后后台加了上百款游戏，线上 sitemap 里却长期只剩
 * /platforms/flash 和 /platforms/html5，全部类型页一条都没有。
 *
 * ⚠️ 这个文件必须是 .js：server/ 里的代码不经过 TypeScript 编译，import 不了 .ts。
 */

/**
 * 目前对外开放的平台白名单。不在名单里的平台、以及它们的游戏，前台一律不展示
 * （后台 /admin 仍可看到并管理全部平台的游戏），所以也不能进 sitemap。
 *
 * 空数组表示「不限制，全部平台开放」—— 判断一律走 isPlatformEnabled，别直接
 * 对这个数组做 includes，否则清空成 [] 时会变成「全部平台都被禁」。
 *
 * 说明：gb 与 gbc 是**两个**平台（1989 的 Game Boy 和 1998 的 Game Boy Color），
 *       模拟器核心同为 gambatte，但分类、ROM 目录（roms/gb、roms/gbc）各自独立；
 *       Flash 与 HTML5 是两种不同的网页游戏：前者交给 Ruffle，后者直接加载网页入口。
 */
export const ENABLED_PLATFORM_IDS = Object.freeze([
  'nes', 'flash', 'html5', 'gba', 'gb', 'gbc', 'java', 'arcade', 'dos',
])

export function isPlatformEnabledId(id) {
  return ENABLED_PLATFORM_IDS.length === 0 || ENABLED_PLATFORM_IDS.includes(id)
}

/**
 * 有独立详情页的类型 id，顺序与前台一致。
 *
 * 这里只有 id —— 名称、图标、简介是展示层的事，留在 src/data/genres.ts。
 * 两边的 id 集合必须一致，`npm run test:indexnow` 里有一条用例专门盯这个：
 * 库里出现一个不在名单里的 genre_id（例如类型下线了但游戏还挂着），
 * 它的详情页在前台是 404，绝不能被写进 sitemap。
 */
export const GENRE_IDS = Object.freeze([
  'action', 'fighting', 'shooter', 'platformer', 'adventure', 'rpg',
  'strategy', 'racing', 'sports', 'music', 'puzzle', 'card',
])
