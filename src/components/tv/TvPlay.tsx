import { useCallback, useEffect, useState } from 'react'
import { platformMap } from '@/data/platforms'
import { GameAgeGuard } from '@/components/game/AgeGate'
import { GameCover } from '@/components/game/GameCover'
import { EmulatorPlayer } from '@/emulator/PlayerChunk'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { romLangsOf, romUrlForKey, useRomUrl, type RomLang } from '@/services/roms'
import { usePageData, type GameData } from '@/services/pageData'
import { gameTitle } from '@/services/i18nData'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'

/**
 * TV 模式的「开玩」那一屏：**播放器占满整个浏览器窗口**。
 *
 * TV 模式指的不是把网页设成全屏（那是浏览器的 Fullscreen API，遥控器上未必调得出来，
 * 车机浏览器多半直接没有），而是**回车之后这一屏只剩播放器** —— 没有侧边栏、
 * 没有顶栏、没有详情页那一长串评论和相关推荐，画面吃满整个窗口。
 *
 * ## 为什么是「换一屏」而不是「跳一页」
 *
 * 走的是 TV 页自己的查询串（`?play=<slug>`），不是另开一条路由：
 *   · 浏览器 / 遥控器的「返回」天然能用（历史里有这一条），退回来时列表还是热的，不用重取；
 *   · 焦点能还回你刚才按下去的那一款（见 TvPage 的 initialId）；
 *   · 不多一个能被收录的地址 —— 这一屏是个动作，不是一篇内容。
 *
 * ## ⚠️ 这里的 props 和 EmbedPage 是同一份，必须一起改
 *
 * 底下那一长串 prop（core / arcadeRomData / dos* / rom* …）和 pages/EmbedPage.tsx
 * 里那一份是**同一套**。本该抽成公共组件，但 EmbedPage 是第三方网站嵌着在用的，
 * 而且它注释里记着「高度链从来没接上过」那种隐蔽故障史 —— 抽的时候必须能真的跑起来验，
 * 不能靠读代码。所以暂时是两份，由 scripts/test-tv-play.mjs 逐个 prop 名比对钉住：
 * 哪天有人给播放器加了 prop 只改了一边，那条测试会红。**抽成一份之后请把那条测试删掉。**
 */
export function TvPlay({ slug, onExit }: { slug: string; onExit: () => void }) {
  const t = useT()
  const lang = useLang()
  const state = usePageData<GameData>(`/games/${encodeURIComponent(slug)}`, undefined, 'game')
  const game = state.data?.game ?? undefined
  const platform = game ? platformMap[game.platform] : undefined
  const biosUrl = usePlatformBiosUrl(platform?.id)
  const [romLang, setRomLang] = useState<RomLang | null>(null)
  const rom = useRomUrl(game, romLang)

  /*
    Esc 退回列表。电视遥控器的「返回」和车机的实体返回键在浏览器里多半报的就是
    Escape 或 Backspace；两个都收，但 Backspace 要避开输入框（这一屏没有输入框，
    不过播放器内部可能有，所以仍然判一下 target）。
  */
  /*
    退出时顺手把整页全屏也退掉（进来时 TvPage 的 onClick 要过一次）。
    不退的话，回到列表那一屏还停在全屏里 —— 地址栏不见、退出的入口也不明显，
    人会以为卡住了。

    ⚠️ Esc 在全屏状态下会被浏览器**先**拿去退全屏，下面那个 keydown 收不到。
    所以「按两下 Esc 才回到列表」是预期行为：第一下退全屏，第二下退播放器。
    别为了省这一下去监听 fullscreenchange —— 那会和播放器自己的全屏键打架。
  */
  const leave = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    onExit()
  }, [onExit])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leave])

  return (
    // 整个浏览器窗口都交给播放器。bg-black 而不是主题色：画面之外的留白在电视上越不显眼越好
    <div className="flex h-dvh flex-col overflow-hidden bg-black">
      <div className="min-h-0 flex-1">
        {state.status === 'error' ? (
          <p className="flex h-full items-center justify-center px-8 text-center text-white/70">{state.error}</p>
        ) : !game ? (
          <div className="h-full animate-pulse bg-black" />
        ) : (
          <GameAgeGuard game={game}>
            <EmulatorPlayer
              key={game.slug}
              platform={platform}
              gameName={game.title}
              gameSlug={game.slug}
              maxPlayers={game.maxPlayers ?? 1}
              /* 回车进来的就直接开一局 —— 遥控器上再要求按一次「开始游戏」是多余的一步 */
              autoStart
              /*
                fill 是开关，className 的 h-full 是高度链 —— 缺了 fill 这个 h-full 不生效。
                两者必须成对，理由见 EmulatorPlayer 里 embedFill 那段（那里记着实测表）。
              */
              fill
              className="h-full"
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
              romUnreachable={rom.unreachable}
              onRetryRom={rom.retry}
              romLangs={romLangsOf(game)}
              romLang={rom.lang}
              onRomLangChange={setRomLang}
              backdrop={
                <GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />
              }
            />
          </GameAgeGuard>
        )}
      </div>

      {/* 退回列表。遥控器按返回键也行（上面的 Esc / Backspace），这颗是给鼠标和触屏留的 */}
      <button
        type="button"
        onClick={leave}
        className="absolute left-4 top-4 z-50 rounded-full border border-white/25 bg-black/60 px-4 py-2 text-xs font-semibold text-white backdrop-blur"
      >
        ← {t.tv.backToList}
      </button>
      <span className="sr-only">{game ? gameTitle(game, lang) : slug}</span>
    </div>
  )
}
