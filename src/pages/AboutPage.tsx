import { Button, buttonClasses } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'
import { CONTACT_EMAIL } from '@/components/layout/Logo'

const STORY_ICONS = ['📦', '🔎', '▶️']
const VALUE_ICONS = ['⚡', '🧩', '🛠️']

/** 关于页：用个人口吻讲清起点、转折和现在，不把独立项目包装成虚构的大团队。 */
export function AboutPage() {
  const t = useT()
  const copy = t.aboutPage

  useSeo({
    title: copy.seoTitle,
    description: copy.seoDescription,
    canonicalPath: '/about',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        name: copy.seoTitle,
        description: copy.seoDescription,
        mainEntity: {
          '@type': 'WebSite',
          name: '8BitGo',
          url: 'https://8bitgo.com',
        },
      },
    ],
  })

  return (
    <div className="overflow-hidden pb-16 sm:pb-24">
      <section className="relative border-b border-line bg-surface">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          aria-hidden
          style={{
            backgroundImage:
              'radial-gradient(circle at 18% 22%, var(--color-brand-soft) 0, transparent 28%), radial-gradient(circle at 82% 70%, var(--color-coin-soft) 0, transparent 24%)',
          }}
        />
        <div className="container-x relative grid min-h-[34rem] items-center gap-10 py-16 lg:grid-cols-12 lg:py-20">
          <div className="lg:col-span-7">
            <p className="text-pixel text-[11px] tracking-wider text-brand-hover">{copy.heroEyebrow}</p>
            <h1 className="mt-5 max-w-4xl text-4xl font-black leading-[1.08] tracking-tight sm:text-6xl xl:text-7xl">
              {copy.heroTitleLead}
              <span className="block text-brand">{copy.heroTitleAccent}</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-muted sm:text-lg">{copy.heroBody}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button to="/games" size="lg">{copy.playCta} →</Button>
              <Button to="/about#story" variant="secondary" size="lg">{copy.storyCta}</Button>
            </div>
          </div>
          <div className="lg:col-span-5">
            <PixelConsole />
          </div>
        </div>
      </section>

      <section id="story" className="container-x scroll-mt-20 py-16 sm:py-24">
        <div className="max-w-3xl">
          <p className="text-pixel text-[10px] tracking-wider text-coin">{copy.storyEyebrow}</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-5xl">{copy.storyTitle}</h2>
          <p className="mt-5 text-base leading-8 text-muted sm:text-lg">{copy.storyBody}</p>
        </div>

        <ol className="mt-10 grid gap-4 lg:grid-cols-3">
          {copy.steps.map((step, index) => (
            <li key={step.title} className="relative rounded-3xl border-2 border-line bg-surface p-6 shadow-[0_5px_0_0_var(--color-line)]">
              <div className="flex items-center justify-between">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-2xl" aria-hidden>
                  {STORY_ICONS[index]}
                </span>
                <span className="text-pixel text-[10px] text-dim">0{index + 1}</span>
              </div>
              <h3 className="mt-6 text-xl font-extrabold">{step.title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="container-x">
        <div className="overflow-hidden rounded-[2rem] bg-fg px-6 py-10 text-bg sm:px-10 sm:py-14 lg:px-14">
          <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <p className="text-pixel text-[10px] tracking-wider text-coin">{copy.missionEyebrow}</p>
              <h2 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">{copy.missionTitle}</h2>
            </div>
            <p className="text-sm leading-7 opacity-70 sm:text-base lg:col-span-5">{copy.missionBody}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {copy.values.map((value, index) => (
            <article key={value.title} className="rounded-3xl border border-line bg-surface p-6">
              <span className="text-2xl" aria-hidden>{VALUE_ICONS[index]}</span>
              <h3 className="mt-4 font-extrabold">{value.title}</h3>
              <p className="mt-2 text-sm leading-7 text-muted">{value.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container-x pt-16 sm:pt-24">
        <div className="grid gap-5 lg:grid-cols-12">
          <article className="rounded-[2rem] border-2 border-brand/20 bg-brand-soft p-7 sm:p-10 lg:col-span-8">
            <p className="text-pixel text-[10px] tracking-wider text-brand-hover">{copy.creatorEyebrow}</p>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{copy.creatorTitle}</h2>
            <p className="mt-4 max-w-2xl leading-8 text-muted">{copy.creatorBody}</p>
            <h3 className="mt-8 text-lg font-extrabold">{copy.contactTitle}</h3>
            <p className="mt-2 text-sm leading-7 text-muted">{copy.contactBody}</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <a href={`mailto:${CONTACT_EMAIL}`} className={buttonClasses('primary', 'md')}>
                ✉️ {copy.emailCta}
              </a>
              <a
                href="https://x.com/sohash_moledao"
                target="_blank"
                rel="noreferrer"
                className={buttonClasses('secondary', 'md')}
              >
                𝕏 {copy.xCta}
              </a>
            </div>
          </article>

          <aside className="rounded-[2rem] border border-line bg-surface p-7 sm:p-8 lg:col-span-4">
            <span className="text-3xl" aria-hidden>🛡️</span>
            <h2 className="mt-5 text-xl font-extrabold">{copy.legalTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-muted">{copy.legalBody}</p>
          </aside>
        </div>
      </section>
    </div>
  )
}

/** 纯 CSS 的掌机插画，不增加图片请求，也能跟随浅色 / 深色主题。 */
function PixelConsole() {
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <span className="absolute -left-3 top-10 rounded-full border border-line bg-surface px-3 py-1 text-xs font-bold shadow-lg">NES</span>
      <span className="absolute -right-2 bottom-16 rounded-full border border-line bg-surface px-3 py-1 text-xs font-bold shadow-lg">GBA</span>
      <div className="rotate-2 rounded-[2.5rem] border-2 border-brand-shadow bg-brand p-5 shadow-[0_12px_0_0_var(--color-brand-shadow)]">
        <div className="rounded-[1.8rem] bg-[#20242d] p-5">
          <div className="scanlines grid aspect-[4/3] place-items-center overflow-hidden rounded-xl border-4 border-[#3b414d] bg-[#d8f4b0] text-[#23320f]">
            <div className="text-center">
              <p className="text-pixel text-3xl leading-relaxed sm:text-4xl">8BIT</p>
              <p className="text-pixel text-2xl text-brand-shadow sm:text-3xl">GO!</p>
              <p className="mt-4 animate-pulse font-mono text-xs font-bold">PRESS START</p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between px-5 pb-2 pt-7">
          <div className="relative h-20 w-20">
            <span className="absolute left-6 top-0 h-20 w-8 rounded-md bg-[#263038]" />
            <span className="absolute left-0 top-6 h-8 w-20 rounded-md bg-[#263038]" />
          </div>
          <div className="flex rotate-[-18deg] gap-4">
            <span className="h-10 w-10 rounded-full bg-live shadow-[0_4px_0_0_#a72c35]" />
            <span className="h-10 w-10 rounded-full bg-live shadow-[0_4px_0_0_#a72c35]" />
          </div>
        </div>
      </div>
    </div>
  )
}
