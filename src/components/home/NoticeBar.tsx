import type { VisibleSiteNotice } from '../../../shared/site-notice.js'
import { cx } from '@/lib/format'

/**
 * 首页那条公告（搜索框与横幅之间）。文案与语气都由后台决定。
 *
 * ## 两种语气
 *
 *   warn  黄色 —— **提示**：站点近期有波动、某个功能正在测试
 *   error 红色 —— **Sorry**：站长自己动了什么，导致玩不了 / 进不来
 *
 * ## 正文一律用 text-fg，颜色只放在边框和图标上
 *
 * 亮黄（#ffc800）在浅色底上做正文几乎读不出来，而这个横条是**要人真的读一遍**的东西：
 * 「站点正在维护」没被看清，玩家就会以为是游戏坏了，然后来报障。
 * 所以颜色只用来给语气定调（左边框 + 图标），字照旧用最高对比度那一档。
 *
 * ## 不给它加 aria-label
 *
 * 那需要给八种语言各加一条键，而这里的文本**本来就是后台写给所有访客看的**，
 * 读出来就是完整信息，不需要我们再加一句「公告：」。图标是装饰性的，对读屏隐藏。
 */
export function NoticeBar({ notice }: { notice?: VisibleSiteNotice | null }) {
  if (!notice) return null
  const warn = notice.level === 'warn'
  /*
    ⚠️ `mb-4` 长在组件里，不是父级给的间距：没有公告时整条不渲染，
    间距跟着一起消失 —— 父级包一层带 margin 的 div 的话，首页会永远多出
    一条谁也不需要看懂的 16px 空档。
  */
  return (
    <section className="container-x mb-4">
      <p
        role="status"
        className={cx(
          'flex items-start gap-2 rounded-card border px-4 py-2.5 text-sm leading-relaxed',
          warn ? 'border-coin/50 bg-coin/15' : 'border-live/50 bg-live/12',
        )}
      >
        <span aria-hidden className="shrink-0 select-none">
          {warn ? '⚠️' : '🙏'}
        </span>
        <span className="min-w-0 break-words text-fg">{notice.text}</span>
      </p>
    </section>
  )
}
