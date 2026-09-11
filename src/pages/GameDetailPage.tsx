import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { InternalLink } from '@/components/ui/InternalLink'
import { recordRecent, toggleFavorite, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import type { RomLang } from '@/config/languages'
import { ROM_LANG_ABBR } from '@/config/languages'
import { romLangsOf, romUrlForKey, useRomUrl } from '@/services/roms'
import { parseDosExtras, type DosExtraSource } from '@/lib/dosExtras'
import { resolveRuntime, runtimesFor } from '@/emulator'
import { p2pPlayable } from '@/emulator'
import { requestMatch } from '@/services/matchRequest'
import { usePageData, type GameData } from '@/services/pageData'
import { platformMap, EXPERIMENTAL_PLATFORMS } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { formatCount, formatPlayers } from '@/lib/format'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { useSeo, breadcrumbSchema, videoGameSchema } from '@/services/seo'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import { dosExtrasName, gameDescription, gameTitle, genreLabel, needsTranslation, platformDesc, platformLabel } from '@/services/i18nData'
import { EmulatorPlayer, preloadPlayer } from '@/emulator/PlayerChunk'
import { stageHeightCap } from '@/emulator/screenAspect'
import { IsolatedPlayCard } from '@/components/game/IsolatedPlayCard'
import { GameCover } from '@/components/game/GameCover'
import { GameAgeGuard } from '@/components/game/AgeGate'
import { GameComments } from '@/components/game/GameComments'
import { GameRating } from '@/components/game/GameRating'
import { ShareDialog } from '@/components/game/ShareDialog'
import { AddToCollectionDialog } from '@/components/game/AddToCollectionDialog'
import { GameCard } from '@/components/game/GameCard'
import { KeymapCards } from '@/components/game/KeymapCards'
import { TranslateButton } from '@/components/game/TranslateButton'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'
import { NotFoundPage } from './NotFoundPage'
import { useShell } from '@/components/layout/ShellContext'
import { CONTACT_EMAIL } from '@/components/layout/Logo'
import { cx } from '@/lib/format'
import { FEATURES } from '@/config/features'
import { isolatedEmbedFor } from '../../shared/isolated-embeds.js'
import { splitDevelopers } from '@/lib/developers'

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
  const t = useT()
  // 详情页要的就是这一款游戏和它的相关推荐，由后端一次给全 ——
  // v1 是把整个游戏库拉进内存再 find(slug)，几千款时光是首屏就得下载整个目录
  const state = usePageData<GameData>(`/games/${encodeURIComponent(slug)}`, undefined, 'game')
  // data.game 为 null 表示后端确认没有这款游戏；undefined 是「还没拿到」，两者不能混为一谈
  const game = state.data?.game ?? undefined
  const related = state.data?.related ?? []
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
   * 用不用「看直播」那套版面：播放器缩回左边 8 列，右边的平台卡 / 评论和它**顶边齐**
   * （也就是 09-07 之前那个 8/4 两栏，站长管它叫「第一版 play page」）。
   *
   * 为什么观众要这一套：观众看到的是一路被编码压过的流，画面越大糊得越明显。
   * 1440 的屏上满宽播放器是 1121 宽，缩回 8 列约 726 —— 小一圈，糊就被压下去了。
   * 站长的原话是「主播推过来的流糊没关系，观众端看起来糊就用小播放器来弥补」。
   *
   * ⚠️ **判据是 URL 上的 `?live=`，不是运行时的 `session.live`。** 用 URL 的好处是它在
   * 这个页面的整个生命周期里不变：版面不会在开播 / 断流的瞬间跳一下，也就不存在
   * 「播放器被重新挂载 → 流断掉」的风险。代价是一个边角：观众点了「我自己玩」
   * （EmulatorPlayer 内部的 ignoreInvite）之后 URL 上的 `?live=` 还在，版面会继续维持 8 列。
   * 那种情况下画面小一点没什么害处，想要满宽点一下「沉浸模式」即可。
   *
   * ⚠️ 沉浸模式优先级更高：那时整个侧栏是收起的（见 aside 的 className），
   * 播放器本来就该吃满 12 列。
   */
  const watchLayout = Boolean(liveInvite) && !immersive
  /**
   * 右栏那块直播面板的挂载点。播放器通过 portal 把面板画进这个节点。
   *
   * ⚠️ 用 **state + 回调 ref**，不用 useRef：portal 的目标节点必须在渲染时就拿得到，
   * 而 useRef 挂上之后**不会触发重渲染** —— 播放器那边会一直看到 null，面板永远不出现。
   */
  const [livePanelSlot, setLivePanelSlot] = useState<HTMLElement | null>(null)
  const user = useCurrentUser()
  const [shareOpen, setShareOpen] = useState(false)
  const [addToCollection, setAddToCollection] = useState(false)
  const isFav = Boolean(user?.favorites.includes(slug))
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
  const [romLang, setRomLang] = useState<RomLang | null>(null)
  /**
   * 玩家点过翻译按钮之后，覆盖在简介上的译文。
   * - null = 还没翻，按 gameDescription() 三层回退
   * - string = 翻译后的文本（已经写到 description_i18n，但前端 state 也保留一份，
   *           这样母语描述改了描述前页面闪一下不奇怪）
   * 不持久化到 localStorage —— 跨页签持久化反而引入「后台改了简介但用户看不到」的隐性 bug，
   * 反正刷新一次页面就重新走 needsTranslation() 判断按钮该不该显示
   */
  const [translatedDescription, setTranslatedDescription] = useState<string | null>(null)
  useEffect(() => setRomLang(null), [slug])
  /*
    一进详情页就把播放器 chunk 拉起来，和取数 / 年龄门接口并行。
    播放器要等 GameAgeGuard 放行才挂载，而 lazy() 是挂载那一刻才开始下载 ——
    不预热的话「接口 → chunk → 播放器」是串行的，玩家多等一段纯黑。见 PlayerChunk.preloadPlayer。
    跨源隔离的那几款（isolatedEmbed）用不到，但那要等 game 到了才知道；多下一个会被缓存的 chunk 不算代价。
  */
  useEffect(() => preloadPlayer(), [])
  const rom = useRomUrl(game, romLang)
  /** 这款游戏绑了哪几种语言的 ROM；少于两种时播放器不显示切换入口 */
  const romLangs = game ? romLangsOf(game) : []

  // 记录最近浏览。依赖只看 slug：重新取数会得到一个全新的 game 对象，
  // 按对象比较会让同一款游戏被重复记一次
  useEffect(() => {
    if (game) void recordRecent(game.slug)
  }, [game?.slug])

  // SEO：hook 必须在下面的 early return 之前调用，所以「还没取到」和「确实没有」都要在这里各给一套
  const lang = useLang()
  /**
   * 这一款是不是「要整页跨源隔离才跑得起来」的游戏（登记表在 shared/isolated-embeds.js）。
   * 命中的话详情页不内嵌模拟器，改成显示一个跳 /play/<slug> 的入口。
   */
  const isolatedEmbed = isolatedEmbedFor(game?.slug)
  const seoTitle = game ? gameTitle(game, lang) : ''
  const seoPlatform = game ? platformMap[game.platform] : undefined
  const seoPlatformName = seoPlatform ? platformLabel(t, seoPlatform.id, seoPlatform.name) : ''
  // 平台级 BIOS。必须在下面那几个 early return 之前调 —— hook 的调用顺序每次渲染都要一致。
  // 异步到货，第一帧一般是空串；播放器只在挂载引擎那一刻读它，不会因此重启游戏
  const biosUrl = usePlatformBiosUrl(seoPlatform?.id)
  // SEO 描述也要跟语言走：英文页面挂一段中文 meta description，
  // 搜索结果里就是一串看不懂的字，等于白写
  const seoDesc = game ? plainText(gameDescription(game, lang)) : ''
  useSeo(
    game
      ? {
          title: fmt(t.game.docTitle, { title: seoTitle }),
          // 优先用游戏自己的简介，没有再套通用模板
          description: seoDesc || fmt(t.seo.gameDesc, { title: seoTitle, platform: seoPlatformName }),
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
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.library, path: '/games' },
              { name: seoTitle, path: `/games/${game.slug}` },
            ]),
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
  // 没有具体文件时，按优先级取该平台实际会用的引擎 —— 跟 PlayLocalPage 的选法一致。
  // 只用 resolveRuntime(platform.id) 会走到「平台默认引擎」那一档（platforms.ts 的 runtime
  // 字段），显示的是兜底引擎而不是真正会跑的那个：NDS 装了 webretro 仍写着 EmulatorJS，
  // NES 明明由 jsnes 接管也一样。
  const runtime = runtimesFor(platform.id)[0] ?? resolveRuntime(platform.id)
  // 「支持语言」格：从 game.roms 里读出真正绑了哪些语言槽，映射成 CN / EN / JP 缩写。
  // romLangsOf 只返回有 key 的槽，所以「数据库里有那个语言的 ROM 就写什么」。
  const supportedLangs = Array.from(
    new Set(romLangsOf(game).map((l) => ROM_LANG_ABBR[l])),
  ).join(' ')

  return (
    <div className="container-x py-6 sm:py-8">
      {/*
        ⚠️ 可见的面包屑在 2026-09-07 按站长要求去掉了（这一页的主角是播放器，
        顶上那行小字只是把画面往下推）。

        **但 JSON-LD 的 breadcrumbSchema 留着**（见上面 useSeo 那一段）——
        那是给搜索结果用的结构化数据，不占任何像素，去掉纯亏。
        两者是两回事，别看到「面包屑没了」就把 schema 一起删。

        站内返回路径没丢：平台名在右侧那张平台卡上是链接，游戏库在侧边栏里。
      */}

      {/*
        播放器独占一行、**铺满内容列**，高度到视口就停，而不是塞在 8/12 那一栏里。

        这一页的主角是游戏。以前播放器只占左边 8 列、右边是平台卡和评论：1440 宽的屏幕上
        画面只有 750×420，4:3 的老游戏再让掉两侧黑边，实际画面 560 宽 —— 比一张封面图大不了多少，
        而右边那一栏在玩的时候没人看。

        ⚠️ 以上说的是**自己玩**。看直播（watchLayout）时反过来要那个 8 列的老版面 ——
        那里画面小才是优点，理由见 watchLayout 上面那段。

        ── 为什么是限高，不是限宽（2026-09-07 改，站长拿红线标了要对齐）──
        第一版是给 16:9 的框设**宽度**上限 `(100dvh - 10rem) * 16/9` 再居中，为的是矮屏
        （1280×720 的笔记本）上 16:9 铺满宽度会比视口还高、玩家得滚着玩。代价是框两侧缩进，
        **和底下的标题、资料区对不齐**，一眼看过去像坏了。
        现在改成框铺满内容列、设**高度**上限：画面是 object-fit:contain，于是在框内左右留黑边 ——
        **画面尺寸一模一样**（受同一个高度约束），黑边只是从「框外的页面底色」搬进了「框内的黑」。
        矮屏那条约束一点没放松。完整推导在 screenAspect.ts 的 stageHeightCap。

        10rem = 顶栏 4rem + 页面上下留白 + 再留一指宽让下面的标题露个头，暗示还有内容。
        （原来这笔预算里还含面包屑的一行，面包屑 09-07 去掉了 —— 那一份现在是标题多露的余量。
        想让画面再大一点就把 10rem 往下调，但别调没了「标题露头」那一指。）
        沉浸模式下顶栏藏了，用原来那个 7rem。
        `lg:` 以上才限：横屏手机（852×330）一跑起来就进铺满视口的游玩布局，不该由这里管。

        ⚠️ 上限**不套在外面这一层**，逐个交给真的是 16:9 的那几块。套外层的话播放器下面那条
        弹幕输入框会跟着白挨，又变成对不齐。**别为了少写一处把它挪回外层。**
      */}
      {/*
        播放器 + 资料区 + 侧栏**同一个 12 列网格**。

        两种排法，靠 watchLayout 切，DOM 结构完全不变（只换类名）——
        **不能改成两套 JSX**：`<EmulatorPlayer>` 一旦在树里换了位置就会被卸载重建，
        正在看的那路直播当场断流、自己玩的那一局存档没落盘就没了。

          自己玩（默认）   [    播放器 12 列    ] / [ 资料区 8 ][ 侧栏 4 ]
          看直播           [ 播放器 8 ][ 侧    ] / [ 资料区 8 ][   栏   ]
      */}
      <div className="grid gap-8 lg:grid-cols-12">
        <div className={cx('w-full', watchLayout ? 'lg:col-span-8' : 'lg:col-span-12')}>
          <GameAgeGuard
                /*
                  门卫拦下来时画的也是个 16:9 的框，得和播放器一样宽 ——
                  只给播放器不给门卫的话，「还在核对年龄」那一下框先宽一截、放行后又跳窄。
                */
                className={stageCap}
                slug={game.slug}
                markedAdult={Boolean(game.adult)}
                backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
              >
                {/*
                  少数游戏（reVC 移植的 GTA 之类）要 SharedArrayBuffer，只能在一个
                  跨源隔离的整页里跑，塞不进详情页 —— 详情页一开 require-corp，
                  Google Fonts、收录脚本和跨源封面图会被一起掐掉。
                  这些游戏改成显示一个入口，跳到 /play/<slug>。理由见 shared/isolated-embeds.js。
                */}
                {isolatedEmbed ? (
                  <IsolatedPlayCard
                    frameClassName={stageCap}
                    slug={game.slug}
                    gameName={game.title}
                    icon={game.icon}
                    backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
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
                  platform={platform}
                  gameName={game.title}
                  gameSlug={game.slug}
                  maxPlayers={game.players}
                  invite={invite}
                  cloudInvite={cloudInvite}
                  watch={watchOnly}
                  liveInvite={liveInvite}
                livePanelSlot={watchLayout ? livePanelSlot : null}
                  icon={game.icon}
                  // 这一款指定的核心（街机尤其需要），以及平台级 BIOS（Neo Geo 缺了起不来）
                  core={game.core}
                  genres={game.genres}
                  arcadeRomData={game.arcadeRomData}
                  dosExecutable={game.dosExecutable}
                  dosBackend={game.dosBackend}
                  dosSystemUrl={game.dosSystem ? romUrlForKey(game.dosSystem) : undefined}
                  dosExtras={dosExtraSources(game.dosExtras)}
                  dosExtrasLabel={dosExtrasName(game, lang)}
                  dosWindowsVersion={game.dosWindowsVersion}
                  dosLaunchDelay={game.dosLaunchDelay}
                  dosboxConfig={game.dosboxConfig}
                  dosSaveHint={game.dosSaveHint}
                  biosUrl={biosUrl || undefined}
                  romUrl={rom.status === 'found' ? rom.url : undefined}
                  romChecking={rom.status === 'checking'}
                  romUnavailable={rom.status === 'missing'}
                  romUnreachable={rom.unreachable}
                  onRetryRom={rom.retry}
                  romLangs={romLangs}
                  romLang={rom.lang}
                  onRomLangChange={setRomLang}
                  backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
                  onReport={reportProblem}
                />
                )}
          </GameAgeGuard>

          {/*
            实验性平台的提示，紧贴在播放器下面。
            必须在玩家点「开始」**之前**就看得到 —— PS2 大多数游戏在浏览器里跑不起来，
            让人先等一分钟加载再看到一句报错，那是把他的时间和对站点的信任一起花掉。

            注：它和播放器、标题、资料区**同宽**（都是内容列）。09-07 把限宽换成限高之后
            这一整列就都对齐了，不需要再为它单独调什么。
          */}
          {EXPERIMENTAL_PLATFORMS.has(platform.id) && (
            <p className="mt-3 rounded-xl border border-coin/40 bg-coin-soft px-3 py-2 text-xs text-muted">
              ⚠️ {t.runtime.playExperimental}
            </p>
          )}
        </div>

          <div className={immersive ? 'lg:col-span-12' : 'lg:col-span-8'}>
            {/* 标题与元信息 */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{seoTitle}</h1>
                {seoTitle !== game.title && <p className="mt-1 text-sm text-muted">{game.title}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
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
                  {game.multiplayer && <Badge tone="online" className="text-xs">{t.game.badgeMultiplayer}</Badge>}
                  {game.bodyControl && <Badge tone="coin" className="text-xs">{t.game.badgeBodyControl}</Badge>}
                  {game.adult && <Badge tone="live" className="text-xs">{t.game.badgeAdult}</Badge>}
                  <CoinBadge amount={game.coinReward} className="text-xs" />
                </div>
              </div>
              {game.plays > 0 && (
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                  <span className="text-xs text-muted">{fmt(t.common.playsCount, { n: formatCount(game.plays) })}</span>
                </div>
              )}
            </div>

            {/* 动作按钮 */}
            <div className="mt-5 flex flex-wrap gap-2">
              {user ? (
                <Button variant={isFav ? 'primary' : 'secondary'} size="sm" onClick={() => void toggleFavorite(game.slug).catch(() => {})} aria-pressed={isFav}>
                  {isFav ? t.game.favorited : t.game.favorite}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={openAuthModal}>
                  {t.game.favorite}
                </Button>
              )}
              {/*
                以前这个按钮点了只是把当前 URL 抄进剪贴板。现在改成开分享面板：
                嵌入代码需要尺寸选择，而「跨站 iframe 存不了档、带不进登录态」这两句
                必须有地方说出来，一个按钮给不了这些。见 components/game/ShareDialog.tsx。
              */}
              <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)}>
                {t.game.share}
              </Button>
              {/* 加入合集：没登录的先弹登录，别让他填完一轮才发现要登录 */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => (user ? setAddToCollection(true) : openAuthModal())}
                title={user ? undefined : t.collections.loginToAdd}
              >
                📚 {t.collections.addTo}
              </Button>
              {/*
                「创建联机房间」以前是 `to="/games?multiplayer=1"` —— 点了只是跳到游戏库
                筛多人游戏，一个房也不建（用户报的就是这个）。现在它真的开房：
                喊一声 requestMatch()，播放器接住（见 services/matchRequest.ts）——
                游戏没开始就先开始，跑起来立刻在**这一局**上开房，不重开。

                条件里加 p2pPlayable：光看 game.multiplayer 不够，那只说明这游戏支持多人，
                不代表这个平台的模拟器能联机、也不代表信令配好了。画一个点了没反应的按钮
                比不画更糟。
              */}
              {game.multiplayer && p2pPlayable(game.platform) && (
                <Button variant="secondary" size="sm" onClick={requestMatch}>
                  {t.game.createRoom}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={reportProblem}>
                {t.game.report}
              </Button>
            </div>

            {/* 简介 */}
            <section className="mt-8">
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-bold">{t.game.about}</h2>
                {/* 「翻译」按钮：当前语言不是 zh-Hans / en 且该语言还没翻译过时挂一个。
                    needsTranslation() 在已翻译的情况下也会返回 false，按钮就不会再出现 */}
                {needsTranslation(game, lang) && (
                  <TranslateButton<{ text: string }>
                    endpoint={`/api/games/${encodeURIComponent(game.slug)}/translate-description`}
                    lang={lang}
                    onTranslated={(r) => setTranslatedDescription(r.text)}
                  />
                )}
              </div>
              <GameDescription
                // 把译文塞进 key —— 一旦翻译结果改变，子组件全部状态重置，展开 / 收起重新计算
                key={`${game.slug}:${lang}:${translatedDescription ?? ''}`}
                description={translatedDescription ?? gameDescription(game, lang)}
                showMore={t.game.showMore}
                showLess={t.game.showLess}
              />
              <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Meta label={t.game.year} value={String(game.year)} />
                <Meta
                  label={t.game.developer}
                  value={splitDevelopers(game.developer).map((name, index) => (
                    <span key={name}>
                      {index > 0 && ', '}
                      <InternalLink
                        to={`/games?developer=${encodeURIComponent(name)}`}
                        className="hover:text-brand-hover"
                      >
                        {name}
                      </InternalLink>
                    </span>
                  ))}
                />
                <Meta label={t.game.players} value={formatPlayers(game.players)} />
                <Meta label={t.game.supportedLanguages} value={supportedLangs || '—'} />
              </dl>
              {game.tags && game.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {game.tags.map((t) => (
                    <InternalLink
                      key={t}
                      to={`/games?q=${encodeURIComponent(t)}`}
                      /*
                        站内搜索是无限空间、没有收录价值，所以这里不出 href
                        （nofollow 挡不住发现，见 lib/seoLinks.ts）。
                        可抓的同类入口在上面：/platforms/:id 和 /genres/:id 都已经链过。
                      */
                      className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:border-brand hover:text-fg"
                    >
                      #{t}
                    </InternalLink>
                  ))}
                </div>
              )}
            </section>

            {/* 操作说明 */}
            <section className="mt-8">
              <h2 className="text-lg font-bold">{t.game.controls}</h2>
              <KeymapCards runtimeId={runtime?.id} platform={platform.id} />
            </section>
          </div>

          {/* 侧栏 */}
          <aside
            className={cx(
              'space-y-8 lg:col-span-4',
              /*
                看直播时侧栏要和**播放器**顶边齐（参考图那样），所以显式排到第 9 列、从第 1 行
                起跨两行。不写的话自动排版是这样的：播放器占 8 列落在第 1 行、资料区 8 列放不下
                → 第 2 行、侧栏再补到第 2 行右边 —— 侧栏就跑到标题旁边去了，和播放器差一整行。
              */
              watchLayout && 'lg:col-start-9 lg:row-start-1 lg:row-span-2',
              immersive && 'hidden',
            )}
          >
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
            ) : (
              <>
              <div className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span
                    className="grid h-12 w-12 place-items-center rounded-xl text-2xl"
                    style={{ background: `${platform.color}22`, border: `1px solid ${platform.color}55` }}
                    aria-hidden
                  >
                    {platform.icon}
                  </span>
                  <div>
                    <p className="font-bold">{platformLabel(t, platform.id, platform.name)}</p>
                    <p className="text-xs text-muted">
                      {platform.manufacturer} · {platform.year}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">{platformDesc(t, platform.id, platform.description)}</p>
                <Button to={`/platforms/${platform.id}`} variant="secondary" size="sm" className="mt-4 w-full">
                  {fmt(t.game.browsePlatform, { platform: platform.shortName })}
                </Button>
              </div>

              {/*
                评分与评论。放在平台卡下面 —— 沉浸模式下整个侧栏是隐藏的（见 aside 的 className），
                那时候玩家在全屏玩游戏，这两块跟着一起收起来是对的。

                评分在评论上面：打个分是一秒钟的动作，写评论要斟酌半天。
                把成本低的那个放在先看到的位置，参与率会差出一个数量级。
              */}
              {FEATURES.ratings && <GameRating gameSlug={game.slug} />}
              {FEATURES.comments && <GameComments gameSlug={game.slug} />}

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
      </div>

      {/* 相关游戏 */}
      {related.length > 0 && (
        <section className="mt-14">
          <SectionHeader title={t.game.relatedTitle} subtitle={t.game.relatedSubtitle} icon="💡" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {related.map((g) => (
              <GameCard key={g.slug} game={g} />
            ))}
          </div>
        </section>
      )}

      {addToCollection && <AddToCollectionDialog gameSlug={game.slug} onClose={() => setAddToCollection(false)} />}

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        slug={game.slug}
        title={seoTitle || game.title}
        isolated={Boolean(isolatedEmbed)}
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
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-1 truncate font-semibold">
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
    <div className="container-x py-6 sm:py-8" aria-busy="true">
      {/*
        和真页面同一套版位：播放器整行**铺满内容列**、高度到视口就停，资料区在下面 ——
        骨架和正文错位的话数据一到整页跳一下。
        · 顶上那条面包屑占位跟着真页面一起去掉了（09-07）
        · 限宽换成了限高（同 stageHeightCap），骨架不会进沉浸模式，所以只要非沉浸那一档
      */}
      <div className="w-full">
        <SkeletonBlock className="aspect-[16/9] rounded-2xl border border-line lg:max-h-[calc(100dvh-10rem)]" />
      </div>
      <div className="mt-6 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <SkeletonBlock className="h-8 w-2/3" />
          <div className="mt-3 flex gap-2">
            <SkeletonBlock className="h-7 w-20 rounded-lg" />
            <SkeletonBlock className="h-7 w-24 rounded-lg" />
            <SkeletonBlock className="h-7 w-16 rounded-lg" />
          </div>
          <div className="mt-8 space-y-3">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-3 w-11/12" />
            <SkeletonBlock className="h-3 w-3/4" />
          </div>
        </div>
        <aside className="space-y-8 lg:col-span-4">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex gap-3">
              <SkeletonBlock className="h-12 w-12 shrink-0 rounded-xl" />
              <div className="flex-1 pt-1">
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock className="mt-2 h-3 w-1/2" />
              </div>
            </div>
            <SkeletonBlock className="mt-5 h-3 w-full" />
            <SkeletonBlock className="mt-2 h-3 w-4/5" />
            <SkeletonBlock className="mt-5 h-9 w-full rounded-xl" />
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
