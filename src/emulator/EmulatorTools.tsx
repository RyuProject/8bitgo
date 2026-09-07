/**
 * 统一模拟器工具栏：暂停 / 存档 / 音量 / 手柄 / 截屏 / 录像。
 *
 * 各引擎的能力不一样（云联机暂停不了、Flash 没有存档……），
 * 所以按钮是按运行时上报的 caps 集合动态显示的 —— 支持才亮，不支持直接不画。
 *
 * 录像有硬上限 60 秒，录完当场下载到本地，全程不经过服务器。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Capability, RuntimeHandle, RuntimeId, ScreenLayoutState } from './types'
import { layoutToken, showsTouchScreen } from './dualScreen'
import { canRecord, downloadBlob, mediaFileName, startRecording, MAX_RECORD_MS, type Recorder } from './recorder'
import { useT, fmt } from '@/services/i18n'
import { NesKeyBinder } from './NesKeyBinder'
import { useLang } from '@/services/lang'
import {
  asSaveRuntime,
  cloudSavesEnabled,
  fetchCloudSave,
  pullLocalSave,
  pullSave,
  pushSave,
  saveInfo,
  setSaveTarget,
  type SaveTarget,
  type SaveWhere,
  effectiveSaveTarget,
} from '@/services/saves'
import { SaveLoadModal, type SaveLoadCard } from './SaveLoadModal'
import { installHotkeys } from './hotkeyBridge'
import type { HotkeyAction } from '@/services/hotkeys'
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
   * 双屏机型的屏幕布局，由运行时从**核心自报的选项表**里读出来后经 onScreenLayout 报上来
   * （见 dualScreen.ts）。null / 取值不足两个 = 这一局没有布局可切，整块 UI 不画。
   *
   * ⚠️ 当前值只认这里报上来的那一份，别在组件里另存一个 state ——
   * 适配器是唯一的真相，两边各存一份迟早对不上（「屏幕按键」那个开关踩过一次）。
   */
  screenLayout?: ScreenLayoutState | null
  /**
   * 这款 DOS 游戏自己的存档说明（后台逐游戏填，如「按 F2 存档 / F3 读档」）。
   * 留空就只显示通用的三步说明 —— DOS 游戏的存档键各家不同，通用文案只能给最常见的 ESC / F1。
   */
  dosSaveHint?: string
  /**
   * 播放器那一块 DOM（模拟器 iframe 就在里面）。
   * 快捷键要在**游戏正开着**的时候也能按，而那时焦点在 iframe 里 ——
   * 必须从这一块里找到 iframe、在它的文档上也挂一份监听。见 hotkeyBridge.ts。
   */
  stageRef?: RefObject<HTMLElement | null>
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

