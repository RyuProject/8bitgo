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
import { cloudSavesEnabled, pullSave, pushSave, saveInfo, type SaveRuntime, type SaveWhere } from '@/services/saves'
import { cx } from '@/lib/format'

interface Props {
  handle: RuntimeHandle | null
  caps: Set<Capability>
  gameName: string
  /** 存档按它归档。没有 slug（玩家自己传的 ROM）就只能导出成文件 */
  gameSlug?: string
  /** 哪个引擎 —— 内存快照和 DOS 变更包不通用，必须分开存 */
  runtimeId?: RuntimeId
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

export function EmulatorTools({ handle, caps, gameName, gameSlug, runtimeId, className }: Props) {
  const t = useT()
  const lang = useLang()
  const tt = t.player.tools
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(handle?.volume ?? 1)
  const [muted, setMuted] = useState(false)
  const [panel, setPanel] = useState<'volume' | 'gamepad' | null>(null)
  const [msg, setMsg] = useState('')
  const [pads, setPads] = useState<string[]>([])
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recRef = useRef<Recorder | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const msgTimer = useRef(0)
  /** 现有存档的落点和时间，用来在读档按钮上显示「云端 · 3 分钟前」 */
  const [archived, setArchived] = useState<{ where: SaveWhere; updatedAt: number } | null>(null)

  // 存档归档需要「哪个引擎 + 哪个游戏」两个坐标；缺一个就只能走文件导入导出
  const saveRuntime = (runtimeId ?? null) as SaveRuntime | null
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
    setMsg('')
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
      if (alive && info) setArchived({ where: info.where, updatedAt: info.updatedAt })
    })
    return () => {
      alive = false
    }
  }, [archivable, saveRuntime, gameSlug, handle])

  // 手柄面板开着的时候才轮询，平时不占 CPU
  useEffect(() => {
    if (panel !== 'gamepad') return
    const scan = () => {
      const list = navigator.getGamepads ? navigator.getGamepads() : []
      setPads(Array.prototype.filter.call(list, (p: Gamepad | null) => p?.connected).map((p: Gamepad) => p.id))
    }
    scan()
    const timer = window.setInterval(scan, 1000)
    return () => window.clearInterval(timer)
  }, [panel])

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

  const whereLabel = (w: SaveWhere) => (w === 'cloud' ? tt.whereCloud : tt.whereLocal)

  /** 存到哪儿了，用同一套话说清楚 —— 玩家最关心的就是「换台电脑还在不在」 */
  const sayStored = (where: SaveWhere) => {
    setArchived({ where, updatedAt: Date.now() })
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
          sayStored(r.where)
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
   */
  const doFsSave = async () => {
    try {
      const r = await handle.fsSave?.()
      if (!r?.ok) {
        say(tt.fsSaveNothing)
        return
      }
      sayStored(r.where ?? (toCloud ? 'cloud' : 'local'))
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
          setArchived({ where: got.where, updatedAt: got.updatedAt })
          say(typeof note === 'string' && note ? note : fmt(tt.loadFrom, { where: whereLabel(got.where) }))
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

  return (
    <div className={cx('relative flex flex-wrap items-center gap-1.5', className)}>
      {caps.has('pause') && (
        <button type="button" className={cx(BTN, paused && BTN_ON)} onClick={togglePause} title={paused ? tt.resume : tt.pause} aria-pressed={paused}>
          {paused ? '▶' : '⏸'}
        </button>
      )}

      {caps.has('volume') && (
        <button
          type="button"
          className={cx(BTN, panel === 'volume' && BTN_ON)}
          onClick={() => setPanel(panel === 'volume' ? null : 'volume')}
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
          onClick={() => setPanel(panel === 'gamepad' ? null : 'gamepad')}
          title={tt.gamepad}
          aria-expanded={panel === 'gamepad'}
        >
          🎮
        </button>
      )}

      {/* DOS：只有「保存进度」一个动作。它没有「某一帧」的概念，也没有可下载的文件，
          下次进游戏时引擎会自己把改动装回去，所以不需要读档按钮 */}
      {caps.has('fsSave') && (
        <button
          type="button"
          className={BTN}
          onClick={() => void doFsSave()}
          title={`${tt.fsSave} · ${tt.fsSaveHint}`}
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
                  ? fmt(tt.loadTitle, { where: whereLabel(archived.where), when: timeAgo(archived.updatedAt, lang) })
                  : tt.load
              }
            >
              📂
            </button>
          )}
          {/* 存档已经进了云端或浏览器时，再给一条「自己保管一份」的出口 */}
          {archivable && (
            <button type="button" className={BTN} onClick={() => void doExport()} title={tt.exportFile}>
              📥
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

      {caps.has('screenshot') && (
        <button type="button" className={BTN} onClick={() => void doShot()} title={tt.shot}>
          📷
        </button>
      )}

      {caps.has('record') && (
        <button
          type="button"
          className={cx(BTN, recording && 'border-live bg-live/15 text-red-300')}
          onClick={toggleRecord}
          title={recording ? fmt(tt.recStop, { s: String(seconds) }) : tt.rec}
          aria-pressed={recording}
        >
          {recording ? <span className="tabular-nums">⏹ {seconds}s</span> : '⏺'}
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
        <div className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-lg border border-line bg-surface px-3 py-2 shadow-lg">
          <p className={cx('font-semibold', pads.length ? 'text-online' : 'text-muted')}>
            {pads.length ? fmt(tt.gamepadOn, { n: String(pads.length) }) : tt.gamepadOff}
          </p>
          {pads.map((id) => (
            <p key={id} className="mt-1 truncate text-muted" title={id}>
              · {id}
            </p>
          ))}
          <p className="mt-2 border-t border-line pt-2 text-muted">{tt.gamepadHint}</p>
        </div>
      )}
    </div>
  )
}
