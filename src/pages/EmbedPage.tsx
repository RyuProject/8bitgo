/**
 * `/embed/<slug>` —— 给第三方页面（论坛、博客、自建站）嵌进 iframe 的精简游玩页。
 *
 * ── 为什么要单开一条路由 ─────────────────────────────────────
 * 详情页那一套（侧边栏、顶栏、评论、相关推荐、面包屑）在一个 640x480 的 iframe 里
 * 全是负担。而 immersive 只是客户端状态、不进 URL，别人贴不出来。所以嵌入必须有一个
 * **自己的地址**，而且这条路由要挂在 Layout 之外 —— 挂里面就还是带着整个外壳。
 *
 * ── 第三方 iframe 里必然拿不到的东西（不是 bug，是浏览器的规则）──
 * 1. **SharedArrayBuffer**：`crossOriginIsolated` 要求整条祖先链隔离，顶层是别人的
 *    论坛，不可能发 COOP/COEP。所以 shared/isolated-embeds.js 登记表里那批游戏
 *    （reVC 的 GTA 之类）在这里只能显示一个跳转入口，硬跑必然黑屏。
 * 2. **存档与登录态**：跨站 iframe 的存储被浏览器分区，Safari 直接屏蔽第三方存储。
 *    IndexedDB 存档、cookie 登录态、G 币在嵌入里基本都指望不上 —— 分享面板里
 *    会如实告知（见 components/game/ShareDialog.tsx），这一页也不假装能存。
 * 3. **联机**：信令要登录态，同上。所以这里把 maxPlayers 压成 1，让播放器不要画出
 *    点了没反应的多人入口。
 *
 * ── 置底品牌条 ───────────────────────────────────────────────
 * 一行很矮的条：游戏名 + 「在 8BitGo 打开」。它同时承担三件事 ——
 * 回流入口、版权免责声明在第三方页面上唯一的落点、以及让玩家知道自己在玩谁家的东西。
 * 链接必须 target="_blank"，否则会在 iframe 里套娃打开整站。
 */
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { usePageData, type GameData } from '@/services/pageData'
import { platformMap } from '@/data/platforms'
import { isPlatformEnabled } from '@/config/platforms'
import { langPrefix, type RomLang } from '@/config/languages'
import { romLangsOf, romUrlForKey, useRomUrl } from '@/services/roms'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { gameTitle } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator'
import { GameCover } from '@/components/game/GameCover'
import { GameAgeGuard } from '@/components/game/AgeGate'
import { SITE_NAME } from '@/components/layout/Logo'
import { isolatedEmbedFor } from '../../shared/isolated-embeds.js'

/** 嵌入页里的一句话提示：出不了游戏时至少让人知道为什么，别只给一块黑 */
function EmbedNotice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-black px-6 text-center">
      <div className="max-w-sm">
        <p className="text-sm leading-6 text-white/70">{children}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  )
}

export function EmbedPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const t = useT()
  const lang = useLang()
  const state = usePageData<GameData>(`/games/${encodeURIComponent(slug)}`, undefined, 'game')
  const game = state.data?.game ?? undefined
  const platform = game ? platformMap[game.platform] : undefined
  const biosUrl = usePlatformBiosUrl(platform?.id)
  const [romLang, setRomLang] = useState<RomLang | null>(null)
  const rom = useRomUrl(game, romLang)
  const isolated = isolatedEmbedFor(slug)

  // 薄壳页不进索引 —— 详情页才是这款游戏的正主
  useSeo({ title: game ? gameTitle(game, lang) : slug, noindex: true })

  /**
   * 回主站的地址要带语言前缀，而且必须是**整站的绝对路径**：
   * 这一页在别人的域名里，router 的 basename 帮不上忙，用 <Link> 还会在 iframe 里套娃。
   */
  const homeUrl = `${langPrefix(lang)}/games/${encodeURIComponent(slug)}`
  const title = game ? gameTitle(game, lang) : slug

  let body: React.ReactNode
  if (state.status === 'error') {
    body = <EmbedNotice>{state.error}</EmbedNotice>
  } else if (state.status === 'loading') {
    body = <div className="h-full animate-pulse bg-black" />
  } else if (!game || !platform || !isPlatformEnabled(platform.id)) {
    body = <EmbedNotice>{t.game.notFoundMsg}</EmbedNotice>
  } else if (isolated) {
    // SAB 游戏：顶层不是我们，隔离拿不到 —— 只给入口，不假装能跑
    body = (
      <EmbedNotice
        action={
          <a
            href={homeUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex h-10 items-center rounded-full bg-brand px-5 text-sm font-bold text-white transition hover:bg-brand-hover"
          >
            {t.embed.openOnSite}
          </a>
        }
      >
        {t.embed.isolatedNotice}
      </EmbedNotice>
    )
  } else {
    body = (
      <GameAgeGuard
        slug={game.slug}
        markedAdult={Boolean(game.adult)}
        backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
      >
        <EmulatorPlayer
          key={game.slug}
          platform={platform}
          gameName={game.title}
          gameSlug={game.slug}
          /* 跨站 iframe 里联机指望不上（信令要登录态），压成 1 让播放器别画多人入口 */
          maxPlayers={1}
          icon={game.icon}
          core={game.core}
          genres={game.genres}
          arcadeRomData={game.arcadeRomData}
          dosExecutable={game.dosExecutable}
          dosBackend={game.dosBackend}
          dosSystemUrl={game.dosSystem ? romUrlForKey(game.dosSystem) : undefined}
          dosWindowsVersion={game.dosWindowsVersion}
          dosLaunchDelay={game.dosLaunchDelay}
          dosboxConfig={game.dosboxConfig}
          dosSaveHint={game.dosSaveHint}
          biosUrl={biosUrl || undefined}
          romUrl={rom.status === 'found' ? rom.url : undefined}
          romChecking={rom.status === 'checking'}
          romUnavailable={rom.status === 'missing'}
          onRetryRom={rom.retry}
          romLangs={game ? romLangsOf(game) : []}
          romLang={rom.lang}
          onRomLangChange={setRomLang}
          backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
        />
      </GameAgeGuard>
    )
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-black">
      <div className="min-h-0 flex-1">{body}</div>
      {/* 置底品牌条：回流入口 + 版权声明在第三方页面上唯一的落点 */}
      <footer className="flex flex-none items-center justify-between gap-3 border-t border-white/10 bg-[#111118] px-3 py-1.5 text-[11px] text-white/50">
        <span className="min-w-0 truncate">{title}</span>
        <a
          href={homeUrl}
          target="_blank"
          rel="noopener"
          className="flex-none whitespace-nowrap font-semibold text-white/80 underline-offset-2 transition hover:text-white hover:underline"
        >
          {fmt(t.embed.poweredBy, { site: SITE_NAME })}
        </a>
      </footer>
    </div>
  )
}
