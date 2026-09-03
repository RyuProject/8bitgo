/**
 * 统一模拟器工具栏：暂停 / 存档 / 音量 / 手柄 / 截屏 / 录像。
 *
 * 各引擎的能力不一样（云联机暂停不了、Flash 没有存档……），
 * 所以按钮是按运行时上报的 caps 集合动态显示的 —— 支持才亮，不支持直接不画。
 *
 * 录像有硬上限 60 秒，录完当场下载到本地，全程不经过服务器。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Capability, RuntimeHandle, RuntimeId } from './types'
import { canRecord, downloadBlob, mediaFileName, startRecording, MAX_RECORD_MS, type Recorder } from './recorder'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { asSaveRuntime, cloudSavesEnabled, pullSave, pushSave, saveInfo, type SaveWhere } from '@/services/saves'
import { cx } from '@/lib/format'

interface Props {
  handle: RuntimeHandle | null
  caps: Set<Capability>
  gameName: string
  /** 存档按它归档。没有 slug（玩家自己传的 ROM）就只能导出成文件 */
  gameSlug?: string
  /** 哪个引擎 —— 内存快照和 DOS 变更包不通用，必须分开存 */
  runtimeId?: RuntimeId
  /**
   * 这款 DOS 游戏自己的存档说明（后台逐游戏填，如「按 F2 存档 / F3 读档」）。
   * 留空就只显示通用的三步说明 —— DOS 游戏的存档键各家不同，通用文案只能给最常见的 ESC / F1。
   */
  dosSaveHint?: string
  className?: string
}

/** 「3 分钟前」。用浏览器自带的本地化，不用为此加一堆文案键 */
function timeAgo(ts: number, lang: string): string {
  const sec = Math.max(1, Math.round((Date.now() - ts) / 1000))
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always' })
    if (sec < 60) return rtf.format(-sec, 'second')
    if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute')
    if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour')
    return rtf.format(-Math.round(sec / 86400), 'day')
  } catch {
    // 老浏览器没有 Intl.RelativeTimeFormat
    return new Date(ts).toLocaleString()
  }
}

const BTN = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-muted transition-colors hover:border-brand hover:text-fg disabled:opacity-40'
const BTN_ON = 'border-brand bg-brand-soft text-brand-hover'

