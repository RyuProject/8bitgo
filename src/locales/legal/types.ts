/**
 * 法律文本（服务条款 / 隐私政策）的结构。
 *
 * 为什么单独一个 legal/ 目录、而不是像别的文案一样写在 zh-Hans.ts 里：
 * 这两份东西加起来两千多行，塞进那个已经 1300 行的文件会让所有人都不想打开它。
 * src/locales/about.ts 已经开了「长文案抽出去」的先例，这里把三种语言都抽出来。
 *
 * ⚠️ Translation 是从 zh-Hans.ts 推导的（见 locales/index.ts），所以这里给了
 * **显式接口**而不是让 TS 去推：推出来的会是一堆字面量类型和定长元组，
 * 别的语言想少写一节都会报错。写成接口之后各语言的 sections 条数可以不同 ——
 * 键名一致就够了。
 */

/** 一节：标题由组件渲染成挂了 id 的 h2（目录锚点要用），body 走 renderMarkdown */
export interface LegalSection {
  /** 锚点 id，只用 [a-z0-9-]，全文唯一 —— scripts/test-legal-pages.mjs 会查重 */
  id: string
  title: string
  /**
   * 正文，极简 Markdown（语法见 src/lib/markdown.tsx）。
   * 只支持 ## / ###、- 列表、1. 列表、> 引用、**粗体**、`代码`、[文字](链接)。
   * **没有表格**，所以「保存期限」那种对照关系一律写成列表。
   * body 里的小标题从 ### 起 —— ## 会和组件渲染的节标题撞层级。
   */
  body: string
}

export interface LegalDocCopy {
  seoTitle: string
  seoDescription: string
  h1: string
  /** 「最后更新」这几个字 */
  updatedLabel: string
  /** ISO 日期 YYYY-MM-DD。改内容就要改它 —— 测试会校验是合法日期且不在未来 */
  updated: string
  /** 开头的导语，也走 renderMarkdown */
  intro: string
  /** 目录标题 */
  tocLabel: string
  sections: LegalSection[]
}