export function EmulatorTools({ handle, caps, gameName, gameSlug, runtimeId, dosSaveHint,
  screenLayout, stageRef, className }: Props) {
  const t = useT()
  const lang = useLang()
  const tt = t.player.tools

  /**
   * 可选的屏幕布局。**少于两个就等于没有** —— 只有一个取值的选择器没有意义，
   * 引擎自己建设置菜单时也是这么判的（`values.length <= 1` 直接不画那一行）。
   */
  const layoutValues = screenLayout?.values ?? []
  /**
   * 取值 → 中文名。查不到就原样返回核心给的英文（见 dualScreen.layoutToken 的理由）。
   * 写成一张显式表而不是 `tt['layout' + token]`：那种拼键取字符串在 TS 里要么得 any、
   * 要么得给 locale 加索引签名，两条都会把「文案键写错了」从编译错误降级成线上空白。
   */
  const layoutLabel = (value: string): string => {
    switch (layoutToken(value)) {
      case 'StackTop':
        return tt.layoutStackTop
      case 'StackBottom':
        return tt.layoutStackBottom
      case 'SideLeft':
        return tt.layoutSideLeft
      case 'SideRight':
        return tt.layoutSideRight
      case 'TopOnly':
        return tt.layoutTopOnly
      case 'BottomOnly':
        return tt.layoutBottomOnly
      case 'HybridTop':
        return tt.layoutHybridTop
      case 'HybridBottom':
        return tt.layoutHybridBottom
      default:
        return value
    }
  }
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(handle?.volume ?? 1)
  const [muted, setMuted] = useState(false)
  const [panel, setPanel] = useState<'volume' | 'gamepad' | 'fsSave' | null>(null)
  /**
   * handle 走 ref 给快捷键那个 effect 用。
   *
   * 那个 effect 的依赖列表里**没有** handle（下面有 eslint-disable），
   * 直接在回调里引用会把挂载那一刻的 handle 闭包捕获死 —— 换游戏之后
   * 「引擎开着弹窗吗」问的还是上一局那个引擎。
   */
  const handleRef = useRef(handle)
  handleRef.current = handle
  /** 存档面板（三张卡：云端 / 这个浏览器 / 文件）。见 SaveLoadModal.tsx */
  const [saveModal, setSaveModal] = useState(false)
  /** DOS「固化存档」正在飞：按钮压住，别让连点把 lastPush 判断搞反（见 doFsSave） */
  const [fsSaving, setFsSaving] = useState(false)
  /**
   * 移动端：次要按钮（音量 / 手柄 / 另存 / 截屏 / 录像）收进「⋯」里。
   * 桌面端这个 state 不起作用 —— 那一组在 sm: 断点上无条件常驻（见 return 里的 secondaryCls）。
   */
  const [more, setMore] = useState(false)
  const [msg, setMsg] = useState('')
  const [pads, setPads] = useState<string[]>([])
  /** 鼠标上下反转（DOS 射击游戏）。初值从句柄读，之后本地维护 —— 和音量一样的做法 */
  const [mouseInv, setMouseInv] = useState(Boolean(handle?.mouseInverted))
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
    setMouseInv(Boolean(handle?.mouseInverted))
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
  const doSave = async (target: SaveTarget) => {
    setPanel(null)
    /*
      ⚠️ 弹窗也要关，和 loadFrom 对齐。
      不关的话，唯一的反馈 say() 画在工具栏上、被弹窗那层 `inset-0 bg-black/50` 的遮罩
      整个盖住 —— 而 N64 / PSX 的快照推云端要好几秒，这几秒里面板一动不动、没有任何提示。
      玩家判定「没反应」就会连点，于是对同一个档位并发好几次 saveState + pushSave，
      最终落盘的可能是较早那一份。
    */
    setSaveModal(false)
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
      // 「下载」不是存到哪儿，是不存、直接给他文件
      if (target === 'download') {
        downloadBlob(blob, mediaFileName(gameName, handle.saveExt ?? 'state'))
        say(tt.saveOk)
        return
      }
      if (archivable && saveRuntime && gameSlug) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const r = await pushSave(saveRuntime, gameSlug, bytes, 0, target)
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
      /**
       * where 说不出来就别替它编。以前这里退回 `toCloud ? 'cloud' : 'local'` —— 而 toCloud
       * 只是「这个部署开了云存档」这个全局开关，**不代表这一次真的写进了云端**。
       * 没登录的玩家存 DOS 游戏，东西只落在本机，界面却说「已存到云端」，
       * 他换台设备就发现进度不见了，而我们明明告诉过他相反的话。
       */
      if (!r.where) {
        say(tt.saveFail)
        return
      }
      sayStored(r.where, r.error)
    } catch (e) {
      say(e instanceof Error && e.message ? e.message : tt.saveFail)
    } finally {
      setFsSaving(false)
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

  /**
   * 从指定的地方读档。
   *
   * 和 doLoad() 的分工：那个是「读现有的最好那份」（快捷读档按钮用），
   * 这个是玩家在面板里点了某一张卡的「读档」—— 他要的就是**那儿**的那份，
   * 这时候再去别处找等于答非所问。空了就直说，别悄悄读了别的地方的。
   */
  const loadFrom = async (from: 'cloud' | 'local') => {
    if (!archivable || !saveRuntime || !gameSlug) return
    setSaveModal(false)
    try {
      const got = from === 'cloud' ? await fetchCloudSave(saveRuntime, gameSlug) : await pullLocalSave(saveRuntime, gameSlug)
      if (!got) {
        say(tt.saveLoadNothing)
        return
      }
      // slice() 保证拿到的是一段独立的 buffer，不受原数组偏移影响
      const note = await handle.loadState?.(got.data.slice().buffer)
      setArchived({ where: from, updatedAt: got.updatedAt })
      say(typeof note === 'string' && note ? note : fmt(tt.loadFrom, { where: whereLabel(from) }))
    } catch (e) {
      say(fmt(tt.loadFail, { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  /**
   * 面板上那三张卡。
   *
   * 云存档排第一 —— 它是唯一「换台设备还在」的选项。没登录时整张卡压暗、
   * 标题旁边写「需要登录」：灰一个按钮却不说为什么，玩家只会以为是坏了。
   *
   * 每次点「保存」都把这次的选择记下来（setSaveTarget）：DOS 那条自动固化存档的路
   * 没有界面可问，走的就是这个记忆；没记过就落本地，不会偷偷上云。
   */
  const saveCards: SaveLoadCard[] = [
    {
      id: 'cloud',
      saveKey: 'save:cloud',
      loadKey: 'load:cloud',
      title: tt.saveCardCloud,
      desc: tt.saveCardCloudDesc,
      disabled: !toCloud || !archivable,
      disabledNote: toCloud ? undefined : tt.saveNeedLogin,
      onSave: () => {
        setSaveTarget('cloud')
        void doSave('cloud')
      },
      onLoad: () => void loadFrom('cloud'),
    },
    {
      id: 'local',
      saveKey: 'save:local',
      loadKey: 'load:local',
      title: tt.saveCardLocal,
      desc: tt.saveCardLocalDesc,
      disabled: !archivable,
      onSave: () => {
        setSaveTarget('local')
        void doSave('local')
      },
      onLoad: () => void loadFrom('local'),
    },
    {
      id: 'download',
      saveKey: 'save:file',
      loadKey: 'load:file',
      // 文件这一路不需要 archivable：没有 slug 的本地 ROM 也能把存档下载下来带走
      title: tt.saveCardFile,
      desc: tt.saveCardFileDesc,
      onSave: () => {
        setSaveTarget('download')
        void doSave('download')
      },
      onLoad: () => {
        setSaveModal(false)
        fileRef.current?.click()
      },
    },
  ]

  /**
   * 装上存 / 读档的快捷键。
   *
   * 依赖里带 saveCards 是因为每张卡的动作闭包着 handle / gameSlug；
   * 换了游戏、换了引擎都要重挂一遍，否则快捷键还在对上一局操作。
   */
  useEffect(() => {
    if (!caps.has('saveState')) return
    const byAction: Record<HotkeyAction, (() => void) | undefined> = {
      'save:cloud': saveCards[0].disabled ? undefined : saveCards[0].onSave,
      'load:cloud': saveCards[0].disabled ? undefined : saveCards[0].onLoad,
      'save:local': saveCards[1].disabled ? undefined : saveCards[1].onSave,
      'load:local': saveCards[1].disabled ? undefined : saveCards[1].onLoad,
      'save:file': saveCards[2].onSave,
      'load:file': saveCards[2].onLoad,
    }
    return installHotkeys(
      stageRef?.current ?? null,
      (action) => byAction[action]?.(),
      // 引擎自己开着弹窗（改键面板等按键、金手指、联机）时让开，见 hotkeyBridge 里那段注释
      () => handleRef.current?.popupOpen?.() === true,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps, saveCards, stageRef])

  /** 另存为文件：玩家想自己保管一份，或者换个站点 / 换台机器带过去 */
  const doExport = async () => {
    /*
      ⚠️ 必须在调 saveState 之前判。
      云联机的 saveState 是把状态**存到服务器**然后 return null（本地没有可导出的文件）。
      以前直接调下去：服务器上那份存档被这一刻的状态盖掉了，而界面见到 null 报的是
      「保存失败」—— 玩家以为什么都没发生，其实他想回退到的那份更早的进度已经没了。
      doSave 早就有这道判断，doExport 一直没抄。
    */
    if (handle.saveMode === 'remote') {
      say(tt.saveRemote)
      return
    }
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
    caps.has('volume') ||
    caps.has('gamepad') ||
    caps.has('screenshot') ||
    caps.has('record') ||
    (caps.has('saveState') && archivable) ||
    Boolean(handle.setMouseInvert)

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
          {/*
            存档 / 读档都进这一个面板。

            以前点一下就存，而且登录用户一律「本地 + 顺手上云」—— 玩家从没被问过。
            存档是他自己的东西，存在哪儿该他说了算，所以现在点开是三张卡：
            云端 / 这个浏览器 / 文件，每张自己带「读」和「存」。
          */}
          <button type="button" className={BTN} onClick={() => setSaveModal(true)} title={tt.saveLoadTitle}>
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

        {/*
          鼠标上下反转。只有 js-dos 开了相对鼠标（射击类，见 emulator/mouseCapture.ts）的那一局
          才有 setMouseInvert。Build 引擎那批 DOS 射击游戏（毁灭公爵 3D、影武者、血祭…）出厂默认
          前推 = 低头，当年要进 SETUP.EXE 才翻得过来，网页里玩家进不了 SETUP，只能在这儿翻。
          按游戏记忆（见 adapters/jsdos.ts），亮着 = 这款游戏已经反转。
        */}
        {handle.setMouseInvert && (
          <button
            type="button"
            className={cx(BTN, mouseInv && BTN_ON)}
            onClick={() => {
              const next = !mouseInv
              handle.setMouseInvert?.(next)
              setMouseInv(next)
              say(next ? tt.mouseYOn : tt.mouseYOff)
            }}
            title={mouseInv ? tt.mouseYInverted : tt.mouseYNormal}
            aria-label={tt.mouseY}
            aria-pressed={mouseInv}
          >
            🖱️
          </button>
        )}

        {/* 存档已经进了云端或浏览器时，再给一条「自己保管一份」的出口。
            条件要和 hasSecondary 那边一致，并且必须带上 saveState —— 导出走的就是它。
            DOS 是 saveRuntime 但只有 fsSave，少这一条的话按钮照画，点了永远是「保存失败」 */}
        {archivable && caps.has('saveState') && (
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
        <div
          className={cx(
            'absolute bottom-full left-0 z-20 mb-2 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-line bg-surface px-3 py-2 shadow-lg',
            // 红白机那一路多一整块改键表格，w-64 摆不下两列；
            // 双屏布局那一排是八个中文选项，同样要宽一点，并且要能滚
            runtimeId === 'jsnes' || layoutValues.length > 1 ? 'max-h-[70vh] w-72' : 'w-64',
          )}
        >
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

          {/*
            键盘改键分两路：
              红白机（jsnes）—— 映射是我们自己实现的，界面就在这儿（NesKeyBinder）；
              EmulatorJS  —— 引擎自带一套更全的（1P~4P、键盘+手柄、清空/恢复默认、
                             自己持久化、按钮清单跟着平台变），我们只补一个入口。
                             它的面板挂在播放器根元素上，不在被我们藏掉的那条底栏里，
                             所以一句 controlMenu.style.display='' 就弹得出来
                             （见 adapters/emulatorjs.ts 的 openControls）。
              DOS / Flash / J2ME —— 键盘直通给游戏，我们确实插不上手。

            为什么值得有：按钮名是 libretro 那套（A/B/X/Y/L/R/L2/R2），而游戏把什么
            动作绑在哪个按钮上是**游戏自己**定的 —— 比如有些赛车游戏油门在 R2，
            默认键盘映射下就是 `R` 键，玩家看着键位表也想不到那是油门。能改就够了。
          */}
          {runtimeId === 'jsnes' && <NesKeyBinder />}
          {caps.has('remapKeys') && handle?.openControls && (
            <div className="mt-2 border-t border-line pt-2">
              <button
                type="button"
                onClick={() => {
                  handle.openControls?.()
                  // 面板弹在播放器里、和这个下拉不在一层，留着这个下拉只会挡住它
                  setPanel(null)
                }}
                className="rounded-md border border-line px-2 py-0.5 font-semibold text-fg hover:border-brand hover:text-brand"
              >
                {tt.remapKeys}
              </button>
              <p className="mt-1 text-muted">{tt.remapKeysHint}</p>
            </div>
          )}

          {/*
            双屏布局（NDS）。取值一律用核心自报的原样字符串回填，我们只把它翻成中文
            （见 dualScreen.ts 的 layoutToken）—— 认不出的取值就原样显示英文，
            **不猜一个中文名**：换核心之后同一个词可能是别的意思，硬翻会把玩家骗到。

            为什么摆在这个面板里：NDS 的触摸屏就是下面那块屏，换布局直接决定
            「画面还能不能戳」，跟紧接着那个「屏幕按键」开关是同一件事的两半。
          */}
          {layoutValues.length > 1 && screenLayout && (
            <div className="mt-2 border-t border-line pt-2">
              <p className="font-semibold text-fg">{tt.screenLayout}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {layoutValues.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={value === screenLayout.current}
                    onClick={() => handle.setScreenLayout?.(value)}
                    className={cx(
                      'rounded-md border px-2 py-0.5',
                      value === screenLayout.current
                        ? 'border-brand bg-brand-soft font-semibold text-brand-hover'
                        : 'border-line text-fg hover:border-brand hover:text-brand',
                    )}
                  >
                    {layoutLabel(value)}
                  </button>
                ))}
              </div>
              {/*
                当前布局把触摸屏藏起来了 —— 说清楚，别让玩家以为是坏了。
                适配器这时已经把屏幕按键补上了（见 adapters/emulatorjs.ts 的 syncLayoutInput），
                这句话是把那个「自动」讲明白，不是一句纯警告。
              */}
              {!showsTouchScreen(screenLayout.current) && (
                <p className="mt-1 text-live">{tt.layoutNoTouchWarn}</p>
              )}
              <p className="mt-1 text-muted">{tt.layoutHint}</p>
            </div>
          )}

          {/*
            引擎自带那套屏幕按键的开关。只在触屏设备上出现 —— 桌面端两个能力都不会声明。

            NDS 这类「机器本身就是触屏」的平台默认是收起的：那套按键压在画面下半部分，
            而下屏就是触摸屏（见 adapters/emulatorjs.ts 的 POINTER_FIRST）。
            可马力欧赛车 DS 这种还是要实体按键的，得让玩家自己调回来。

            当前状态直接读 caps —— 适配器每次切换都会重新 onCaps，是同一份真相，
            不在这里另存一个 state，免得两边对不上。
          */}
          {handle.setEnginePad && (caps.has('enginePad') || caps.has('enginePointer')) && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
              <span className="text-muted">{tt.screenPad}</span>
              <button
                type="button"
                onClick={() => handle.setEnginePad?.(!caps.has('enginePad'))}
                className="shrink-0 rounded-md border border-line px-2 py-0.5 font-semibold text-fg hover:border-brand hover:text-brand"
              >
                {caps.has('enginePad') ? tt.screenPadHide : tt.screenPadShow}
              </button>
            </div>
          )}
        </div>
      )}

      {saveModal && <SaveLoadModal cards={saveCards} onClose={() => setSaveModal(false)} />}

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
            {/*
              ⚠️ 落点要读玩家**真正生效**的那个选择（effectiveSaveTarget），不能拿
              `toCloud` 猜 —— 那只是「这个部署开了云存档」这个全局开关。doFsSave 的注释
              早就写明「where 说不出来就别替它编」，可事前这句说明一直在编：
              DOS 会话根本进不去存档落点面板（那个面板要 caps.has('saveState')，
              而 DOS 只有 fsSave），所以对每个 DOS 玩家实际落点恒为本地，
              而这句话恒告诉他「存到云端」—— 他会照着它决定「我存好了，可以换台电脑了」。
            */}
            <li className="text-muted">{fmt(tt.fsSaveStep2, { where: whereLabel(effectiveSaveTarget()) })}</li>
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
              disabled={fsSaving}
              className={cx(BTN, 'px-2 border-brand text-brand-hover', fsSaving && 'opacity-60')}
              onClick={() => void doFsSave()}
            >
              💾 {fsSaving ? '…' : tt.fsSaveConfirm}
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