export function EmulatorTools({ handle, caps, gameName, gameSlug, runtimeId, dosSaveHint, className }: Props) {
  const t = useT()
  const lang = useLang()
  const tt = t.player.tools
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(handle?.volume ?? 1)
  const [muted, setMuted] = useState(false)
  const [panel, setPanel] = useState<'volume' | 'gamepad' | 'fsSave' | null>(null)
  /**
   * 移动端：次要按钮（音量 / 手柄 / 另存 / 截屏 / 录像）收进「⋯」里。
   * 桌面端这个 state 不起作用 —— 那一组在 sm: 断点上无条件常驻（见 return 里的 secondaryCls）。
   */
  const [more, setMore] = useState(false)
  const [msg, setMsg] = useState('')
  const [pads, setPads] = useState<string[]>([])
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recRef = useRef<Recorder | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const msgTimer = useRef(0)
  /** 现有存档的落点和时间，用来在读档按钮上显示「云端 · 3 分钟前」 */
  const [archived, setArchived] = useState<{ where: SaveWhere; updatedAt: number; pending?: boolean } | null>(null)
  /**
   * 上一次「保存进度」空手而归（玩家还没在游戏里存盘）。
   * 这个状态只用来把说明面板里的第 ① 步标红 —— toast 4 秒就没了，
   * 而这恰恰是玩家最需要盯着看的一句。
   */
  const [fsSaveFailed, setFsSaveFailed] = useState(false)

  // 存档归档需要「哪个引擎 + 哪个游戏」两个坐标；缺一个就只能走文件导入导出。
  // ⚠️ 必须过 asSaveRuntime 白名单，不能直接把 RuntimeId 断言成 SaveRuntime ——
  // html5（第三方游戏页自己管存储）和 liveview（在看别人直播，没有自己的机器状态）
  // 都不是存档引擎，服务端也不认。以前直接断言的结果是：看直播的人一进页面
  // 就发一个注定被 400 掉的 /api/saves/liveview/... 查询。
  const saveRuntime = asSaveRuntime(runtimeId)
  const archivable = Boolean(saveRuntime && gameSlug)
  const toCloud = cloudSavesEnabled()

  const say = useCallback((text: string) => {
    setMsg(text)
    window.clearTimeout(msgTimer.current)
    msgTimer.current = window.setTimeout(() => setMsg(''), 4000)
  }, [])

  // 换游戏 / 卸载时把状态清干净，别让上一局的「暂停中」留在界面上
  useEffect(() => {
    setPaused(false)
    setPanel(null)
    setMore(false)
    setMsg('')
    setFsSaveFailed(false)
    setMuted(false)
    setVolume(handle?.volume ?? 1)
    return () => {
      recRef.current?.cancel()
      recRef.current = null
      setRecording(false)
      window.clearTimeout(msgTimer.current)
    }
  }, [handle])

  // 进游戏时问一次「这个游戏有没有存档」，读档按钮上要显示
  useEffect(() => {
    let alive = true
    setArchived(null)
    if (!archivable || !saveRuntime || !gameSlug) return
    void saveInfo(saveRuntime, gameSlug).then((info) => {
      if (alive && info) setArchived({ where: info.where, updatedAt: info.updatedAt, pending: info.pending })
    })
    return () => {
      alive = false
    }
  }, [archivable, saveRuntime, gameSlug, handle])

  /*
    手柄面板开着的时候才轮询，平时不占 CPU。

    ⚠️ 不能只读外层的 navigator.getGamepads()。手柄对每个文档是**分别**可见的
    （规范里的 [[hasGamepadGesture]]：玩家按下手柄按键那一刻，只有当时有焦点的文档
    才拿得到手柄）。EmulatorJS 这类跑在 iframe 里的运行时，我们开局后会把焦点交给
    iframe（见 frameFocus.ts）—— 于是手柄只对 iframe 可见，外层这边读到的是空的。
    照那样显示，就会出现「手柄明明能操作游戏，面板却说没检测到」。
    所以两边取**并集**：运行时那侧报上来的（handle.gamepads）加外层自己看到的。
  */
  useEffect(() => {
    if (panel !== 'gamepad') return
    const scan = () => {
      const outer = navigator.getGamepads ? navigator.getGamepads() : []
      const ids = new Set<string>(handle?.gamepads?.() ?? [])
      for (const pad of Array.from(outer)) if (pad?.connected) ids.add(pad.id)
      setPads([...ids])
    }
    scan()
    const timer = window.setInterval(scan, 1000)
    return () => window.clearInterval(timer)
  }, [panel, handle])

  /*
    面板一关就把焦点还给运行时。玩家点 🎮 那一下焦点就落到了外层的按钮上，
    iframe 里的引擎从这一刻起收不到键盘、也读不到手柄 —— 关面板正是还回去的时机。
  */
  const prevPanel = useRef(panel)
  useEffect(() => {
    const was = prevPanel.current
    prevPanel.current = panel
    // 只在「开着 → 关上」那一下还，不是每次 render 都抢一把：
    // 播放器自己也在开局时给过一次，重复抢焦点会把玩家正在用的别的控件顶掉
    if (panel === null && was !== null) handle?.focus?.()
  }, [panel, handle])

  // 录像计时（同时也是 60 秒上限的进度显示）
  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setElapsed(recRef.current?.elapsed() ?? 0), 200)
    return () => window.clearInterval(timer)
  }, [recording])

  if (!handle || caps.size === 0) return null

  const applyVolume = (v: number, mute: boolean) => {
    setVolume(v)
    setMuted(mute)
    handle.setVolume?.(mute ? 0 : v)
  }

  const togglePause = () => {
    const next = !paused
    setPaused(next)
    handle.setPaused?.(next)
  }

  const whereLabel = (w: SaveWhere, pending?: boolean) =>
    w === 'cloud' ? tt.whereCloud : pending ? tt.whereLocalPending : tt.whereLocal

  /**
   * 存到哪儿了，用同一套话说清楚 —— 玩家最关心的就是「换台电脑还在不在」。
   *
   * cloudError 有值 = 玩家是登录状态、本该进云端，但云端那一路失败了。
   * 这句必须说出来：只回一句「已存在这个浏览器里」的话，一个已登录的玩家
   * 会以为存档跟着账号走了，而撞上配额或者令牌过期之后其实一直没有。
   */
  const sayStored = (where: SaveWhere, cloudError?: string) => {
    setArchived({ where, updatedAt: Date.now(), pending: Boolean(cloudError) })
    if (cloudError) {
      say(fmt(tt.saveCloudFailed, { msg: cloudError }))
      return
    }
    say(where === 'cloud' ? tt.saveCloudOk : tt.saveLocalOk)
  }

  /**
   * 存档（内存快照式的引擎）。
   * 登录了进云端跟着账号走；没登录就落在这个浏览器里，随时能再导出成文件。
   */
  const doSave = async () => {
    try {
      const blob = await handle.saveState?.()
      if (handle.saveMode === 'remote') {
        say(tt.saveRemote)
        return
      }
      if (!blob) {
        say(tt.saveFail)
        return
      }
      if (archivable && saveRuntime && gameSlug) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const r = await pushSave(saveRuntime, gameSlug, bytes)
        if (r.ok && r.where) {
          sayStored(r.where, r.cloudFailed ? r.error : undefined)
          return
        }
        // 云端和浏览器都写不进去（超配额、太大、无痕模式）：
        // 退回下载成文件，总之不能让玩家的进度就这么没了
        downloadBlob(blob, mediaFileName(gameName, handle.saveExt ?? 'state'))
        say(fmt(tt.saveFellBack, { msg: r.error ?? '' }))
        return
      }
      downloadBlob(blob, mediaFileName(gameName, handle.saveExt ?? 'state'))
      say(tt.saveOk)
    } catch (e) {
      say(e instanceof Error && e.message ? e.message : tt.saveFail)
    }
  }

  /**
   * 保存进度（DOS）。
   * 和上面不是一回事：它固化的是**盘上被改过的文件**，
   * 所以玩家必须先在游戏里用游戏自己的存档功能存过盘，这里才有东西可存。
   *
   * ⚠️ 这一步只在玩家看过说明面板、点了「我已经在游戏里存过盘了」之后才执行 ——
   * 直接点按钮就存的老行为，最常见的结局是存下一个空包，玩家却以为进度已经保住了。
   */
  const doFsSave = async () => {
    try {
      const r = await handle.fsSave?.()
      if (!r?.ok) {
        // reason 'nothing' = 盘上没有新写出的文件，游戏里还没存过。面板留着并把
        // 第 ① 步标红，比一条 4 秒就消失的 toast 更能让人看懂下一步要做什么。
        if (!r || r.reason === 'nothing') {
          setFsSaveFailed(true)
          setPanel('fsSave')
          say(tt.fsSaveNothing)
          return
        }
        // 'failed' = 引擎或者两边的存储都没成功。这是真的错误，不该让玩家
        // 去游戏里反复存盘 —— 那不是他的问题
        say(r.error ? fmt(tt.fsSaveFailed, { msg: r.error }) : tt.saveFail)
        return
      }
      setFsSaveFailed(false)
      setPanel(null)
      // where 一定有值：fsSave 只在 push 钩子真的落过盘时才返回 ok
      sayStored(r.where ?? (toCloud ? 'cloud' : 'local'), r.error)
    } catch (e) {
      say(e instanceof Error && e.message ? e.message : tt.saveFail)
    }
  }

  /** 从文件读档 */
  const doLoadFile = async (file: File | null | undefined) => {
    if (!file) return
    try {
      const note = await handle.loadState?.(await file.arrayBuffer())
      say(typeof note === 'string' && note ? note : tt.loadOk)
    } catch (e) {
      say(fmt(tt.loadFail, { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  /** 读档：有存好的就读那份，没有就让他选个文件 */
  const doLoad = async () => {
    if (archivable && saveRuntime && gameSlug) {
      try {
        const got = await pullSave(saveRuntime, gameSlug)
        if (got) {
          // slice() 保证拿到的是一段独立的 buffer，不受原数组偏移影响
          const note = await handle.loadState?.(got.data.slice().buffer)
          setArchived({ where: got.where, updatedAt: got.updatedAt, pending: got.pending })
          say(
            typeof note === 'string' && note
              ? note
              : fmt(tt.loadFrom, { where: whereLabel(got.where, got.pending) }),
          )
          return
        }
      } catch (e) {
        say(fmt(tt.loadFail, { msg: e instanceof Error ? e.message : String(e) }))
        return
      }
    }
    fileRef.current?.click()
  }

  /** 另存为文件：玩家想自己保管一份，或者换个站点 / 换台机器带过去 */
  const doExport = async () => {
    try {
      const blob = await handle.saveState?.()
      if (!blob) {
        say(tt.saveFail)
        return
      }
      downloadBlob(blob, mediaFileName(gameName, handle.saveExt ?? 'state'))
      say(tt.saveOk)
    } catch (e) {
      say(e instanceof Error && e.message ? e.message : tt.saveFail)
    }
  }

  const doShot = async () => {
    try {
      const blob = await handle.screenshot?.()
      if (!blob) {
        say(tt.shotFail)
        return
      }
      downloadBlob(blob, mediaFileName(gameName, 'png'))
      say(tt.shotOk)
    } catch {
      say(tt.shotFail)
    }
  }

  const finishRecording = async (prefix?: string) => {
    const rec = recRef.current
    recRef.current = null
    setRecording(false)
    setElapsed(0)
    if (!rec) return
    const out = await rec.stop()
    if (!out) {
      say(tt.recFail)
      return
    }
    downloadBlob(out.blob, mediaFileName(gameName, out.blob.type.includes('mp4') ? 'mp4' : 'webm'))
    say(prefix ? `${prefix} · ${tt.recOk}` : tt.recOk)
  }

  const toggleRecord = () => {
    if (recRef.current) {
      void finishRecording()
      return
    }
    const sources = handle.captureSources?.()
    if (!sources || !canRecord(sources)) {
      say(tt.recFail)
      return
    }
    const rec = startRecording(sources, {
      maxMs: MAX_RECORD_MS,
      // 录满自动停：这里同样走下载流程，玩家不会白录一场
      onAutoStop: () => void finishRecording(tt.recAuto),
    })
    if (!rec) {
      say(tt.recFail)
      return
    }
    recRef.current = rec
    setElapsed(0)
    setRecording(true)
    say(tt.recHint)
  }

  const seconds = Math.min(60, Math.floor(elapsed / 1000))

  /**
   * 这一局到底有没有「次要按钮」。
   * 全都不支持时（比如 html5 的第三方游戏页）就别画那个「⋯」—— 点开是空的。
   */
  const hasSecondary =
    caps.has('volume') || caps.has('gamepad') || caps.has('screenshot') || caps.has('record') || (caps.has('saveState') && archivable)

  return (
    <div className={cx('relative flex flex-wrap items-center gap-1.5', className)}>
      {caps.has('pause') && (
        <button type="button" className={cx(BTN, paused && BTN_ON)} onClick={togglePause} title={paused ? tt.resume : tt.pause} aria-pressed={paused}>
          {paused ? '▶' : '⏸'}
        </button>
      )}

      {/* DOS：只有「保存进度」一个动作。它没有「某一帧」的概念，也没有可下载的文件，
          下次进游戏时引擎会自己把改动装回去，所以不需要读档按钮。
          点它先开说明面板而不是直接存 —— 见下面 panel === 'fsSave' 那段 */}
      {caps.has('fsSave') && (
        <button
          type="button"
          className={cx(BTN, panel === 'fsSave' && BTN_ON)}
          onClick={() => {
            setFsSaveFailed(false)
            setPanel(panel === 'fsSave' ? null : 'fsSave')
          }}
          title={`${tt.fsSave} · ${tt.fsSaveHint}`}
          aria-expanded={panel === 'fsSave'}
        >
          💾
        </button>
      )}

      {caps.has('saveState') && (
        <>
          <button type="button" className={BTN} onClick={() => void doSave()} title={tt.save}>
            💾
          </button>
          {handle.loadState && (
            <button
              type="button"
              className={BTN}
              onClick={() => void doLoad()}
              title={
                archived
                  ? fmt(tt.loadTitle, {
                      where: whereLabel(archived.where, archived.pending),
                      when: timeAgo(archived.updatedAt, lang),
                    })
                  : tt.load
              }
            >
              📂
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              void doLoadFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </>
      )}

      {/*
        次要按钮组。手机上收进「⋯」，桌面端常驻。

        为什么不在移动端和桌面端各画一份：那样每个按钮都有两个实例，
        录像中的那个一旦被 CSS 藏掉，另一份的 recRef 状态是对不上的。
        所以只画一份，靠同一个容器换定位方式 —— 手机上是弹出层（absolute + hidden），
        到 sm: 断点全部改回普通的行内一段（static + flex）。
      */}
      <div
        data-testid="emulator-tools-more"
        className={cx(
          'items-center gap-1.5',
          more
            ? 'absolute bottom-full left-0 z-30 mb-2 flex max-w-[calc(100vw-2rem)] flex-wrap rounded-lg border border-line bg-surface px-2 py-2 shadow-lg'
            : 'hidden',
          'sm:static sm:z-auto sm:mb-0 sm:flex sm:max-w-none sm:flex-wrap sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none',
        )}
      >
        {caps.has('volume') && (
          <button
            type="button"
            className={cx(BTN, panel === 'volume' && BTN_ON)}
            onClick={() => {
              setPanel(panel === 'volume' ? null : 'volume')
              setMore(false)
            }}
            title={tt.volume}
            aria-expanded={panel === 'volume'}
          >
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
        )}

        {caps.has('gamepad') && (
          <button
            type="button"
            className={cx(BTN, panel === 'gamepad' && BTN_ON)}
            onClick={() => {
              setPanel(panel === 'gamepad' ? null : 'gamepad')
              setMore(false)
            }}
            title={tt.gamepad}
            aria-expanded={panel === 'gamepad'}
          >
            🎮
          </button>
        )}

        {/* 存档已经进了云端或浏览器时，再给一条「自己保管一份」的出口 */}
        {archivable && (
          <button type="button" className={BTN} onClick={() => void doExport()} title={tt.exportFile}>
            📥
          </button>
        )}

        {caps.has('screenshot') && (
          <button type="button" className={BTN} onClick={() => void doShot()} title={tt.shot}>
            📷
          </button>
        )}

        {caps.has('record') && (
          <button
            type="button"
            className={cx(BTN, recording && 'border-live bg-live/15 text-live')}
            onClick={toggleRecord}
            title={recording ? fmt(tt.recStop, { s: String(seconds) }) : tt.rec}
            aria-pressed={recording}
          >
            {recording ? <span className="tabular-nums">⏹ {seconds}s</span> : '⏺'}
          </button>
        )}
      </div>

      {/* 「⋯」只在手机上出现，也只在这一组真有东西可收的时候出现 */}
      {hasSecondary && (
        <button
          type="button"
          className={cx(BTN, more && BTN_ON, 'sm:hidden')}
          onClick={() => {
            setMore((v) => !v)
            setPanel(null)
          }}
          title={tt.more}
          aria-label={tt.more}
          aria-expanded={more}
        >
          ⋯
        </button>
      )}

      {msg && <span className="max-w-[16rem] truncate text-muted">{msg}</span>}

      {panel === 'volume' && (
        <div className="absolute bottom-full left-0 z-20 mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-lg">
          <button type="button" className={BTN} onClick={() => applyVolume(volume, !muted)} title={muted ? tt.unmute : tt.mute}>
            {muted ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => applyVolume(Number(e.target.value) / 100, false)}
            className="w-32 accent-brand"
            aria-label={tt.volume}
          />
          <span className="w-8 tabular-nums text-muted">{Math.round((muted ? 0 : volume) * 100)}</span>
        </div>
      )}

      {panel === 'gamepad' && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface px-3 py-2 shadow-lg">
          <p className={cx('font-semibold', pads.length ? 'text-online' : 'text-muted')}>
            {pads.length ? fmt(tt.gamepadOn, { n: String(pads.length) }) : tt.gamepadOff}
          </p>
          {pads.map((id) => (
            <p key={id} className="mt-1 truncate text-muted" title={id}>
              · {id}
            </p>
          ))}
          {/* 红白机的映射是我们自己实现的（见 gamepadInput.ts），所以能把具体键位说清楚；
              别的引擎是引擎自带的映射，只能给一句笼统的 */}
          <p className="mt-2 border-t border-line pt-2 text-muted">
            {runtimeId === 'jsnes' ? tt.gamepadHintNes : tt.gamepadHint}
          </p>
        </div>
      )}

      {/*
        DOS 存档说明。
        为什么要拦这一下：js-dos 存的是**盘上被改过的文件**，不是内存快照 ——
        玩家不先在游戏里存盘，点多少次都只是把一个没有变化的盘固化一遍。
        原来这句话只在按钮的 title 里，手机上根本没有 hover，等于没说。
      */}
      {panel === 'fsSave' && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface px-3 py-2 shadow-lg">
          <p className="font-semibold text-fg">{tt.fsSave}</p>
          <p className="mt-1 text-muted">{tt.fsSaveWhy}</p>
          <ol className="mt-2 space-y-1">
            {/* 空手而归时把第 ① 步标出来：问题百分之百出在这一步 */}
            <li className={fsSaveFailed ? 'font-semibold text-live' : 'text-muted'}>{tt.fsSaveStep1}</li>
            <li className="text-muted">{fmt(tt.fsSaveStep2, { where: whereLabel(toCloud ? 'cloud' : 'local') })}</li>
            <li className="text-muted">{tt.fsSaveStep3}</li>
          </ol>
          {/* 后台给这款游戏填了具体按键就顶上来 —— 比通用的「ESC 或 F1」有用得多 */}
          {dosSaveHint && (
            <p className="mt-2 rounded-md bg-brand-soft px-2 py-1 text-brand-hover">
              {fmt(tt.fsSaveGameHint, { hint: dosSaveHint })}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 border-t border-line pt-2">
            <button
              type="button"
              className={cx(BTN, 'px-2 border-brand text-brand-hover')}
              onClick={() => void doFsSave()}
            >
              💾 {tt.fsSaveConfirm}
            </button>
            <button type="button" className={cx(BTN, 'px-2')} onClick={() => setPanel(null)}>
              {tt.fsSaveCancel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
