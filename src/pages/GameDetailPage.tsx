import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { InternalLink } from '@/components/ui/InternalLink'
import { recordRecent, toggleFavorite, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import type { RomSlotLang } from '@/config/languages'
import { romLanguageLabel } from '@/config/languages'
import { dosExecutableForRom, dosSockdriveForRom, dosStartupCommandsForRom, romLangsOf, romUrlForKey, useRomUrl } from '@/services/roms'
import { parseDosExtras, type DosExtraSource } from '@/lib/dosExtras'
import { extOf, resolveRuntime, runtimesFor, type Runtime } from '@/emulator'
import { p2pPlayable } from '@/emulator'
import { visitCountsAsPlayed } from '@/emulator/playedScope'
import { requestMatch } from '@/services/matchRequest'
import { requestIpxHost } from '@/services/ipxRequest'
import { usePageData, type GameData } from '@/services/pageData'
import { platformMap, EXPERIMENTAL_PLATFORMS } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { formatCount, formatPlayers } from '@/lib/format'
import { usePlatformBiosUrl, usePsxBiosUrl } from '@/services/platformBios'
import { detectPsxBiosRegion } from '@/emulator/psxBiosRegion'
import { useSeo, breadcrumbSchema, videoGameSchema, faqSchema } from '@/services/seo'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import { dosExtrasName, gameDescription, gameSeoLanguagePlan, gameSeoTitle, gameTitle, genreLabel, needsTranslation, platformLabel } from '@/services/i18nData'
import { EmulatorPlayer, preloadPlayer } from '@/emulator/PlayerChunk'
import { stageHeightCap } from '@/emulator/screenAspect'
import { IsolatedPlayCard } from '@/components/game/IsolatedPlayCard'
import { GameCover } from '@/components/game/GameCover'
import { GameDetailLayout } from '@/components/game/GameDetailLayout'
import { GameAgeGuard } from '@/components/game/AgeGate'
import { GameComments } from '@/components/comments/Comments'
import { GameRating } from '@/components/game/GameRating'
import { ShareDialog } from '@/components/game/ShareDialog'
import { AddToCollectionDialog } from '@/components/game/AddToCollectionDialog'
import { GameCard } from '@/components/game/GameCard'
import { KeymapCards } from '@/components/game/KeymapCards'
import { TranslateButton } from '@/components/game/TranslateButton'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { Button, buttonClasses } from '@/components/ui/Button'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'
import { NotFoundPage } from './NotFoundPage'
import { useShell } from '@/components/layout/ShellContext'
import { CONTACT_EMAIL } from '@/components/layout/Logo'
import { cx } from '@/lib/format'
import { FEATURES } from '@/config/features'
import { isolatedEmbedFor } from '../../shared/isolated-embeds.js'
import { isIsolatedRuntimePlatform } from '../../shared/isolated-runtime-platforms.js'
import { isInlineIsolatedPlatform } from '../../shared/inline-isolated-platforms.js'
import { splitDevelopers } from '@/lib/developers'
import { newStartupId, recordStartupEvent } from '@/services/startupFunnel'
import { useGameHotfix } from '@/services/hotfixes'
import { isMahjongPanelGame } from '@/emulator/mahjongPanel'
import { html5EmbedLoginFor } from '@/emulator/html5EmbedLogin'
import { grindcraftHtml5Entry } from '@/emulator/grindcraftHtml5'
import { builtinWebGameFor } from '../../shared/builtin-web-games.js'

export function GameDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [searchParams] = useSearchParams()
  // ?p2p= 是 P2P 邀请链接；?room= 是云端房间（付费通道）
  const invite = searchParams.get('p2p') ?? undefined
  const cloudInvite = searchParams.get('room') ?? undefined
  // 从「直播」进来的：默认只看不玩
  const watchOnly = searchParams.get('watch') === '1'
  // ?live= 是「一人玩多人看」的直播间（和联机房的观众席不是一回事）
  const liveInvite = searchParams.get('live') ?? undefined
  // DOS IPX 邀请是 P2P peer 别名；打开链接后自动启动同一游戏并加入局域网隧道。
  const ipxInvite = searchParams.get('ipx')?.trim() ?? ''
  /*
    ?autoplay=1：进来就自动开一局。目前的来路只有 TV（遥控器回车即播）。
    ⚠️ 不进 canonical —— useSeo 的 canonicalPath 取的是 pathname，不带查询串，
    所以这个参数不会造出第二个可收录地址。
  */
  const autoStart = searchParams.get('autoplay') === '1' || Boolean(ipxInvite)
  const t = useT()
  // 详情页要的就是这一款游戏和它的相关推荐，由后端一次给全 ——
  // v1 是把整个游戏库拉进内存再 find(slug)，几千款时光是首屏就得下载整个目录
  const state = usePageData<GameData>(`/games/${encodeURIComponent(slug)}`, undefined, 'game')
  // data.game 为 null 表示后端确认没有这款游戏；undefined 是「还没拿到」，两者不能混为一谈
  const game = state.data?.game ?? undefined
  const related = state.data?.related ?? []
  /** 每次进入一款游戏只生成一个访问 id；站内切到另一款时必须换，不能把两页串成一条漏斗。 */
  const startupVisitRef = useRef<{ slug: string; id: string } | null>(null)
  if (!startupVisitRef.current || startupVisitRef.current.slug !== slug) {
    startupVisitRef.current = { slug, id: newStartupId() }
  }
  const startupVisitId = startupVisitRef.current.id
  useEffect(() => {
    if (!game?.slug) return
    recordStartupEvent(game.slug, {
      visitId: startupVisitId,
      event: 'detail_view',
      platform: game.platform,
    })
  }, [game?.slug, game?.platform, startupVisitId])
  const { immersive, setImmersive } = useShell()
  /**
   * 播放器那一块的**高度**上限（2026-09-07 从「限宽 + 居中」改过来的，站长拿红线标了要对齐）。
   *
   * 限宽那一版把 16:9 的框两侧缩进、和底下的标题 / 资料区对不齐；限高之后框铺满内容列、
   * 边缘对齐，而画面（object-fit: contain）在框内左右留黑边，**尺寸一模一样**。
   * 完整理由见 screenAspect.ts 的 stageHeightCap。
   *
   * 发给年龄门和跨源入口卡，**落在它们内层那个 16:9 上**（不是外框，外框是 overflow-hidden）。
   * **播放器不用它**：全屏 / 游玩布局那两种铺满视口的形态不能被 max-h 夹住，
   * 所以播放器在自己那个普通分支里挂同一个 stageHeightCap。
   */
  const stageCap = stageHeightCap(immersive)
  /**
   * 看直播或联机玩家才缩成 8/4：观众端小一圈能减轻视频流的模糊感，联机玩家则要给右侧弹幕留位置。
   * 普通游玩在超宽屏用 9/3，让右侧评论从播放器顶边开始；较窄桌面仍让播放器独占一行，避免评论挤窄。
   *
   * 为什么观众要这一套：观众看到的是一路被编码压过的流，画面越大糊得越明显。
   * 1440 的屏上满宽播放器是 1121 宽，缩回 8 列约 726 —— 小一圈，糊就被压下去了。
   * 站长的原话是「主播推过来的流糊没关系，观众端看起来糊就用小播放器来弥补」。
   *
   * ⚠️ **观看判据是 URL 上的 `?live=`**，不会因短暂断流跳版。
   * 真正上场当联机玩家时由播放器明确回报 matchPlayer，右栏换成玩家弹幕面板；
   * 只换网格类名和 portal 目标，播放器组件保持原位，不会被卸载重建。
   *
   * ⚠️ 沉浸模式优先级更高：那时整个侧栏是收起的（见 aside 的 className），
   * 播放器本来就该吃满 12 列。
   */
  /** 联机玩家进房后把弹幕放到画面右边；观众仍只走上面的观看布局。 */
  const [matchPlayer, setMatchPlayer] = useState(false)
  const watchLayout = Boolean(liveInvite) && !matchPlayer && !immersive
  const matchLayout = matchPlayer && !immersive
  const twoColumn = watchLayout || matchLayout
  /**
   * 右栏那块直播面板的挂载点。播放器通过 portal 把面板画进这个节点。
   *
   * ⚠️ 用 **state + 回调 ref**，不用 useRef：portal 的目标节点必须在渲染时就拿得到，
   * 而 useRef 挂上之后**不会触发重渲染** —— 播放器那边会一直看到 null，面板永远不出现。
   */
  const [livePanelSlot, setLivePanelSlot] = useState<HTMLElement | null>(null)
  const [matchPanelSlot, setMatchPanelSlot] = useState<HTMLElement | null>(null)
  const user = useCurrentUser()
  const [shareOpen, setShareOpen] = useState(false)
  const [addToCollection, setAddToCollection] = useState(false)
  // 用游戏的真实 slug 判断：URL 里的 slug 大小写可能不同，而切换收藏用的是 game.slug，
  // 两边不一致时按钮会显示「未收藏」，一点反而取消收藏。
  const isFav = Boolean(user?.favorites.includes(game?.slug ?? slug))
  // 收藏请求在路上时禁掉按钮：连点两下会发两次切换，最终状态取决于哪个响应后到。
  const [favBusy, setFavBusy] = useState(false)
  const onToggleFavorite = (target: string) => {
    if (favBusy) return
    setFavBusy(true)
    void toggleFavorite(target)
      .catch(() => {})
      .finally(() => setFavBusy(false))
  }
  /**
   * 「反馈问题」：滚到本页评论区并把光标放进输入框 —— 出错的玩家想说话时，评论区就是最近的出口。
   * 以前这颗按钮跳 /blog，玩家到了博客列表页不知道该干什么。
   * 沉浸模式下侧栏（含评论区）是隐藏的，先退出沉浸再滚；评论功能没开或元素不在时退回写邮件。
   */
  const reportProblem = () => {
    const scroll = () => {
      const el = document.getElementById('comments')
      if (!FEATURES.comments || !el) {
        const subject = encodeURIComponent(`[8BitGo] ${slug}`)
        window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}`
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      window.setTimeout(() => el.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }), 450)
    }
    if (immersive) {
      setImmersive(false)
      // 等布局把侧栏放出来再滚（下一帧）
      window.setTimeout(scroll, 60)
      return
    }
    scroll()
  }
  /**
   * 玩家手动选的 ROM 语言（null = 跟着站点语言走）。
   * 换游戏时要清掉，否则上一款选的「日本語」会带到下一款上。
   */
  const [romLang, setRomLang] = useState<RomSlotLang | null>(null)
  /**
   * 玩家点过翻译按钮之后，覆盖在简介上的译文。
   * - null = 还没翻，按人工简介 / 自动译文 / 中英文基准依次回退
   * - string = 翻译后的文本（已经写到 description_i18n，但前端 state 也保留一份，
   *           这样母语描述改了描述前页面闪一下不奇怪）
   * 不持久化到 localStorage —— 跨页签持久化反而引入「后台改了简介但用户看不到」的隐性 bug，
   * 反正刷新一次页面就重新走 needsTranslation() 判断按钮该不该显示
   */
  // 译文连同「是哪一款、哪种语言」一起存：详情页在相关游戏之间跳转时组件是复用的，
  // 只存文本会把 A 的译文盖到 B 的简介上；翻译请求在跳转之后才返回也一样会错位。
  const [translated, setTranslated] = useState<{ slug: string; lang: string; text: string } | null>(null)
  useEffect(() => setRomLang(null), [slug])
  const rom = useRomUrl(game, romLang)
  /** 这款游戏绑了哪几种语言的 ROM；少于两种时播放器不显示切换入口 */
  const romLangs = game ? romLangsOf(game) : []

  /*
    记录最近浏览（侧边栏的「曾经玩过」）。依赖只看 slug：重新取数会得到一个全新的
    game 对象，按对象比较会让同一款游戏被重复记一次。

    ⚠️ **带着 `?live=` 进来的不记** —— 那是来看别人玩的，这台机器一帧都没跑过，
    把它算成「曾经玩过」只会让侧边栏里堆满自己根本没玩过的游戏。
    联机（`?p2p=` / `?room=`）是另一回事：访客真的在操作这一局，照记。

    他要是看完直播自己又开了一局，播放器那边会补记一次（见 EmulatorPlayer 的 onReady）。
  */
  useEffect(() => {
    if (game && visitCountsAsPlayed(liveInvite)) void recordRecent(game.slug)
  }, [game?.slug, liveInvite])

  // SEO：hook 必须在下面的 early return 之前调用，所以「还没取到」和「确实没有」都要在这里各给一套
  const lang = useLang()
  const translatedDescription =
    translated && game && translated.slug === game.slug && translated.lang === lang ? translated.text : null
  /**
   * 这一款是不是「要整页跨源隔离才跑得起来」的游戏（登记表在 shared/isolated-embeds.js）。
   * 命中的话详情页不内嵌模拟器，改成显示一个跳 /play/<slug> 的入口。
   */
  const isolatedEmbed = isolatedEmbedFor(game?.slug)
  // 少数第三方 HTML5 游戏的账号登录只允许在顶层页面完成；它们从详情页直接开新标签，不挂 iframe。
  const externalLaunchUrl = game?.platform === 'html5'
    ? builtinWebGameFor(game.slug)?.externalLaunchUrl
    : undefined
  /**
   * PPSSPP 也需要跨源隔离，但它不再跳到铺满视口的精简页：服务端会直接给 PSP 的
   * 正常详情页加 COOP/COEP，因此播放器、标题、资料与侧栏都可以和其它平台保持一致。
   * PS2 / Dolphin 暂时仍用精简隔离页；它们的兼容性提示和启动形态另行保留。
   */
  // 街机平台默认仍走 EmulatorJS，不应因为 Play! 的例外把所有街机页都改成整页启动。
  // 只有后台明确给这款街机选择 Play! System 2x6 时，才需要独立 COOP/COEP 文档。
  const requiresIsolatedRuntime = game?.platform === 'arcade'
    ? game.runtime === 'play'
    : isIsolatedRuntimePlatform(game?.platform)
  const isolatedRuntimePlatform = game?.platform === 'arcade' && game.runtime === 'play'
    ? 'arcade'
    : game && isIsolatedRuntimePlatform(game.platform) ? game.platform : undefined
  const requiresIsolation = Boolean(isolatedEmbed) || requiresIsolatedRuntime
  const usesIsolatedLaunchCard = requiresIsolation && !isInlineIsolatedPlatform(game?.platform)
  /*
    AI 临时修补（后台「AI 修补」，shared/hotfix.js）：这款游戏在这个浏览器上有没有生效的退路。
    ready 之前把 ROM 当成「检查中」，开始按钮晚一点出现，也不让一局开到一半被换核心。
    拉取和 ROM 探测并行，最多 1.5 秒；看直播的观众不跑模拟器，不需要。
  */
  const hotfix = useGameHotfix(game?.slug, game?.platform, Boolean(game) && !usesIsolatedLaunchCard && !externalLaunchUrl && !liveInvite)
  /**
   * 从游戏列表经 React Router 进入 PSP / 塞班页时，浏览器沿用原文档，不会重新请求 SSR 的隔离头。
   * 自动完整刷新一次，让当前 URL 真正变成带 COOP/COEP 的顶层文档；sessionStorage 与导航类型
   * 双重挡住响应头配置错误时的无限刷新。刷新前先不挂播放器，免得 PPSSPP 在旧文档里白启动一次。
   */
  const pspNeedsDocumentReload = typeof window !== 'undefined'
    && isInlineIsolatedPlatform(game?.platform)
    && !window.crossOriginIsolated
  const [pspIsolationReloadFailed, setPspIsolationReloadFailed] = useState(false)
  useEffect(() => {
    if (!isInlineIsolatedPlatform(game?.platform) || typeof window === 'undefined') {
      setPspIsolationReloadFailed(false)
      return
    }
    const reloadKey = `8bitgo:psp-isolation:${window.location.pathname}`
    if (window.crossOriginIsolated) {
      try { window.sessionStorage.removeItem(reloadKey) } catch { /* 无痕/禁存储不影响已经隔离的页面 */ }
      setPspIsolationReloadFailed(false)
      return
    }

    try {
      if (window.sessionStorage.getItem(reloadKey) === '1') {
        setPspIsolationReloadFailed(true)
        return
      }
      window.sessionStorage.setItem(reloadKey, '1')
    } catch {
      const navigation = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      if (navigation?.type === 'reload') {
        setPspIsolationReloadFailed(true)
        return
      }
    }
    window.location.reload()
  }, [game?.platform, game?.slug])
  /*
    只给真的会内嵌播放器的游戏预热 chunk。年龄门必须等 game 到了才挂，
    所以此时预热仍和 access 接口并行；pthread 模拟器 / 隔离页 / 不存在的游戏用不上这 240 KB，
    原先无条件预热会在玩家还没点击“开始游戏”时白白下载。
  */
  useEffect(() => {
    if (game && !usesIsolatedLaunchCard && !externalLaunchUrl) preloadPlayer()
  }, [game?.slug, usesIsolatedLaunchCard, externalLaunchUrl])
  const seoTitle = game ? gameTitle(game, lang) : ''
  const seoPlatform = game ? platformMap[game.platform] : undefined
  const seoPlatformName = seoPlatform ? platformLabel(t, seoPlatform.id, seoPlatform.name) : ''
  const seoDocumentTitle = game ? gameSeoTitle(seoTitle, seoPlatform?.shortName ?? '', lang) : ''
  // CS1.6 的联机房间由嵌入页自己的浏览器服务器提供，不走站点通用的 4 人 P2P 字段。
  // 生产数据因此仍是 multiplayer=false / players=1；详情页若照抄会把眼前可用的 16 人房宣传成单机。
  const hasEmbeddedCs16Rooms = game?.slug === 'counter-strike-16'
  const effectiveMultiplayer = Boolean(game?.multiplayer) || hasEmbeddedCs16Rooms
  // BIOS hook 必须在下面的 early return 之前调用 —— 每次渲染的 hook 顺序要一致。
  // PS1 优先按光盘序列号 / 明确地区标记选 BIOS；不确定或未绑定地区 BIOS 时沿用平台级绑定。
  const psxRegion = game?.platform === 'psx'
    ? detectPsxBiosRegion({
        slug: game.slug,
        title: game.title,
        primaryIdentifier: rom.key ?? rom.url,
        identifiers: [game.rom, ...Object.values(game.roms ?? {})],
      })
    : undefined
  const platformBiosUrl = usePlatformBiosUrl(seoPlatform?.id)
  const psxBiosUrl = usePsxBiosUrl(psxRegion)
  const biosUrl = game?.platform === 'psx' ? psxBiosUrl : platformBiosUrl
  // SEO 描述也要跟语言走：英文页面挂一段中文 meta description，
  // 搜索结果里就是一串看不懂的字，等于白写
  const seoDesc = game ? plainText(gameDescription(game, lang)) : ''
  const seoLanguages = game ? gameSeoLanguagePlan(game, lang) : undefined
  // 游戏详情页常见问题：用现有翻译 token 拼出随语言走的问答，补足可被爬虫读懂的正文，
  // 并配合 faqSchema 结构化数据争取「人们还问 / 精选摘要」露出。未翻译的语言（faqNs 缺失）自动跳过。
  const faqNs = t.game.faq
  const faqVars = { title: seoTitle, platform: seoPlatformName, year: game?.year ? String(game.year) : '' }
  const faqItems = game && faqNs
    ? [
        { q: fmt(faqNs.playQ, faqVars), a: fmt(faqNs.playA, faqVars) },
        { q: fmt(faqNs.platformQ, faqVars), a: fmt(faqNs.platformA, faqVars) },
        { q: fmt(faqNs.saveQ, faqVars), a: fmt(faqNs.saveA, faqVars) },
        { q: fmt(faqNs.mobileQ, faqVars), a: fmt(faqNs.mobileA, faqVars) },
      ]
    : []
  useSeo(
    game
      ? {
          title: fmt(t.game.docTitle, { title: seoDocumentTitle }),
          // canonical 钉死数据库里的真 slug：slug 列是 utf8mb4_unicode_ci，大小写 / 重音不同的
          // URL（/games/Metal-Slug-3）也能查到同一款游戏，不钉的话每种写法都自称 canonical
          canonicalPath: `/games/${game.slug}`,
          // 优先用游戏自己的简介，没有再套通用模板
          description: seoDesc || fmt(t.seo.gameDesc, { title: seoTitle, platform: seoPlatformName }),
          contentLanguages: seoLanguages?.contentLanguages,
          canonicalLanguage: seoLanguages?.canonicalLanguage,
          image: game.cover,
          publishedTime: game.addedAt,
          updatedTime: game.updatedAt || game.addedAt,
          // 评论功能关掉时前台一条回复都看不见，这时候上报「最新回复时间」是谎报
          replyTime: FEATURES.comments ? game.lastCommentAt : undefined,
          jsonLd: [
            videoGameSchema({
              name: seoTitle,
              slug: game.slug,
              description: seoDesc,
              image: game.cover,
              platform: seoPlatformName,
              genres: game.genres.map((id) => genreLabel(t, id, genreMap[id]?.name ?? id)),
              year: game.year,
              developer: game.developer,
              rating: game.rating,
              ratingCount: game.ratingCount,
              language: seoLanguages?.canonicalLanguage,
              // URL 的语言由正文 canonical 决定；inLanguage 单独如实声明玩家可直接启动的 ROM 槽。
              // 两者不能混用，否则中文介绍 + 日文 ROM 会被错误地标成日文内容页。
              inLanguage: romLangs,
              multiplayer: effectiveMultiplayer,
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.library, path: '/games' },
              { name: seoTitle, path: `/games/${game.slug}` },
            ], seoLanguages?.canonicalLanguage),
            ...(faqItems.length ? [faqSchema(faqItems)] : []),
          ],
        }
      : state.status === 'ready'
        ? // 后端明确说了没有这款游戏
          { title: t.game.notFoundTitle, noindex: true }
        : // 还在取数：先用站点默认标题，别急着挂 noindex ——
          // 那会让「先渲染骨架、后拿到数据」的爬虫读到一个不该有的 noindex
          {},
  )

  // 数据是异步来的，游戏还没到手不代表它不存在，否则每次进详情页都会先闪一下 404
  if (!game) {
    if (state.status === 'error') return <LoadError message={state.error} onRetry={state.retry} />
    if (state.status === 'loading') return <DetailSkeleton />
    return <NotFoundPage message={t.game.notFoundMsg} />
  }

  // platform 是数据库里存的值：可能是代码不认识的，也可能是还没对外开放的（见 config/platforms）。
  // v1 在取数时就把这两种情况滤掉了，v2 由后端直接按 slug 回，得在这里挡：
  // 不挡的话下面每一处 platform.xxx 都会把整页带崩。
  if (!seoPlatform || !isPlatformEnabled(seoPlatform.id)) return <NotFoundPage message={t.game.notFoundMsg} />
  const platform = seoPlatform
  /*
    GrindCraft 的存量 SWF 会触发 Ruffle 未实现的 Flex TextBlock API，随后 enterFrame 被终止并留下黑帧。
    游戏方公开的 HTML5 页面已实测可进入菜单和实际玩法，因此只在详情播放器上替换运行时与入口。
  */
  const grindcraftHtml5Url = grindcraftHtml5Entry(game.slug)
  const playerPlatform = grindcraftHtml5Url ? platformMap.html5 : platform
  // 操作说明必须跟播放器使用同一套“平台 + 实际 ROM 扩展名 + 逐游戏覆盖”解析。
  // 以前这里只拿平台优先级，NES 页面永远显示 jsnes 键位；现在容器包会稳定走 EmulatorJS，
  // 若说明仍写 F2/F4 和 jsnes 2P 键，玩家会以为按键坏了。直链 `.nes` 的 mapper 要到播放器
  // Range 探测后才知道，这里取安全兜底；后台明确指定的 runtime 始终优先。
  const runtime: Runtime =
    grindcraftHtml5Url
      ? resolveRuntime({ platform: 'html5', ext: 'html', runtimeOverride: 'html5' })!
      : resolveRuntime({
          platform: platform.id,
          ext: rom.status === 'found' ? extOf(rom.url) : undefined,
          runtimeOverride: (hotfix.runtime as typeof game.runtime | undefined) ?? game.runtime,
        }) ?? runtimesFor(platform.id)[0] ?? resolveRuntime(platform.id)!
  /*
    外链 HTML5 游戏自带账号登录只能在顶层页面完成时，给玩家一条「去新标签页登录」的提示。
    地址解析出来前（SSR 与水合首帧都是 checking）先看 game.roms 里登记的入口，
    这样提示随首屏 HTML 一起出来，水合后换成实际选中的那条也不会让版面跳一下。
  */
  const embedLogin = platform.id !== 'html5'
    ? null
    : rom.status === 'found'
      ? html5EmbedLoginFor(rom.url)
      : Object.values(game.roms ?? {}).map((entry) => html5EmbedLoginFor(entry)).find(Boolean) ?? null
  // 「支持语言」格：从 game.roms 里读出真正绑了哪些语言槽，直接显示语言名。
  // 这既让玩家不用猜 CN / JP，也让 SSR 的正文明确说出哪些语言 ROM 真正可选。
  const supportedLangs = Array.from(
    new Set(romLangs.map((l) => romLanguageLabel(l))),
  ).join(' · ')

  return (
    <div className="container-x py-6 sm:py-8 lg:pt-0">
      {/*
        ⚠️ 可见的面包屑在 2026-09-07 按站长要求去掉了（这一页的主角是播放器，
        顶上那行小字只是把画面往下推）。

        **但 JSON-LD 的 breadcrumbSchema 留着**（见上面 useSeo 那一段）——
        那是给搜索结果用的结构化数据，不占任何像素，去掉纯亏。
        两者是两回事，别看到「面包屑没了」就把 schema 一起删。

        站内返回路径没丢：平台名在右侧那张平台卡上是链接，游戏库在侧边栏里。
      */}

      {/*
        普通游戏页让播放器独占一行，资料与社区侧栏从播放器下方分列，和新稿的阅读顺序一致。
        看直播和联机玩家继续用 8/4，并让右栏从播放器顶边开始，给实时面板留出空间。

        布局只改同一组节点的网格类名，`<EmulatorPlayer>` 不会因状态切换而卸载，
        避免直播断开、联机重连或游戏状态丢失。
      */}
      <GameDetailLayout sessionLayout={twoColumn} immersive={immersive}>
        <section className="game-detail-layout__player w-full">
          {hotfix.notice && (
            <p role="status" className={cx('mb-3 rounded-lg border border-coin/50 bg-coin/15 px-3 py-2 text-sm text-fg', stageCap)}>
              {t.game.hotfixNotice[hotfix.notice]}
            </p>
          )}
          <GameAgeGuard
                /*
                  门卫拦下来时画的也是个 16:9 的框，得和播放器一样宽 ——
                  只给播放器不给门卫的话，「还在核对年龄」那一下框先宽一截、放行后又跳窄。
                */
                className={cx(stageCap, 'game-detail-stage-ratio')}
                slug={game.slug}
                markedAdult={Boolean(game.adult)}
                // 背景那张是糊到底再压一层黑底的，96×96 完全够用，没必要下 300×300
                backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority thumb className="h-full w-full" />}
              >
                {/*
                  PSP / 塞班的普通详情页会自动换成隔离顶层文档；其余登记过的游戏与 PS2 / Dolphin
                  暂时仍显示入口卡，再跳到 /play/<slug>。理由见 shared/isolated-embeds.js。
                */}
                {pspNeedsDocumentReload ? (
                  <div className={cx('flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-2xl border border-line bg-black px-6 text-center text-sm text-muted', stageCap, 'game-detail-stage-ratio')}>
                    <p>
                      {pspIsolationReloadFailed
                        ? (game.platform === 'symbian' ? t.runtime.eka2l1NeedsIsolation : t.runtime.ppssppNeedsIsolation)
                        : t.player.loadingEngine}
                    </p>
                    {pspIsolationReloadFailed && (
                      <Button
                        onClick={() => {
                          try { window.sessionStorage.removeItem(`8bitgo:psp-isolation:${window.location.pathname}`) } catch { /* 仍允许用户手动再试 */ }
                          window.location.reload()
                        }}
                      >
                        {t.common.retry}
                      </Button>
                    )}
                  </div>
                ) : externalLaunchUrl ? (
                  <div className={cx('overflow-hidden rounded-2xl border border-line bg-black', stageCap)}>
                    <div className={cx('relative flex aspect-video w-full items-center justify-center', 'game-detail-stage-ratio')}>
                      <div className="absolute inset-0 opacity-60 blur-sm">
                        <GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority thumb className="h-full w-full" />
                      </div>
                      <div className="scanlines absolute inset-0" aria-hidden />
                      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
                      <div className="relative flex flex-col items-center gap-4 px-6 text-center">
                        {game.icon && <span className="hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl" aria-hidden>{game.icon}</span>}
                        <a
                          href={externalLaunchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={buttonClasses('primary', 'lg')}
                          aria-label={`${t.player.start} · ${game.title}`}
                        >
                          <span aria-hidden>▶</span> {t.player.start} ↗
                        </a>
                        <p className="max-w-sm text-xs text-muted">{t.player.externalGameHint}</p>
                      </div>
                    </div>
                  </div>
                ) : usesIsolatedLaunchCard ? (
                  <IsolatedPlayCard
                    frameClassName={cx(stageCap, 'game-detail-stage-ratio')}
                    slug={game.slug}
                    gameName={game.title}
                    isolatedPlatform={isolatedRuntimePlatform}
                    startupVisitId={startupVisitId}
                    icon={game.icon}
                    // 背景那张是糊到底再压一层黑底的，96×96 完全够用，没必要下 300×300
                backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority thumb className="h-full w-full" />}
                  />
                ) : (
                <EmulatorPlayer
                  /*
                    只给满宽。**高度上限由播放器自己**在它那个「普通」分支里挂（stageHeightCap）——
                    全屏时舞台是 fullscreen 元素、游玩布局时是 fixed 铺满视口，
                    从这里挂 max-h 会把那两种形态一起夹住。
                  */
                  className="w-full"
                  key={game.slug}
                  pagePresentation
                  displayTitle={gameTitle(game, lang)}
                  stagePoster={<GameCover game={game} ratio="landscape" showTitle={false} showBadge={false} still priority thumb className="h-full w-full" />}
                  onShare={() => setShareOpen(true)}
                  onPageMatchRequest={game.multiplayer && (p2pPlayable(game.platform) || game.platform === 'dos')
                    ? (game.platform === 'dos' ? requestIpxHost : requestMatch)
                    : undefined}
                  platform={playerPlatform}
                  gameName={game.title}
                  gameSlug={game.slug}
                  runtime={grindcraftHtml5Url ? 'html5' : (hotfix.runtime as typeof game.runtime | undefined) ?? game.runtime}
                  startupVisitId={startupVisitId}
                  maxPlayers={game.multiplayer ? game.players : 1}
                  invite={invite}
                  cloudInvite={cloudInvite}
                  watch={watchOnly}
                  liveInvite={liveInvite}
                  autoStart={autoStart}
                livePanelSlot={watchLayout ? livePanelSlot : null}
                matchPanelSlot={matchLayout ? matchPanelSlot : null}
                onMatchPlayerChange={setMatchPlayer}
                  icon={game.icon}
                  // 这一款指定的核心（街机尤其需要），以及平台级 BIOS（Neo Geo 缺了起不来）
                  core={hotfix.core ?? game.core}
                  genres={game.genres}
                  arcadeRomData={game.arcadeRomData}
                  arcadeMameDisks={game.arcadeMameDisks}
                  arcadeBios={game.arcadeBios}
                  arcadeNoBios={game.arcadeNoBios}
                  arcadeDip={game.arcadeDip}
                  arcadeButtons={game.arcadeButtons}
                  flashControls={grindcraftHtml5Url ? undefined : game.flashControls}
                  dosExecutable={dosExecutableForRom(game, rom)}
                  dosStartupCommands={dosStartupCommandsForRom(game, rom)}
                  dosBackend={game.dosBackend}
                  dosPc98={game.dosPc98}
                  dosSystemUrl={game.dosSystem ? romUrlForKey(game.dosSystem) : undefined}
                  dosSockdriveUrl={dosSockdriveForRom(game, rom) ? romUrlForKey(dosSockdriveForRom(game, rom)!) : undefined}
                  dosExtras={dosExtraSources(game.dosExtras)}
                  dosExtrasLabel={dosExtrasName(game, lang)}
                  dosWindowsVersion={game.dosWindowsVersion}
                  dosLaunchDelay={game.dosLaunchDelay}
                  dosboxConfig={game.dosboxConfig}
                  dosSaveHint={game.dosSaveHint}
                  biosUrl={biosUrl || undefined}
                  romUrl={grindcraftHtml5Url ?? (rom.status === 'found' && hotfix.ready ? rom.url : undefined)}
                  romChecking={!grindcraftHtml5Url && (rom.status === 'checking' || (rom.status === 'found' && !hotfix.ready))}
                  romUnavailable={!grindcraftHtml5Url && rom.status === 'missing'}
                  romUnreachable={!grindcraftHtml5Url && rom.unreachable}
                  onRetryRom={rom.retry}
                  onRomLoadFailed={rom.failover}
                  romLangs={grindcraftHtml5Url ? [] : romLangs}
                  romLang={grindcraftHtml5Url ? undefined : rom.lang}
                  romLangSelection={grindcraftHtml5Url ? undefined : romLang}
                  onRomLangChange={setRomLang}
                  // 背景那张是糊到底再压一层黑底的，96×96 完全够用，没必要下 300×300
                backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority thumb className="h-full w-full" />}
                  onReport={reportProblem}
                />
                )}
          </GameAgeGuard>

          {/*
            实验性平台的提示，紧贴在播放器下面。
            必须在玩家点「开始」**之前**就看得到 —— PS2 大多数游戏在浏览器里跑不起来，
            让人先等一分钟加载再看到一句报错，那是把他的时间和对站点的信任一起花掉。

            PSP 已经固定走自建 PPSSPP + Range 流式读盘，这句「实验性 / 可能很慢」
            不再给玩家提供有用信息，反而会让正常运行的游戏看起来不可靠，所以只在这里排除 PSP；
            平台卡片原有的实验标记不受影响。

            注：它和播放器、标题、资料区**同宽**（都是内容列）。09-07 把限宽换成限高之后
            这一整列就都对齐了，不需要再为它单独调什么。
          */}
          {EXPERIMENTAL_PLATFORMS.has(platform.id) && platform.id !== 'psp' && (
            <p className="mt-3 rounded-xl border border-coin/40 bg-coin-soft px-3 py-2 text-xs text-muted">
              ⚠️ {platform.runtime === 'dolphin'
                ? t.runtime.dolphinExperimental
                : t.runtime.playExperimental}
            </p>
          )}

          {/*
            第三方 HTML5 游戏自带的 Google / Discord 登录在游戏框里一定被对方拒绝（Google 回 403），
            本站拦不住、也代替不了，见 src/emulator/html5EmbedLogin.ts。和上面那条一样，
            要在玩家点游戏里那颗按钮**之前**就看得到，所以不等开局。
          */}
          {embedLogin && !externalLaunchUrl && (
            <p role="note" className="mt-3 rounded-xl border border-coin/40 bg-coin-soft px-3 py-2 text-xs text-muted">
              {fmt(t.game.embedLoginNotice, { providers: embedLogin.providers.join(' / ') })}{' '}
              <a
                href={embedLogin.url}
                target="_blank"
                rel="noopener"
                onClick={(event) => {
                  if (!window.confirm(t.game.embedLoginOpenConfirm)) event.preventDefault()
                }}
                className="font-semibold text-brand-hover underline underline-offset-2 hover:text-fg"
              >
                {t.game.embedLoginOpen} ↗
              </a>
              <span className="mt-1 block">{t.game.embedLoginSaveWarning}</span>
            </p>
          )}
          {slug === 'pokecatch' && (
            <p role="note" className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
              {lang.startsWith('zh')
                ? '游戏会在新标签页打开，登录由游戏方处理。存档桥扩展可把游戏进度同步到 8BitGo；Safari 和 Android Chrome 可在这里手动导入或导出。登录游戏账号不等于同步到 8BitGo。'
                : 'The game opens in a new tab and handles sign-in itself. The Save Bridge extension can sync its progress to 8BitGo; Safari and Android Chrome can import or export saves here. Signing in to the game does not sync it to 8BitGo.'}
              {' '}
              <Link to="/pokecatch-save-sync" className="font-semibold text-brand-hover underline underline-offset-2 hover:text-fg">
                {lang.startsWith('zh') ? '设置存档同步' : 'Set up save sync'}
              </Link>
            </p>
          )}
        </section>

          <section className="game-detail-layout__main min-w-0">
            <header className="game-detail-heading">
              <div className="game-detail-heading__copy">
                <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{seoTitle}</h1>
                {seoTitle !== game.title && <p className="mt-1 text-sm text-muted">{game.title}</p>}
                <div className="game-detail-chip-row mt-3">
                  <Link to={`/platforms/${platform.id}`}>
                    <Badge tone="brand" className="text-xs">
                      {platform.icon} {platformLabel(t, platform.id, platform.name)}
                    </Badge>
                  </Link>
                  {game.genres.map((id) => (
                    <Link key={id} to={`/genres/${id}`}>
                      <Badge className="text-xs">
                        {genreMap[id]?.icon} {genreLabel(t, id, genreMap[id]?.name ?? id)}
                      </Badge>
                    </Link>
                  ))}
                  {rom.status === 'found' && <Badge tone="online" className="text-xs">{t.common.instantPlay}</Badge>}
                  {effectiveMultiplayer && <Badge tone="online" className="text-xs">{t.game.badgeMultiplayer}</Badge>}
                  {game.bodyControl && <Badge tone="coin" className="text-xs">{t.game.badgeBodyControl}</Badge>}
                  {game.adult && <Badge tone="live" className="text-xs">{t.game.badgeAdult}</Badge>}
                  <CoinBadge amount={game.coinReward} className="text-xs" />
                </div>
              </div>
              <details className="game-detail-heading__actions relative">
                <summary
                  aria-label={t.common.more}
                  title={t.common.more}
                  className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full border border-line bg-surface text-lg text-muted transition hover:border-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  ⋯
                </summary>
                <div className="absolute right-0 top-11 z-20 flex min-w-48 flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-xl">
                  {user ? (
                    <Button variant={isFav ? 'primary' : 'secondary'} size="sm" className="justify-start" onClick={() => onToggleFavorite(game.slug)} disabled={favBusy} aria-pressed={isFav}>
                      {isFav ? t.game.favorited : t.game.favorite}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" className="justify-start" onClick={openAuthModal}>
                      {t.game.favorite}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="justify-start"
                    onClick={() => (user ? setAddToCollection(true) : openAuthModal())}
                    title={user ? undefined : t.collections.loginToAdd}
                  >
                    📚 {t.collections.addTo}
                  </Button>
                  {game.multiplayer && (p2pPlayable(game.platform) || game.platform === 'dos') && (
                    <Button variant="secondary" size="sm" className="justify-start" onClick={game.platform === 'dos' ? requestIpxHost : requestMatch}>
                      {game.platform === 'dos' ? t.game.createIpxRoom : t.game.createRoom}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="justify-start" onClick={reportProblem}>
                    {t.game.report}
                  </Button>
                </div>
              </details>
            </header>

            {/* 简介 */}
            <section className="mt-6">
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-bold">{t.game.about}</h2>
                {/* 「翻译」按钮：当前语言不是 zh-Hans / en 且该语言还没翻译过时挂一个。
                    needsTranslation() 在已翻译的情况下也会返回 false，按钮就不会再出现 */}
                {needsTranslation(game, lang) && (
                  <TranslateButton<{ text: string }>
                    endpoint={`/api/games/${encodeURIComponent(game.slug)}/translate-description`}
                    lang={lang}
                    onTranslated={(r) => setTranslated({ slug: game.slug, lang, text: r.text })}
                  />
                )}
              </div>
              <dl className="game-detail-metadata mt-4">
                {game.year > 0 && <Meta label={t.game.year} value={String(game.year)} />}
                <Meta
                  label={t.game.developer}
                  value={splitDevelopers(game.developer).map((name, index) => (
                    <span key={name}>
                      {index > 0 && ', '}
                      <InternalLink to={`/games?developer=${encodeURIComponent(name)}`} className="hover:text-brand-hover">
                        {name}
                      </InternalLink>
                    </span>
                  ))}
                />
                <Meta label={t.game.players} value={hasEmbeddedCs16Rooms ? '1–16' : formatPlayers(game.players)} />
                <Meta label={t.game.supportedLanguages} value={supportedLangs || '—'} />
              </dl>
              <GameDescription
                // 把译文塞进 key —— 一旦翻译结果改变，子组件全部状态重置，展开 / 收起重新计算
                key={`${game.slug}:${lang}:${translatedDescription ?? ''}`}
                description={translatedDescription ?? gameDescription(game, lang)}
                showMore={t.game.showMore}
                showLess={t.game.showLess}
              />
              {game.tags && game.tags.length > 0 && lang === 'zh-Hans' && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {game.tags.slice(0, 6).map((t) => (
                    <InternalLink
                      key={t}
                      to={`/games?q=${encodeURIComponent(t)}`}
                      /*
                        站内搜索是无限空间、没有收录价值，所以这里不出 href
                        （nofollow 挡不住发现，见 lib/seoLinks.ts）。
                        可抓的同类入口在上面：/platforms/:id 和 /genres/:id 都已经链过。
                      */
                      className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-muted transition hover:bg-brand-soft hover:text-fg"
                    >
                      {t}
                    </InternalLink>
                  ))}
                </div>
              )}
            </section>

            <section className="mt-8" aria-label={t.game.communityContributors}>
              <h2 className="text-sm font-bold">{t.game.communityContributors}</h2>
              <p className="game-detail-contributors-empty mt-2">{t.game.communityContributorsEmpty}</p>
            </section>

            <section className="mt-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-bold">💡 {t.game.guidesTitle}</h2>
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`[8BitGo] ${game.title} guide`)}`}
                  className="inline-flex min-h-9 items-center rounded-lg border border-line bg-surface px-3 text-xs font-semibold transition hover:border-brand hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  ✎ {t.game.guidesSubmit}
                </a>
              </div>
              <div className="game-detail-empty-state mt-3 min-h-28">
                <p className="max-w-md text-sm">{t.game.guidesEmpty}</p>
              </div>
            </section>

            {related.length > 0 && (
              <section className="mt-8">
                <SectionHeader title={t.game.relatedTitle} subtitle={t.game.relatedSubtitle} icon="💡" />
                <div className="adaptive-game-grid mt-4">
                  {related.map((g) => (
                    <GameCard key={g.slug} game={g} coverRatio="landscape" showCoin={false} />
                  ))}
                </div>
              </section>
            )}

            {/* 常见问题：可见问答 + faqSchema 结构化数据，补足可被爬虫读懂的页面正文，
                并争取「人们还问」/ 精选摘要的露出（faqSchema 在 useSeo 里按 faqItems 注入） */}
            {game && faqItems.length > 0 && (
              <section className="mt-8">
                <h2 className="text-lg font-bold">{t.game.faqTitle}</h2>
                <dl className="mt-4 space-y-4">
                  {faqItems.map((item, i) => (
                    <div key={i}>
                      <dt className="font-semibold">{item.q}</dt>
                      <dd className="mt-1 text-sm leading-relaxed text-muted">{item.a}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {/* 操作说明 */}
            <section className="mt-8">
              <h2 className="text-lg font-bold">{t.game.controls}</h2>
              <KeymapCards
                runtimeId={runtime?.id}
                platform={playerPlatform.id}
                gameSlug={game.slug}
                arcadeButtons={game.arcadeButtons}
                arcadeBios={game.arcadeBios}
                core={game.core}
                mahjongPanel={isMahjongPanelGame(playerPlatform.id, game.core, Object.values(game.roms ?? {}))}
              />
            </section>
          </section>

          {/* 侧栏 */}
          <aside className="game-detail-layout__sidebar">
            {/*
              看直播时右栏**整块换掉**：平台卡 / 评分 / 评论对正在看直播的人没有意义，
              站长的原话是「观众端清除最右侧的内容，然后右侧放现在观看的联机+观众，
              下面放弹幕，然后弹幕历史记录」。

              这里只放一个**空容器**，真正的内容由 EmulatorPlayer 通过 portal 挂进来 ——
              面板要的名单 / 人数 / 弹幕 / 发送句柄全在播放器的 state 里（见 LiveWatchPanel 文件头）。

              lg:sticky：左边播放器很高，右栏内容比它短；不 sticky 的话往下滚一点弹幕就出画了。
            */}
            {watchLayout ? (
              <div ref={setLivePanelSlot} className="lg:sticky lg:top-20" />
            ) : matchLayout ? (
              <div ref={setMatchPanelSlot} className="lg:sticky lg:top-20" />
            ) : (
              <>
              {/*
                详情接口提供的是去重后的游玩数和游戏支持人数，没有实时在线玩家数；
                第二格明确显示支持人数，不能把它包装成「正在玩」以免误导玩家。
              */}
              <section
                className="game-detail-card overflow-hidden"
                aria-label={`${fmt(t.common.playsCount, { n: formatCount(game.plays) })} · ${t.game.currentlyPlaying}`}
              >
                <div className="grid grid-cols-2 divide-x divide-line border-b border-line px-3 py-3">
                  <div
                    role="group"
                    aria-label={fmt(t.common.playsCount, { n: formatCount(game.plays) })}
                    title={fmt(t.common.playsCount, { n: formatCount(game.plays) })}
                    className="flex min-w-0 items-center gap-2 px-2 first:pl-0"
                  >
                    <span className="text-lg" aria-hidden>🔥</span>
                    <span className="min-w-0">
                      <span className="block truncate text-lg font-extrabold tabular-nums">{formatCount(game.plays)}</span>
                      <span className="block text-[11px] text-muted">{t.game.playCountLabel}</span>
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 px-3">
                    <span className="text-lg" aria-hidden>🎮</span>
                    <span className="min-w-0">
                      {/* 详情 API 没有实时在线人数；显示空值，支持人数已在简介元信息中展示。 */}
                      <span className="block truncate text-lg font-extrabold tabular-nums">—</span>
                      <span className="block truncate text-[11px] text-muted">{t.game.currentlyPlaying}</span>
                    </span>
                  </div>
                </div>
                {FEATURES.ratings && (
                  <GameRating gameSlug={game.slug} compact embedded className="p-4">
                    <div className="game-detail-chip-row mt-3 border-t border-line pt-3">
                      {game.genres.slice(0, 6).map((id) => (
                        <Link key={id} to={`/genres/${id}`} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted transition hover:text-fg">
                          {genreLabel(t, id, genreMap[id]?.name ?? id)}
                        </Link>
                      ))}
                    </div>
                  </GameRating>
                )}
              </section>

              {/* 评论服务只在本来就启用时取数；布局本身不增加新的请求。 */}
              {FEATURES.comments && <GameComments gameSlug={game.slug} className="game-detail-comments" />}

              {FEATURES.coins && (
              <div className="rounded-2xl border border-coin/30 bg-gradient-to-br from-coin/10 to-transparent p-5">
                <p className="text-pixel text-[11px] text-coin">G COIN</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {game.coinReward > 0
                    ? fmt(t.game.coinReward, {
                        n: game.coinReward,
                        suffix: user ? t.game.coinSuffixIn : t.game.coinSuffixOut,
                      })
                    : t.game.coinNone}
                </p>
                {user ? (
                  <p className="mt-4 text-sm font-semibold text-coin">
                    {fmt(t.game.coinBalance, { n: user.coins.toLocaleString(getLang()) })}
                  </p>
                ) : (
                  <Button onClick={openAuthModal} variant="coin" size="sm" className="mt-4">
                    {t.game.coinLogin}
                  </Button>
                )}
              </div>
              )}
              </>
            )}
          </aside>
      </GameDetailLayout>

      {addToCollection && <AddToCollectionDialog gameSlug={game.slug} onClose={() => setAddToCollection(false)} />}

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        slug={game.slug}
        title={seoTitle || game.title}
        isolated={requiresIsolation}
      />
    </div>
  )
}

/**
 * 后台的附加文件清单 → 播放器要的 { url, path }。
 *
 * 没配就返回 undefined（不是空数组）：这个值每次渲染都会重算，返回新的空数组只会让
 * 下游多一份没用的新引用。清单本身很短（后台上限 12 条），不值得为它上 useMemo。
 */
function dosExtraSources(list?: string[]): DosExtraSource[] | undefined {
  const refs = parseDosExtras(list)
  return refs.length ? refs.map((e) => ({ ...e, url: romUrlForKey(e.key) })) : undefined
}

function GameDescription({
  description,
  showMore,
  showLess,
}: {
  description: string
  showMore: string
  showLess: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [canToggle, setCanToggle] = useState(false)
  const descriptionId = useId()
  const descriptionRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const node = descriptionRef.current
    if (!node || expanded) return

    let active = true
    const measure = () => {
      if (active) setCanToggle(node.scrollHeight > node.clientHeight + 1)
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    // 像素字体加载后每行能放下的字数会变化，要再量一次，避免按钮误显或漏显。
    void document.fonts?.ready.then(measure)

    return () => {
      active = false
      observer?.disconnect()
    }
  }, [description, expanded])

  return (
    <div>
      {/*
       * 这里只做 CSS 视觉裁切，不截短字符串、也不条件渲染正文。
       * 因此 SSR HTML、meta description 和结构化数据里始终保留完整简介，搜索引擎可以正常抓取。
       */}
      <p
        ref={descriptionRef}
        id={descriptionId}
        className={cx('mt-2 leading-relaxed text-muted', !expanded && 'line-clamp-4')}
      >
        {description}
      </p>
      {canToggle && (
        <button
          type="button"
          className="mt-2 rounded-sm text-sm font-semibold text-brand-hover underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          aria-expanded={expanded}
          aria-controls={descriptionId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? showLess : showMore}
        </button>
      )}
    </div>
  )
}

function Meta({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {to ? (
          <Link to={to} className="hover:text-brand-hover">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/** meta description / 结构化数据里的描述必须是单行纯文本：去掉 Markdown 与 HTML 标记 */
function plainText(source: string): string {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 取数期间的占位。
 * 布局和真实页面对齐（左侧播放器 + 标题，右侧平台卡），数据到位时不会整页跳一下。
 */
function DetailSkeleton() {
  return (
    <div className="container-x py-6 sm:py-8 lg:pt-0" aria-busy="true">
      <div className="game-detail-layout" aria-busy="true">
        <div className="game-detail-layout__player">
          <SkeletonBlock className="aspect-video rounded-2xl border border-line sm:aspect-[3/1] lg:max-h-[calc(100dvh-10rem)]" />
        </div>
        <section className="game-detail-layout__main min-w-0">
          <SkeletonBlock className="h-8 w-2/3" />
          <div className="mt-3 flex gap-2">
            <SkeletonBlock className="h-6 w-16 rounded-full" />
            <SkeletonBlock className="h-6 w-20 rounded-full" />
            <SkeletonBlock className="h-6 w-14 rounded-full" />
          </div>
          <div className="game-detail-metadata mt-6">
            {[0, 1, 2, 3].map((item) => <SkeletonBlock key={item} className="h-10" />)}
          </div>
          <div className="mt-6 space-y-3">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-3 w-11/12" />
            <SkeletonBlock className="h-3 w-3/4" />
          </div>
        </section>
        <aside className="game-detail-layout__sidebar">
          <div className="game-detail-card p-4">
            <div className="grid grid-cols-2 divide-x divide-line">
              <div className="px-2 first:pl-0">
                <SkeletonBlock className="h-3 w-8" />
                <SkeletonBlock className="mt-2 h-5 w-14" />
              </div>
              <div className="px-3">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="mt-2 h-5 w-12" />
              </div>
            </div>
            <SkeletonBlock className="mt-5 h-14 w-full rounded-xl" />
          </div>
          <div className="game-detail-card p-4">
            <SkeletonBlock className="h-4 w-20" />
            <SkeletonBlock className="mt-4 h-16 w-full rounded-xl" />
            <SkeletonBlock className="mt-4 h-9 w-full rounded-xl" />
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * 取数失败。和「没有这款游戏」分开：网络挂了不该告诉用户游戏不存在，
 * 那会让人以为游戏被下架了。
 */
function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT()
  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center" role="alert">
      <p className="text-4xl" aria-hidden>
        📡
      </p>
      <p className="mt-4 max-w-md text-sm text-muted">{message}</p>
      {/* 取数失败给一个「重试」，别让人去刷新整页（手机上刷新还会把播放器 chunk 再下一遍） */}
      {onRetry && (
        <Button type="button" variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          {t.common.retry}
        </Button>
      )}
    </div>
  )
}
