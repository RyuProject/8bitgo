/**
 * isolated-embeds.js 的类型声明。
 *
 * 本体必须是 .js（server/ 不过 TypeScript 编译，import 不了 .ts），
 * 所以按 site-languages / site-taxonomy / dosbox-config 的同一套做法手写一份给前端用。
 * 改了 isolated-embeds.js 的导出，记得同步这里。
 */

export interface IsolatedEmbed {
  /**
   * iframe 的 src。两种写法：
   *   - 本站同源的绝对路径，以 / 开头，例如 '/embed/vc/'
   *   - 完整的外站 URL，例如 'https://vc.8bitgo.com/'（那边必须自己发 COEP: require-corp）
   */
  embed: string
  /** 外壳页 <title> 用的名字；不填就用 slug */
  title?: string
}

export const ISOLATED_EMBEDS: Readonly<Record<string, IsolatedEmbed>>

export function isolatedEmbedFor(slug: string | undefined): IsolatedEmbed | undefined
