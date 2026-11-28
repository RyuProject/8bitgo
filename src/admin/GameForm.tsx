import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { ArcadeMameDisk, FlashControlButton, Game, GenreId, PlatformId } from '@/types'
import { LANGUAGES, normalizeRomLanguageCode, romLanguageLabel, ROM_LANGS, type RomSlotLang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { genres } from '@/data/genres'
import { cx } from '@/lib/format'
import {
  bundleDirFor,
  defaultKeyFor,
  defaultMediaKey,
  defaultRomKeyForLang,
  deleteRomObjectsExactly,
  dirOfKey,
  getRomConfig,
  guessUploadType,
  isBundleKey,
  keepsOriginalFileName,
  listRomObjects,
  clearRomProbeCache,
  copyRomToSockdriveStaging,
  headRom,
  pingRomApi,
  probeRom,
  romUrlForKey,
  uploadRom,
  type UploadStage,
} from '@/services/roms'
import { bundleBytes, bundleWarnings, pickMainSwf, planSwfBundleFromZip, type SwfBundleFile, type SwfBundlePlan } from '@/lib/swfBundle'
import { assertValidZip, assertValidZipBlob, clearValidatedZipBlobLocalHeaders, extractZipEntry, isZip, type ZipFileEntry } from '@/lib/unzip'
import { inspectPlayArcadeBundle } from '@/lib/playArcadeBundle'
import { arcadeArchiveLayoutProblem } from '@/lib/arcadeArchive'
import { arcadeArchiveUnsafePathProblem } from '@/lib/namcoSystem11'
import { identifyNamcoMameSet, namcoMameStatusNote, type NamcoMameMatch } from '@/lib/namcoMameSets'
import {
  identifyKnownMameArcadeMedia,
  mameDiskFromFile,
  mameDiskHeaderProblem,
  mameDiskObjectKey,
  type MameArcadeDiskExpectation,
  type MameArcadeDiskProfile,
} from '@/lib/mameArcadeMedia'
import { mameChdProfileForRomFileName } from '@/lib/mameChdSets'
import { flattenArcadeZipBlob } from '@/lib/flattenArcadeZip'
import {
  buildMameCatalogSetZip,
  describeMameCatalogDevice,
  identifyMameCatalogSets,
  loadMameSetCatalog,
  mameCatalogBiosName,
  mameCatalogStatusNote,
  mayContainMameCatalogSet,
  type MameCatalogMatch,
} from '@/lib/mameSetCatalog'
import { detectArcadeCore, type ArcadeCoreId } from '@/lib/arcadeCoreDetection'
import { assertRomArchiveRef, impliedRomName, romArchiveRef } from '@/lib/romArchiveUrl'
import {
  extraObjectName,
  extraPathProblem,
  formatDosExtra,
  normalizeExtraPath,
  parseDosExtra,
  parseDosExtras,
  skipExtraEntry,
  type DosExtraRef,
} from '@/lib/dosExtras'
import { identifyArcadeRomset, loadRomsetIndex, type RomsetIdentification } from '@/lib/arcadeRomset'
import type { ArcadeHack } from '@/data/arcadeHacks'
import { biosSetUrlSync, platformBiosUrlSync, fetchPlatformBios, loadedPlatformBios } from '@/services/platformBios'
// 「平台级那份是不是正好要的这个系统」这条规则和播放器共用一份实现，别各写一份
import { biosNameOfUrl } from '@/emulator/biosPlan'
import { uploadSwfBundle, type BundleUploadProgress } from './swfUpload'
import { compressCoverToWebp } from '@/lib/imageResize'
import { canReuseRomObjectKey, confirmUpload, confirmConvertedUpload, confirmDiscImage, cleanupSuperseded, deleteRomObjects, human, isDeletableKey } from './uploadGuards'
import { psxIsoValidationProblem } from './psxIso'
import { pspIsoValidationProblem } from './pspIso'
import { chdCompressors } from '@/emulator/psxChd'
import { PSX_RANGE_BYTES } from '@/emulator/psxRangeDisc'
import { buildPsxM3u, PSX_M3U_MAX_DISCS } from '@/emulator/psxM3u'
import { coreOptionsFor } from '@/config/emulators'
import { FEATURES } from '@/config/features'
import { isPlayable } from '@/emulator'
import { NETPLAY_MAX_PLAYERS } from '../../shared/netplay-players.js'
import { normalizeDevelopers } from '@/lib/developers'
import { Field, btnClass, inputClass } from './ui'
import { RomOpenLink } from './RomOpenLink'
import { fetchAdminGames, patchGame } from '@/services/store'
import { api, apiEnabled } from '@/services/api'
import { objectReferenceMatches, planRomObjectDeletion, unbindRomObjectKeys, type PlatformBiosRefs } from './romDeletePlan'
import { mergeDosboxConfigOverride, normalizeDosboxConfigOverride, parseDosboxConfigOverride } from '../../shared/dosbox-config.js'
import { romPackInnerName } from '../../shared/rom-pack-format.js'
import { extractGameKeywordsFromDescriptions } from './gameKeywords'
import { normalizeDosStartupCommands } from '../../shared/dos-startup-commands.js'
import { isVersionedSockdriveDirectory } from '../../shared/sockdrive-url.js'
import { probeRange } from '@/emulator/remoteDisc'
import { inspectRomPackBlob, isRomPackBytes, packRomForUpload, recommendedRomPackCodec, releasePackedRomUpload, romPackKey, unpackRomPackBlob } from '@/services/romPack'
import { fetchBlobWithProgress } from '@/emulator/loadProgress'
import { romCacheKey } from '@/emulator/romCache'
import { alternateRomUrls } from '@/services/romHosts'
import { downloadLegacyPsxPackForMigration, isLegacyPsxPackKey } from './psxRomMigration'
import { isStreamingDiscPlatform } from '../../shared/streaming-disc-platforms.js'
import { html5EntryProblem, normalizeHtml5Entry } from '@/emulator/html5Entry'
import { getUploadActivity, subscribeUploadActivity, trackUploadActivity } from '@/services/uploadActivity'
import { flashCompatibilityIssue } from '@/emulator/flashCompatibility'
import { assertSwf, assertSwfBlob } from '@/lib/romValidation'
import {
  clearDiscStagingKey,
  clearPendingDiscConversion,
  createPspConversion,
  pspChdKey,
  pspConversionCapability,
  pspConversionLabel,
  pspStagingKey,
  retryPspConversion,
  rememberPendingDiscConversion,
  rememberPspConversion,
  rememberedPendingDiscConversion,
  rememberedPspConversion,
  waitForPspConversion,
} from '@/services/pspConversion'
import {
  createPsxConversion,
  psxChdKey,
  psxConversionCapability,
  psxConversionLabel,
  psxStagingKey,
  rememberPsxConversion,
  rememberedPsxConversion,
  waitForPsxConversion,
} from '@/services/psxConversion'
import {
  clearPendingSockdriveCreation,
  clearSockdriveUploadIdentity,
  createSockdriveConversion,
  preserveSockdriveSourceAfterCreateError,
  rememberPendingSockdriveCreation,
  rememberSockdriveConversion,
  rememberedPendingSockdriveCreation,
  rememberedSockdriveConversion,
  retrySockdriveConversion,
  sockdriveConversionCapability,
  sockdriveConversionLabel,
  sockdriveUploadIdentity,
  type SockdriveConversionJob,
  waitForSockdriveConversion,
} from '@/services/sockdriveConversion'

/*
  一键模板。点一下是**合并**进现有配置（mergeDosboxConfigOverride），不是覆盖，可以叠着点。

  下面三条「性能」相关的由来（2026-09-11 实测 js-dos 8.4.1 内嵌的镜像模板）：
    · cycles：站点默认 cycles=auto，而 auto 在**实模式**下是一个保守的固定值，
      只有程序进了保护模式才自动跳到 max（DOSBox-X 自己的提示原文：
      "DOSBox-X has switched to max cycles, because of the setting: cycles=auto"）。
      也就是说一个实模式的 VGA 动作游戏现在是按老 386 的速度在跑。默认值不改
      —— auto 的保守正是为了不让早期游戏跑飞 —— 但得让人知道有这个旋钮。
    · memsize：js-dos 的 Win 3.11 镜像写的是 **256**（DOS 7.1 是 64、Win95/98 是 128）。
      Win 3.11 增强模式根本用不到，而 DOSBox-X 会把这块内存一次性分配出来，
      在 wasm 里就是实打实 256 MB 堆，内存紧张的设备上可能直接分配失败。
    · oplemu：DOSBox-X 的 OPL 模拟里 nuked 是逐样本精确模拟、CPU 开销最大。
      用 AdLib / FM 音乐的老游戏可以拿音色精度换 CPU。
*/
const DOSBOX_CONFIG_TEMPLATES = [
  { label: '关闭 GUS', config: '[gus]\ngus=false' },
  { label: '鼠标 1:1', config: '[sdl]\nsensitivity=100\nraw_mouse_input=true' },
  { label: 'CPU 兼容模式', config: '[cpu]\ncore=normal' },
  { label: '⚡ 提速（放开 CPU）', config: '[cpu]\ncycles=max' },
  { label: '⚡ 内存 32 MB', config: '[dosbox]\nmemsize=32' },
  { label: '⚡ FM 音乐省 CPU', config: '[sblaster]\noplemu=fast' },
] as const

const DOS_83_STREAM_SEGMENT = /^[A-Za-z0-9_^$~!#%&{}@'()-]{1,8}(\.[A-Za-z0-9_^$~!#%&{}@'()-]{1,3})?$/
const isDos83StreamPath = (value: string) => value.split('/').every((part) => DOS_83_STREAM_SEGMENT.test(part))
const PENDING_DISC_CREATE_RETRY = 'pending-create'

/** 任务接口明确拒绝创建时回收孤立 ISO；认证错误和被另一任务引用的源对象必须保留。 */
async function cleanupRejectedDiscSource(
  platform: 'psp' | 'psx',
  slug: string,
  lang: string,
  request: { sourceKey: string },
  error: unknown,
): Promise<{ handled: boolean; warning?: string }> {
  const status = Number((error as { status?: unknown })?.status)
  if (!Number.isFinite(status) || status < 400 || status >= 500 || status === 401 || status === 403) return { handled: false }

  const code = (error as { data?: { code?: unknown } })?.data?.code
  clearPendingDiscConversion(platform, slug, lang)
  clearDiscStagingKey(platform, slug, lang, request.sourceKey)
  if (code === 'conversion_source_conflict') return { handled: true }

  const deletion = await deleteRomObjects([request.sourceKey]).catch(() => null)
  return deletion?.failed.length
    ? { handled: true, warning: `临时 ISO ${request.sourceKey} 未能自动删除，请在 ROM 存储页清理` }
    : deletion === null
      ? { handled: true, warning: `临时 ISO ${request.sourceKey} 的删除结果无法确认，请在 ROM 存储页核对` }
      : { handled: true }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 街机 BIOS 系统名的候选。**只是候选**（datalist），输入框仍然是自由文本 ——
 * 完整名单有 18 种（romset 索引里统计出来的），列在这里的是游戏数靠前的那些，
 * 剩下的（`skns`、`decocass`、`cchip`…）手填就行：
 * 价值在于「常见的能点，不用背」，而不在于穷举。
 */
const KNOWN_ARCADE_BIOS = [
  'neogeo',
  'pgm',
  'namcoc76',
  'ngp_ngp',
  'skns',
  'decocass',
  'cchip',
  'nmk004',
  'midssio',
  'isgsm',
  'astro_astrocde',
]

const today = () => new Date().toISOString().slice(0, 10)

type VolcTranslationUsage = {
  usedChars: number
  limitChars: number
  remainingChars: number
  exhausted: boolean
  trackingError?: boolean
  volcConfigured?: boolean
}

const EMPTY: Game = {
  slug: '',
  title: '',
  titleZh: '',
  titleLocalized: {},
  platform: 'nes',
  genres: ['action'],
  // 不知道发行年份时存 0，避免新游戏沿用一个看似真实的 1990 年。
  year: 0,
  developer: '',
  rating: 0,
  ratingCount: 0,
  plays: 0,
  players: 1,
  multiplayer: false,
  netplayMode: 'auto',
  coinReward: 0,
  icon: '🎮',
  cover: '',
  video: '',
  description: '',
  tags: [],
  addedAt: today(),
  adult: false,
  hidden: false,
  rom: '',
  roms: {},
  romAssets: {},
  romBundleEntries: {},
  // 逐游戏运行时覆盖；NES 与 Play! System 2x6 街机包会用到，其余平台留空走默认引擎
  runtime: null,
  requiresNetwork: null,
}

const FLASH_CONTROL_PRESETS = {
  arrows: { p1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' } },
  arrowsSpace: { p1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'Space' } },
  wasdSpace: { p1: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', a: 'Space' } },
  fireboy: {
    p1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
    p2: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
  },
} satisfies Record<string, NonNullable<Game['flashControls']>>

// Flash 包请求路径必须能在浏览器 URL 与服务端白名单间无歧义往返。
// eslint-disable-next-line no-control-regex
const INVALID_FLASH_BUNDLE_PATH = /[\\?#\x00-\x1f\x7f]/

const cloneFlashControls = (value: NonNullable<Game['flashControls']>): NonNullable<Game['flashControls']> =>
  JSON.parse(JSON.stringify(value))

interface Props {
  /** 传入则为编辑模式 */
  initial?: Game
  /** 志愿者个人库只能编辑资料，不得借表单触发 R2 上传 / 删除。 */
  personalLibrary?: boolean
  /** 保存期间由父层锁住整张表单，避免请求飞行中继续编辑却被成功回包关闭。 */
  submitting?: boolean
  /** 管理员可把编辑器缩到角落；文件上传 / 转码结束后再自动提交当前草稿。 */
  autoSaveAfterUpload?: boolean
  onMinimizeForUpload?: () => void
  onBackgroundUploadFailure?: (message?: string | null) => void
  onSubmit: (game: Game) => void | boolean | string | Promise<void | boolean | string>
  onCancel: () => void
}

export function GameForm({
  initial,
  personalLibrary = false,
  submitting = false,
  autoSaveAfterUpload = false,
  onMinimizeForUpload,
  onBackgroundUploadFailure,
  onSubmit,
  onCancel,
}: Props) {
  const initialForm = initial ?? { ...EMPTY, addedAt: today() }
  const initialTagsText = (initial?.tags ?? []).join(', ')
  const [form, setForm] = useState<Game>(initialForm)
  const formElementRef = useRef<HTMLFormElement | null>(null)
  const uploadActivity = useSyncExternalStore(subscribeUploadActivity, getUploadActivity, getUploadActivity)
  const backgroundSawActivity = useRef(false)
  const backgroundFailureBaseline = useRef(0)
  const backgroundStartedBaseline = useRef(0)
  const backgroundWaitingForSelectedFile = useRef(false)
  const backgroundSubmitRequested = useRef(false)
  const backgroundFailureReported = useRef(false)
  /** 上传 ROM 得出的“这包还缺哪张盘”只在当前编辑会话提示；真正的绑定要等 CHD 上传成功才入表单。 */
  const [mameMediaProfile, setMameMediaProfile] = useState<MameArcadeDiskProfile | null>(null)
  /** 街机通常只有一个可启动 ROM；地区变体按需展开，避免新建条目先看到八份空上传位。 */
  const [showArcadeVariants, setShowArcadeVariants] = useState(() =>
    Object.keys(initial?.roms ?? {}).some((lang) => lang !== 'en'),
  )
  const [tagsText, setTagsText] = useState(initialTagsText)
  const [backgroundFilePoll, setBackgroundFilePoll] = useState(0)
  const formRef = useRef(form)
  const keywordDescriptions = useMemo(() => ({
    'zh-Hans': form.description ?? '',
    ...(form.descriptionI18n ?? {}),
    ...(form.descriptionLocalized ?? {}),
    // 英文页同样优先已保存的人工/机器译文；没有时才用固定英文简介。
    en: form.descriptionLocalized?.en || form.descriptionI18n?.en || form.descriptionEn || '',
  }), [form.description, form.descriptionEn, form.descriptionI18n, form.descriptionLocalized])
  const hasKeywordDescriptions = Object.values(keywordDescriptions).some((text) => Boolean(text?.trim()))
  // 请求期间若管理员继续改简介，译文回包不能覆盖更新后的手工内容。
  formRef.current = form
  const autoTagsValue = useRef('')
  const tagsManuallyEdited = useRef(Boolean(initialTagsText))
  const [newRomLanguageCode, setNewRomLanguageCode] = useState('')
  const [slugTouched, setSlugTouched] = useState(Boolean(initial))
  // 历史值先视作管理员手选；本次表单自动识别出的核心仍可被下一次 ROM 识别更新。
  const manualCoreChoice = useRef(Boolean(initial?.core?.trim()))
  const [error, setError] = useState<string | null>(null)
  const [translatingLanguage, setTranslatingLanguage] = useState<string | null>(null)
  const [translationFeedback, setTranslationFeedback] = useState<{
    language: string
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  const [volcTranslationUsage, setVolcTranslationUsage] = useState<VolcTranslationUsage | null>(null)
  const [romDeleteBusy, setRomDeleteBusy] = useState(false)
  const romDeleteBusyRef = useRef(false)
  const initialSnapshot = useRef(JSON.stringify({ form: initialForm, tagsText: initialTagsText }))
  /**
   * Sockdrive 后台任务会直接在服务端原子绑定语言槽，父页面手里的 initial 不会因此自动刷新。
   * 单独维护这三项已落库事实，避免成功后表单把服务端刚写好的值误报成“未保存修改”。
  */
  const persistedSockdriveLanguage = useRef({
    roms: { ...initial?.roms },
    executables: { ...initial?.dosExecutables },
    sockdrives: { ...initial?.dosSockdrives },
  })
  const isEdit = Boolean(initial)
  const pc98Form = form.platform === 'dos' && Boolean(form.dosPc98)
  const dosboxXSockdriveForm = form.platform === 'dos' && form.dosBackend === 'dosboxX' && !pc98Form
  const windowsGuestForm = form.platform === 'dos' && form.dosBackend === 'dosboxX' && !pc98Form && Boolean(form.dosSystem?.trim())
  const hasLanguageSockdrive = Object.values(form.dosSockdrives ?? {}).some((value) => Boolean(value?.trim()))
  const hasAnySockdrive = Boolean(form.dosSockdrive?.trim()) || hasLanguageSockdrive
  /**
   * 转换任务要用数据库里的旧值做 CAS。先把运行环境、EXE 与当前流式盘保存好，才能避免
   * 管理员上传完几个 GB 后才收到“数据库配置不一致”；ROM 本身允许由一键上传原子换新。
   */
  const sockdriveConfigSaved = (lang: RomSlotLang) => Boolean(
    dosboxXSockdriveForm && initial?.slug &&
    initial.slug === slugify(form.slug || form.title) &&
    initial.platform === form.platform &&
    initial.dosBackend === form.dosBackend &&
    (initial.dosSystem ?? '').trim() === (form.dosSystem ?? '').trim() &&
    JSON.stringify(initial.dosExtras ?? []) === JSON.stringify(form.dosExtras ?? []) &&
    (persistedSockdriveLanguage.current.executables[lang] ?? initial.dosExecutable ?? '').trim() === (form.dosExecutables?.[lang] ?? form.dosExecutable ?? '').trim() &&
    (persistedSockdriveLanguage.current.sockdrives[lang] ?? '').trim() === (form.dosSockdrives?.[lang] ?? '').trim()
  )
  /** 该平台可选的核心。没配置的平台不显示这一栏 */
  const coreOptions = coreOptionsFor(form.platform)
  const customRomLangs = [...new Set([
    ...Object.keys(form.roms ?? {}),
    ...Object.keys(form.romBackups ?? {}),
    ...Object.keys(form.dosExecutables ?? {}),
    ...Object.keys(form.dosStartupCommands ?? {}),
    ...Object.keys(form.dosSockdrives ?? {}),
  ])].filter((code) => !(ROM_LANGS as readonly string[]).includes(code)).sort()
  const allRomLangs: RomSlotLang[] = [...ROM_LANGS, ...customRomLangs]
  // SEO 简介只给实际绑定了 ROM 的语言开输入框；zh-Hans / en 继续使用上面的固定简介字段。
  const localizedRomLanguages = allRomLangs.filter((lang) =>
    lang !== 'zh-Hans' && lang !== 'en' && Boolean(form.roms?.[lang]?.trim()),
  )
  const localizedTitleRomLanguages = localizedRomLanguages.filter((language) =>
    LANGUAGES.some(({ code }) => code === language),
  )
  const arcadePrimaryLang = allRomLangs.find((lang) => Boolean(form.roms?.[lang]?.trim())) ?? 'en'
  /*
    只有选择 MAME 核心时，才按已保存对象 key 恢复 CHD 面板；FBNeo 的 CPS-3 ROMset
    也可能有同名 MAME 版本。真正保存前 CHD 会核验 MAME SHA-1，玩家开局还会重验 ZIP CRC，
    所以这只是恢复操作入口，不能把“文件名碰巧一样”当成可运行的结论。
  */
  const selectedMameCore = form.platform === 'arcade' && form.core === 'mame-current'
  const restoredMameMediaProfile = selectedMameCore
    ? mameChdProfileForRomFileName(form.roms?.[arcadePrimaryLang])
    : null
  const activeMameMediaProfile = selectedMameCore ? mameMediaProfile ?? restoredMameMediaProfile : null
  const displayedRomLangs: readonly RomSlotLang[] = form.platform === 'arcade' && !showArcadeVariants
    ? [arcadePrimaryLang]
    : allRomLangs

  const hasUnsavedChanges = () => JSON.stringify({ form, tagsText }) !== initialSnapshot.current
  // 文件选择后会先做本地校验、识别和覆盖确认，活动账本在这些步骤后才开始计数。
  // 保存 / 最小化不能只看账本，否则会把仍在预检的文件当成“没有上传任务”。
  const hasSelectedUploadFiles = () => {
    const formElement = formElementRef.current
    return Boolean(formElement && [...formElement.querySelectorAll<HTMLInputElement>('input[type="file"]')]
      .some((input) => input.files?.length))
  }

  useEffect(() => {
    if (!autoSaveAfterUpload) {
      backgroundSawActivity.current = false
      backgroundWaitingForSelectedFile.current = false
      backgroundSubmitRequested.current = false
      backgroundFailureReported.current = false
    }
  // 失败基线在按钮事件里同步记录，避免很快完成的上传先于 effect 被错误地当成旧失败。
  }, [autoSaveAfterUpload])

  useEffect(() => {
    if (!autoSaveAfterUpload) return
    if (uploadActivity.active.length) {
      backgroundSawActivity.current = true
      backgroundSubmitRequested.current = false
      return
    }
    // 活动可能在 React 收到限频通知前已经结束；started 计数仍能确认后台确实等过任务。
    if (uploadActivity.started > backgroundStartedBaseline.current) backgroundSawActivity.current = true
    // 嵌套任务可能有一次失败后被外层上传器成功重试。只有全部任务结束后才判定最终失败。
    if (uploadActivity.failures > backgroundFailureBaseline.current && !backgroundFailureReported.current) {
      backgroundFailureReported.current = true
      setError('后台上传或转码失败，已停止自动保存；恢复编辑后可查看具体错误并重试。')
      onBackgroundUploadFailure?.('后台上传或转码失败，已恢复编辑。')
      return
    }
    // 本地预检没有计入活动账本；选中的文件还在时轮询，等预检结束并进入上传账本。
    if (hasSelectedUploadFiles()) {
      backgroundSawActivity.current = true
      let timer = 0
      const pollSelectedFile = () => {
        const current = getUploadActivity()
        if (current.active.length || current.started > backgroundStartedBaseline.current || !hasSelectedUploadFiles()) {
          // 文件选择本身不会触发账本通知；只在预检结束 / 任务开始时重读一次表单。
          setBackgroundFilePoll((value) => value + 1)
          return
        }
        timer = window.setTimeout(pollSelectedFile, 250)
      }
      timer = window.setTimeout(pollSelectedFile, 250)
      return () => window.clearTimeout(timer)
    }
    // 用户选择了文件，但预检 / 确认后没有启动任何任务，不能把旧表单当作上传结果提交。
    if (backgroundWaitingForSelectedFile.current && uploadActivity.started <= backgroundStartedBaseline.current) {
      backgroundWaitingForSelectedFile.current = false
      backgroundSawActivity.current = false
      setError('文件没有进入上传流程；请查看文件校验提示并重新选择，游戏资料未自动保存。')
      onBackgroundUploadFailure?.('文件没有进入上传流程，已恢复编辑。')
      return
    }
    backgroundWaitingForSelectedFile.current = false
    if (!backgroundSawActivity.current) return
    const timer = window.setTimeout(() => {
      if (getUploadActivity().active.length) return
      backgroundSubmitRequested.current = true
      // 直接派发 submit 事件，沿用同一套表单校验，同时避免浏览器原生 required 校验吞掉事件。
      formElementRef.current?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [autoSaveAfterUpload, uploadActivity, onBackgroundUploadFailure, backgroundFilePoll])

  useEffect(() => {
    if (!autoSaveAfterUpload || !backgroundSubmitRequested.current || !error) return
    onBackgroundUploadFailure?.(error)
    backgroundSubmitRequested.current = false
  }, [autoSaveAfterUpload, error, onBackgroundUploadFailure])

  useEffect(() => {
    if (submitting) return
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [form, tagsText, submitting])

  useEffect(() => {
    if (personalLibrary || !apiEnabled()) return
    let active = true
    void api.get<VolcTranslationUsage>('/api/admin/translation-usage', true)
      .then((usage) => { if (active) setVolcTranslationUsage(usage) })
      .catch(() => { if (active) setVolcTranslationUsage(null) })
    return () => { active = false }
  }, [personalLibrary])

  const requestCancel = () => {
    if (submitting || romDeleteBusy) return
    if (getUploadActivity().active.length || hasSelectedUploadFiles()) {
      setError('文件仍在校验、上传或转码；请先缩小窗口让任务在后台完成，或等任务结束后再关闭。')
      return
    }
    if (hasUnsavedChanges() && !window.confirm('还有未保存的修改，确定放弃吗？')) return
    onCancel()
  }

  const startBackgroundUpload = () => {
    const activity = getUploadActivity()
    backgroundFailureBaseline.current = activity.failures
    backgroundStartedBaseline.current = activity.started
    const hasSelectedFiles = hasSelectedUploadFiles()
    backgroundWaitingForSelectedFile.current = hasSelectedFiles && activity.active.length === 0
    // 没有待处理文件时，点击“上传并保存”本身就是保存当前草稿的请求。
    backgroundSawActivity.current = true
    backgroundSubmitRequested.current = false
    backgroundFailureReported.current = false
    setError(null)
    onMinimizeForUpload?.()
  }

  useEffect(() => {
    if (!isEdit && !slugTouched) setForm((f) => ({ ...f, slug: slugify(f.title) }))
  }, [form.title, isEdit, slugTouched])

  useEffect(() => {
    if (tagsManuallyEdited.current && (!autoTagsValue.current || tagsText !== autoTagsValue.current)) return
    const generated = extractGameKeywordsFromDescriptions(keywordDescriptions).join(', ')
    if (generated === tagsText) return
    autoTagsValue.current = generated
    setTagsText(generated)
  }, [keywordDescriptions, tagsText])


  /**
   * 这款游戏当前绑定的全部对象 key。
   * **刻意不去重** —— cleanupSuperseded 要靠「同一个 key 出现几次」判断它是不是
   * 被多个槽位共用（比如 en 和 ja 指向同一份 ROM），共用的就不能删。
   */
  const allBoundKeys = [
    form.rom ?? '',
    ...Object.values(form.roms ?? {}),
    ...Object.values(form.romBackups ?? {}),
    ...(form.arcadeMameDisks ?? []).map((disk) => disk.key),
    form.cover ?? '',
    form.video ?? '',
  ]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)

  const set = <K extends keyof Game>(key: K, value: Game[K]) => setForm((f) => ({ ...f, [key]: value }))

  /**
   * 编辑弹窗里的“解绑并删除”必须先从全库解除引用，再删 R2 对象。
   * 不能只查当前游戏：ROM 可能被其它游戏 / 语言槽共用；漏查会把别人的游戏变成 404。
   */
  const deleteBoundRom = async (rawKey: string): Promise<{ removed: number; unboundGames: number } | null> => {
    const key = rawKey.trim()
    if (!key || personalLibrary) throw new Error('当前账号不能删除 R2 ROM')
    if (!isDeletableKey(key)) throw new Error('这个地址不属于可由本站删除的 R2 对象；请使用普通“解绑”')
    if (romDeleteBusyRef.current) throw new Error('另一个 ROM 删除操作正在进行，请稍后')

    const romConfig = getRomConfig()
    if (!romConfig.api || !romConfig.token) throw new Error('请先在“ROM 存储”页配置 Worker 地址和口令，才能删除 R2 文件')
    if (!apiEnabled()) throw new Error('游戏数据库 API 未启用，无法检查全库引用；已阻止删除')

    romDeleteBusyRef.current = true
    setRomDeleteBusy(true)
    let unboundGames = 0
    try {
      // 多文件包里的任意成员都代表整目录；先列出全目录，才能准确检查兄弟文件有没有被别的游戏引用。
      const bundleObjects = isBundleKey(key) ? await listRomObjects(dirOfKey(key)) : []
      const objectKeys = isBundleKey(key) ? [...new Set(bundleObjects.map((object) => object.key))] : [key]
      if (!objectKeys.includes(key)) throw new Error(`R2 目录清单中找不到 ${key}，为避免误删已停止操作`)

      // 分页扫描全部游戏；只拿当前页就无法证明对象没有被其它游戏复用。
      const first = await fetchAdminGames({ page: 1, pageSize: 100 })
      const games = [...first.items]
      for (let page = 2; page <= first.totalPages; page++) {
        const next = await fetchAdminGames({ page, pageSize: 100 })
        games.push(...next.items)
      }
      if (games.length !== first.total) {
        throw new Error(`全库引用检查不完整（读取 ${games.length} / ${first.total} 款游戏），为避免误删没有执行`)
      }
      // 平台 BIOS 也是 R2 对象；fetchPlatformBios 失败时会静默给空表，删除前必须直接读、读不到就停。
      const platformBios = await api.get<PlatformBiosRefs>('/api/platform-bios/map').catch(() => {
        throw new Error('读取平台 BIOS 绑定失败，无法确认对象没被 BIOS 使用；已阻止删除')
      })

      const plan = planRomObjectDeletion(games, objectKeys, platformBios ?? {})
      // 未保存的表单也可能把同一 key 用作封面 / 系统盘；这类引用不能由 ROM 按钮顺手清除。
      const targets = new Set(objectKeys)
      const draftReferences: Array<[string, string | undefined]> = [
        ['封面', form.cover],
        ['视频', form.video],
        ['DOS 系统镜像', form.dosSystem],
        ['DOS 流式盘', form.dosSockdrive],
        ...Object.values(form.dosSockdrives ?? {}).map((value) => ['DOS 流式盘', value] as [string, string | undefined]),
        ...parseDosExtras(form.dosExtras).map(({ key: extraKey }) => ['DOS 附加文件', extraKey] as [string, string | undefined]),
        ...(form.arcadeMameDisks ?? []).map((disk) => ['MAME 媒体盘', disk.key] as [string, string | undefined]),
      ]
      const draftOtherReferences = draftReferences.flatMap(([field, value]) => {
        if (typeof value !== 'string') return []
        return objectReferenceMatches(field, value, targets) ? [field] : []
      })
      const blocked = [...plan.otherReferences, ...draftOtherReferences.map((field) => ({ slug: form.slug, title: form.titleZh || form.title || form.slug, field }))]
      if (blocked.length) {
        const refs = [...new Set(blocked.map((reference) => `${reference.title}（${reference.field}）`))].slice(0, 6).join('、')
        throw new Error(`该对象还被非 ROM 字段使用：${refs}${blocked.length > 6 ? '…' : ''}。请先在对应字段解除引用，再删除。`)
      }

      const referencedGames = [...new Map(plan.romGames.map((game) => [game.slug, game])).values()]
      const affected = referencedGames.length
        ? `\n\n会先从 ${referencedGames.length} 款游戏的所有主 ROM、语言 ROM 和备用地址中解除引用：${referencedGames.slice(0, 6).map((game) => game.titleZh || game.title || game.slug).join('、')}${referencedGames.length > 6 ? '…' : ''}`
        : '\n\n当前游戏库没有已保存的 ROM 引用。'
      const bundleNote = isBundleKey(key)
        ? `\n\n这是多文件包成员，会连同目录下 ${objectKeys.length} 个对象一起删除。`
        : ''
      if (!window.confirm(`确定解绑并从 R2 永久删除 ${key}？此操作不可恢复。${affected}${bundleNote}\n\n继续吗？`)) return null

      // 表单草稿也同步清理整组 key；否则之后保存其它字段时会把已删除的旧 key 写回数据库。
      setForm((current) => {
        let next = current
        for (const objectKey of objectKeys) next = { ...next, ...unbindRomObjectKeys(next, [objectKey]) }
        return next
      })

      // 逐游戏写回，每一步失败都立即停下；此时对象仍在 R2，宁可留下孤儿也不能制造死链。
      for (const game of referencedGames) {
        const patch = unbindRomObjectKeys(game, objectKeys)
        if (Object.keys(patch).length) {
          await patchGame(game.slug, patch)
          unboundGames++
        }
      }

      const deletion = await deleteRomObjectsExactly(objectKeys)
      if (deletion.failed.length) {
        throw new Error(`已解除 ${unboundGames} 款游戏的引用，但 R2 有 ${deletion.failed.length} 个对象删除失败；请稍后在 ROM 存储页重试`)
      }
      if (!deletion.removed.length) throw new Error('Worker 没有确认删除任何对象；引用已解除，请在 ROM 存储页核查文件')
      return { removed: deletion.removed.length, unboundGames }
    } finally {
      romDeleteBusyRef.current = false
      setRomDeleteBusy(false)
    }
  }

  /*
    打开表单就把 BIOS 绑定表拉下来。

    上传文件的识别那条路本来会顺手拉一次（sniffArcade 里），但**手填系统名**的人不会触发它 ——
    而手填恰恰是识别不出来时唯一的出路（汉化版、驱动表里没有的板子）。
    没拉下来时下面那条即时校验只能闭嘴（宁可不说，也不能对着空表报「没绑定」）。
  */
  useEffect(() => {
    void fetchPlatformBios()
  }, [])

  /*
   * 街机索引约 600KB，只供后台使用。切到街机时趁管理员仍在填写标题等资料预热它，
   * 选 ZIP 后就不必把“读取中央目录”和“下载索引”串行等待；省流量模式仍尊重用户选择。
   */
  useEffect(() => {
    if (form.platform !== 'arcade') return
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return
    const timer = window.setTimeout(() => { void loadRomsetIndex() }, 120)
    return () => window.clearTimeout(timer)
  }, [form.platform])

  /**
   * 「这个游戏要的 BIOS 还没绑地址」——值是系统名，没有就是 null。
   *
   * 两条路都算已绑定：
   *   · 按系统绑了 `bios:pgm`（新的一档）
   *   · 平台级那一份的**文件名正好就是它**（老站把 arcade 绑成 neogeo.zip 的情况）
   *
   * ⚠️ 绑定表没拉下来时返回 null —— 对着空表报「没绑定」比不报更糟（会把人骗去改配置）。
   */
  const biosUnbound = (() => {
    if (!loadedPlatformBios()) return null
    const name = form.arcadeBios?.trim().toLowerCase()
    if (!name) return null
    if (biosSetUrlSync(name)) return null
    if (biosNameOfUrl(platformBiosUrlSync(form.platform)) === name) return null
    return name
  })()

  /**
   * 把识别到的改版包写进 RomData 字段。
   *
   * onlyIfEmpty 用在「上传时自动认出来」那一路：管理员可能已经手写 / 改过一份 dat，
   * 上传个文件就把它冲掉太粗暴。字段里有东西时改由界面上那个按钮明确触发。
   */
  /**
   * 上传识别自动填过的值。只有「当前值还是自动填的那份」时，重新上传另一款游戏才允许改写 / 清空：
   * 以前只在字段为空时填，于是同一张表单先传 PGM 游戏（自动填 pgm）、再换成 kof97.zip，
   * BIOS 仍是 pgm —— skipPlatformBios 跳过 neogeo.zip，只写 /pgm.zip，开局就是缺文件。
   * 管理员手改过的值（和自动值不同）永远不动。
   */
  const autoArcade = useRef<{ bios: string; romData: string; buttons?: Game['arcadeButtons'] }>({ bios: '', romData: '' })
  const applyHack = (hack: ArcadeHack, onlyIfEmpty = false) => {
    if (!hack.romData) return
    setForm((f) => {
      const cur = f.arcadeRomData?.trim() ?? ''
      if (onlyIfEmpty && cur && cur !== autoArcade.current.romData) return f
      if (onlyIfEmpty) autoArcade.current.romData = hack.romData!.trim()
      return { ...f, arcadeRomData: hack.romData }
    })
  }
  /** 新的街机 ZIP 开始识别：撤掉上一次自动填、且管理员没改过的字段 */
  const resetAutoArcadeFields = () => {
    // 副作用放在 updater 外面：StrictMode 会把 updater 跑两遍，第二遍不能看到已经清空的记录
    const auto = autoArcade.current
    autoArcade.current = { bios: '', romData: '' }
    if (!auto.bios && !auto.romData && !auto.buttons) return
    setForm((f) => {
      const next = { ...f }
      if (auto.bios && (f.arcadeBios?.trim().toLowerCase() ?? '') === auto.bios) next.arcadeBios = undefined
      if (auto.romData && (f.arcadeRomData?.trim() ?? '') === auto.romData) next.arcadeRomData = undefined
      if (auto.buttons && f.arcadeButtons === auto.buttons) next.arcadeButtons = undefined
      return next
    })
  }

  const applyDosboxTemplate = (config: string) => {
    try {
      // 先校验当前文本，避免模板按钮把管理员刚输错的一行悄悄带进最终配置。
      const current = normalizeDosboxConfigOverride(form.dosboxConfig)
      set('dosboxConfig', mergeDosboxConfigOverride(current, config).trim())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DOSBox 配置格式不正确')
    }
  }

  const toggleGenre = (id: GenreId) =>
    setForm((f) => ({
      ...f,
      genres: f.genres.includes(id) ? f.genres.filter((g) => g !== id) : [...f.genres, id],
    }))

  const addRomLanguage = () => {
    const code = normalizeRomLanguageCode(newRomLanguageCode)
    if (!code) return setError('请输入有效的语言代码，例如 ko、pt-BR（最多 10 个字符）')
    const existing = allRomLangs.find((candidate) => normalizeRomLanguageCode(candidate) === code)
    if (existing) return setError(`${romLanguageLabel(existing)} 已存在，无需重复添加`)
    setForm((f) => ({ ...f, roms: { ...f.roms, [code]: f.roms?.[code] ?? '' } }))
    setNewRomLanguageCode('')
    setShowArcadeVariants(true)
    setError(null)
  }

  const setRomLang = (lang: RomSlotLang, key: string) =>
    setForm((f) => {
      const roms = { ...f.roms }
      const romAssets = { ...f.romAssets }
      const romBundleEntries = { ...f.romBundleEntries }
      if ((f.roms?.[lang] ?? '') !== key.trim()) delete romAssets[lang]
      if ((f.roms?.[lang] ?? '') !== key.trim()) delete romBundleEntries[lang]
      if (key.trim()) roms[lang] = key.trim()
      else delete roms[lang]
      return { ...f, roms, romAssets, romBundleEntries }
    })

  const setRomAssetsLang = (lang: RomSlotLang, paths: string[]) =>
    setForm((f) => {
      const romAssets = { ...f.romAssets }
      if (paths.length) romAssets[lang] = [...new Set(paths)]
      else delete romAssets[lang]
      return { ...f, romAssets }
    })

  const setRomBundleEntryLang = (lang: RomSlotLang, path: string) =>
    setForm((f) => {
      const romBundleEntries = { ...f.romBundleEntries }
      if (path.trim()) romBundleEntries[lang] = path.trim()
      else delete romBundleEntries[lang]
      return { ...f, romBundleEntries }
    })

  const setDosEntryLang = (lang: RomSlotLang, path: string) =>
    setForm((f) => {
      const dosExecutables = { ...f.dosExecutables }
      if (path) dosExecutables[lang] = path
      else delete dosExecutables[lang]
      return { ...f, dosExecutables }
    })

  const setDosStartupCommandsLang = (lang: RomSlotLang, commands: string) =>
    setForm((f) => {
      const dosStartupCommands = { ...f.dosStartupCommands }
      if (commands) dosStartupCommands[lang] = commands
      else delete dosStartupCommands[lang]
      return { ...f, dosStartupCommands }
    })

  const setDosSockdriveLang = (lang: RomSlotLang, value: string) =>
    setForm((f) => {
      const dosSockdrives = { ...f.dosSockdrives }
      if (value.trim()) dosSockdrives[lang] = value.trim()
      else delete dosSockdrives[lang]
      return { ...f, dosSockdrives }
    })

  /**
   * 后台明确回报 bound=true 时，数据库已经保存了 ROM、EXE 与 Sockdrive。
   * 只把这三项合入“已保存基线”，其它标题、简介等本地修改仍保持未保存，不能顺手洗白。
   */
  const acceptCompletedSockdrive = (lang: RomSlotLang, job: SockdriveConversionJob) => {
    const apply = (game: Game): Game => {
      const roms = { ...game.roms }
      if (job.targetRomKey?.trim()) roms[lang] = job.targetRomKey.trim()
      const dosExecutables = { ...game.dosExecutables, [lang]: job.executable.trim() }
      const dosSockdrives = { ...game.dosSockdrives, [lang]: job.targetPrefix.trim() }
      return { ...game, roms, dosExecutables, dosSockdrives }
    }
    if (!job.bound) {
      setDosSockdriveLang(lang, job.targetPrefix)
      return
    }

    if (job.targetRomKey?.trim()) persistedSockdriveLanguage.current.roms[lang] = job.targetRomKey.trim()
    persistedSockdriveLanguage.current.executables[lang] = job.executable.trim()
    persistedSockdriveLanguage.current.sockdrives[lang] = job.targetPrefix.trim()
    try {
      const snapshot = JSON.parse(initialSnapshot.current) as { form: Game; tagsText: string }
      initialSnapshot.current = JSON.stringify({ ...snapshot, form: apply(snapshot.form) })
    } catch {
      // 快照只服务离开页面提示；解析失败不能挡住已由服务端完成的绑定。
    }
    setForm(apply)
  }

  const setRomBackupLang = (lang: RomSlotLang, key: string) =>
    setForm((f) => {
      const romBackups = { ...f.romBackups }
      if (key.trim()) romBackups[lang] = key.trim()
      else delete romBackups[lang]
      return { ...f, romBackups }
    })

  const updateEnglishDescription = (description: string) => {
    set('descriptionEn', description || undefined)
  }

  const updateLocalizedDescription = (language: string, description: string) => {
    setTranslationFeedback((current) => current?.language === language ? null : current)
    setForm((current) => {
      const descriptions = { ...current.descriptionLocalized }
      if (description.trim()) descriptions[language] = description
      else delete descriptions[language]
      return { ...current, descriptionLocalized: Object.keys(descriptions).length ? descriptions : undefined }
    })
  }

  const translateLocalizedDescription = async (language: string) => {
    if (translatingLanguage) return
    if (!apiEnabled()) {
      setTranslationFeedback({ language, kind: 'error', text: '项目 API 未连接，无法调用翻译服务。' })
      return
    }
    const currentForm = formRef.current
    const sourceText = String(currentForm.descriptionEn ?? '').trim()
    if (!sourceText) {
      setTranslationFeedback({ language, kind: 'error', text: '请先填写英文简介，再点击翻译。' })
      return
    }
    const originalTarget = String(currentForm.descriptionLocalized?.[language] ?? '')
    if (originalTarget.trim() && !window.confirm(`“${romLanguageLabel(language)}”已有简介；翻译结果会替换当前输入内容。继续吗？`)) return

    setTranslatingLanguage(language)
    setTranslationFeedback(null)
    try {
      const slug = slugify(currentForm.slug || currentForm.title)
      const result = await api.post<{
        lang: string
        text: string
        provider?: 'mymemory' | 'lingva' | 'volc' | 'mixed' | 'unknown'
        volcUsage?: VolcTranslationUsage
      }>(
        `/api/games/${encodeURIComponent(slug)}/translate-description-preview`,
        { lang: language, sourceText },
        true,
      )
      if (result.volcUsage) setVolcTranslationUsage(result.volcUsage)
      const latest = formRef.current
      const latestTarget = String(latest.descriptionLocalized?.[language] ?? '')
      if (String(latest.descriptionEn ?? '').trim() !== sourceText || latestTarget !== originalTarget) {
        setTranslationFeedback({
          language,
          kind: 'error',
          text: '翻译期间简介内容有变化，未填入过期译文；请确认英文简介后重新点击。',
        })
        return
      }
      updateLocalizedDescription(language, result.text)
      const providerLabel = result.provider === 'mymemory'
        ? 'MyMemory'
        : result.provider === 'lingva'
          ? 'Lingva'
          : result.provider === 'mixed'
            ? 'MyMemory / Lingva / 火山混合服务'
            : '火山兜底'
      const usageLabel = result.volcUsage
        ? `火山用量 ${result.volcUsage.usedChars.toLocaleString()} / ${result.volcUsage.limitChars.toLocaleString()} 字符。`
        : ''
      setTranslationFeedback({
        language,
        kind: 'success',
        text: `已填入输入框（${providerLabel}）。${usageLabel}译文尚未保存，提交游戏表单后才会生效。`,
      })
    } catch (err) {
      setTranslationFeedback({
        language,
        kind: 'error',
        text: err instanceof Error ? err.message : '翻译失败，请稍后重试。',
      })
    } finally {
      setTranslatingLanguage(null)
    }
  }

  const regenerateKeywords = () => {
    const generated = extractGameKeywordsFromDescriptions(keywordDescriptions).join(', ')
    if (!generated) return setError('请至少填写一段简介，再提取关键词')
    autoTagsValue.current = generated
    tagsManuallyEdited.current = false
    setTagsText(generated)
    setError(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    if (getUploadActivity().active.length || hasSelectedUploadFiles()) {
      setError('文件仍在本地校验、上传或转码；等它完成后再保存，避免把旧地址写回游戏。')
      return
    }
    const slug = slugify(form.slug || form.title)
    if (!form.title.trim()) return setError('请填写英文标题')
    if (!slug) return setError('slug 不能为空')
    if (Object.values(form.descriptionLocalized ?? {}).some((value) => value.length > 4000)) {
      return setError('各语言简介不能超过 4000 个字符')
    }
    if (form.genres.length === 0) return setError('至少选择一个类型')
    const pc98 = form.platform === 'dos' && Boolean(form.dosPc98)
    const windowsGuest = form.platform === 'dos' && form.dosBackend === 'dosboxX' && !pc98 && Boolean(form.dosSystem?.trim())
    const dosboxXSockdrive = form.platform === 'dos' && form.dosBackend === 'dosboxX' && !pc98
    if (pc98) {
      if (form.dosSystem?.trim()) return setError('PC-98 模式不能配置 Windows 系统镜像')
      if (form.dosSockdrive?.trim() || Object.values(form.dosSockdrives ?? {}).some((value) => value?.trim())) {
        return setError('PC-98 模式不能配置 Sockdrive；请直接上传单个 .fdi 软盘镜像')
      }
      if (form.dosExtras?.length) return setError('PC-98 模式不能现场合并 DOS 附加文件')
      if (form.dosExecutable?.trim() || Object.values(form.dosExecutables ?? {}).some((value) => value?.trim())) {
        return setError('PC-98 FDI 会从软盘自身启动，请清空 DOS 自启动程序')
      }
      if (Object.values(form.dosStartupCommands ?? {}).some((value) => value?.trim())) {
        return setError('PC-98 FDI 会从软盘自身启动，请清空 DOS 启动前命令')
      }
      const pc98Keys = [form.rom?.trim(), ...Object.values(form.roms ?? {}).map((value) => value?.trim())].filter(Boolean)
      const wrongImage = pc98Keys.find((key) => !/\.fdi$/i.test(romPackInnerName(key!)))
      if (wrongImage) return setError(`PC-98 模式只接受 .fdi 软盘镜像：${wrongImage}`)
      try {
        const machine = parseDosboxConfigOverride(form.dosboxConfig).entries.find(
          (entry) => entry.section === 'dosbox' && entry.key.replace(/[\s_-]+/g, ' ').trim() === 'machine',
        )
        if (machine) return setError('PC-98 模式的 [dosbox] machine 固定为 pc98，不能在配置覆盖中修改')
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'DOSBox 配置格式不正确')
      }
    }
    if (windowsGuest && !/\.jsdos(?:[?#].*)?$/i.test(form.dosSystem!.trim())) {
      return setError('Windows 系统镜像必须是 .jsdos 文件、对象 key 或 URL')
    }
    for (const code of customRomLangs) {
      if (normalizeRomLanguageCode(code) !== code) {
        return setError(`自定义语言代码“${code}”无效；请使用 ko、pt-BR 等最多 10 个字符的标准语言代码`)
      }
    }
    const dosSockdrive = dosboxXSockdrive ? form.dosSockdrive?.trim().replace(/\/+$/, '') : undefined
    if (dosSockdrive) {
      // 这个值会进 DOSBox-X 的 autoexec；不能把换行、引号或空格留到玩家开局后才暴露。
      if (dosSockdrive.length > 500 || /[^\x21-\x7e]|["'%&|<>^()]/.test(dosSockdrive)) {
        return setError('Sockdrive 目录必须用 ASCII，且不能含空格、引号、DOS 批处理保留字符或超过 500 字符')
      }
      if (dosSockdrive.startsWith('//')) return setError('Sockdrive 目录不能使用 // 开头的协议相对地址')
      if (/^[a-z][a-z0-9+.-]*:/i.test(dosSockdrive) && !/^https?:\/\//i.test(dosSockdrive)) {
        return setError('Sockdrive 完整地址只支持 HTTP 或 HTTPS')
      }
      if (/[?#]/.test(dosSockdrive)) return setError('Sockdrive 目录不能带查询参数或锚点')
      if (/(?:^|\/)sockdrive\.metaj$/i.test(dosSockdrive) || /\.raw$/i.test(dosSockdrive)) {
        return setError('Sockdrive 请填写包含 sockdrive.metaj 的目录，不要填写某个文件')
      }
      if (!isVersionedSockdriveDirectory(dosSockdrive)) {
        return setError('Sockdrive 目录必须以版本号或内容哈希结尾；发布新磁盘时必须换新目录')
      }
      try {
        const resolved = new URL(romUrlForKey(dosSockdrive) || dosSockdrive, window.location.href)
        if (!/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password) {
          return setError('Sockdrive 必须是没有账号口令的 HTTP(S) 目录')
        }
        /* js-dos 8.4.1 的 OPFS 缓存键只保留 200 字符，超长地址会让不同版本共用旧分块。 */
        if (resolved.toString().replace(/\/+$/, '').replace(/^https?:\/\//i, '').length > 200) {
          return setError('Sockdrive 完整地址过长，会与旧版本的本地磁盘缓存冲突')
        }
      } catch {
        return setError('Sockdrive 目录无法解析为有效地址')
      }
      if (form.dosExtras?.length) {
        return setError('流式游戏盘不能现场合并 DOS 附加文件；请先把补丁写入磁盘再重新生成 Sockdrive')
      }
    }
    const cleanedDosEntries: Record<string, string> = {}
    const cleanedDosStartupCommands: Record<string, string> = {}
    const cleanedDosSockdrives: Record<string, string> = {}
    for (const l of allRomLangs) {
      const rawLanguageSockdrive = form.dosSockdrives?.[l]?.trim().replace(/\/+$/, '')
      if (rawLanguageSockdrive) {
        const prefix = `${romLanguageLabel(l)} Sockdrive：`
        if (!dosboxXSockdrive) return setError(`${prefix}需要 DOSBox-X；普通 DOSBox 不支持远程磁盘按需读取`)
        if (!form.roms?.[l]?.trim()) return setError(`${prefix}请先绑定同语言 ROM 完整回退包`)
        if (rawLanguageSockdrive.length > 500 || /[^\x21-\x7e]|["'%&|<>^()]/.test(rawLanguageSockdrive)) {
          return setError(`${prefix}目录必须用 ASCII，且不能含空格、引号、DOS 批处理保留字符或超过 500 字符`)
        }
        if (rawLanguageSockdrive.startsWith('//')) return setError(`${prefix}不能使用 // 开头的协议相对地址`)
        if (/^[a-z][a-z0-9+.-]*:/i.test(rawLanguageSockdrive) && !/^https?:\/\//i.test(rawLanguageSockdrive)) {
          return setError(`${prefix}完整地址只支持 HTTP 或 HTTPS`)
        }
        if (/[?#]/.test(rawLanguageSockdrive)) return setError(`${prefix}目录不能带查询参数或锚点`)
        if (/(?:^|\/)sockdrive\.metaj$/i.test(rawLanguageSockdrive) || /\.raw$/i.test(rawLanguageSockdrive)) {
          return setError(`${prefix}请填写包含 sockdrive.metaj 的目录，不要填写某个文件`)
        }
        if (!isVersionedSockdriveDirectory(rawLanguageSockdrive)) {
          return setError(`${prefix}目录必须以版本号或内容哈希结尾；发布新磁盘时必须换新目录`)
        }
        try {
          const resolved = new URL(romUrlForKey(rawLanguageSockdrive) || rawLanguageSockdrive, window.location.href)
          if (!/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password) {
            return setError(`${prefix}必须是没有账号口令的 HTTP(S) 目录`)
          }
          if (resolved.toString().replace(/\/+$/, '').replace(/^https?:\/\//i, '').length > 200) {
            return setError(`${prefix}完整地址过长，会与旧版本的本地磁盘缓存冲突`)
          }
        } catch {
          return setError(`${prefix}目录无法解析为有效地址`)
        }
        cleanedDosSockdrives[l] = rawLanguageSockdrive
      }
      try {
        const commands = normalizeDosStartupCommands(form.dosStartupCommands?.[l])
        if (commands) {
          if (!form.roms?.[l]?.trim()) return setError(`${romLanguageLabel(l)} 填了启动前命令，但还没有绑定 ROM ZIP`)
          if (windowsGuest) return setError('共享 Windows 系统模式不能使用 DOS 启动前命令')
          if (/^\s*imgmount\b.*\.cue\b/im.test(commands) && form.dosBackend !== 'dosboxX') {
            return setError(`${romLanguageLabel(l)} 使用 CUE 光盘镜像，请先在“运行环境”选择 DOSBox-X`)
          }
          cleanedDosStartupCommands[l] = commands
        }
      } catch (err) {
        return setError(`${romLanguageLabel(l)}：${err instanceof Error ? err.message : '启动前命令无效'}`)
      }
      const raw = form.dosExecutables?.[l]?.trim()
      if (!raw) continue
      if (!form.roms?.[l]?.trim()) return setError(`${romLanguageLabel(l)} 填了启动文件，但还没有绑定 ROM ZIP`)
      const path = raw.replace(/\\/g, '/').replace(/^\/+/, '')
      // 与服务端 dosExecutableOf 一致；在提交前指出错误，避免后端丢掉无效路径却返回成功。
      // eslint-disable-next-line no-control-regex
      if (path.length > 200 || /[\x00-\x1f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        return setError(`${romLanguageLabel(l)} 的启动文件路径无效，请填写 ZIP 内的相对路径`)
      }
      cleanedDosEntries[l] = path
    }
    if (Object.keys(cleanedDosSockdrives).length && form.dosExtras?.length) {
      return setError('流式游戏盘不能现场合并 DOS 附加文件；请先把补丁写入磁盘再重新生成 Sockdrive')
    }
    if (windowsGuest && !form.dosExecutable?.trim() && (!Object.keys(form.roms ?? {}).length || allRomLangs.some((l) => form.roms?.[l]?.trim() && !cleanedDosEntries[l]))) {
      return setError('共享 Windows 系统模式需要默认自启动 EXE，或为每个已绑定语言填写启动文件')
    }
    let dosboxConfig: string | undefined
    if (form.platform === 'dos') {
      try {
        dosboxConfig = normalizeDosboxConfigOverride(form.dosboxConfig) || undefined
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'DOSBox 配置格式不正确')
      }
    }

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)

    const cleanedRoms: Record<string, string> = {}
    const cleanedRomBackups: Record<string, string> = {}
    const cleanedRomAssets: Record<string, string[]> = {}
    const cleanedRomBundleEntries: Record<string, string> = {}
    for (const l of allRomLangs) {
      const raw = form.roms?.[l]?.trim()
      if (form.platform === 'html5' && raw) {
        const problem = html5EntryProblem(raw)
        if (problem) return setError(`${romLanguageLabel(l)}：${problem}`)
      }
      const v = raw ? (form.platform === 'html5' ? normalizeHtml5Entry(raw) : raw) : ''
      if (v) cleanedRoms[l] = v
      const assets = form.romAssets?.[l]
      if (v && Array.isArray(assets) && assets.length) cleanedRomAssets[l] = [...new Set(assets)]
      const entry = form.romBundleEntries?.[l]?.trim()
      if (v && entry) cleanedRomBundleEntries[l] = entry
      const rawBackup = form.romBackups?.[l]?.trim()
      if (form.platform === 'html5' && rawBackup) {
        const problem = html5EntryProblem(rawBackup)
        if (problem) return setError(`${romLanguageLabel(l)}备用地址：${problem}`)
      }
      const backup = rawBackup ? (form.platform === 'html5' ? normalizeHtml5Entry(rawBackup) : rawBackup) : ''
      if (!backup) continue
      if (!v) return setError(`${romLanguageLabel(l)} 填了备用地址，但还没有主地址`)
      if (backup === v) return setError(`${romLanguageLabel(l)} 的备用地址不能和主地址相同`)
      cleanedRomBackups[l] = backup
    }
    const rawGenericRom = form.rom?.trim() ?? ''
    if (form.platform === 'html5' && rawGenericRom) {
      const problem = html5EntryProblem(rawGenericRom)
      if (problem) return setError(`通用入口：${problem}`)
    }
    const cleanedGenericRom = rawGenericRom
      ? (form.platform === 'html5' ? normalizeHtml5Entry(rawGenericRom) : rawGenericRom)
      : ''
    for (const value of [cleanedGenericRom, ...Object.values(cleanedRoms), ...Object.values(cleanedRomBackups)]) {
      if (!value) continue
      if (value.length > 500) return setError('ROM 地址过长（数据库上限 500 字符）')
      const ref = romArchiveRef(value)
      if (!ref) continue
      try {
        if (value.length > 500) throw new Error('外站 ZIP 地址过长（数据库上限 500 字符）')
        assertRomArchiveRef(ref)
        if (!/^https?:\/\//i.test(ref.sourceUrl)) throw new Error('外站 ZIP 必须填写完整的 HTTP(S) 地址')
        if (form.platform === 'html5') throw new Error('HTML5 游戏不能用 ZIP 单文件解包；请部署完整站点并填写入口 URL')
        if (form.platform === 'java') throw new Error('Java 游戏当前需要服务端读取 JAR，不能使用仅浏览器解包的外站 ZIP')
        if (isStreamingDiscPlatform(form.platform)) throw new Error('大光盘镜像需要按需读取，不能整包下载后在浏览器解包')
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'ZIP 内 ROM 路径无效')
      }
    }

    const gameToSave: Game = {
      ...form,
      slug,
      title: form.title.trim(),
      titleZh: form.titleZh?.trim() || undefined,
      // 仅去空格和空值，不按当前 ROM 槽过滤：先解绑再换包时，已校对的名称不能悄悄丢失。
      titleLocalized: Object.fromEntries(
        Object.entries(form.titleLocalized ?? {})
          .map(([language, title]) => [language, title.trim()] as const)
          .filter(([, title]) => Boolean(title)),
      ),
      developer: normalizeDevelopers(form.developer) || '未知',
      cover: form.cover?.trim() || undefined,
      video: form.video?.trim() || undefined,
      rom: cleanedGenericRom || undefined,
      roms: Object.keys(cleanedRoms).length ? cleanedRoms : undefined,
      // 显式提交空对象：解绑入口 / 改成单文件时必须清除旧的多文件授权清单。
      romAssets: form.platform === 'flash' ? cleanedRomAssets : {},
      romBundleEntries: form.platform === 'flash' ? cleanedRomBundleEntries : {},
      // 空对象也要送出：管理员清空最后一个备用地址时，服务端才能删除旧值。
      romBackups: cleanedRomBackups,
      // 空对象也显式提交：编辑时清空所有语言入口，服务端才知道这是有意清除。
      dosExecutables: form.platform === 'dos' && !pc98 ? cleanedDosEntries : {},
      // 清空最后一个语言命令时也要显式送空对象，服务端才能删掉旧命令。
      dosStartupCommands: form.platform === 'dos' && !pc98 ? cleanedDosStartupCommands : {},
      // 每个语言槽绑定自己的流式盘；空对象同样要送出，才能明确清掉最后一条旧绑定。
      dosSockdrives: form.platform === 'dos' && !pc98 ? cleanedDosSockdrives : {},
      tags: tags.length ? tags : undefined,
      /**
       * rating / ratingCount / plays 都不在表单里填，编辑时原样带回、新建时是 0。
       *
       * plays 由后端在玩家真正开始游戏时累加；评分是 game_ratings 明细的聚合，
       * 服务端在每次有人打分时按明细重算（见 server/src/ratings-repo.js）。
       * ⚠️ 也就是说这两个字段发上去服务端根本不看（gameApiToRow 不映射它们），
       * 想手动「调一下评分」是调不动的 —— 下一票一来就被算回真实值。
       */
      rating: Math.max(0, Number(form.rating) || 0),
      ratingCount: Math.max(0, Math.round(Number(form.ratingCount) || 0)),
      plays: Math.max(0, Math.round(Number(form.plays) || 0)),
      coinReward: Math.max(0, Math.round(Number(form.coinReward) || 0)),
      year: Math.round(Number(form.year) || 0),
      // 空 / 0 / 负数一律当「不上首页」。清空输入框时有的浏览器回 0 而不是空串，
      // 不归一化的话这款游戏会莫名其妙钉在首页第一个
      homeRank: Number(form.homeRank) > 0 ? Math.round(Number(form.homeRank)) : undefined,
      // 空字符串要写成 undefined，否则会当成「核心名叫空串」存进去
      core: form.core?.trim() || undefined,
      // Play! 只允许在街机上作为 System 2x6 包的显式运行时，不影响普通 FBNeo / MAME ROM。
      runtime: form.platform === 'nes' || (form.platform === 'arcade' && form.runtime === 'play')
        ? (form.runtime ?? undefined)
        : null,
      // 普通 DOS 用它生成 autoexec；共享 Windows 3.x 直接运行它，95/98 则写进启动批处理。
      // 旧式“系统和游戏揉在一个 .jsdos”没有共享系统字段，仍按原 bundle 的 conf 启动。
      dosExecutable: form.platform === 'dos' && !pc98 ? form.dosExecutable?.trim() || undefined : undefined,
      // 普通 DOS 是默认值，不落冗余字段；勾选时才明确保存 DOSBox-X。
      dosBackend: form.platform === 'dos' && (pc98 || form.dosBackend === 'dosboxX') ? 'dosboxX' : undefined,
      dosPc98: form.platform === 'dos' ? pc98 : false,
      // 平台仍然保存为 DOS；这些字段只描述 DOSBox-X 里面要启动的客体系统。
      dosSystem: windowsGuest ? form.dosSystem!.trim() : undefined,
      // 留空完全走旧的整包游戏层；填写后才启用按扇区读取，方便单款游戏独立灰度和回退。
      dosSockdrive,
      dosWindowsVersion: windowsGuest ? form.dosWindowsVersion ?? '9x' : undefined,
      dosLaunchDelay: windowsGuest ? Math.max(5, Math.min(120, Math.round(Number(form.dosLaunchDelay) || 24))) : undefined,
      dosExtras: form.platform === 'dos' && !pc98 ? form.dosExtras : undefined,
      dosExtrasLabel: form.platform === 'dos' && !pc98 ? form.dosExtrasLabel?.trim() || undefined : undefined,
      dosExtrasLabelEn: form.platform === 'dos' && !pc98 ? form.dosExtrasLabelEn?.trim() || undefined : undefined,
      // 整包 Windows 客体仍不可存；纯 DOS / Windows Sockdrive 只固化改过的扇区，可以使用存档说明。
      dosSaveHint: form.platform === 'dos' && (!windowsGuest || Boolean(dosSockdrive) || Object.keys(cleanedDosSockdrives).length > 0) ? form.dosSaveHint?.trim() || undefined : undefined,
      // 街机改版包专用；换成别的平台时要清掉，否则改完平台还留着一份没人读的 dat
      arcadeRomData: form.platform === 'arcade' ? form.arcadeRomData?.trim() || undefined : undefined,
      // 非街机平台一律不带这个字段：留着的话换平台后旧的 BIOS 名会跟着走，
      // 而 mappers 那边只做形状校验，它不知道这款游戏已经不该要 BIOS 了
      arcadeBios: form.platform === 'arcade' ? form.arcadeBios?.trim().toLowerCase() || undefined : undefined,
      // CHD 是某款 MAME 游戏的内容媒体而不是 BIOS；换平台时必须一并清掉，
      // 否则以后又切回街机会带着一张不属于当前 ROM 的盘。
      arcadeMameDisks: form.platform === 'arcade' ? form.arcadeMameDisks : undefined,
      /*
        DIP 开关同理：非街机要清掉，否则换完平台还挂着一句没人读的话。

        ⚠️ 这里**不能**像上面的 BIOS 名那样 toLowerCase()：那一栏允许写完整的核心选项键
        （`fbneo-dipswitch-kov-Controls=Mahjong`），而键名是大小写敏感的 ——
        小写化之后就再也匹配不上了，症状是「后台填了、跑起来没反应」。
        组名那一段的大小写无所谓：匹配时两边都归一化（见 dipPlan 的 normName）。
      */
      arcadeDip: form.platform === 'arcade' ? form.arcadeDip?.trim() || undefined : undefined,
      arcadeButtons: form.platform === 'arcade' ? form.arcadeButtons : undefined,
      // Flash 配置同时保存画面兼容模式和键位；纯鼠标游戏也可能只留下显示模式。
      flashControls: form.platform === 'flash' ? form.flashControls : undefined,
      // 只在 Flash 条目保存依赖标记；未核实必须保留 null，不能等同于离线可玩。
      requiresNetwork: form.platform === 'flash' ? form.requiresNetwork ?? null : null,
      dosboxConfig,
      // 空字符串写成 undefined，否则会存一条空的英文简介，
      // 前台判「有没有英文版」时就会误判成有
      descriptionEn: form.descriptionEn?.trim() || undefined,
      // 暂时移除 ROM 槽时保留旧文案，避免换包流程误删已校对的 SEO 内容。
      descriptionLocalized: Object.fromEntries(
        Object.entries(form.descriptionLocalized ?? {})
          .map(([language, description]) => [language, description.trim()] as const)
          .filter(([, description]) => Boolean(description)),
      ),
    }
    void Promise.resolve(onSubmit(gameToSave)).then((saved) => {
      if (typeof saved === 'string') {
        backgroundSubmitRequested.current = false
        setError(saved)
        if (autoSaveAfterUpload) onBackgroundUploadFailure?.(null)
        return
      }
      if (saved === false && autoSaveAfterUpload) {
        backgroundSubmitRequested.current = false
        setError('游戏资料未保存成功，草稿仍保留在编辑器中。')
        onBackgroundUploadFailure?.(null)
      }
    }).catch(() => {
      if (autoSaveAfterUpload) {
        backgroundSubmitRequested.current = false
        setError('游戏资料未保存成功，草稿仍保留在编辑器中。')
        onBackgroundUploadFailure?.(null)
      }
    })
  }

  return (
    <form ref={formElementRef} onSubmit={submit} className="space-y-4" aria-busy={submitting || romDeleteBusy || uploadActivity.active.length > 0}>
      <nav aria-label="游戏编辑分区" className="sticky top-0 z-20 -mx-3 flex flex-wrap gap-1 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur sm:-mx-5 sm:px-5">
        {[
          ['game-basic', '基础信息'],
          ['game-runtime', '平台与运行'],
          ['game-roms', '游戏文件'],
          ['game-media', '展示与简介'],
          ['game-publish', '发布设置'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cx(btnClass.small, 'border border-transparent text-muted hover:border-line hover:bg-surface-2 hover:text-fg')}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs" role="status">
        <span><b className="text-fg">{platformMap[form.platform]?.nameZh ?? form.platform}</b></span>
        <span className="text-muted">{Object.values(form.roms ?? {}).filter((key) => key?.trim()).length || Number(Boolean(form.rom?.trim()))} 个 ROM 槽已绑定</span>
        {coreOptions.length > 0 && (
          <span className="text-muted">核心：{form.core ? coreOptions.find((option) => option.id === form.core)?.label ?? form.core : '自动适配'}</span>
        )}
        {form.platform === 'arcade' && (
          <span className="text-muted">
            自动识别：{form.playersInferred ? `${form.playersInferred} 人` : '玩家人数待识别'}
            {form.arcadeBios ? ` · BIOS ${form.arcadeBios}` : ''}
          </span>
        )}
        {!isPlayable(form.platform) && <span className="text-live">此平台暂不支持在线运行</span>}
      </div>
      <fieldset disabled={submitting || romDeleteBusy} className="contents">
      <section id="game-basic" className="scroll-mt-14 space-y-4 rounded-xl border border-line p-4">
        <header>
          <h3 className="text-sm font-semibold">基础信息</h3>
          <p className="mt-1 text-xs text-muted">先填标题、平台与分类；slug 会跟随英文标题生成，也可以在新建时手动调整。</p>
        </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="英文标题 *">
          <input className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Super Mario Bros." maxLength={200} required />
        </Field>
        <Field label="中文译名">
          <input className={inputClass} value={form.titleZh ?? ''} onChange={(e) => set('titleZh', e.target.value)} placeholder="超级马力欧兄弟" maxLength={200} />
        </Field>
        {localizedTitleRomLanguages.map((language) => (
          <Field
            key={language}
            label={`标题（${romLanguageLabel(language)}）`}
            hint="此语言界面会用它显示游戏名、页面标题和站内搜索。先核对该语言槽实际 ROM 的发行地区/版本，再填当地玩家常用的正式名称；改版 ROM 不要直接套用原版标题。留空时回退到原名，繁体中文会先回退到自动转换的繁体译名。"
          >
            <input
              className={inputClass}
              value={form.titleLocalized?.[language] ?? ''}
              onChange={(e) => set('titleLocalized', {
                ...form.titleLocalized,
                [language]: e.target.value,
              })}
              placeholder={language === 'zh-Hant'
                ? form.titleI18n?.[language] || form.titleZh || form.title
                : form.title}
              maxLength={200}
            />
          </Field>
        ))}
        <Field label="slug（URL 标识）" hint={isEdit ? '编辑时不可修改' : '留空则根据英文标题自动生成'}>
          <input
            className={cx(inputClass, isEdit && 'opacity-60')}
            value={form.slug}
            disabled={isEdit}
            onChange={(e) => {
              setSlugTouched(true)
              set('slug', e.target.value)
            }}
            placeholder="super-mario-bros"
          />
        </Field>
        <Field label="平台 *">
          <select className={inputClass} value={form.platform} onChange={(e) => {
            set('platform', e.target.value as PlatformId)
            set('runtime', undefined)
            // 模拟器核心是平台专属配置；切平台后必须重新按新平台自动推断。
            manualCoreChoice.current = false
            set('core', undefined)
          }}>
            {platforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon} {p.name}
                {isPlayable(p.id) ? '' : '（暂不支持在线运行）'}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="类型 *（可多选）">
        <div className="flex flex-wrap gap-1.5">
          {genres.map((g) => {
            const on = form.genres.includes(g.id)
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleGenre(g.id)}
                className={cx(
                  'rounded-md border px-2 py-1 text-xs transition',
                  on ? 'border-brand bg-brand-soft text-fg' : 'border-line text-muted hover:text-fg',
                )}
              >
                {g.icon} {g.name}
              </button>
            )
          })}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="发行年份" hint="不确定可以留空，前台不会显示年份">
          <input type="number" className={inputClass} value={form.year || ''} onChange={(e) => set('year', Number(e.target.value))} />
        </Field>
        <Field label="开发商" hint="多个开发商用逗号分隔">
          <input className={inputClass} value={form.developer} onChange={(e) => set('developer', e.target.value)} placeholder="Nintendo, HAL Laboratory" maxLength={200} />
        </Field>
        <Field
          label="最大玩家数"
          hint={
            form.platform === 'arcade'
              ? '街机按 ROM 自动识别，这里的值不生效'
              : (form.netplayMode ?? 'auto') === 'on' ? '强制开启联机时用这个人数' : '「自动」时按 ROM 推断，这里的值不生效'
          }
        >
          <select
            className={inputClass}
            value={form.players}
            disabled={form.platform === 'arcade' || (form.netplayMode ?? 'auto') !== 'on'}
            onChange={(e) => set('players', Number(e.target.value) as Game['players'])}
          >
            {Array.from({ length: NETPLAY_MAX_PLAYERS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} 人
              </option>
            ))}
          </select>
        </Field>
        {FEATURES.coins && (
          <Field label="G 币奖励">
            <input type="number" min="0" className={inputClass} value={form.coinReward} onChange={(e) => set('coinReward', Number(e.target.value))} />
          </Field>
        )}
        <Field label="上线日期">
          <input type="date" className={inputClass} value={form.addedAt} onChange={(e) => set('addedAt', e.target.value)} />
        </Field>
      </div>
      </section>

      <section id="game-runtime" className="scroll-mt-14 space-y-4 rounded-xl border border-line p-4">
        <header>
          <h3 className="text-sm font-semibold">平台与运行</h3>
          <p className="mt-1 text-xs text-muted">{platformMap[form.platform]?.name ?? form.platform} 专属选项会按平台自动展开；留空的核心和引擎由播放器按 ROM 特征选择。</p>
        </header>
      <div className="grid w-full min-w-0 gap-3 sm:grid-cols-2">
        {form.platform === 'dos' && (
          <>
            {/* Field 根节点也是 label，复选框卡片再嵌一层 label 会破坏 HTML 结构。运行区是两列网格，跨行项目用 col-span-full；span-4 会造出隐式列，让选项组被压成窄列。 */}
            <div className="col-span-full min-w-0">
              <span className="mb-1 block text-xs font-medium text-muted">运行环境</span>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                <label className="flex min-h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm">
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={form.dosBackend === 'dosboxX'}
                    disabled={pc98Form}
                    onChange={(e) => {
                      setForm((current) => ({
                        ...current,
                        dosBackend: e.target.checked ? 'dosboxX' : undefined,
                        dosWindowsVersion: e.target.checked ? current.dosWindowsVersion ?? '9x' : current.dosWindowsVersion,
                        dosLaunchDelay: e.target.checked ? current.dosLaunchDelay ?? 24 : current.dosLaunchDelay,
                      }))
                    }}
                  />
                  <span className="min-w-0">DOSBox-X（CUE 光盘 / Windows 3.x / 95 / 98）</span>
                </label>
                <label className="flex min-h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm">
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={pc98Form}
                    onChange={(e) => {
                      const next = e.target.checked
                      if (next && !window.confirm('PC-98 会改为从 .fdi 软盘直接启动，并清空 Windows、Sockdrive、DOS 启动程序和附加文件设置。继续吗？')) return
                      setForm((current) => next
                        ? {
                            ...current,
                            dosPc98: true,
                            dosBackend: 'dosboxX',
                            dosSystem: undefined,
                            dosSockdrive: undefined,
                            dosSockdrives: {},
                            dosExecutable: undefined,
                            dosExecutables: {},
                            dosStartupCommands: {},
                            dosExtras: undefined,
                            dosExtrasLabel: undefined,
                            dosExtrasLabelEn: undefined,
                            dosWindowsVersion: undefined,
                            dosLaunchDelay: undefined,
                          }
                        : { ...current, dosPc98: false })
                    }}
                  />
                  <span className="min-w-0">PC-98 软盘模式（.fdi）</span>
                </label>
              </div>
              <p className="mt-1 text-[11px] text-dim">
                数据库平台仍是 DOS。PC-98 会固定使用 DOSBox-X 的 <code>machine=pc98</code>，从 FDI 自身启动；只挂 CUE 光盘时系统镜像留空；要运行 Windows 才需要填写系统镜像。
              </p>
            </div>
            {pc98Form ? (
              <Field label="PC-98 启动方式" className="col-span-full min-w-0">
                <p className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm text-fg">
                  上传一张 <code>.fdi</code> 软盘镜像即可。播放器会在本地生成 js-dos 启动包，固定以 <code>machine=pc98</code> 挂载到 A: 后启动，不需要填写 EXE、BAT、Windows 系统盘或 Sockdrive。
                </p>
              </Field>
            ) : form.dosBackend === 'dosboxX' ? (
              <>
                <SystemImageField
                  value={form.dosSystem ?? ''}
                  onChange={(value) => set('dosSystem', value || undefined)}
                  allowStorage={!personalLibrary}
                />
                <Field label="全语言共用流式盘（旧数据兼容，可选）" className="col-span-full min-w-0">
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={form.dosSockdrive ?? ''}
                    onChange={(e) => set('dosSockdrive', e.target.value || undefined)}
                    placeholder="sockdrives/caesar3-v1"
                  />
                  <p className="mt-1 text-[11px] text-dim">
                    单语言游戏或所有语言确实共用同一块磁盘时才填这里。多语言游戏请在下方每个 ROM
                    语言槽中分别上传，播放器会跟随实际命中的语言选择流式盘。纯 DOS 可不填系统镜像，
                    但仍必须使用 DOSBox-X；路径必须带版本，禁止原地覆盖。
                  </p>
                  {form.dosSockdrive?.trim() && Object.keys(form.roms ?? {}).length > 1 && (
                    <p className="mt-2 rounded-lg border border-live/40 bg-live/10 px-3 py-2 text-xs text-live">
                      ⚠️ 当前有多个语言 ROM，却配置了全局流式盘。除非这些语言本来就在同一块游戏盘内，
                      否则请清空这里，并在对应语言槽分别生成，避免玩家选中文却挂载英文内容。
                    </p>
                  )}
                  {form.dosSystem?.trim() && !hasAnySockdrive && (
                    <p className="mt-2 rounded-lg border border-live/40 bg-live/10 px-3 py-2 text-xs text-live">
                      ⚠️ 当前是整包兼容模式：玩家冷启动必须完整下载并重打游戏 ZIP，而且 Windows
                      客体里的战役、玩家档案和设置不会持久化。经营、战略或中大型游戏上线前应转换并绑定 Sockdrive。
                    </p>
                  )}
                </Field>
                <Field label="Windows 版本">
                  <select
                    className={inputClass}
                    value={form.dosWindowsVersion ?? '9x'}
                    onChange={(e) => set('dosWindowsVersion', e.target.value === '3x' ? '3x' : '9x')}
                  >
                    <option value="3x">Windows 3.x（Program Manager）</option>
                    <option value="9x">Windows 95 / 98（开始菜单）</option>
                  </select>
                  <p className="mt-1 text-[11px] text-dim">决定播放器用 Program Manager 的 File → Run，还是开始菜单的 Run。</p>
                </Field>
                <Field label="默认 Windows 自启动 EXE">
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={form.dosExecutable ?? ''}
                    onChange={(e) => set('dosExecutable', e.target.value || undefined)}
                    placeholder="WINDEPTH.EXE 或 BIN/GAME.EXE"
                  />
                  <p className="mt-1 text-[11px] text-dim">
                    游戏 ZIP 或流式游戏盘内的相对路径；语言槽有单独入口时优先使用语言槽的值。Windows 3.x 会先打开 EXE 所在目录再运行，请填写类似 ZEEK1.EXE、BIN/GAME.EXE 的 DOS 8.3 英文路径。
                  </p>
                </Field>
                <Field label="开机等待（秒）">
                  <input
                    type="number"
                    min="5"
                    max="120"
                    className={inputClass}
                    value={form.dosLaunchDelay ?? 24}
                    onChange={(e) => set('dosLaunchDelay', Math.max(5, Math.min(120, Number(e.target.value) || 24)))}
                  />
                  <p className="mt-1 text-[11px] text-dim">这是桌面识别的最长等待上限；桌面稳定后会提前启动，慢设备可适当调大。</p>
                </Field>
              </>
            ) : (
              <Field label="默认启动程序">
                <input
                  className={inputClass}
                  value={form.dosExecutable ?? ''}
                  onChange={(e) => set('dosExecutable', e.target.value || undefined)}
                  placeholder="PARANOID.COM 或 NFS/TNFS.EXE"
                />
                <p className="mt-1 text-[11px] text-dim">
                  ZIP 包内的相对路径。语言槽没填入口时用这里；这里也留空则自动猜测。旧游戏的设置会继续生效。
                </p>
              </Field>
            )}
            <Field
              label={`${form.dosBackend === 'dosboxX' ? 'DOSBox-X' : 'DOSBox'} 配置覆盖`}
              className="col-span-full min-w-0"
            >
              <textarea
                className={cx(inputClass, 'h-44 resize-y py-2 font-mono text-xs leading-5')}
                value={form.dosboxConfig ?? ''}
                onChange={(e) => set('dosboxConfig', e.target.value || undefined)}
                spellCheck={false}
                placeholder={'[cpu]\ncycles=max\n\n[dos]\nems=false'}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {DOSBOX_CONFIG_TEMPLATES
                  // raw_mouse_input 是 DOSBox-X 独有项，普通 DOSBox 上显示只会让管理员误以为已经生效。
                  .filter((template) => form.dosBackend === 'dosboxX' || !template.config.includes('raw_mouse_input'))
                  .map((template) => (
                    <button
                      key={template.label}
                      type="button"
                      className={cx(btnClass.secondary, 'h-7 px-2 text-xs')}
                      onClick={() => applyDosboxTemplate(template.config)}
                    >
                      {template.label}
                    </button>
                  ))}
                <button
                  type="button"
                  className={cx(btnClass.secondary, 'h-7 px-2 text-xs')}
                  onClick={() => {
                    set('dosboxConfig', undefined)
                    setError(null)
                  }}
                >
                  恢复系统默认
                </button>
              </div>
              <p className="mt-1 text-[11px] text-dim">
                只保存需要覆盖的 INI 项；支持内存、CPU、DOS 内存接口、声卡和灵敏度设置。[autoexec]、鼠标捕获模式与游戏盘挂载由站点保护。
              </p>
              {form.dosBackend === 'dosboxX' ? (
                <p className="mt-1 text-[11px] text-dim">
                  Windows 3.x 镜像默认 <code>memsize=256</code>，手机内存紧张时可降到 32 MB；实模式游戏偏慢时可尝试 <code>cycles=max</code>。
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-dim">
                  普通 DOS 默认 16 MB、<code>cycles=auto</code>。后期保护模式游戏内存不足可设 32 MB；实模式动作游戏偏慢可用 <code>cycles=max</code>；老游戏与 EMS 冲突时可设 <code>[dos] ems=false</code>。
                </p>
              )}
            </Field>
            {!pc98Form && (
              <DosExtrasField
                slug={slugify(form.slug || form.title)}
                value={form.dosExtras}
                onChange={(next) => set('dosExtras', next)}
                label={form.dosExtrasLabel ?? ''}
                onLabelChange={(next) => set('dosExtrasLabel', next)}
                labelEn={form.dosExtrasLabelEn ?? ''}
                onLabelEnChange={(next) => set('dosExtrasLabelEn', next)}
                allowStorage={!personalLibrary}
              />
            )}
            {/* 整包 qcow2 不可保存；Sockdrive 只持久化改过的扇区，可以安全接回存档入口。 */}
            {(!windowsGuestForm || hasAnySockdrive) && (
              <Field label="存档提示" className="col-span-full min-w-0">
                <input
                  className={inputClass}
                  value={form.dosSaveHint ?? ''}
                  onChange={(e) => set('dosSaveHint', e.target.value || undefined)}
                  maxLength={120}
                  placeholder="按 F2 存档、F3 读档"
                />
                <p className="mt-1 text-[11px] text-dim">
                  显示在播放器「保存进度」的说明面板里。DOS 存档是先在游戏里存盘、再由播放器固化盘上的改动，
                  而各家的存档键完全不同（Doom 是 F2，多数游戏走 ESC 菜单）—— 填这句能省掉玩家一轮试错。留空只显示通用说明。
                </p>
              </Field>
            )}
          </>
        )}
        {form.platform === 'arcade' && (
          <>
          <div className="col-span-full min-w-0 rounded-xl border border-line bg-surface-2/40 p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold">街机专属设置</h4>
                <p className="mt-1 text-xs text-muted">上传 ROM 后会自动识别核心、BIOS、动作键和联机人数；只在识别不适用或需要特殊兼容时手动调整。</p>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded-full border border-line bg-surface px-2 py-1 text-muted">
                  联机人数：{form.playersInferred ? `${form.playersInferred} 人` : '上传后识别'}
                </span>
                <span className="rounded-full border border-line bg-surface px-2 py-1 text-muted">
                  BIOS：{form.arcadeBios || '平台默认'}
                </span>
              </div>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          <Field label="街机动作键" hint="手机屏幕只显示游戏真正使用的按钮">
            <select
              className={inputClass}
              value={form.arcadeButtons ?? ''}
              onChange={(e) => set('arcadeButtons', e.target.value ? Number(e.target.value) as Game['arcadeButtons'] : undefined)}
            >
              {/* 留空时播放器按 BIOS 推断（Neo Geo 4 键，其它 6 键）；以前下拉框把空值显示成「6 键」，看不出是默认 */}
              <option value="">自动（Neo Geo 4 键 / 其它 6 键）</option>
              <option value={2}>2 键</option>
              <option value={4}>4 键</option>
              <option value={6}>6 键</option>
            </select>
          </Field>
          <Field label="BIOS 包（系统名）" className="col-span-full min-w-0">
            <input
              className={cx(inputClass, 'font-mono')}
              list="known-arcade-bios"
              value={form.arcadeBios ?? ''}
              onChange={(e) => set('arcadeBios', e.target.value || undefined)}
              spellCheck={false}
              placeholder="自动识别；例如 neogeo / pgm"
            />
            <datalist id="known-arcade-bios">
              {KNOWN_ARCADE_BIOS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <p className="mt-1 text-[11px] text-dim">
              上传时会自动匹配；留空使用平台默认 BIOS。只有改版包或识别不到的系统才需要手填，地址在「ROM 存储 → 街机 BIOS 包」里按系统名绑定。
            </p>
            {/*
              手填这条路必须当场告诉人「这个系统还没绑地址」—— 上传那次识别会自动查一遍，
              手输却不会，而缺 BIOS 的报错（核心说 missing files）看上去永远像 ROM 的问题。
              绑定表没拉下来时不说话（见上面那条 useEffect 的说明）。
            */}
            {biosUnbound && (
              <p className="mt-1 text-[11px] text-live">
                ⚠️ 还没绑 <span className="font-mono">bios:{biosUnbound}</span> 的地址，
                平台级那份也不是它 —— 现在直接开会报「缺文件」。
                {!personalLibrary && (
                  <Link to="/admin/roms" className="ml-1 text-brand-hover hover:underline">
                    去绑定 →
                  </Link>
                )}
              </p>
            )}
          </Field>
            </div>
          <details
            open={Boolean(form.arcadeDip?.trim() || form.arcadeRomData?.trim())}
            className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
          >
            <summary className="cursor-pointer select-none text-xs font-medium text-fg">
              高级兼容设置（仅麻将 DIP、汉化 / 改版 RomData 需要）
            </summary>
            <p className="mt-1 text-[11px] text-dim">
              普通官方 romset 不需要填写这里。已有配置会自动展开，避免编辑时漏看。
            </p>
            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="DIP 开关">
                <input
                  className={cx(inputClass, 'font-mono')}
                  value={form.arcadeDip ?? ''}
                  onChange={(e) => set('arcadeDip', e.target.value || undefined)}
                  spellCheck={false}
                  placeholder="mahjong"
                />
                <p className="mt-1 text-[11px] text-dim">
                  仅在麻将类游戏需要切换为麻将面板时填写 <code>mahjong</code>；也可填 <code>组名=值</code>，多条用逗号分隔。只对 FBNeo 系核心有效。
                </p>
              </Field>
              <Field label="RomData（汉化 / 改版包）">
                <textarea
                  className={cx(inputClass, 'h-44 resize-y py-2 font-mono text-xs leading-5')}
                  value={form.arcadeRomData ?? ''}
                  onChange={(e) => set('arcadeRomData', e.target.value || undefined)}
                  spellCheck={false}
                  placeholder={'// wofcn 已能识别，但加载方案尚未通过投币后的实际对白画面验证，当前不会自动启动。\n// 请勿把实验中的 RomData 写入游戏级共享字段。\n// 其它改版包请填写与实际 ROM 完全匹配的 ZipName、DrvName 和完整 ROM 清单。'}
                />
                <p className="mt-1 text-[11px] text-dim">
                  仅给不在 FBNeo 驱动表里的包用。必须同时写 <code>ZipName</code> 和 <code>DrvName</code>；已识别的改版包会在上传结果中提供一键填入。
                </p>
              </Field>
            </div>
          </details>
          </div>
          </>
        )}
        {form.platform === 'flash' && (
          <>
            <Field label="外部网络依赖">
              <select
                className={inputClass}
                value={form.requiresNetwork == null ? '' : form.requiresNetwork ? 'yes' : 'no'}
                onChange={(e) => set('requiresNetwork', e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}
              >
                <option value="">未确认</option>
                <option value="yes">需要外部网络</option>
                <option value="no">不需要外部网络</option>
              </select>
              <p className="mt-1 text-[11px] text-dim">
                这是给 API 客户端的运行提示，不会自动补齐 Flash 外部资源。确认自包含后再选「不需要」。
              </p>
            </Field>
            <FlashControlsField
              value={form.flashControls}
              onChange={(value) => set('flashControls', value)}
            />
          </>
        )}
        {coreOptions.length > 0 && (
          <Field label="模拟器核心">
            <select
              className={inputClass}
              value={form.core ?? ''}
              onChange={(e) => {
                const value = e.target.value || undefined
                manualCoreChoice.current = Boolean(value)
                set('core', value)
              }}
            >
              <option value="">平台默认</option>
              {coreOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {/*
              说明按平台分三套。原来只有街机那一段 —— 而这个下拉现在 PS1 和 NDS 也有，
              给他们看「拳皇是 Neo Geo」等于没说，还会让人以为换核心是为了修 romset。
              三个平台换核心的**目的完全不同**，这一格就是告诉管理员该为什么换。
            */}
            {form.platform === 'arcade' ? (
              <p className="mt-1 text-[11px] text-dim">
                上传时会按 ROM CRC 自动选核心：完整命中 FBNeo 支持集时选 FBNeo，精确命中已验证的 MAME 专属指纹时选 MAME 当前版；
                不完整或无法确认的包不会猜，已有手动选择也不会被覆盖。MAME 当前版兼容面广，但启动较慢、占用更高。
              </p>
            ) : form.platform === 'nds' ? (
              <p className="mt-1 text-[11px] text-dim">
                melonDS DS 1.4.0 是默认的持续维护核心，布局里自带《节奏天国》需要的左/右旋转。
                所以只在<strong className="text-muted">这一款画面不对、或者手机上跑不动</strong>时才换成 DeSmuME：
                它有帧跳和可调分辨率，代价是准确度不如 melonDS DS。旧 melonDS 已下线，不再可选。
              </p>
            ) : form.platform === 'psx' ? (
              <p className="mt-1 text-[11px] text-dim">
                两个核心的取舍方向<strong className="text-muted">完全相反，没有哪个更好</strong>：PCSX-ReARMed 为手机而生，
                快、省内存，但 GTE 精度是近似的，个别游戏会花屏或几何抖动；Beetle PSX HW 准得多、还能拉高清，
                中低端手机上会掉帧。默认保「能跑起来」，有画面问题或想要高清的单款再换。
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-dim">
                留空 = 用平台默认核心。<strong className="text-muted">每个核心认的 romset 版本、支持的选项都不一样</strong>，
                只在这一款有具体问题时才换。
              </p>
            )}
          </Field>
        )}
        {(form.platform === 'nes' || form.platform === 'arcade') && (
          <Field label="模拟器引擎">
            <select
              className={inputClass}
              value={form.runtime ?? ''}
              onChange={(e) => set('runtime', (e.target.value || undefined) as typeof form.runtime)}
            >
              {form.platform === 'nes' ? (
                <>
                  <option value="">自动（按格式 / mapper 选择）</option>
                  <option value="jsnes">jsnes（明确指定，轻量、启动快）</option>
                  <option value="emulatorjs">EmulatorJS（兼容性更好，需下载核心）</option>
                </>
              ) : (
                <>
                  <option value="">自动（FBNeo / MAME）</option>
                  <option value="play">Play! System 2x6（仅 8BitGo Play! 街机包）</option>
                </>
              )}
            </select>
            <p className="mt-1 text-[11px] text-dim">
              {form.platform === 'nes'
                ? <>自动模式只在直链 iNES 的 mapper 已确认受支持时用 <b>jsnes</b>；8BG / ZIP、未知格式或不支持的 mapper 走 <b>EmulatorJS</b>。已人工验收的容器 ROM 可在这里明确固定 jsnes，避免同一游戏因为探测条件变化而切换引擎和存档命名空间。</>
                : <>只有按 <code>8bitgo-play-arcade-v1</code> 目录结构制作的 System 2x6 包才能选 Play!；普通街机 romset 保持自动模式。该包会整包下载到浏览器，至少需要约 1GB 可用内存，不属于按扇区流式启动。</>}
            </p>
          </Field>
        )}
        {!personalLibrary && <Field label="首页排序">
          <input
            type="number"
            min="0"
            className={inputClass}
            placeholder="留空 = 不上首页"
            value={form.homeRank ?? ''}
            onChange={(e) => set('homeRank', e.target.value === '' ? undefined : Number(e.target.value))}
          />
          <p className="mt-1 text-[11px] text-dim">
            填数字就会进首页最上面的「站长精选」那一栏，小的排前面，留空 = 不上首页。
            精选是<strong className="text-muted">单独的一栏</strong>，不挂 #1 #2 的排名角标 —— 手挑的顺序不该被当成热度榜。
            它<strong className="text-muted">不会顶掉任何东西</strong>：按游玩次数排的那份真榜一直在下面的「最多人玩的模拟器游戏」那一栏。
            全部留空时，精选那一栏整个不出现，首页第一栏就是真榜。
          </p>
        </Field>}
      </div>
      </section>

      <section id="game-roms" className="scroll-mt-14 space-y-4 rounded-xl border border-line p-4">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">游戏文件</h3>
            <p className="mt-1 text-xs text-muted">选择文件后会先做平台识别与完整性检查，再按文件大小和网络条件选择直传或断点分片。</p>
          </div>
          <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] text-muted">
            {Object.values(form.roms ?? {}).filter((key) => key?.trim()).length} 个语言槽已绑定
          </span>
        </header>
      <div className="space-y-3 rounded-xl border border-line p-3">
        <div>
          <p className="text-sm font-semibold">{form.platform === 'arcade' ? '街机 ROM 与启动配置' : 'ROM 文件（按语言）'}</p>
          {form.platform === 'arcade' ? (
            <>
              <p className="mt-0.5 text-xs text-muted">
                一份 ZIP 对应一个可启动 romset。选择文件后会在浏览器只读取 ZIP 目录与 CRC，自动校验结构、识别 FBNeo / MAME、推荐核心并补齐可确定的 BIOS；不会解压整包或猜测不完整 ROM 的名字。
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-line bg-surface-2 p-2 text-xs"><b className="text-fg">1. 选择 ZIP</b><p className="mt-1 text-dim">原始 romset ZIP；嵌套目录会安全拍平或明确阻止。</p></div>
                <div className="rounded-lg border border-line bg-surface-2 p-2 text-xs"><b className="text-fg">2. 自动识别</b><p className="mt-1 text-dim">只在 CRC 完整命中时改为正确 set 名，避免上传后才出现缺文件。</p></div>
                <div className="rounded-lg border border-line bg-surface-2 p-2 text-xs"><b className="text-fg">3. 保存条目</b><p className="mt-1 text-dim">按识别结果检查核心、BIOS 与必需 CHD，再保存即可。</p></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">默认只显示一个主版本，减少新建条目的无效操作。</span>
                <button
                  type="button"
                  className={cx(btnClass.small, 'border border-line bg-surface-2 text-fg hover:border-line-strong')}
                  onClick={() => setShowArcadeVariants((shown) => !shown)}
                >
                  {showArcadeVariants ? '收起地区 / 语言变体' : '添加地区 / 语言变体'}
                </button>
              </div>
            </>
          ) : (
            <p className="mt-0.5 text-xs text-muted">
              每个语言先探主地址、再探同语言备用地址；两者都失败才依次回退到 <span className="font-medium text-fg">English → 日本語 → 简体中文 → 繁體中文 → 其他已绑定语言</span>，全部没有时提示“游戏没有当前语言版本”。
            </p>
          )}
          {form.platform === 'dos' && (
            <p className="mt-1 text-xs text-muted">
              {pc98Form
                ? 'PC-98 模式只接受 .fdi 软盘镜像；每个语言槽可以绑定不同的 FDI，启动路径由软盘自身决定。'
                : 'DOS 可以像以前一样每种语言上传不同包；若一个 ZIP 内含多语言，只上传一次，再把其他语言槽绑定到同一个 ZIP key，并分别填写 BAT / EXE 等启动文件的包内相对路径。'}
            </p>
          )}
          {isStreamingDiscPlatform(form.platform) && (
            <p className="mt-1 text-xs text-muted">
              {form.platform === 'ps2'
                ? 'PS2 直接上传 .iso（也支持 .chd / .cso 等 Play! 格式），不要套 ZIP。播放器会按需分段读盘。'
                : form.platform === 'psp'
                  ? 'PSP 直接上传 .iso；需要节省流量可用 .cso / .chd，不要套 ZIP。PPSSPP 会从 R2 按 2MB 分块读盘，不会先下载整份镜像。'
                  : 'GameCube / Wii 直接上传 .rvz 或 .iso（也支持平台列表里的其它 Dolphin 单文件格式），不要套 ZIP。推荐用桌面 Dolphin 转成 RVZ，播放器会按需分段读盘。'}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface-2 p-3">
            <label className="min-w-40 flex-1 text-xs text-muted">
              自定义语言代码
              <input
                className={cx(inputClass, 'mt-1')}
                value={newRomLanguageCode}
                onChange={(e) => setNewRomLanguageCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRomLanguage() } }}
                placeholder="例如 ko、pt-BR"
                maxLength={10}
              />
            </label>
            <button type="button" className={btnClass.secondary} onClick={addRomLanguage}>添加语言 ROM 槽</button>
            <p className="basis-full text-[11px] text-dim">保留现有语言槽，可按 ISO / BCP-47 代码添加单款游戏专用语言；例如 ko（韩语）、pt-BR（巴西葡萄牙语）。</p>
          </div>
        </div>
        {displayedRomLangs.map((lang) => (
          <div key={lang} className="space-y-2">
            {form.platform === 'dos' && !pc98Form && (
              <>
                <Field label={`${romLanguageLabel(lang)} 启动文件（${form.dosSockdrives?.[lang]?.trim() || form.dosSockdrive?.trim() ? '流式游戏盘内' : 'ZIP 内'}）`}>
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={form.dosExecutables?.[lang] ?? ''}
                    onChange={(e) => setDosEntryLang(lang, e.target.value)}
                    placeholder="例如 CN/START.BAT、GAME.EXE"
                  />
                  <p className="mt-1 text-[11px] text-dim">
                    {form.dosBackend === 'dosboxX' && form.dosSystem?.trim()
                      ? '留空则用上面的默认 Windows 自启动 EXE；共享 Windows 系统模式不自动猜测。'
                      : '留空则用上面的默认启动程序；默认也留空时由播放器自动猜测。'}
                  </p>
                </Field>
                <Field label={`${romLanguageLabel(lang)} 启动前命令（ZIP 内）`}>
                  <textarea
                    className={cx(inputClass, 'min-h-24 font-mono text-sm')}
                    value={form.dosStartupCommands?.[lang] ?? ''}
                    onChange={(e) => setDosStartupCommandsLang(lang, e.target.value)}
                    placeholder={'imgmount d "./CD/HEROES2_fixed.cue" -t cdrom'}
                    disabled={form.dosBackend === 'dosboxX' && Boolean(form.dosSystem?.trim())}
                  />
                  <p className="mt-1 text-[11px] text-dim">
                    播放器已经挂载 ZIP 为 C 盘，命令会在上面的 BAT / EXE 启动前执行。光盘镜像必须在同一个 ZIP 内；中文版可挂载 ./CD/HEROES2_fixed.cue，免 CD 的英文版留空。CUE 光盘请选 DOSBox-X 核心，且不要再写 mount c、c: 或 heroes2.exe。
                  </p>
                </Field>
                {allRomLangs.some((other) => other !== lang && form.roms?.[other]?.trim()) && (
                  <select
                    className={cx(inputClass, 'text-xs')}
                    value=""
                    onChange={(e) => e.target.value && setRomLang(lang, e.target.value)}
                    aria-label={`给 ${romLanguageLabel(lang)} 复用已上传的 DOS ZIP`}
                  >
                    <option value="">复用其他语言已绑定的 ZIP（只绑定，不重复上传）</option>
                    {allRomLangs.filter((other) => other !== lang && form.roms?.[other]?.trim()).map((other) => (
                      <option key={other} value={form.roms![other]}>{romLanguageLabel(other)} · {form.roms![other]}</option>
                    ))}
                  </select>
                )}
              </>
            )}
            <RomField
              lang={lang}
              dosEntry={form.platform === 'dos' ? form.dosExecutables?.[lang] : undefined}
              label={form.platform === 'arcade'
                ? lang === arcadePrimaryLang
                  ? `街机 ROM（${romLanguageLabel(lang)} · 主版本）`
                  : `${romLanguageLabel(lang)} 街机 ROM（地区 / 语言变体）`
                : lang === 'en' ? 'English ROM（第一回退）' : lang === 'ja' ? '日本語 ROM（第二回退）' : `${romLanguageLabel(lang)} ROM`}
              value={form.roms?.[lang] ?? ''}
              assetsValue={form.romAssets?.[lang] ?? []}
              bundleEntryValue={form.romBundleEntries?.[lang] ?? ''}
              backupValue={form.romBackups?.[lang] ?? ''}
              platform={form.platform}
              runtime={form.runtime}
              slug={slugify(form.slug || form.title)}
              persistedSlug={initial?.slug}
              autoSockdrive={sockdriveConfigSaved(lang) && initial?.slug ? {
                gameSlug: initial.slug,
                executable: form.dosExecutables?.[lang] ?? form.dosExecutable ?? '',
                value: form.dosSockdrives?.[lang] ?? '',
                windowsGuest: windowsGuestForm,
                hasExtras: Boolean(form.dosExtras?.length),
                onCompleted: (job) => acceptCompletedSockdrive(lang, job),
              } : undefined}
              onChange={(key) => setRomLang(lang, key)}
              onAssetsChange={(paths) => setRomAssetsLang(lang, paths)}
              onBundleEntryChange={(path) => setRomBundleEntryLang(lang, path)}
              onBackupChange={(key) => setRomBackupLang(lang, key)}
              allBoundKeys={allBoundKeys}
              onDeleteRom={deleteBoundRom}
              deletingRom={romDeleteBusy}
              onHackFound={(hack) => {
                // wofcn 的识别结果只属于这份 ROM；arcade_romdata 是游戏级字段，不能写入后影响其它语言槽。
                if (hack.romDataScope !== 'rom') applyHack(hack, true)
              }}
              onApplyHack={(hack) => applyHack(hack)}
              onArcadeIdentityReset={resetAutoArcadeFields}
              // 只填空的（或上次自动填的）：管理员手填过就听他的（汉化版借用别的驱动时人比表准）
              onBiosFound={(name) => setForm((f) => {
                const cur = f.arcadeBios?.trim().toLowerCase() ?? ''
                if (cur && cur !== autoArcade.current.bios) return f
                const bios = name.trim().toLowerCase()
                autoArcade.current.bios = bios
                return { ...f, arcadeBios: bios || undefined }
              })}
              onButtonsFound={(buttons) => setForm((f) => {
                if (f.arcadeButtons && f.arcadeButtons !== autoArcade.current.buttons) return f
                autoArcade.current.buttons = buttons
                return { ...f, arcadeButtons: buttons }
              })}
              onMameMediaFound={setMameMediaProfile}
              onCoreFound={(core) => {
                if (!manualCoreChoice.current) setForm((f) => ({ ...f, core }))
              }}
              allowStorage={!personalLibrary}
            />
            {dosboxXSockdriveForm && form.roms?.[lang]?.trim() && (
              <SockdriveAutoField
                slug={initial?.slug ?? ''}
                lang={lang}
                romKey={form.roms[lang]!}
                executable={form.dosExecutables?.[lang] ?? form.dosExecutable ?? ''}
                value={form.dosSockdrives?.[lang] ?? ''}
                streamingEnabled={dosboxXSockdriveForm}
                windowsGuest={windowsGuestForm}
                hasExtras={Boolean(form.dosExtras?.length)}
                configurationSaved={sockdriveConfigSaved(lang) &&
                  (persistedSockdriveLanguage.current.roms[lang] ?? '').trim() === (form.roms?.[lang] ?? '').trim()}
                allowStorage={!personalLibrary}
                onChange={(value) => setDosSockdriveLang(lang, value)}
                onCompleted={(job) => acceptCompletedSockdrive(lang, job)}
              />
            )}
          </div>
        ))}
      </div>

      {selectedMameCore && (activeMameMediaProfile || form.arcadeMameDisks?.length) && (
        <MameDiskField
          profile={activeMameMediaProfile}
          value={form.arcadeMameDisks ?? []}
          onChange={(arcadeMameDisks) => set('arcadeMameDisks', arcadeMameDisks.length ? arcadeMameDisks : undefined)}
          allowStorage={!personalLibrary}
        />
      )}
      </section>

      <section id="game-media" className="scroll-mt-14 space-y-4 rounded-xl border border-line p-4">
        <header>
          <h3 className="text-sm font-semibold">展示与简介</h3>
          <p className="mt-1 text-xs text-muted">封面会自动缩放压缩；关键词可从已有语言简介提取，翻译结果仍可继续手动校对。</p>
        </header>
      <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
        <Field label="封面 emoji" hint="无封面图 / 视频时的兜底">
          <input className={cx(inputClass, 'text-center text-lg')} value={form.icon} onChange={(e) => set('icon', e.target.value)} maxLength={4} />
        </Field>
        <MediaField
          kind="covers"
          label="封面图片"
          hint="1:1 正方形最佳；留空用程序生成的渐变封面。可上传或手填 key / URL"
          value={form.cover ?? ''}
          slug={slugify(form.slug || form.title)}
          onChange={(v) => set('cover', v)}
          allBoundKeys={allBoundKeys}
          allowStorage={!personalLibrary}
        />
      </div>

      <MediaField
        kind="videos"
        label="卡片视频"
        hint="4:3 横版最佳；有视频时卡片悬停自动播放（静音循环），优先级高于封面图。建议同时设封面图作为封面帧"
        value={form.video ?? ''}
        slug={slugify(form.slug || form.title)}
        onChange={(v) => set('video', v)}
        allBoundKeys={allBoundKeys}
        allowStorage={!personalLibrary}
      />

      <Field label="简介（中文）">
        <textarea
          className={cx(inputClass, 'h-24 resize-y py-2')}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={16_000}
          placeholder="一两句话介绍这款游戏"
        />
      </Field>

      <Field label="简介（English）">
        <textarea
          className={cx(inputClass, 'h-24 resize-y py-2')}
          value={form.descriptionEn ?? ''}
          onChange={(e) => updateEnglishDescription(e.target.value)}
          maxLength={16_000}
          placeholder="One or two sentences about this game"
        />
        <p className="mt-1 text-[11px] text-dim">
          这是固定的英文简介；其他语言没有单独简介或自动译文时会回退到这里，再回退到中文。
          已上传 ROM 的语言可在下方填写更准确的独立简介。
        </p>
        {volcTranslationUsage && !personalLibrary && (
          <p className={cx('mt-1 text-[11px]', volcTranslationUsage.trackingError ? 'text-live' : 'text-dim')} role="status">
            {volcTranslationUsage.trackingError
              ? '火山字符用量记录异常；系统已停止调用火山兜底。'
              : `火山兜底用量：${volcTranslationUsage.usedChars.toLocaleString()} / ${volcTranslationUsage.limitChars.toLocaleString()} 字符；翻译顺序为 MyMemory → Lingva → 火山。${volcTranslationUsage.volcConfigured ? '' : '当前未配置火山密钥；两个公共服务都失败时无法继续翻译。'}`}
          </p>
        )}
      </Field>

      {localizedRomLanguages.map((language) => {
        const hasLocalizedRoute = (ROM_LANGS as readonly string[]).includes(language)
        const isTranslating = translatingLanguage === language
        const canUseVolc = hasLocalizedRoute && language !== 'en' && language !== 'zh-Hans'
        return (
          <Field key={language} label={`简介（${romLanguageLabel(language)}）`}>
            <div className="mb-1 flex justify-end">
              {canUseVolc && (
                <button
                  type="button"
                  className={btnClass.secondary}
                  onClick={() => void translateLocalizedDescription(language)}
                  disabled={submitting || Boolean(translatingLanguage) || !form.descriptionEn?.trim() || !slugify(form.slug || form.title) || !apiEnabled()}
                  title={!apiEnabled() ? '项目 API 未连接' : !form.descriptionEn?.trim() ? '请先填写英文简介' : !slugify(form.slug || form.title) ? '请先填写游戏标题或 slug' : '调用火山翻译并填入此输入框，不会自动保存'}
                >
                  {isTranslating ? '翻译中…' : '翻译并填写'}
                </button>
              )}
            </div>
            <textarea
              className={cx(inputClass, 'h-24 resize-y py-2')}
              value={form.descriptionLocalized?.[language] ?? ''}
              onChange={(e) => updateLocalizedDescription(language, e.target.value)}
              maxLength={4000}
              placeholder={form.descriptionI18n?.[language]?.trim() || `为 ${romLanguageLabel(language)} ROM 填写独立简介`}
            />
            <p className="mt-1 text-[11px] text-dim">
              {hasLocalizedRoute
                ? '用于对应语言的游戏详情与 SEO。请只写该 ROM 版本可核验的内容；地区/修订、多人或无线功能、改版特性不确定时不要写成事实。留空时使用英文简介，没有英文简介时回退中文。灰色占位文字仅供参考，不会保存。'
                : '此语言码目前没有独立站点语言页面；简介会保存，待站点开放对应语言路由后用于 SEO。'}
            </p>
            {translationFeedback?.language === language && (
              <p className={cx('mt-1 text-[11px]', translationFeedback.kind === 'success' ? 'text-emerald-500' : 'text-live')} role="status" aria-live="polite">
                {translationFeedback.text}
              </p>
            )}
          </Field>
        )
      })}

      <Field label="关键词 / 标签" hint="从中文、英文及已填写的其他语言简介中分别提取主题词和短语；新建条目自动更新，手动编辑后不再覆盖。用逗号分隔。">
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={tagsText}
            onChange={(e) => {
              tagsManuallyEdited.current = true
              autoTagsValue.current = ''
              setTagsText(e.target.value)
            }}
          />
          <button type="button" className={btnClass.secondary} onClick={regenerateKeywords} disabled={!hasKeywordDescriptions}>
            从所有语言简介提取
          </button>
        </div>
      </Field>
      </section>

      <section id="game-publish" className="scroll-mt-14 space-y-4 rounded-xl border border-line p-4">
        <header>
          <h3 className="text-sm font-semibold">发布设置</h3>
          <p className="mt-1 text-xs text-muted">联机人数默认按 ROM 推断；这里集中管理上下架、精选和玩家可见行为。</p>
        </header>
      <div className="flex flex-wrap gap-4 text-sm">
        {/*
          联机不再要求逐款勾选：默认「自动」由服务端按 ROM 推断人数（街机读 FBNeo 驱动表，
          见 server/src/netplay-auto.js），这里只用来纠错。
        */}
        {/* 街机没有手动开关：服务端忽略 netplayMode，按 FBNeo 驱动表自动识别（netplay-auto.js） */}
        {form.platform === 'arcade' ? (
          <span className="inline-flex items-center gap-2">
            联机
            <span className="text-xs text-muted">
              自动识别：
              {form.playersInferred
                ? `${form.playersInferred} 人${form.playersInferred >= 2 ? '，可联机' : '，单人游戏不开放联机'}`
                : '驱动表里没有这个 romset，按街机默认 2 人'}
            </span>
          </span>
        ) : (
        <label className="inline-flex items-center gap-2">
          联机
          <select
            className={inputClass}
            value={form.netplayMode ?? 'auto'}
            onChange={(e) => set('netplayMode', e.target.value as NonNullable<Game['netplayMode']>)}
          >
            <option value="auto">自动（按 ROM 推断）</option>
            <option value="on">强制开启</option>
            <option value="off">强制关闭</option>
          </select>
          <span className="text-xs text-muted">
            {(form.netplayMode ?? 'auto') === 'auto'
              ? form.playersInferred
                ? `推断为 ${form.playersInferred} 人${form.playersInferred >= 2 ? '，可联机' : '，单人游戏不开放联机'}`
                : '这个平台还没有自动数据，沿用已保存的设置'
              : null}
          </span>
        </label>
        )}
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={Boolean(form.adult)} onChange={(e) => set('adult', e.target.checked)} /> 成人游戏（需验证年满 18 岁）
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={Boolean(form.hidden)} onChange={(e) => set('hidden', e.target.checked)} />{' '}
          {personalLibrary ? '在我的库中隐藏' : '下架（前台不显示）'}
        </label>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-live/15 px-3 py-2 text-sm text-live">
          {error}
        </p>
      )}
      </section>

      <div className="sticky bottom-0 z-20 -mx-3 flex justify-end gap-2 border-t border-line bg-surface/95 px-3 py-3 backdrop-blur sm:-mx-5 sm:px-5">
        <button type="button" className={btnClass.secondary} onClick={requestCancel} disabled={submitting || romDeleteBusy}>
          取消
        </button>
        {!personalLibrary && onMinimizeForUpload && (
          <button
            type="button"
            className={btnClass.secondary}
            onClick={startBackgroundUpload}
            disabled={submitting || romDeleteBusy}
            title="弹窗会缩到角落；当前上传与转码全部结束后自动保存"
          >
            后台上传并保存
          </button>
        )}
        <button type="submit" className={btnClass.primary}>
          {submitting ? '保存中…' : isEdit ? '保存修改' : '新增游戏'}
        </button>
      </div>
      </fieldset>
    </form>
  )
}

const FLASH_BUTTON_LABEL: Record<FlashControlButton, string> = {
  up: '上', down: '下', left: '左', right: '右', a: 'A', b: 'B', select: '选择', start: '开始',
}
const FLASH_KEY_OPTIONS = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape', 'ShiftLeft', 'ControlLeft',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
  ...'0123456789'.split('').map((digit) => `Digit${digit}`),
]

function FlashControlsField({
  value,
  onChange,
}: {
  value?: Game['flashControls']
  onChange: (value: Game['flashControls']) => void
}) {
  const displayMode = value?.displayMode ?? 'fit'
  // 显示模式不属于键位预设；否则只切一次画面模式，方向键预设就会被误判成「自定义」。
  const controlValue = value?.p1 && Object.keys(value.p1).length
    ? { p1: value.p1, ...(value.p2 ? { p2: value.p2 } : {}) }
    : undefined
  const serialized = controlValue ? JSON.stringify(controlValue) : ''
  const preset = !controlValue
    ? 'mouse'
    : Object.entries(FLASH_CONTROL_PRESETS).find(([, controls]) => JSON.stringify(controls) === serialized)?.[0] ?? 'custom'
  const buttons = Object.keys(FLASH_BUTTON_LABEL) as FlashControlButton[]

  const replaceControls = (controls?: NonNullable<Game['flashControls']>) => {
    const next = controls ? cloneFlashControls(controls) : {}
    if (displayMode === 'ruffle') next.displayMode = 'ruffle'
    onChange(next.p1 || next.displayMode ? next : undefined)
  }

  const update = (player: 'p1' | 'p2', button: FlashControlButton, key: string) => {
    const next = cloneFlashControls(value ?? { p1: {} })
    const pad = { ...next[player] }
    if (key) pad[button] = key
    else delete pad[button]
    if (player === 'p1') {
      if (Object.keys(pad).length) next.p1 = pad
      else {
        delete next.p1
        // 2P 不能脱离 1P 独立存在；删光 1P 时一起清掉，避免保存接口拒绝整张表单。
        delete next.p2
      }
    } else if (Object.keys(pad).length) next.p2 = pad
    else delete next.p2
    onChange(next.p1 || next.displayMode ? next : undefined)
  }

  return (
    <Field
      label="Flash 显示与控制"
      hint="默认按 SWF 原始比例居中；纯鼠标游戏不要配键位"
      className="col-span-2 sm:col-span-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted">
          画面缩放
          <select
            className={cx(inputClass, 'mt-1')}
            value={displayMode}
            onChange={(e) => {
              const next = cloneFlashControls(value ?? {})
              if (e.target.value === 'ruffle') next.displayMode = 'ruffle'
              else delete next.displayMode
              onChange(next.p1 || next.displayMode ? next : undefined)
            }}
          >
            <option value="fit">原始比例等比居中（推荐）</option>
            <option value="ruffle">Ruffle 原始显示（兼容）</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          操作方式
          <select
            className={cx(inputClass, 'mt-1')}
            value={preset}
            onChange={(e) => {
              const name = e.target.value
              if (name === 'mouse') replaceControls()
              else if (name !== 'custom') replaceControls(FLASH_CONTROL_PRESETS[name as keyof typeof FLASH_CONTROL_PRESETS])
            }}
          >
            <option value="mouse">纯鼠标 / 触屏点击（不显示手柄）</option>
            <option value="arrows">方向键</option>
            <option value="arrowsSpace">方向键 + 空格</option>
            <option value="wasdSpace">WASD + 空格</option>
            <option value="fireboy">双人：方向键 + WASD</option>
            {preset === 'custom' && <option value="custom">自定义</option>}
          </select>
        </label>
      </div>

      {controlValue && (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
          {(['p1', 'p2'] as const).map((player) => {
            const enabled = player === 'p1' || Boolean(controlValue.p2)
            return (
              <div key={player}>
                <div className="mb-2 flex items-center gap-3 text-xs font-semibold text-muted">
                  <span>{player === 'p1' ? '1P' : '2P'}</span>
                  {player === 'p2' && (
                    <label className="flex items-center gap-1 font-normal">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          const next = cloneFlashControls(value ?? controlValue)
                          if (e.target.checked) next.p2 = {}
                          else delete next.p2
                          onChange(next)
                        }}
                      />
                      同屏双人
                    </label>
                  )}
                </div>
                {enabled && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {buttons.map((button) => (
                      <label key={button} className="text-[11px] text-dim">
                        {FLASH_BUTTON_LABEL[button]}
                        <select
                          className={cx(inputClass, 'mt-1 py-1 text-xs')}
                          value={controlValue[player]?.[button] ?? ''}
                          onChange={(e) => update(player, button, e.target.value)}
                        >
                          <option value="">不使用</option>
                          {FLASH_KEY_OPTIONS.map((key) => <option key={key} value={key}>{key}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p className="mt-1 text-[11px] text-dim">
        Flash 没有统一按键标准；不要给纯鼠标游戏套默认方向键。双人配置会同时开放直播观众的 2P 座位。
      </p>
    </Field>
  )
}

/**
 * 分片上传时的进度补充说明。
 *
 * 只有一句「上传中 43%」的话，管理员看不出这次是从头传还是接着上次传的 ——
 * 而「已恢复 4 片」恰恰是他最想确认的那件事（否则会怀疑上次那几十 MB 白传了）。
 * 小文件走单发 PUT，没有分片信息，这时返回空串、界面上什么都不多显示。
 */
function stageText(stage: UploadStage | null): string {
  if (!stage) return ''
  if (stage.checkingTotal !== undefined) {
    return `正在校验续传分片 ${stage.checkingParts ?? 0}/${stage.checkingTotal}`
  }
  if (stage.parts <= 1) return ''
  const networkText = stage.measuredMbps
    ? ` · 实测 ${stage.measuredMbps.toFixed(1)} Mbps${stage.concurrency ? ` · ${stage.concurrency} 路` : ''}`
    : stage.done < stage.parts
      ? ` · 正在测速${stage.concurrency ? ` · ${stage.concurrency} 路` : ''}`
      : ''
  const serverText = stage.serverWaitMs !== undefined
    ? ` · Worker/R2 平均额外等待约 ${stage.serverWaitMs >= 1000 ? `${(stage.serverWaitMs / 1000).toFixed(1)}s` : `${Math.round(stage.serverWaitMs)}ms`}${stage.serverWaitSamples ? `（${stage.serverWaitSamples} 片样本）` : ''}`
    : ''
  const hashText = stage.hashWaitMs !== undefined
    ? ` · 本机校验平均等待约 ${stage.hashWaitMs >= 1000 ? `${(stage.hashWaitMs / 1000).toFixed(1)}s` : `${Math.round(stage.hashWaitMs)}ms`}${stage.hashWaitSamples ? `（${stage.hashWaitSamples} 片样本）` : ''}`
    : ''
  return `分片 ${stage.done}/${stage.parts}` +
    (stage.resumed ? ` · 已恢复 ${stage.resumed} 片` : '') +
    networkText + serverText + hashText
}

/**
 * DOS 附加文件（资料片 / 补丁 / 额外配置）。
 *
 * 站长 2026-09-11 的原话：「有的时候不是我上传游戏而是运维人员，他们不太会用 cd curl unzip 指令」。
 * 所以这个字段的硬要求是：**把从网上下下来的那个 zip 原样丢进来就行**。
 * 组件自己判断是不是压缩包、自己拆、逐个传、自己算好每个文件在游戏目录里的落点，
 * 全程不需要命令行，也不用重打那份十几 MB 的游戏 ROM。
 *
 * 存进库的是一行一个 `对象key` 或 `对象key|游戏里的路径`（见 lib/dosExtras.ts）。
 *
 * ⚠️ 「移除」只解除这款游戏的绑定，不删 R2 上的对象 —— 和 SystemImageField 一个道理：
 * 同一份补丁可能被别的游戏引用，编辑这一款时顺手删掉会把别人弄坏。真要删去「ROM 存储」页。
 */
const DOS_EXTRAS_MAX = 12

/** 附件批次只开两路；省流量、弱网和低资源设备收回到单路，避免小文件并发放大重传。 */
function dosExtrasUploadConcurrency(): number {
  if (typeof navigator === 'undefined') return 1
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
    deviceMemory?: number
  }
  const type = String(nav.connection?.effectiveType ?? '').toLowerCase()
  const weakNetwork = nav.connection?.saveData || ['slow-2g', '2g', '3g'].includes(type)
  const lowResource = (nav.deviceMemory ?? Infinity) <= 2 || (nav.hardwareConcurrency ?? Infinity) <= 2
  return weakNetwork || lowResource ? 1 : 2
}

function DosExtrasField({
  slug,
  value,
  onChange,
  label,
  onLabelChange,
  labelEn,
  onLabelEnChange,
  allowStorage,
}: {
  slug: string
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  label: string
  onLabelChange: (value: string | undefined) => void
  labelEn: string
  onLabelEnChange: (value: string | undefined) => void
  allowStorage: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = allowStorage && Boolean(cfg.api && cfg.token)
  const refs = parseDosExtras(value)

  const write = (next: DosExtraRef[]) => {
    const lines = next.map(formatDosExtra)
    onChange(lines.length ? lines : undefined)
  }

  const onFiles = async (files: File[]) => {
    if (!files.length) return
    setMsg(null)

    // 第一步：把选中的东西摊平成「一份份要上传的文件」。压缩包就地拆开，其余原样。
    const planned: { path: string; blob: Blob }[] = []
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer()
        if (isZip(buf)) {
          for (const entry of assertValidZip(buf, file.name)) {
            if (skipExtraEntry(entry.name)) continue
            planned.push({ path: entry.name, blob: new Blob([await extractZipEntry(buf, entry) as BlobPart]) })
          }
        } else {
          planned.push({ path: file.name, blob: file })
        }
      }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '读取附加文件失败' })
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    // 第二步：先把「这批到底放不放得下」说清楚，再动手传。
    // 传到一半才发现超限、前几个已经进了 R2 —— 那种半成品状态最难收拾。
    const usable = planned.filter((item) => normalizeExtraPath(item.path) && extraObjectName(item.path))
    if (!usable.length) {
      setMsg({ ok: false, text: '这些文件里没有能用的附加文件（压缩包可能是空的，或者只有目录）' })
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    // 名字里有中文 / 空格的一律先拦下来。硬传上去的结果是对象 key 被滤成「.MIX」这种
    // 一碰就撞的东西，而在 FAT 盘上它就是一团乱码 —— 玩家只会看到游戏读不到资料片
    const problems = usable
      .map((item) => extraPathProblem(item.path))
      .filter((p): p is NonNullable<typeof p> => p !== null)
    const blocking = problems.filter((p) => p.blocking)
    if (blocking.length) {
      setMsg({ ok: false, text: blocking.map((p) => p.text).join(' ') })
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    // 同名的是替换，不占新名额
    const existing = new Set(refs.map((r) => r.path.toLowerCase()))
    const fresh = usable.filter((item) => !existing.has(normalizeExtraPath(item.path).toLowerCase())).length
    if (refs.length + fresh > DOS_EXTRAS_MAX) {
      setMsg({
        ok: false,
        text: `最多 ${DOS_EXTRAS_MAX} 个附加文件：现在有 ${refs.length} 个，这批要新增 ${fresh} 个。` +
          '每个文件都会进玩家的加载链路，请只挑真正需要的（说明书、截图之类不用传）。',
      })
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    const dir = `extras/${slug || 'shared'}`
    const entries = usable.map((item) => {
      const path = normalizeExtraPath(item.path)
      return { path, key: `${dir}/${extraObjectName(path)}`, blob: item.blob }
    })
    const next = refs.slice()
    const failed: string[] = []
    let done = 0
    setBusy(`检查 ${entries.length} 个文件`)
    try {
      await trackUploadActivity('DOS 附加文件批量上传与绑定', async () => {
        /*
          不同目标可以并行检查；覆盖弹窗仍按文件顺序逐个出现。ZIP 里可能有两个名字被 DOS 规则
          折叠成同一个对象 key（或大小写不同但落到同一 DOS 路径），这种批次继续串行，保留原来的
          「先传第一份，再询问是否覆盖」语义，不能让两份同时抢写同一个 R2 对象。
        */
        const duplicateKeys = new Set<string>()
        const seenKeys = new Set<string>()
        for (const entry of entries) {
          const normalized = entry.key.toLowerCase()
          if (seenKeys.has(normalized)) duplicateKeys.add(normalized)
          seenKeys.add(normalized)
        }

        const approved: Array<{ entry: typeof entries[number] }> = []
        if (duplicateKeys.size === 0) {
          const heads = await Promise.all(entries.map((entry) => headRom(entry.key).catch(() => null)))
          for (let i = 0; i < entries.length; i++) {
            if (await confirmUpload(entries[i].key, entries[i].blob, heads[i])) {
              approved.push({ entry: entries[i] })
            }
          }
        }
        const uploadCount = duplicateKeys.size > 0 ? entries.length : approved.length

        const uploadOne = async (entry: typeof entries[number]) => {
          const { path, key, blob } = entry
          try {
            // 重复 key 批次要在每次写完后再探测，确保覆盖提示看到刚写入的对象。
            if (duplicateKeys.size > 0 && !(await confirmUpload(key, blob))) return
            setBusy(`${path} 0% · ${done}/${uploadCount} 完成`)
            const result = await uploadRom(blob, key, (pct) => setBusy(`${path} ${pct}% · ${done}/${uploadCount} 完成`))
            const at = next.findIndex((r) => r.path.toLowerCase() === path.toLowerCase())
            /*
              新传的默认是**强制注入**。可选与否由管理员看着体积自己勾 ——
              默认成可选的话，补丁这种「不打就是另一个游戏」的东西会悄悄变成没人打。
              原地替换时保留原来那一条的可选状态：重传一版资料片不该把开关也弄丢。
            */
            const ref = { key: result.key, path, optional: at >= 0 ? next[at].optional : false }
            if (at >= 0) next[at] = ref
            else next.push(ref)
            done++
          } catch (err) {
            failed.push(`${path}（${err instanceof Error ? err.message : '上传失败'}）`)
          }
        }

        if (duplicateKeys.size > 0) {
          // 旧的覆盖交互依赖每份文件上传后立刻更新 R2；重复路径一律按原顺序处理。
          for (const entry of entries) await uploadOne(entry)
        } else {
          let cursor = 0
          const workers = Array.from({ length: Math.min(dosExtrasUploadConcurrency(), approved.length) }, async () => {
            while (cursor < approved.length) {
              const index = cursor++
              const { entry } = approved[index]
              await uploadOne(entry)
            }
          })
          await Promise.all(workers)
        }

        setBusy(null)
        if (inputRef.current) inputRef.current.value = ''
        write(next)
        const warn = problems.map((p) => p.text).join(' ')
        if (failed.length) setMsg({ ok: false, text: `${done} 个已上传，${failed.length} 个失败：${failed.join('；')}` })
        else if (done) setMsg({ ok: !warn, text: `已上传并绑定 ${done} 个附加文件。${warn}`.trim() })
      })
    } finally {
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Field label="附加文件（资料片 / 补丁）" className="col-span-full min-w-0">
      {refs.length > 0 && (
        <ul className="mb-2 space-y-1">
          {refs.map((ref, i) => (
            <li key={`${ref.key}|${ref.path}|${i}`} className="flex flex-col gap-1 sm:flex-row sm:items-center">
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-dim"
                title="勾上 = 几百 MB 的资料片，玩家在开始界面上自己决定要不要下；不勾 = 每次都注入（补丁必须不勾）"
              >
                <input
                  type="checkbox"
                  checked={ref.optional}
                  onChange={(e) => {
                    const next = refs.slice()
                    next[i] = { ...ref, optional: e.target.checked }
                    write(next)
                  }}
                />
                可选
              </label>
              <input
                className={cx(inputClass, 'font-mono sm:flex-1')}
                value={ref.path}
                onChange={(e) => {
                  const next = refs.slice()
                  next[i] = { ...ref, path: e.target.value }
                  write(next)
                }}
                aria-label="在游戏目录里的路径"
              />
              <span
                className="truncate font-mono text-[11px] text-dim sm:w-72 sm:shrink-0"
                title={`对象 key：${ref.key}`}
              >
                {ref.key}
              </span>
              <button
                type="button"
                className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
                onClick={() => write(refs.filter((_, j) => j !== i))}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(Array.from(e.target.files ?? []))}
        />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!canUpload || busy !== null}
          onClick={() => inputRef.current?.click()}
        >
          {busy === null ? '上传附加文件 / 压缩包' : `上传中 ${busy}`}
        </button>
        <input
          className={cx(inputClass, 'font-mono sm:flex-1')}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="或直接填已上传的对象 key，如 extras/command-conquer/SC-002.MIX"
        />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!manual.trim() || refs.length >= DOS_EXTRAS_MAX}
          onClick={() => {
            const ref = parseDosExtra(manual)
            if (!ref) return setMsg({ ok: false, text: '这个 key 解析不出文件名' })
            setManual('')
            setMsg(null)
            write([...refs.filter((r) => r.path.toLowerCase() !== ref.path.toLowerCase()), ref])
          }}
        >
          添加
        </button>
      </div>
      {refs.some((r) => r.optional) && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="shrink-0 text-[11px] text-dim">资料片名称</span>
          <input
            className={cx(inputClass, 'sm:flex-1')}
            value={label}
            maxLength={60}
            onChange={(e) => onLabelChange(e.target.value || undefined)}
            placeholder="中文名，如：隐秘行动"
          />
          <input
            className={cx(inputClass, 'sm:flex-1')}
            value={labelEn}
            maxLength={60}
            onChange={(e) => onLabelEnChange(e.target.value || undefined)}
            placeholder="English name, e.g. Covert Operations"
          />
        </div>
      )}
      {msg && <p className={cx('mt-1 text-[11px]', msg.ok ? 'text-emerald-400' : 'text-rose-400')}>{msg.text}</p>}
      <p className="mt-1 text-[11px] text-dim">
        加载时并进游戏目录，<b>不改动已上传的 ROM</b>，也不用刷全站缓存。资料片（《命令与征服》的 SC-002.MIX）、
        官方补丁、额外的 .INI 都走这里。<b>压缩包可以整个丢进来</b>，会自动拆开逐个上传。
「路径」那格是文件在游戏目录里的落点，默认就是文件名（= 和本体放同一层），需要进子目录才改它，清空即恢复默认。
        <b>「可选」是给几百 MB 的资料片用的</b>：勾上之后玩家会在开始界面看到一个开关，<b>默认不下载</b>，
        想玩资料片的自己勾一下 —— 别让每个路过点开的人都先下 500 MB。补丁这种「不打就是另一个游戏」的必须不勾。
        名字中英各填一格：开关上那句话（「同时加载…（额外 498 MB）」）八种语言都有译文，
        只有这个名字是专有名词，不填英文的话英文玩家会在一句英文里看到一个中文名。
        体积不用填，开局前会自动量一次。最多 {DOS_EXTRAS_MAX} 个 —— 每个强制注入的都会进玩家开局的加载链路。
      </p>
    </Field>
  )
}

/**
 * 可复用的 Windows 客体系统镜像。
 *
 * 它不是某一款游戏的 ROM，因此不进入 allBoundKeys，也不在这里提供“从 R2 删除”：同一份
 * Windows 镜像可能被几十款游戏引用，编辑其中一款时顺手删掉会把其它游戏一起弄坏。
 * 管理员可以解除当前游戏的绑定；真正删除共享对象仍到「ROM 存储」页明确操作。
 */
function SystemImageField({
  value,
  onChange,
  allowStorage,
}: {
  value: string
  onChange: (value: string) => void
  allowStorage: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  /** 分片上传的进度明细（单发 PUT 时一直是 null） */
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [uploadedKeys, setUploadedKeys] = useState<string[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const cfg = getRomConfig()
  const canUpload = allowStorage && Boolean(cfg.api && cfg.token)

  useEffect(() => {
    if (!canUpload) return
    let active = true
    setOptionsLoading(true)
    setOptionsError(null)
    listRomObjects('systems/dos')
      .then((objects) => {
        if (!active) return
        const keys = objects
          .filter((object) => /\.jsdos$/i.test(object.key))
          .sort((a, b) => {
            // 系统镜像通常会按版本反复上传，最近上传的应该最容易被选到。
            const byTime = String(b.uploaded ?? '').localeCompare(String(a.uploaded ?? ''))
            return byTime || a.key.localeCompare(b.key)
          })
          .map((object) => object.key)
        setUploadedKeys(keys)
      })
      .catch((err) => {
        if (active) setOptionsError(err instanceof Error ? err.message : '读取已上传镜像失败')
      })
      .finally(() => {
        if (active) setOptionsLoading(false)
      })
    return () => {
      active = false
    }
  }, [canUpload, cfg.api, cfg.token])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (!/\.jsdos$/i.test(file.name)) {
      setMsg({ ok: false, text: '请选择 .jsdos 系统镜像' })
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    const old = value.trim()
    // 已绑对象 key 时允许原地更新；完整 URL / 站内文件不归当前 R2 Worker 管，另存新 key。
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'windows-system.jsdos'
    const key = old && isDeletableKey(old) && /\.jsdos$/i.test(old) ? old : `systems/dos/${safeName}`
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setMsg(null)
    setProgress(0)
    try {
      const result = await uploadRom(file, key, (pct, at) => {
        setProgress(pct)
        if (at) setStage(at)
      })
      onChange(result.key)
      setUploadedKeys((keys) => [result.key, ...keys.filter((item) => item !== result.key)])
      setMsg({ ok: true, text: `系统镜像已上传并绑定：${result.key}（${human(result.size)}）` })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '系统镜像上传失败' })
    } finally {
      setProgress(null)
      setStage(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Field label="共享 Windows 系统镜像" className="col-span-full min-w-0">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={500}
          placeholder="systems/dos/system-win95-v1.jsdos"
        />
        <select
          className={cx(inputClass, 'font-mono sm:w-72 sm:shrink-0')}
          value={uploadedKeys.includes(value.trim()) ? value.trim() : ''}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          disabled={!canUpload || optionsLoading || uploadedKeys.length === 0}
          aria-label="快速选择已上传的系统镜像"
        >
          <option value="">
            {optionsLoading ? '正在读取已上传镜像…' : uploadedKeys.length ? '快速选择已上传镜像' : '暂无已上传镜像'}
          </option>
          {uploadedKeys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <input ref={inputRef} type="file" accept=".jsdos" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!canUpload || progress !== null}
          onClick={() => inputRef.current?.click()}
        >
          {progress === null ? '上传镜像' : `${progress}%`}
        </button>
        {value.trim() && (
          <button
            type="button"
            className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
            onClick={() => {
              onChange('')
              setMsg({ ok: true, text: '已解除这款游戏的系统镜像绑定；共享文件没有删除' })
            }}
          >
            解除绑定
          </button>
        )}
      </div>
      {optionsError && <p className="mt-1 text-[11px] text-live">下拉选项读取失败：{optionsError}；仍可手动填写。</p>}
      <p className="mt-1 text-[11px] text-dim">
        可填对象 key、站内路径或完整 URL。相同值可给所有 Win95 游戏复用；留空则兼容旧模式，把游戏 ROM 当作系统与游戏合一的完整 .jsdos。
        {value.trim() && romUrlForKey(value.trim()) && (
          <>
            {' '}<RomOpenLink className="text-brand-hover hover:underline" href={romUrlForKey(value.trim())}>检查文件</RomOpenLink>
          </>
        )}
      </p>
      {!canUpload && (
        <p className="mt-1 text-[11px] text-dim">
          {allowStorage ? '要直接上传，请先在「ROM 存储」页配置 Worker 地址与口令。' : '个人库只保存文件引用，不能上传或删除对象存储文件。'}
        </p>
      )}
      {progress !== null && stageText(stage) && <p className="mt-1 font-mono text-[11px] text-dim">{stageText(stage)}</p>}
      {msg && <p className={cx('mt-1 text-xs', msg.ok ? 'text-brand-hover' : 'text-live')}>{msg.text}</p>}
    </Field>
  )
}

/** 选了 zip 之后先摊开、等管理员确认的那一份「待上传的包」 */
interface PendingBundle {
  /** 压缩包完整内容，确认后逐个文件现解现传 */
  zip: ArrayBuffer
  /** 压缩包文件名，只用于显示 */
  name: string
  /** 目标包目录，如 roms/flash/jyqx3 */
  dir: string
  plan: SwfBundlePlan
}

/**
 * 原始 DOS / Windows ZIP 的自动发布入口。
 *
 * 这里不把 1GB+ 文件送进 Express：浏览器沿用 R2 multipart，服务端只拿 staging key 建持久任务。
 * 页面关掉只会停止进度轮询，不会杀掉转换；下次打开编辑页会从 localStorage 找回任务显示。
 */
function SockdriveAutoField({
  slug,
  lang,
  romKey,
  executable,
  value,
  streamingEnabled,
  windowsGuest,
  hasExtras,
  configurationSaved,
  allowStorage,
  onChange,
  onCompleted,
}: {
  slug: string
  lang?: RomSlotLang
  romKey?: string
  executable: string
  value: string
  streamingEnabled: boolean
  windowsGuest: boolean
  hasExtras: boolean
  configurationSaved: boolean
  allowStorage: boolean
  onChange: (value: string) => void
  onCompleted: (job: SockdriveConversionJob) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const restored = useRef('')
  const [progress, setProgress] = useState<number | null>(null)
  const [busySelecting, setBusySelecting] = useState(false)
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [failedJobId, setFailedJobId] = useState('')
  const [pendingCreation, setPendingCreation] = useState(false)
  const cfg = getRomConfig()
  const canUpload = allowStorage && configurationSaved && Boolean(cfg.api && cfg.token) && Boolean(slug) && Boolean(!lang || romKey?.trim()) && streamingEnabled && !hasExtras

  const watchJob = async (id: string, signal?: AbortSignal) => {
    const completed = await waitForSockdriveConversion(
      id,
      (job) => {
        setProgress(45 + Math.round(job.progress * 0.55))
        setMessage({ ok: true, text: `${sockdriveConversionLabel(job)} ${job.progress}%${job.message ? `；${job.message}` : ''}` })
      },
      signal,
      (error, attempt, retryInMs) => {
        setMessage({
          ok: false,
          text: `后台任务仍在运行；状态查询暂时失败（${error.message}），${Math.ceil(retryInMs / 1000)} 秒后自动重连（第 ${attempt} 次）`,
        })
      },
    )
    rememberSockdriveConversion(slug, null, lang)
    clearSockdriveUploadIdentity(slug, lang, completed.sourceKey)
    clearPendingSockdriveCreation(slug, lang)
    setFailedJobId('')
    setPendingCreation(false)
    onCompleted(completed)
    setProgress(null)
    setMessage({
      ok: true,
      text: `Sockdrive 已发布：${completed.targetPrefix}` +
        (completed.outputFiles ? `（${completed.outputFiles} 个文件，${human(completed.outputBytes ?? 0)}）` : '') +
        (completed.bound ? '；已自动绑定到游戏' : `；${completed.message || '请保存表单完成绑定'}`),
    })
    return completed
  }

  useEffect(() => {
    if (!slug || !allowStorage) return
    const id = rememberedSockdriveConversion(slug, lang)
    const pending = id ? null : rememberedPendingSockdriveCreation(slug, lang)
    const restoreId = id || pending?.sourceKey || ''
    if (!restoreId || restored.current === restoreId) return
    restored.current = restoreId
    const controller = new AbortController()
    if (id) {
      setProgress(45)
      setMessage({ ok: true, text: '正在恢复上次未完成的 Sockdrive 后台任务…' })
      void watchJob(id, controller.signal).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setProgress(null)
        setFailedJobId(id)
        setMessage({ ok: false, text: error instanceof Error ? error.message : '恢复 Sockdrive 任务失败' })
      })
    } else if (pending) {
      let restoredJobId = ''
      setPendingCreation(true)
      setProgress(45)
      setMessage({ ok: true, text: '原始 ZIP 已在私有 staging，正在恢复任务创建，不会重新上传…' })
      void createSockdriveConversion(pending).then(async (job) => {
        restoredJobId = job.id
        setPendingCreation(false)
        rememberSockdriveConversion(slug, job.id, lang)
        if (!controller.signal.aborted) await watchJob(job.id, controller.signal)
      }).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setProgress(null)
        if (restoredJobId) {
          setFailedJobId(restoredJobId)
          rememberSockdriveConversion(slug, restoredJobId, lang)
        }
        setPendingCreation(preserveSockdriveSourceAfterCreateError(error))
        if (!preserveSockdriveSourceAfterCreateError(error)) clearPendingSockdriveCreation(slug, lang)
        setMessage({
          ok: false,
          text: preserveSockdriveSourceAfterCreateError(error)
            ? `原始 ZIP 已保留，无需重传；创建任务失败：${error instanceof Error ? error.message : String(error)}`
            : error instanceof Error ? error.message : '恢复 Sockdrive 任务失败',
        })
      })
    }
    return () => {
      controller.abort()
      if (restored.current === restoreId) restored.current = ''
    }
    // onChange 是父组件每次渲染新建的闭包；同一任务只允许由 restored 启动一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, lang, allowStorage])

  useEffect(() => {
    const onConversion = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string; lang?: string; id?: string | null }>).detail
      if (detail?.slug !== slug || detail.lang !== lang) return
      if (detail.id) {
        setFailedJobId(detail.id)
        setMessage({ ok: true, text: '当前语言已有 Sockdrive 后台任务；可继续查看进度或在失败后重试，不必重新上传 ZIP。' })
      } else {
        setFailedJobId('')
        setMessage((current) => current?.text.startsWith('当前语言已有 Sockdrive 后台任务') ? null : current)
      }
    }
    window.addEventListener('8bitgo:sockdrive-conversion', onConversion)
    return () => window.removeEventListener('8bitgo:sockdrive-conversion', onConversion)
  }, [slug, lang])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    let stagingKey = ''
    let sourceUploaded = false
    let taskCreated = false
    let createdJobId = ''
    setFailedJobId('')
    setMessage(null)
    try {
      if (!/\.zip$/i.test(file.name)) throw new Error('自动转换只接收原始 .zip 游戏包')
      if (!slug) throw new Error('请先保存游戏资料，再上传超大 ZIP')
      if (!configurationSaved) throw new Error('运行环境、启动 EXE 或流式盘地址有未保存修改；请先保存游戏资料')
      if (lang && !romKey?.trim()) throw new Error('请先保存这个语言的 ROM 完整回退包')
      if (!streamingEnabled) throw new Error('请先选择 DOSBox-X；普通 DOSBox 不支持 Sockdrive')
      if (hasExtras) throw new Error('请先把附加文件合入原始 ZIP，并清空 DOS 附加文件')
      const cleanExecutable = executable.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      // 转换耗时可达数小时；必须在上传 1GB 文件之前拦住最终一定无法绑定的入口。
      // eslint-disable-next-line no-control-regex
      if (!/^[^:<>"|?*\x00-\x1f]+\.exe$/i.test(cleanExecutable) || cleanExecutable.length > 255 || cleanExecutable.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('请先填写当前语言游戏盘内安全的 .EXE 相对路径（或上方默认 EXE）')
      }
      if (!windowsGuest && !isDos83StreamPath(cleanExecutable)) {
        throw new Error('纯 DOS 流式盘的启动程序必须使用 DOS 8.3 路径，例如 FALLOUT.EXE 或 GAME/RUN.EXE')
      }
      const capability = await sockdriveConversionCapability()
      if (!capability.available) throw new Error(capability.reason || '服务器暂时不能制作 Sockdrive')
      if (file.size > capability.maxSourceBytes) throw new Error(`ZIP 超过后台上限 ${human(capability.maxSourceBytes)}`)
      const expectedSockdrive = value.trim().replace(/\/+$/, '')
      const signature = JSON.stringify({ executable: cleanExecutable, romKey: lang ? romKey!.trim() : '', expectedSockdrive })
      const identity = await sockdriveUploadIdentity(file, slug, lang, signature)
      const version = identity.version
      const prefix = `sockdrives/${slug}${lang ? `-${lang.toLowerCase()}` : ''}-${version}`
      if (!window.confirm(
        `${file.name}（${human(file.size)}）\n\n` +
        `${lang ? `${romLanguageLabel(lang)}：` : ''}上传后服务器会自动制作、校验并发布到 ${prefix}，关闭页面也会继续。开始吗？`,
      )) return

      stagingKey = identity.key
      setProgress(0)
      setMessage({ ok: true, text: '正在断点上传原始 ZIP；完成后会自动进入服务器队列' })
      await uploadRom(file, stagingKey, (pct, at) => {
        setProgress(Math.round(pct * 0.45))
        if (at) setStage(at)
      })
      sourceUploaded = true
      setStage(null)
      setProgress(45)
      setMessage({ ok: true, text: '原始 ZIP 已安全上传，正在创建持久转换任务…' })
      const request = {
        sourceKey: stagingKey,
        sourceSize: file.size,
        gameSlug: slug,
        ...(lang ? { lang } : {}),
        ...(lang ? { targetRomKey: romKey!.trim(), expectedRomKey: romKey!.trim() } : {}),
        executable: cleanExecutable,
        version,
        expectedSockdrive,
        encoding: 'br',
      } as const
      // 先落恢复账本再发请求：服务端可能已插入任务，但 502 把响应丢在回程上。
      rememberPendingSockdriveCreation(slug, request, lang)
      const job = await createSockdriveConversion(request)
      taskCreated = true
      createdJobId = job.id
      rememberSockdriveConversion(slug, job.id, lang)
      clearSockdriveUploadIdentity(slug, lang, stagingKey)
      setPendingCreation(false)
      await watchJob(job.id)
    } catch (error) {
      setProgress(null)
      setStage(null)
      const keepUploadedSource = sourceUploaded && !taskCreated && preserveSockdriveSourceAfterCreateError(error)
      setPendingCreation(keepUploadedSource)
      setMessage({
        ok: false,
        text: keepUploadedSource
          ? `原始 ZIP 已安全保留，无需重传；创建任务失败：${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error ? error.message : 'Sockdrive 上传或转换失败',
      })
      if (createdJobId) {
        setFailedJobId(createdJobId)
        rememberSockdriveConversion(slug, createdJobId, lang)
      }
      /*
       * 只有 Worker 明确确认“完整 staging 对象已上传”，且服务端明确拒绝建任务时才删。
       * 上传合并结果不确定、网络断开或 5xx 时都不能删：前两种可能已有完整对象，后一种甚至可能已有任务。
       */
      if (stagingKey && sourceUploaded && !taskCreated && !keepUploadedSource) {
        clearPendingSockdriveCreation(slug, lang)
        await deleteRomObjects([stagingKey]).catch(() => {})
        clearSockdriveUploadIdentity(slug, lang, stagingKey)
      }
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const handleFileSelection = async (file: File | undefined) => {
    if (!file) return
    setBusySelecting(true)
    try {
      await onFile(file)
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '处理所选 ZIP 失败' })
      if (inputRef.current) inputRef.current.value = ''
    } finally {
      setBusySelecting(false)
    }
  }

  const retry = async () => {
    const pending = pendingCreation ? rememberedPendingSockdriveCreation(slug, lang) : null
    if (!failedJobId && !pending) return
    setProgress(45)
    setMessage({ ok: true, text: pending ? '正在用已上传的原始 ZIP 重新创建任务…' : '正在重新排队…' })
    try {
      const job = pending
        ? await createSockdriveConversion(pending)
        : await retrySockdriveConversion(failedJobId)
      rememberSockdriveConversion(slug, job.id, lang)
      setPendingCreation(false)
      await watchJob(job.id)
    } catch (error) {
      setProgress(null)
      setMessage({ ok: false, text: error instanceof Error ? error.message : '重试失败' })
    }
  }

  return (
    <Field
      label={lang ? `${romLanguageLabel(lang)}流式游戏盘` : '原始大 ZIP 自动转 Sockdrive'}
      className="col-span-2"
      hint={lang
        ? '选择这个语言的原始 ZIP；上传、转换、发布、校验和语言槽绑定全部自动完成'
        : '适合大型 DOS / Windows 游戏；上传、转换、发布、校验和绑定全部自动完成'}
    >
      <div className="flex flex-wrap gap-2">
        <input
          className={cx(inputClass, 'min-w-64 flex-1 font-mono')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={lang ? `sockdrives/${slug || 'game'}-${lang.toLowerCase()}-v1` : `sockdrives/${slug || 'game'}-v1`}
          disabled={!streamingEnabled || busySelecting || progress !== null}
        />
        <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" disabled={busySelecting || progress !== null} onChange={(event) => void handleFileSelection(event.target.files?.[0])} />
        <button
          type="button"
          className={btnClass.primary}
          disabled={!canUpload || busySelecting || progress !== null}
          onClick={() => inputRef.current?.click()}
        >
          {busySelecting && progress === null
            ? '检查文件…'
            : progress === null
              ? (value.trim() ? '☁️ 发布新版本' : '☁️ 生成流式盘')
              : `处理中 ${progress}%`}
        </button>
        {value.trim() && progress === null && !busySelecting && (
          <RomOpenLink href={romUrlForKey(value.trim())} className={btnClass.secondary}>检查</RomOpenLink>
        )}
        {(failedJobId || pendingCreation) && progress === null && (
          <button type="button" className={btnClass.secondary} onClick={() => void retry()}>
            {pendingCreation ? '重试创建任务（无需重传）' : '查看 / 重试后台任务'}
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-dim">
        必须先保存这款游戏、当前语言 ROM 和启动 EXE。完整 ROM 继续作为同语言回退包；原始 ZIP
        直接分片进私有 staging，不经过站点服务器内存。发布成功后只绑定当前语言，不影响其它版本。
      </p>
      {!slug && <p className="mt-1 text-xs text-live">请先保存游戏资料，再回来上传原始 ZIP。</p>}
      {slug && !configurationSaved && <p className="mt-1 text-xs text-live">运行环境、启动 EXE 或流式盘地址有修改；请先保存，再生成流式盘。</p>}
      {hasExtras && <p className="mt-1 text-xs text-live">当前还有 DOS 附加文件；流式盘必须先把这些文件烘进原始 ZIP。</p>}
      {!allowStorage && <p className="mt-1 text-xs text-dim">个人库不能创建 R2 转换任务。</p>}
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {progress !== null && stageText(stage) && <p className="mt-1 font-mono text-[11px] text-dim">{stageText(stage)}</p>}
      {message && <p className={cx('mt-2 text-xs', message.ok ? 'text-online' : 'text-live')}>{message.text}</p>}
    </Field>
  )
}

/**
 * 新目录允许一款 MAME 游戏声明多张 CHD。旧版只拿数组第一个，像 beatmania III
 * 这类“CD + HDD”机台会悄悄漏掉第二张盘；每张盘现在都有独立上传、重试与解绑操作。
 */
function MameDiskField({
  profile,
  value,
  onChange,
  allowStorage,
}: {
  profile: MameArcadeDiskProfile | null
  value: ArcadeMameDisk[]
  onChange: (value: ArcadeMameDisk[]) => void
  allowStorage: boolean
}) {
  const expected: readonly MameArcadeDiskExpectation[] = profile?.disks.length
    ? profile.disks
    : value.map((disk) => ({
        romset: disk.romset,
        name: disk.name,
        chdSha1: disk.chdSha1,
        dataSha1: disk.dataSha1,
        storedBytes: disk.storedBytes,
        logicalBytes: disk.logicalBytes,
      }))
  if (!expected.length) return null
  return (
    <Field
      label="MAME 必需媒体盘"
      className="col-span-2"
      hint="游戏专属 CHD，不是 BIOS；播放器会完整下载后挂载，支持断点续传、浏览器本地分片缓存和桌面端热区预读，但不等同于扇区流式运行"
    >
      <div className="space-y-3">
        {expected.map((disk) => (
          <MameDiskUploadRow
            key={`${disk.romset}/${disk.name}`}
            profile={profile}
            expected={disk}
            value={value}
            onChange={onChange}
            allowStorage={allowStorage}
          />
        ))}
      </div>
    </Field>
  )
}

function MameDiskUploadRow({
  profile,
  expected,
  value,
  onChange,
  allowStorage,
}: {
  profile: MameArcadeDiskProfile | null
  expected: MameArcadeDiskExpectation
  value: ArcadeMameDisk[]
  onChange: (value: ArcadeMameDisk[]) => void
  allowStorage: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = allowStorage && Boolean(cfg.api && cfg.token)
  const bound = value.find((disk) => disk.romset === expected.romset && disk.name === expected.name)

  const merge = (disk: ArcadeMameDisk) => onChange([
    ...value.filter((item) => !(item.romset === disk.romset && item.name === disk.name)),
    disk,
  ])
  const onFile = async (file: File | undefined) => {
    if (!file) return
    setMessage(null)
    try {
      await trackUploadActivity(`MAME 媒体盘校验与绑定：${file.name}`, async () => {
        if (!/\.chd$/i.test(file.name)) throw new Error('必需媒体盘必须是 .chd 文件')
        const problem = await mameDiskHeaderProblem(file, expected)
        if (problem) throw new Error(problem)
        const resolved = await mameDiskFromFile(file, expected)
        const key = mameDiskObjectKey(resolved)
        /*
          对象路径包含 MAME 需要的 CHD SHA-1：多游戏共用盘时只保存一份，且不会把
          新上传的压缩版本覆盖正在被玩家下载的旧对象。
        */
        const head = await headRom(key).catch(() => null)
        if (head?.exists) {
          /*
            对象 key 是 CHD SHA-1 的内容地址。相同扇区数据可以被不同 chdman 压缩成不同
            大小，不能因为这次选中的压缩版本与桶内版本体积不同而拒绝；播放器会使用桶内
            那份已验证内容，记录也必须反映实际被绑定对象的大小。
          */
          const storedBytes = typeof head.size === 'number' && Number.isSafeInteger(head.size)
            ? head.size
            : resolved.storedBytes
          merge({ ...resolved, storedBytes, key })
          setMessage({
            ok: true,
            text: head.size !== undefined && head.size !== resolved.storedBytes
              ? `桶里已有相同内容的 ${expected.name}.chd（${human(head.size)}；本次文件采用不同压缩体积），已直接绑定，不会覆盖正在使用的版本。`
              : `桶里已有 ${expected.name}.chd，已直接绑定。`,
          })
          return
        }
        setProgress(0)
        const result = await uploadRom(file, key, (pct, at) => {
          setProgress(pct)
          if (at) setStage(at)
        })
        merge({ ...resolved, key: result.key })
        setMessage({ ok: true, text: `已绑定 ${expected.name}.chd（${human(result.size)}）。保存后会挂到 /roms/${expected.romset}/。` })
      })
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'CHD 上传失败' })
    } finally {
      setProgress(null)
      setStage(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="rounded-lg border border-line bg-card/40 p-3 text-sm">
      <p className="font-semibold text-fg">
        {profile?.board ?? 'MAME 已识别 CHD 媒体'} · <code>{expected.romset}/{expected.name}.chd</code>
      </p>
      <p className="mt-1 text-xs text-muted">
        {expected.dataSha1 !== undefined && expected.logicalBytes !== undefined
          ? <>已核验内容：逻辑容量 {human(expected.logicalBytes)}。上传前核对 v5 文件头、两组 SHA-1 和逻辑容量；同一内容可因 CHD 压缩方式不同而有不同文件大小。</>
          : <>MAME 官方目录已锁定文件名和 CHD SHA-1；选中后会读取 v5 文件头，自动记录实际大小、Data SHA-1 与逻辑容量。</>}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input ref={inputRef} type="file" accept=".chd,application/octet-stream" className="hidden" onChange={(event) => void onFile(event.target.files?.[0])} />
        <button type="button" className={btnClass.primary} disabled={!canUpload || progress !== null} onClick={() => inputRef.current?.click()}>
          {progress === null ? (bound ? '☁️ 重新上传并校验' : '☁️ 上传必需 CHD') : `上传中 ${progress}%`}
        </button>
        {bound?.key && <RomOpenLink href={romUrlForKey(bound.key)} className={btnClass.secondary}>检查</RomOpenLink>}
        {bound && progress === null && <button type="button" className={btnClass.secondary} onClick={() => onChange(value.filter((disk) => disk !== bound))}>解绑</button>}
      </div>
      {bound ? <p className="mt-2 font-mono text-[11px] text-online">✓ 已绑定 {bound.key}</p> : <p className="mt-2 text-xs text-live">缺少这张 CHD 时，{expected.romset} 不会启动；播放器会在开局前停止并说明原因。</p>}
      {progress !== null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10"><div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} /></div>}
      {progress !== null && stageText(stage) && <p className="mt-1 font-mono text-[11px] text-dim">{stageText(stage)}</p>}
      {message && <p className={cx('mt-2 text-xs', message.ok ? 'text-online' : 'text-live')}>{message.text}</p>}
      {!canUpload && allowStorage && <p className="mt-2 text-[11px] text-dim">请先在“ROM 存储”页配置 Worker 地址与口令。</p>}
    </div>
  )
}

/**
 * ROM 字段：可手填 key，也可以选文件直接上传到 R2（通过 Worker），成功后自动填入 key。
 *
 * Flash 还多一条路：选 .zip 时不当成 ROM 传上去，而是在浏览器里解开，
 * 把整包文件传到同一个目录，再把主 SWF 绑成这一槽的 ROM ——
 * 大型 Flash 游戏基本都是「主 SWF + 一堆相对路径加载的素材 SWF」，
 * 单传一个 root.swf 上去只会卡在片头（见 lib/swfBundle.ts 的说明）。
 */
function RomField({
  value,
  assetsValue,
  bundleEntryValue,
  backupValue,
  platform,
  runtime,
  slug,
  persistedSlug,
  autoSockdrive,
  onChange,
  onAssetsChange,
  onBundleEntryChange,
  onBackupChange,
  lang,
  dosEntry,
  label,
  allBoundKeys,
  onDeleteRom,
  deletingRom,
  onHackFound,
  onApplyHack,
  onBiosFound,
  onButtonsFound,
  onArcadeIdentityReset,
  onMameMediaFound,
  onCoreFound,
  allowStorage,
}: {
  value: string
  assetsValue: string[]
  bundleEntryValue: string
  backupValue: string
  platform: PlatformId
  runtime?: Game['runtime']
  slug: string
  /** 只有编辑已有游戏才有值；新建表单不能仅凭一个尚未保存的 slug 去改数据库里的同名游戏。 */
  persistedSlug?: string
  /** 已保存的 DOS / Windows 游戏可用同一次文件选择同时发布完整回退包与逐语言流式盘。 */
  autoSockdrive?: {
    gameSlug: string
    executable: string
    value: string
    windowsGuest: boolean
    hasExtras: boolean
    onCompleted: (job: SockdriveConversionJob) => void
  }
  onChange: (key: string) => void
  onAssetsChange: (paths: string[]) => void
  onBundleEntryChange: (path: string) => void
  onBackupChange: (key: string) => void
  lang?: RomSlotLang
  dosEntry?: string
  label?: string
  /** 这款游戏当前绑定的全部对象 key（不去重）—— 判断旧文件是不是还被别的槽位共用 */
  allBoundKeys: string[]
  /** 主库编辑窗的全库安全删除流程；志愿者个人库不开放 R2 删除。 */
  onDeleteRom?: (key: string) => Promise<{ removed: number; unboundGames: number } | null>
  deletingRom?: boolean
  /**
   * 上传时认出是已知改版包。RomData 字段在父组件手里，所以这里只报告，
   * 由父组件决定要不要自动填（现在的规则：字段是空的才自动填，不覆盖人写好的）。
   */
  onHackFound?: (hack: ArcadeHack) => void
  /**
   * 上传时认出这款游戏需要哪个 BIOS 系统包（`neogeo` / `pgm`）。
   * 和 onHackFound 同理：字段在父组件手里，这里只报告，由父组件决定填不填。
   */
  onBiosFound?: (name: string) => void
  /** 精确识别出动作键数（目前只有 Namco 四键格斗）时报告，父组件只填空的 / 自动填过的 */
  onButtonsFound?: (buttons: NonNullable<Game['arcadeButtons']>) => void
  /** 开始识别一个新的街机 ZIP：父组件撤掉上一次自动填、管理员没改过的字段 */
  onArcadeIdentityReset?: () => void
  /** ROM CRC 完整命中一个需要 CHD 的 MAME 游戏时，通知父表单显示对应媒体盘上传位。 */
  onMameMediaFound?: (profile: MameArcadeDiskProfile | null) => void
  /** 上传证据充分时自动选核心；父表单只填空值，不覆盖管理员已有的手动选择。 */
  onCoreFound?: (core: ArcadeCoreId) => void
  /** 管理员点「套用」时明确要求写入，覆盖也无所谓 */
  onApplyHack?: (hack: ArcadeHack) => void
  /** 志愿者库只保存资料引用，不能借这里改对象存储。 */
  allowStorage: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const multiDiscInputRef = useRef<HTMLInputElement>(null)
  const [multiDiscFiles, setMultiDiscFiles] = useState<File[]>([])
  const multiDiscUploadSession = useRef<{
    files: File[]
    slug: string
    lang: string
    setId: string
    completedKeys: Set<string>
  } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  /** 记住失败任务的原平台和语言槽，切换槽位时不能把旧 CHD 写进新槽。 */
  const [failedDiscTask, setFailedDiscTask] = useState<{
    id: string
    platform: 'psp' | 'psx'
    slug: string
    lang: string
  } | null>(null)
  const rememberFailedDiscTask = (id: string, taskPlatform: 'psp' | 'psx') => {
    setFailedDiscTask(id ? { id, platform: taskPlatform, slug, lang: lang || '' } : null)
  }
  const currentFailedDiscTask = failedDiscTask && failedDiscTask.platform === platform &&
    failedDiscTask.slug === slug && failedDiscTask.lang === (lang || '')
    ? failedDiscTask
    : null
  const failedDiscJobId = currentFailedDiscTask?.id || ''
  /** 从选择文件开始就锁住当前 key，防止确认 / 预检期间修改后仍启动旧目标任务。 */
  const [busySelecting, setBusySelecting] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const psxMigrationAbort = useRef<AbortController | null>(null)
  useEffect(() => () => {
    psxMigrationAbort.current?.abort()
    psxMigrationAbort.current = null
  }, [])
  /** 分片上传的进度明细（单发 PUT 时一直是 null） */
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, setPending] = useState<PendingBundle | null>(null)
  const [bundleAt, setBundleAt] = useState<BundleUploadProgress | null>(null)
  const [scanningBundle, setScanningBundle] = useState(false)
  /** 街机 ROM 的自动识别结果，上传后显示在下面 */
  const [romset, setRomset] = useState<RomsetIdentification | null>(null)
  /** FBNeo 索引没有覆盖的、按 MAME 源码 CRC 精确识别的街机 set */
  const [mameRomset, setMameRomset] = useState<NamcoMameMatch | null>(null)
  /** 按 MAME 源码目录认出的 Sega Model 2 等 set；rebuiltFrom 是重组前的原包名（merged 包） */
  const [mameCatalogSet, setMameCatalogSet] = useState<(MameCatalogMatch & { rebuiltFrom?: string }) | null>(null)
  /** 需要额外 CHD 的 MAME 识别结果留在上传位旁边，管理员不必滚到表单底部才知道下一步。 */
  const [mameMedia, setMameMedia] = useState<MameArcadeDiskProfile | null>(null)
  /** 同一个语言槽只恢复一次；父表单每次 setForm 都会重绘，不能因此启动第二条轮询。 */
  const resumedPspJob = useRef('')
  const resumedPsxJob = useRef('')
  type HealthOutcome = Awaited<ReturnType<typeof probeRom>> & { rangeSupported?: boolean }
  const [health, setHealth] = useState<{
    checking: boolean
    primary?: HealthOutcome
    backup?: HealthOutcome
  } | null>(null)
  const archiveRef = romArchiveRef(value)
  /** 识别出来的游戏需要 BIOS，但平台还没绑 —— 就是「Neo Geo BIOS 成员缺失」那个坑 */
  const cfg = getRomConfig()
  const canUpload = allowStorage && Boolean(cfg.api && cfg.token)
  const isFlash = platform === 'flash'
  const isHtml5 = platform === 'html5'
  const isStreamingDisc = isStreamingDiscPlatform(platform)
  const isPlayArcadeBundle = platform === 'arcade' && runtime === 'play'
  /** 新上传直接发布明文；旧 8BG 导入后会解包，仍可用于逐步迁移旧对象。 */
  const acceptsPackedRom = !isStreamingDisc && !isHtml5 && platform !== 'psx' && !isPlayArcadeBundle
  /** 新对象一律明文；旧 8BG 允许导入，但会先解包成原始文件再上传。 */
  const shouldPack = false
  const oneClickSockdrive = platform === 'dos' && Boolean(lang && autoSockdrive && !autoSockdrive.hasExtras)
  /** 街机的 ROM key 保留原文件名 —— FBNeo 靠压缩包名认 romset，见 roms.ts 的 FILENAME_IS_IDENTITY */
  const isArcade = keepsOriginalFileName(platform)
  // Flash 额外收 zip：平台的 romExtensions 保持只有 .swf —— 那个列表还管着
  // 「玩本地 ROM」和格式识别，混进 zip 会让玩家以为拖个 zip 进播放器也能玩
  const accept = [
    ...(isFlash ? ['.swf', '.zip'] : (platformMap[platform]?.romExtensions ?? ['.zip'])),
    ...(acceptsPackedRom || platform === 'psx' ? ['.8bg'] : []),
  ].join(',')
  const defKey = (fileName: string) => (lang ? defaultRomKeyForLang(platform, slug, lang, fileName) : defaultKeyFor(platform, slug, fileName))
  const exampleName = platform === 'gamecube' || platform === 'wii'
    ? 'game.rvz'
    : platform === 'psx'
      ? 'game.chd'
      : isStreamingDisc ? 'game.iso' : 'x.zip'

  useEffect(() => setHealth(null), [value, backupValue])

  /*
    ISO 上传完以后转换发生在服务器，管理员关闭 / 刷新页面不会中断。
    这里从 localStorage 找回任务只是为了恢复进度条和表单值；已有游戏即使不回来，
    服务端也会用 compare-and-swap 把最终 CHD 原子绑定到数据库。
  */
  useEffect(() => {
    // 查询任务只依赖后台管理员会话，不应被浏览器里的 R2 上传令牌挡住；这样关闭标签页后仍能恢复进度。
    if (platform !== 'psp' || !lang || !slug || !allowStorage) return
    const id = rememberedPspConversion(slug, lang)
    const pending = rememberedPendingDiscConversion('psp', slug, lang)
    const resumeKey = pending?.sourceKey || id
    if (!resumeKey || resumedPspJob.current === resumeKey) return
    const startingKey = value
    resumedPspJob.current = resumeKey
    let resumedJobId = id
    const controller = new AbortController()
    setProgress(45)
    setMsg({ ok: true, text: pending ? '正在恢复上次未完成的 PSP ISO → CHD 请求…' : '正在恢复上次未完成的 PSP ISO → CHD 任务…' })
    void (async () => {
      let jobId = id
      if (pending) {
        const created = await createPspConversion(pending)
        jobId = created.id
        resumedJobId = created.id
        rememberPspConversion(slug, lang, jobId)
      }
      if (!jobId) throw new Error('没有可恢复的 PSP 转换任务')
      return waitForPspConversion(jobId, (job) => {
        setProgress(45 + Math.round(job.progress * 0.55))
        setMsg({ ok: true, text: `${pspConversionLabel(job)} ${job.progress}%${job.message ? `；${job.message}` : ''}` })
      }, controller.signal)
    })().then((job) => {
      if (valueRef.current === startingKey) onChange(job.targetKey)
      rememberPspConversion(slug, lang, null)
      clearPendingDiscConversion('psp', slug, lang)
      setFailedDiscTask(null)
      resumedPspJob.current = ''
      setProgress(null)
      setMsg({
        ok: true,
        text: valueRef.current === startingKey
          ? `后台转换完成并恢复绑定：${job.targetKey}（${human(job.outputSize ?? 0)}）`
          : `后台转换已完成：${job.targetKey}（${human(job.outputSize ?? 0)}）；ROM 键在任务期间被修改，请核对表单与游戏绑定后再保存`,
      })
    }).catch(async (error) => {
      if (error instanceof Error && error.name === 'AbortError') return
      const rejected = pending && !resumedJobId
        ? await cleanupRejectedDiscSource('psp', slug, lang, pending, error)
        : { handled: false }
      const status = Number((error as { status?: unknown })?.status)
      if (resumedJobId && status !== 404) {
        rememberPspConversion(slug, lang, resumedJobId)
        rememberFailedDiscTask(resumedJobId, 'psp')
      } else if (status === 404) rememberPspConversion(slug, lang, null)
      else if (rememberedPendingDiscConversion('psp', slug, lang)) rememberFailedDiscTask(PENDING_DISC_CREATE_RETRY, 'psp')
      if (rejected.handled) setFailedDiscTask(null)
      resumedPspJob.current = ''
      setProgress(null)
      setMsg({
        ok: false,
        text: `${error instanceof Error ? error.message : '恢复 PSP 转换任务失败'}${rejected.warning ? `；${rejected.warning}` : ''}`,
      })
    })
    return () => {
      controller.abort()
      if (resumedPspJob.current === resumeKey) resumedPspJob.current = ''
    }
    // onChange 是父组件每次渲染新建的闭包，加入依赖会让同一个任务不断 abort/restart。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, lang, slug, allowStorage])

  useEffect(() => {
    if (platform !== 'psx' || !lang || !slug || !allowStorage) return
    const id = rememberedPsxConversion(slug, lang)
    const pending = rememberedPendingDiscConversion('psx', slug, lang)
    const resumeKey = pending?.sourceKey || id
    if (!resumeKey || resumedPsxJob.current === resumeKey) return
    const startingKey = value
    resumedPsxJob.current = resumeKey
    let resumedJobId = id
    const controller = new AbortController()
    setProgress(45)
    setMsg({ ok: true, text: pending ? '正在恢复上次未完成的 PS1 ISO → CD CHD 请求…' : '正在恢复上次未完成的 PS1 ISO → CD CHD 任务…' })
    void (async () => {
      let jobId = id
      if (pending) {
        const created = await createPsxConversion(pending)
        jobId = created.id
        resumedJobId = created.id
        rememberPsxConversion(slug, lang, jobId)
      }
      if (!jobId) throw new Error('没有可恢复的 PS1 转换任务')
      return waitForPsxConversion(jobId, (job) => {
        setProgress(45 + Math.round(job.progress * 0.55))
        setMsg({ ok: true, text: `${psxConversionLabel(job)} ${job.progress}%${job.message ? `；${job.message}` : ''}` })
      }, controller.signal)
    })().then((job) => {
      if (valueRef.current === startingKey) onChange(job.targetKey)
      rememberPsxConversion(slug, lang, null)
      clearPendingDiscConversion('psx', slug, lang)
      setFailedDiscTask(null)
      resumedPsxJob.current = ''
      setProgress(null)
      setMsg({
        ok: true,
        text: valueRef.current === startingKey
          ? `PS1 CD CHD 已完成并恢复绑定：${job.targetKey}（${human(job.outputSize ?? 0)}）`
          : `PS1 CD CHD 已完成：${job.targetKey}（${human(job.outputSize ?? 0)}）；ROM 键在任务期间被修改，请核对表单与游戏绑定后再保存`,
      })
    }).catch(async (error) => {
      if (error instanceof Error && error.name === 'AbortError') return
      const rejected = pending && !resumedJobId
        ? await cleanupRejectedDiscSource('psx', slug, lang, pending, error)
        : { handled: false }
      const status = Number((error as { status?: unknown })?.status)
      if (resumedJobId && status !== 404) {
        rememberPsxConversion(slug, lang, resumedJobId)
        rememberFailedDiscTask(resumedJobId, 'psx')
      } else if (status === 404) rememberPsxConversion(slug, lang, null)
      else if (rememberedPendingDiscConversion('psx', slug, lang)) rememberFailedDiscTask(PENDING_DISC_CREATE_RETRY, 'psx')
      if (rejected.handled) setFailedDiscTask(null)
      resumedPsxJob.current = ''
      setProgress(null)
      setMsg({
        ok: false,
        text: `${error instanceof Error ? error.message : '恢复 PS1 转换任务失败'}${rejected.warning ? `；${rejected.warning}` : ''}`,
      })
    })
    return () => {
      controller.abort()
      if (resumedPsxJob.current === resumeKey) resumedPsxJob.current = ''
    }
    // onChange 是父组件每次渲染新建的闭包，加入依赖会反复中止同一项任务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, lang, slug, allowStorage])

  /**
   * 检测必须从管理员浏览器发起：让服务端代请求任意后台 URL 会变成 SSRF 入口。
   * 两个源并行探，避免主站超时四秒后才开始等备用站；播放器实际启动时仍按主→备顺序选择。
   */
  const checkHealth = async () => {
    const primaryUrl = value.trim() ? (isHtml5 ? normalizeHtml5Entry(value) : romUrlForKey(value.trim())) : ''
    const backupUrl = backupValue.trim() ? (isHtml5 ? normalizeHtml5Entry(backupValue) : romUrlForKey(backupValue.trim())) : ''
    const urls = [primaryUrl, backupUrl].filter(Boolean)
    if (!urls.length) return
    clearRomProbeCache(urls)
    setHealth({ checking: true })
    const checkOne = async (url: string): Promise<HealthOutcome> => {
      const outcome = await probeRom(url, 6000, isHtml5)
      if (!isStreamingDisc || !outcome.url) return outcome
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 6000)
      try {
        // 普通“文件存在”对大光盘不够：模拟器会不断按扇区读，必须真的返回 206 + Content-Range。
        const range = await probeRange(url, controller.signal)
        return { ...outcome, rangeSupported: range.rangeSupported }
      } finally {
        window.clearTimeout(timer)
      }
    }
    const [primary, backup] = await Promise.all([
      primaryUrl ? checkOne(primaryUrl) : Promise.resolve(undefined),
      backupUrl ? checkOne(backupUrl) : Promise.resolve(undefined),
    ])
    setHealth({ checking: false, primary, backup })
  }

  const healthText = (outcome: HealthOutcome | undefined) => {
    if (!outcome) return ''
    if (outcome.url && outcome.rangeSupported === false) return '❌ 无法验证 HTTP Range（流式光盘必须返回 206）'
    if (outcome.url && outcome.rangeSupported) return '✅ 可用（HTTP Range 206）'
    if (outcome.url) return '✅ 可用'
    if (!outcome.certain) return outcome.reason === 'timeout' ? '⚠️ 检测超时' : '⚠️ 浏览器无法确认（网络或 CORS）'
    if (outcome.reason === 'html') return '❌ 返回的是网页，不是 ROM'
    return `❌ HTTP ${outcome.status ?? '错误'}`
  }
  /** 包目录：这一槽已经绑着某个包里的文件就原地更新，否则按约定新建 */
  const bundleDir = () => {
    const old = value.trim()
    return old && !/^https?:/i.test(old) && isBundleKey(old) ? dirOfKey(old) : bundleDirFor(platform, slug, lang)
  }

  /** 旧包 / 手工绑 key 的游戏可主动扫描同目录，并把确认范围限制在网页资源文件。 */
  const scanFlashAssets = async () => {
    const key = value.trim()
    if (!key || /^https?:/i.test(key) || !isBundleKey(key)) {
      setMsg({ ok: false, text: '请先绑定一个 R2 多文件包里的主 SWF' })
      return
    }
    const dir = dirOfKey(key)
    setScanningBundle(true)
    setMsg(null)
    try {
      const prefix = `${dir}/`
      const objects = await listRomObjects(dir)
      const skipped = /(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i
      const nonWeb = /\.(?:exe|dll|bat|cmd|com|msi|scr|lnk|url|rar|7z|zip|iso|dmg)$/i
      const paths = objects
        .filter((object) => object.key.startsWith(prefix) && object.key !== key)
        .map((object) => object.key.slice(prefix.length))
        .filter((path) => path && path.length <= 500 && !INVALID_FLASH_BUNDLE_PATH.test(path) &&
          !skipped.test(path) && !nonWeb.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..'))
      if (paths.length > 512) throw new Error(`目录中有 ${paths.length} 个候选资源；API 单包上限为 512 个，请先清理无关文件`)
      onAssetsChange(paths)
      onBundleEntryChange(key.slice(key.lastIndexOf('/') + 1))
      setMsg({ ok: true, text: paths.length ? `已登记 ${paths.length} 个同目录依赖文件；保存游戏后开放 API 才会返回这些资源` : '没有找到可登记的同目录依赖文件' })
    } catch (error) {
      setMsg({ ok: false, text: error instanceof Error ? error.message : '扫描多文件包失败' })
    } finally {
      setScanningBundle(false)
    }
  }

  /** 选中 zip：解出目录结构，交给下面的面板等管理员确认 */
  const openBundle = async (file: File) => {
    setMsg({ ok: true, text: `正在读取 ${file.name}…` })
    try {
      const zip = await file.arrayBuffer()
      const plan = planSwfBundleFromZip(zip, slug)
      if (!plan.files.length) throw new Error('压缩包里没有可上传的文件')
      setPending({ zip, name: file.name, dir: bundleDir(), plan })
      setMsg(null)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '读取压缩包失败' })
    }
  }

  /** 重组 merged 包时记下原包名，识别面板据此说明「从哪个包里抽出来的」 */
  const pendingRebuiltFrom = useRef<string | undefined>(undefined)

  /** MAME 源码目录识别：不像 Sega 的包不加载数据表；数据表加载失败不挡普通上传 */
  const identifyCatalogSet = async (entries: readonly ZipFileEntry[], fileName: string): Promise<MameCatalogMatch | null> => {
    if (!mayContainMameCatalogSet(entries)) return null
    try {
      return identifyMameCatalogSets(await loadMameSetCatalog(), entries, fileName).chosen
    } catch (err) {
      console.warn('[mame-catalog] 数据表加载失败，按普通街机包继续：', err)
      return null
    }
  }

  /**
   * merged 包里凑得齐好几个 set（doa.zip 里有 doa / doab / doaa / doaab / doaae）时让管理员挑一个。
   * 不能替他猜：Model 2A 和 2B 是两块不同的板子，地区、版本也不同，猜错了上架的就是另一个游戏。
   * 返回 null = 取消上传。
   */
  const chooseCatalogSet = (candidates: readonly MameCatalogMatch[], fileName: string): MameCatalogMatch | null => {
    const parentIndex = candidates.findIndex((candidate) => !candidate.parent)
    const lines = candidates.map((candidate, index) => (
      `${index + 1}. ${candidate.romset} — ${candidate.title}（${candidate.board}${candidate.parent ? '' : '，父集'}）`
    ))
    const answer = window.prompt(
      `${fileName} 是 MAME merged 包，里面凑得齐 ${candidates.length} 个版本：\n\n${lines.join('\n')}\n\n` +
      '输入要上架的编号。系统会只抽出这个版本的 ROM（含包里自带的设备 ROM），以 MAME 原名重组成单集 ZIP 再上传，不重新压缩。',
      String((parentIndex >= 0 ? parentIndex : 0) + 1),
    )
    if (answer == null) return null
    const picked = candidates[Number.parseInt(answer.trim(), 10) - 1]
    if (!picked) window.alert(`没有编号 ${answer.trim()}；已取消上传。`)
    return picked ?? null
  }

  /**
   * 街机包的自动识别：先检查已核实的 MAME 专用指纹，再比对 FBNeo 驱动表认出 romset。
   *
   * 只在**完全命中**（该 romset 的成员一个不缺、且没有第二个同样满分的候选）时
   * 才改名 —— 差一个 ROM 就套上父集的名字，换来的是「missing files」，比不改还糟。
   * 顺带查一下这游戏要不要 BIOS、平台绑没绑，缺了当场红字提醒。
   *
   * 驱动识别是尽力而为：索引拉不到、包认不出来，都安安静静走原流程。
   * 但 ZIP 完整性和目录结构不是“识别失败”：截断包或成员套子目录交给
   * FBNeo / MAME 一定报缺文件，必须在上传前阻止。
   *
   * 只读 Blob 尾部的中央目录和每个本地头，避免 200MB 大包再申请一块同大的
   * ArrayBuffer；这个峰值在手机后台页会直接把标签页杀掉。
   */
  const sniffArcade = async (file: File, knownEntries?: readonly ZipFileEntry[]): Promise<string | null> => {
    setRomset(null)
    setMameRomset(null)
    setMameCatalogSet(null)
    setMameMedia(null)
    // 同一张表单可能重新上传另一款街机；不清掉上一次的识别结果会把旧 CHD 误绑定到新 ROM。
    onMameMediaFound?.(null)
    if (!isArcade) return null
    onArcadeIdentityReset?.()
    if (!/\.zip$/i.test(file.name)) throw new Error('街机 ROM 必须是 .zip：FBNeo / MAME 靠 ZIP 文件名和根目录成员识别 romset')

    // 目录拍平器刚刚验证过的普通 ZIP 可以把条目复用；拍平后文件名已变则必须重验新包。
    const entries = knownEntries ?? await assertValidZipBlob(file, '街机 ROM')
    const unsafePathProblem = arcadeArchiveUnsafePathProblem(entries)
    if (unsafePathProblem) throw new Error(unsafePathProblem)
    const mameMatch = identifyNamcoMameSet(entries, file.name)
    const mameMedia = identifyKnownMameArcadeMedia(entries, file.name)
    const layoutProblem = arcadeArchiveLayoutProblem(entries)
    // 根目录完整包含某个 Namco System 11/12 set；额外克隆 ROM 在其它子目录中，MAME 不会读它们。
    // 仅对 CRC 完全匹配的已知集合放行，不把通用的子目录包风险降级成警告。
    if (layoutProblem && !mameMatch) throw new Error(layoutProblem)
    if (mameMatch) {
      setMameRomset(mameMatch)
      // System 12 没有 BIOS 集：传空串让父表单撤掉上一次自动填的值（手填的不动）
      onBiosFound?.(mameMatch.bios ?? '')
      if (mameMatch.buttons) onButtonsFound?.(mameMatch.buttons)
      const recommendation = detectArcadeCore({ exactMameBoard: true })
      if (recommendation) onCoreFound?.(recommendation.core)
      return `${mameMatch.romset}.zip`
    }
    /*
      Sega Model 2 等 FBNeo 没有的板子：按 MAME 源码目录的 CRC 认。上传流程在这之前已经把
      merged 包重组成 `<romset>.zip` 单集，所以这里按文件名就能落定唯一候选。
    */
    const catalogSet = await identifyCatalogSet(entries, file.name)
    if (catalogSet) {
      setMameCatalogSet((prior) => ({ ...catalogSet, rebuiltFrom: prior?.rebuiltFrom ?? pendingRebuiltFrom.current }))
      pendingRebuiltFrom.current = undefined
      // 设备 ROM 已打进 ZIP 时传空串：撤掉上一款游戏自动填的 BIOS（手填的不动）
      onBiosFound?.(mameCatalogBiosName(catalogSet))
      if (catalogSet.buttons) onButtonsFound?.(catalogSet.buttons)
      const recommendation = detectArcadeCore({ exactMameBoard: true })
      if (recommendation) onCoreFound?.(recommendation.core)
      return `${catalogSet.romset}.zip`
    }
    let found: RomsetIdentification | null = null
    try {
      found = await identifyArcadeRomset(entries, file.name)
    } catch (err) {
      console.warn('[romset] 识别失败，继续检查 MAME 媒体：', err)
    }

    // CPS-3 等游戏会同时存在 FBNeo 与 MAME 描述；MAME 清单可能只列一颗区域 BIOS，
    // 和 FBNeo 的完整 SIMM 包共享 CRC。完整 FBNeo 指纹优先，否则会把可直接玩的 ZIP
    // 错改名为 MAME set，并让管理员误以为还必须补一张 CHD。
    const fbneoHasExactSet = Boolean(found?.hack || found?.candidates.some((candidate) => candidate.coverage === 1))
    if (mameMedia && !fbneoHasExactSet) {
      setMameMedia(mameMedia)
      onMameMediaFound?.(mameMedia)
      const recommendation = detectArcadeCore({ mameChdSet: true })
      if (recommendation) onCoreFound?.(recommendation.core)
      return `${mameMedia.romset}.zip`
    }

    if (!found) return null
    setRomset(found)

    try {
      /*
        已知改版包优先。它的包名由指纹表说了算（FBNeo 靠包名认游戏，RomData 的
        ZipName 也必须和它一致），不能再走下面那套「覆盖率满分才改名」的判断 ——
        改版包永远不可能在任何 romset 上满分，那是它的定义。
      */
      if (found.hack) {
        onHackFound?.(found.hack)
        // 已知单 ROM 改版只在玩家选择到这份 ROM 后切核；不要把 FBNeo 写进整款游戏的 core 字段。
        if (found.hack.romDataScope !== 'rom') {
          const recommendation = detectArcadeCore({ supportedFbneoRomData: Boolean(found.hack.romData) })
          if (recommendation) onCoreFound?.(recommendation.core)
        }
        return `${found.hack.zipName}.zip`
      }

      // 覆盖率满分足以证明核心家族兼容；即使多个 FBNeo 克隆集无法区分，也只选核心、不猜包名。
      const fbneoHasExactSet = found.candidates.some((candidate) => candidate.coverage === 1)
      const recommendation = detectArcadeCore({ indexedFbneoSet: fbneoHasExactSet })
      if (recommendation) onCoreFound?.(recommendation.core)

      const hit = found.confident
      if (!hit) return null

      // 认准了、且这个 set 不需要 BIOS：也要报一次空值，撤掉上一款游戏自动填的 BIOS
      if (!hit.bios) onBiosFound?.('')
      if (hit.bios) {
        /*
          认出来了就替管理员填上（只填空的：他手填过就听他的 —— 汉化版借用别的驱动、
          或者核心那批 romset 的 set 名和驱动表里不一致时，人比表准）。

          「这个系统的 BIOS 绑了没有」由表单上那条即时校验去说（它同时覆盖手输的情况），
          这里不再报第二遍。
        */
        onBiosFound?.(hit.bios)
      }
      return `${hit.name}.zip`
    } catch (err) {
      console.warn('[romset] 识别失败，按原文件名走：', err)
      return null
    }
  }

  /** 在开始大文件上传前做完检查，避免传完后才发现运行配置或后台转换能力不满足。 */
  const prepareLanguageSockdrive = async (file: File) => {
    if (!autoSockdrive || !lang) return null
    if (autoSockdrive.hasExtras) throw new Error('还有 DOS 附加文件；请先把补丁合入原始 ZIP')
    if (!/\.zip$/i.test(file.name)) throw new Error('流式盘只能从原始 .zip 游戏包生成')
    const executable = autoSockdrive.executable.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    // eslint-disable-next-line no-control-regex
    if (!/^[^:<>"|?*\x00-\x1f]+\.exe$/i.test(executable) || executable.length > 255 || executable.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('请先填写当前语言游戏盘内安全的 .EXE 相对路径（或上方默认 EXE）')
    }
    if (!autoSockdrive.windowsGuest && !isDos83StreamPath(executable)) {
      throw new Error('纯 DOS 流式盘的启动程序必须使用 DOS 8.3 路径，例如 FALLOUT.EXE 或 GAME/RUN.EXE')
    }
    const capability = await sockdriveConversionCapability()
    if (!capability.available) throw new Error(capability.reason || '服务器暂时不能制作 Sockdrive')
    if (file.size > capability.maxSourceBytes) throw new Error(`ZIP 超过后台上限 ${human(capability.maxSourceBytes)}`)

    // 后台服务和浏览器可能指向不同 Worker；只有两边都声明支持时才走 R2 桶内复制。
    const romApi = await pingRomApi().catch(() => ({ isWorker: false, writable: false, sockdriveSourceCopy: false }))
    return {
      executable,
      sourceCopyAvailable: Boolean(capability.sourceCopyAvailable && romApi.isWorker && romApi.sockdriveSourceCopy),
    }
  }

  /** 完整回退包上传后生成私有转换源，转换完成由服务端原子绑定完整包、EXE 与流式盘。 */
  const publishLanguageSockdrive = async (
    file: File,
    targetRomKey: string,
    expectedRomKey: string,
    sourceEtag: string | undefined,
    preparation: { executable: string; sourceCopyAvailable: boolean },
  ) => {
    if (!autoSockdrive || !lang) return ''
    const executable = preparation.executable
    const useR2Copy = preparation.sourceCopyAvailable && Boolean(sourceEtag)

    const expectedSockdrive = autoSockdrive.value.trim().replace(/\/+$/, '')
    const signature = JSON.stringify({ targetRomKey, expectedRomKey, sourceEtag: sourceEtag ?? '', executable, expectedSockdrive })
    const identity = await sockdriveUploadIdentity(file, autoSockdrive.gameSlug, lang, signature)
    const version = identity.version
    const stagingKey = identity.key
    let sourceUploaded = false
    let taskCreated = false
    try {
      setStage(null)
      if (useR2Copy) {
        setProgress(48)
        setMsg({ ok: true, text: `完整回退包已上传；正在由 R2 复制到私有转换区，不会再次上传 ZIP…` })
        await copyRomToSockdriveStaging(targetRomKey, stagingKey, file.size, sourceEtag ?? '')
      } else {
        // 旧 Worker 仍可用原来的私有分片上传，升级 Worker 后自动切到桶内复制。
        setMsg({ ok: true, text: `完整回退包已上传；当前 Worker 不支持桶内复制，正在上传私有转换源…` })
        await uploadRom(file, stagingKey, (pct, at) => {
          setProgress(45 + Math.round(pct * 0.2))
          if (at) setStage(at)
        }, { failureIsFatal: false })
      }
      sourceUploaded = true
      setStage(null)
      const jobProgressStart = useR2Copy ? 50 : 65
      setProgress(jobProgressStart)
      const request = {
        sourceKey: stagingKey,
        sourceSize: file.size,
        gameSlug: autoSockdrive.gameSlug,
        lang,
        targetRomKey,
        expectedRomKey,
        executable,
        version,
        expectedSockdrive,
        encoding: 'br',
      } as const
      rememberPendingSockdriveCreation(autoSockdrive.gameSlug, request, lang)
      const job = await createSockdriveConversion(request, { failureIsFatal: false })
      taskCreated = true
      rememberSockdriveConversion(autoSockdrive.gameSlug, job.id, lang)
      clearSockdriveUploadIdentity(autoSockdrive.gameSlug, lang, stagingKey)
      const completed = await waitForSockdriveConversion(job.id, (next) => {
        setProgress(jobProgressStart + Math.round(next.progress * (100 - jobProgressStart) / 100))
        setMsg({ ok: true, text: `${sockdriveConversionLabel(next)} ${next.progress}%${next.message ? `；${next.message}` : ''}` })
      }, undefined, undefined, { failureIsFatal: false })
      rememberSockdriveConversion(autoSockdrive.gameSlug, null, lang)
      clearPendingSockdriveCreation(autoSockdrive.gameSlug, lang)
      autoSockdrive.onCompleted(completed)
      return `；${romLanguageLabel(lang)}流式盘已发布并${completed.bound ? '自动绑定' : '等待保存'}：${completed.targetPrefix}`
    } catch (error) {
      const keepUploadedSource = sourceUploaded && !taskCreated && preserveSockdriveSourceAfterCreateError(error)
      if (sourceUploaded && !taskCreated && !keepUploadedSource) {
        clearPendingSockdriveCreation(autoSockdrive.gameSlug, lang)
        await deleteRomObjects([stagingKey]).catch(() => {})
        clearSockdriveUploadIdentity(autoSockdrive.gameSlug, lang, stagingKey)
      }
      if (keepUploadedSource) {
        throw new Error(`完整回退包已发布，流式源 ZIP 也已保留，无需重传；创建任务失败：${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
  }

  /**
   * 先预览并允许管理员重排盘序，避免文件选择器的返回顺序悄悄决定游戏换盘顺序；
   * 多盘组再上传不可变盘片对象，最后才发布 M3U 指针并改绑语言槽。
   * 中途失败最多留下未引用的 CHD，不会让线上玩家读到半套或新旧混合的盘组。
   */
  const onMultiDiscFiles = (files: File[] | undefined) => {
    if (!files?.length) return
    if (!lang) {
      setMsg({ ok: false, text: '请先选择 ROM 语言槽，再上传 PS1 多盘组' })
      if (multiDiscInputRef.current) multiDiscInputRef.current.value = ''
      return
    }
    if (files.length < 2 || files.length > PSX_M3U_MAX_DISCS) {
      setMsg({ ok: false, text: `请选择 2–${PSX_M3U_MAX_DISCS} 张 CHD，并按游戏要求的盘片顺序选择` })
      if (multiDiscInputRef.current) multiDiscInputRef.current.value = ''
      return
    }
    const invalid = files.find((file) => !/\.chd$/i.test(file.name) || file.size < PSX_RANGE_BYTES || file.size > 1024 * 1024 * 1024)
    if (invalid) {
      setMsg({ ok: false, text: `${invalid.name} 不是 2MB–1GB 范围内的裸 CHD；多盘流式组只接受 CHD v5` })
      if (multiDiscInputRef.current) multiDiscInputRef.current.value = ''
      return
    }
    // 新选择意味着新的发布意图；不能把上一组未发布的盘片目录复用到另一组文件。
    multiDiscUploadSession.current = null
    setMultiDiscFiles(files)
    setMsg({ ok: true, text: `已载入 ${files.length} 张盘片；请检查顺序，确认后才会上传并绑定。` })
    if (multiDiscInputRef.current) multiDiscInputRef.current.value = ''
  }

  const moveMultiDiscFile = (index: number, offset: -1 | 1) => {
    setMultiDiscFiles((current) => {
      const nextIndex = index + offset
      if (nextIndex < 0 || nextIndex >= current.length) return current
      const next = [...current]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
  }

  const uploadMultiDiscFiles = async () => {
    const files = multiDiscFiles
    if (!files.length) return
    if (!lang) {
      setMsg({ ok: false, text: '请先选择 ROM 语言槽，再上传 PS1 多盘组' })
      return
    }
    setProgress(0)
    setStage(null)
    setMsg({ ok: true, text: '正在检查盘片顺序、CHD v5 格式与容量…' })
    try {
      await trackUploadActivity('PS1 多盘组校验与发布', async () => {
        const entries: { filename: string; label: string }[] = []
        const uploadFiles: File[] = []
        for (const [index, source] of files.entries()) {
          if (!/\.chd$/i.test(source.name)) throw new Error(`${source.name} 不是 CHD；多盘流式组只接受裸 CHD 文件`)
          if (source.size < PSX_RANGE_BYTES || source.size > 1024 * 1024 * 1024) {
            throw new Error(`${source.name} 大小不在 2MB–1GB 的 PS1 Range 支持范围内`)
          }
          if (!chdCompressors(new Uint8Array(await source.slice(0, 32).arrayBuffer()))) {
            throw new Error(`${source.name} 不是受支持的 CHD v5；请先用 chdman 转换`)
          }
          const stem = source.name.replace(/\.chd$/i, '').replace(/[\\/:?#|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)
          const filename = `Disc ${index + 1}${stem ? ` - ${stem}` : ''}.chd`
          entries.push({ filename, label: `Disc ${index + 1}` })
          uploadFiles.push(new File([source], filename, { type: 'application/octet-stream', lastModified: source.lastModified }))
        }
        const playlist = buildPsxM3u(entries)
        const parent = dirOfKey(defKey('discs.m3u'))
        if (!parent) throw new Error('无法生成 PS1 多盘对象目录；请先配置 ROM 前缀')
        const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'game'
        const priorSession = multiDiscUploadSession.current
        const sameSelection = priorSession && priorSession.slug === safeSlug && priorSession.lang === lang &&
          priorSession.files.length === files.length && priorSession.files.every((file, index) => file === files[index])
        if (!sameSelection) {
          const random = new Uint8Array(8)
          crypto.getRandomValues(random)
          const setId = [...random].map(byte => byte.toString(16).padStart(2, '0')).join('')
          multiDiscUploadSession.current = { files: [...files], slug: safeSlug, lang, setId, completedKeys: new Set() }
        }
        const session = multiDiscUploadSession.current!
        const setId = session.setId
        const setDir = `${parent}/${safeSlug}.${lang}.set-${setId}`
        const totalBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0)
        const percentByDisc = new Array<number>(uploadFiles.length).fill(0)
        const completedDiscs = new Set<number>()
        const failures: { index: number; message: string }[] = []
        let nextIndex = 0
        const discUploadAbort = new AbortController()
        const reportProgress = () => {
          const sentBytes = uploadFiles.reduce((sum, file, index) => sum + file.size * percentByDisc[index] / 100, 0)
          setProgress(Math.min(94, Math.round((sentBytes / Math.max(1, totalBytes)) * 94)))
        }
        setMsg({ ok: true, text: `正在并行上传 ${uploadFiles.length} 张盘（最多两张同时传）；全部完成后才会发布多盘清单…` })
        const uploadWorker = async () => {
          while (!failures.length) {
            const index = nextIndex++
            if (index >= uploadFiles.length) return
            const file = uploadFiles[index]
            const key = `${setDir}/${entries[index].filename}`
            try {
              if (session.completedKeys.has(key)) {
                // 同页重试会复用随机目录；先确认已完成对象仍在且大小吻合，避免重传大盘片。
                const existing = await headRom(key).catch(() => null)
                if (existing?.exists && existing.size === file.size) {
                  percentByDisc[index] = 100
                  completedDiscs.add(index)
                  reportProgress()
                  setMsg({ ok: true, text: `已复用 ${completedDiscs.size}/${uploadFiles.length} 张已完成盘片；继续上传剩余盘片…` })
                  continue
                }
                session.completedKeys.delete(key)
              }
              await uploadRom(file, key, (pct, at) => {
                percentByDisc[index] = pct
                reportProgress()
                if (at) setStage(at)
              }, undefined, discUploadAbort.signal)
              percentByDisc[index] = 100
              completedDiscs.add(index)
              session.completedKeys.add(key)
              reportProgress()
              setMsg({ ok: true, text: `已完成 ${completedDiscs.size}/${uploadFiles.length} 张盘；全部完成后发布多盘清单…` })
            } catch (error) {
              // 一张盘失败后立刻停掉同组另一张盘；有强摘要账本的大盘片保留给下次重试续传。
              if (!discUploadAbort.signal.aborted) {
                failures.push({ index, message: error instanceof Error ? error.message : '上传失败' })
                discUploadAbort.abort()
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, uploadFiles.length) }, () => uploadWorker()))
        if (failures.length) {
          failures.sort((a, b) => a.index - b.index)
          const failed = failures[0]
          throw new Error(`第 ${failed.index + 1} 张盘 ${uploadFiles[failed.index].name} 上传失败：${failed.message}`)
        }
        setStage(null)
        const playlistKey = `${setDir}/discs.m3u`
        setProgress(95)
        setMsg({ ok: true, text: '盘片已上传，正在发布多盘清单并绑定当前语言…' })
        const playlistFile = new File([playlist], 'discs.m3u', { type: 'audio/x-mpegurl' })
        await uploadRom(playlistFile, playlistKey, (pct, at) => {
          setProgress(95 + Math.floor(pct / 20))
          if (at) setStage(at)
        })
        onChange(playlistKey)
        multiDiscUploadSession.current = null
        setMultiDiscFiles([])
        setMsg({ ok: true, text: `已发布 ${uploadFiles.length} 张 PS1 光盘（${human(totalBytes)}）和 M3U 清单；当前语言已改绑，请保存游戏条目` })
      })
    } catch (error) {
      setMsg({ ok: false, text: `${error instanceof Error ? error.message : 'PS1 多盘组上传失败'}；未发布清单，现有绑定不变` })
    } finally {
      setProgress(null)
      setStage(null)
    }
  }

  const onFile = async (file: File | undefined, discImageConfirmed = false) => {
    if (!file) return
    const originalKeyValue = value
    let activeDiscJobId = ''
    let activeDiscPlatform: 'psp' | 'psx' | null = null
    if (isHtml5) {
      setMsg({ ok: false, text: 'HTML5 游戏通过网页入口运行，请部署完整游戏站点后填写 HTTPS 网址' })
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (isFlash && /\.zip$/i.test(file.name)) {
      await openBundle(file)
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (isFlash && /\.swf$/i.test(file.name)) {
      setMsg({ ok: true, text: `正在检查 ${file.name} 的网页兼容性…` })
      try {
        const data = await file.arrayBuffer()
        assertSwf(data)
        const issue = await flashCompatibilityIssue(data)
        if (issue) {
          setMsg({ ok: false, text: `${issue.message}；这份文件没有上传` })
          if (inputRef.current) inputRef.current.value = ''
          return
        }
      } catch (error) {
        setMsg({ ok: false, text: error instanceof Error ? `SWF 无效或无法检查：${error.message}；这份文件没有上传` : 'SWF 无效或无法检查；这份文件没有上传' })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    if (platform === 'dos' && dosEntry?.trim() && /\.zip$/i.test(file.name)) {
      try {
        const wanted = dosEntry.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
        // 这里只核对一个文件名，不该为 503MB 的《辐射》先申请同样大的连续内存。
        // Blob 版只读 ZIP 尾部、中央目录和本地头，损坏/截断仍会在上传前被拦下。
        const members = await assertValidZipBlob(file, 'DOS ROM')
        if (!members.some((entry) => entry.name.toLowerCase() === wanted)) {
          setMsg({ ok: false, text: `ZIP 内找不到 ${dosEntry.trim()}；请先改正启动文件路径再上传` })
          if (inputRef.current) inputRef.current.value = ''
          return
        }
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : '无法读取 DOS ZIP 目录' })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    // 数据轨签名和 PS1 启动文件只需读取约 1MB；先查可避免上传整张盘后才被后台拒绝。
    if (platform === 'psx' && /\.iso$/i.test(file.name)) {
      const problem = await psxIsoValidationProblem(file).catch(() => '读取 ISO 目录失败')
      if (problem) {
        setMsg({ ok: false, text: problem })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    if (platform === 'psp' && /\.iso$/i.test(file.name)) {
      const problem = await pspIsoValidationProblem(file).catch(() => '读取 PSP ISO 目录失败')
      if (problem) {
        setMsg({ ok: false, text: problem })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    // 光盘平台：格式和体积先问一句。转 .chd 这件事只有在**上传之前**说才有用
    if (!discImageConfirmed && !(await confirmDiscImage(platform, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (isPlayArcadeBundle) {
      setMsg({ ok: true, text: '正在校验 Play! System 2x6 包（目录、游戏定义、dongle 与镜像）…' })
      try {
        await inspectPlayArcadeBundle(file)
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : 'Play! 街机包校验失败；文件未上传' })
        setProgress(null)
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    // 旧版 CLI 生成的 8BG 仍允许导入，但对象存储不再保留密文。
    // 四字节魔数不够：普通 ROM 可能碰巧以 8BG1 开头；完整解包会逐块校验，再以头里的原名上传明文。
    const hasPackMagic = (acceptsPackedRom || platform === 'psx') && isRomPackBytes(await file.slice(0, 4).arrayBuffer())
    let alreadyPacked = false
    let importedPacked = false
    let packedOriginalName = ''
    let unpackedPackedBlob: Blob | null = null
    let uploadSourceFile = file
    if (hasPackMagic) {
      setMsg({ ok: true, text: `正在校验已有 8BG 容器 ${file.name}…` })
      try {
        const onPackProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          setProgress(Math.min(49, Math.round((loaded / Math.max(1, total)) * 50)))
        }
        let header: Awaited<ReturnType<typeof unpackRomPackBlob>>['header']
        if (platform === 'flash') {
          // 已加密的 8BG 也要验内层 SWF；只验证容器认证码会放过容器里原本就截断的影片。
          const unpacked = await unpackRomPackBlob(file, onPackProgress)
          await assertSwfBlob(unpacked.blob)
          unpackedPackedBlob = unpacked.blob
          header = unpacked.header
        } else {
          // 解包器逐块校验容器；复用这份明文，避免为大包再读一遍密文。
          const unpacked = await unpackRomPackBlob(file, onPackProgress)
          unpackedPackedBlob = unpacked.blob
          header = unpacked.header
        }
        alreadyPacked = true
        packedOriginalName = header.originalName
        const allowed = platformMap[platform]?.romExtensions ?? ['.zip']
        if (!allowed.some((ext) => packedOriginalName.toLowerCase().endsWith(ext.toLowerCase()))) {
          throw new Error(`容器内是 ${packedOriginalName}，不属于 ${platform} 支持的格式（${allowed.join('、')}）`)
        }
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? `8BG 容器不可用：${err.message}` : '8BG 容器不可用' })
        setProgress(null)
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    if (alreadyPacked) {
      const plainBlob = unpackedPackedBlob
      if (!plainBlob) {
        setMsg({ ok: false, text: '旧 8BG 容器没有解出明文；为避免继续发布密文，已取消上传' })
        setProgress(null)
        if (inputRef.current) inputRef.current.value = ''
        return
      }
      uploadSourceFile = new File([plainBlob], packedOriginalName, {
        type: file.type && file.type !== 'application/octet-stream' ? file.type : guessUploadType(packedOriginalName),
        lastModified: file.lastModified,
      })
      alreadyPacked = false
      importedPacked = true
    }
    // 上面的 0–49% 只是本地校验；真正上传还没开始，确认弹窗期间不能留一条假进度。
    setProgress(null)
    if (importedPacked) {
      // 8BG 的文件扩展名属于容器；盘片检查要针对解出的真实文件。
      if (platform === 'psx' && /\.iso$/i.test(uploadSourceFile.name)) {
        const problem = await psxIsoValidationProblem(uploadSourceFile).catch(() => '读取 ISO 目录失败')
        if (problem) {
          setMsg({ ok: false, text: problem })
          if (inputRef.current) inputRef.current.value = ''
          return
        }
      }
      if (platform === 'psp' && /\.iso$/i.test(uploadSourceFile.name)) {
        const problem = await pspIsoValidationProblem(uploadSourceFile).catch(() => '读取 PSP ISO 目录失败')
        if (problem) {
          setMsg({ ok: false, text: problem })
          if (inputRef.current) inputRef.current.value = ''
          return
        }
      }
      if (!discImageConfirmed && !(await confirmDiscImage(platform, uploadSourceFile))) {
        if (inputRef.current) inputRef.current.value = ''
        return
      }
      setMsg({ ok: true, text: `已从旧 8BG 容器解出 ${uploadSourceFile.name}；接下来上传明文对象` })
    }
    // 街机：遇到子目录成员时在本地安全拍平；原始 ZIP 无需重新压缩。
    let flattenedArcadeFiles = 0
    let arcadeEntries: ZipFileEntry[] | undefined
    /** arcadeEntries 对应的是哪一份文件（拍平 / 重组后换了文件，旧目录偏移就作废） */
    let arcadeEntriesOf: File | null = null
    let rebuiltMameSet = ''
    pendingRebuiltFrom.current = undefined
    if (isArcade && !isPlayArcadeBundle) {
      const validatedArcadeBlob = uploadSourceFile
      setMsg({ ok: true, text: '正在读取街机 ZIP 目录与 CRC；不会解压整包…' })
      try {
        arcadeEntries = await assertValidZipBlob(uploadSourceFile, '街机 ROM', { cacheLocalHeaders: true })
        arcadeEntriesOf = uploadSourceFile
        /*
          MAME 专属板子（Sega Model 2 …）的 merged / 命名不规范的包：先按 CRC 认出完整的 set，
          抽出目标版本重组成 `<romset>.zip` 单集。必须排在拍平之前 —— merged 包里克隆集的
          同名异 CRC 文件放在子目录，拍平会因为重名拒绝整包。
        */
        let catalog: Awaited<ReturnType<typeof loadMameSetCatalog>> | null = null
        if (mayContainMameCatalogSet(arcadeEntries)) {
          catalog = await loadMameSetCatalog().catch((err) => {
            console.warn('[mame-catalog] 数据表加载失败，按普通街机包继续：', err)
            return null
          })
        }
        const identification = catalog ? identifyMameCatalogSets(catalog, arcadeEntries, uploadSourceFile.name) : null
        let pick = identification?.chosen ?? null
        if (identification && !pick && identification.candidates.length > 1) {
          pick = chooseCatalogSet(identification.candidates, uploadSourceFile.name)
          if (!pick) {
            setMsg(null)
            if (inputRef.current) inputRef.current.value = ''
            return
          }
        }
        if (pick) {
          const targetName = `${pick.romset}.zip`
          if (!pick.exact || uploadSourceFile.name !== targetName) {
            const rebuilt = await buildMameCatalogSetZip(uploadSourceFile, pick)
            if (!pick.exact) {
              pendingRebuiltFrom.current = uploadSourceFile.name
              rebuiltMameSet = `；已从 ${uploadSourceFile.name} 抽出 ${pick.romset}（${pick.items.length} 个 ROM，丢弃 ${pick.droppedEntries} 个其它版本 / 无关成员）并重组为单集`
            }
            uploadSourceFile = new File([rebuilt], targetName, { type: 'application/zip', lastModified: uploadSourceFile.lastModified })
            arcadeEntries = rebuilt === arcadeEntriesOf ? arcadeEntries : await assertValidZipBlob(uploadSourceFile, '重组后的街机 ROM')
            arcadeEntriesOf = uploadSourceFile
          }
          setMsg({ ok: true, text: `已识别 ${pick.board} · ${pick.romset}（${pick.title}）；正在核对…` })
        } else {
          const flattened = await flattenArcadeZipBlob(uploadSourceFile, arcadeEntries)
          if (flattened.flattenedCount) {
            flattenedArcadeFiles = flattened.flattenedCount
            uploadSourceFile = new File([flattened.blob], uploadSourceFile.name, {
              type: uploadSourceFile.type || 'application/zip',
              lastModified: uploadSourceFile.lastModified,
            })
            setMsg({ ok: true, text: `已检测到 ${flattenedArcadeFiles} 个街机 ROM 成员在子目录中，已自动拍平；正在识别 romset…` })
          }
        }
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : '无法安全拍平 / 重组街机 ZIP；文件未上传' })
        if (inputRef.current) inputRef.current.value = ''
        return
      } finally {
        clearValidatedZipBlobLocalHeaders(validatedArcadeBlob)
      }
    }
    let sniffed: string | null
    try {
      sniffed = isPlayArcadeBundle
        ? uploadSourceFile.name
        : await sniffArcade(uploadSourceFile, uploadSourceFile === arcadeEntriesOf ? arcadeEntries : undefined)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '街机 ROM 校验失败' })
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    const needsPacking = shouldPack && !alreadyPacked
    const oldKey = value.trim()
    // 字段里已有 key（且不是完整 URL）就复用它 —— 同一个槽位始终对着同一个对象，
    // 这样重传就是原地覆盖，不会又生出一份。但包目录里的 key 不能复用：
    // 那是「某个包里的一个文件」，单传一个 swf 顶上去会和包里的其它文件对不上。
    // 街机认出了 romset 就一律用它 —— 哪怕字段里已经有 key。
    // 那个旧 key 十有八九正是「文件名不对所以跑不起来」的元凶，复用它等于把错留住。
    // 共用 ZIP 时，本槽重传必须另存为自己的语言 key；复用旧 key 会把其他语言一起覆盖。
    // 光盘核心靠扩展名选容器。旧槽是 .cso/.chd、这次选的是 .iso 时绝不能“原地复用”旧名字，
    // 否则能力降级路径会把 ISO 字节写进 .chd/.cso，播放器只会得到一份看似存在的坏文件。
    const sameStoredFormat = canReuseRomObjectKey(oldKey, uploadSourceFile.name, shouldPack)
    const reusable = oldKey && sameStoredFormat && allBoundKeys.filter((bound) => bound === oldKey).length <= 1 && !/^https?:/i.test(oldKey) && !oldKey.startsWith('/') && !isBundleKey(oldKey)
    const plainKey = sniffed ? defKey(sniffed) : reusable ? oldKey : defKey(uploadSourceFile.name)
    const key = shouldPack ? romPackKey(plainKey) : plainKey
    let pspIsoToChd = false
    let psxIsoToChd = false
    let finalKey = key
    if (platform === 'psx' && /\.iso$/i.test(uploadSourceFile.name)) {
      let unavailable = lang ? '' : '未选择 ROM 语言槽'
      try {
        if (lang) {
          const capability = await psxConversionCapability()
          if (!capability.available || uploadSourceFile.size > capability.maxIsoBytes) {
            unavailable = capability.reason || `ISO 超过后台上限 ${human(capability.maxIsoBytes)}`
          } else {
            psxIsoToChd = true
            // 旧槽可能是 .chd.8bg；自动转换后的成品是直存 .chd，不能复用旧后缀。
            finalKey = psxChdKey(defKey(uploadSourceFile.name))
          }
        }
      } catch (error) {
        unavailable = error instanceof Error ? error.message : '无法连接后台'
      }
      if (!psxIsoToChd && !window.confirm(
        `PS1 ISO 暂时不能自动转为可流式读取的 CHD：${unavailable}\n\n` +
        '可以原样上传 ISO，使用 PCSX 完整下载后游玩；单独 ISO 不包含原盘 CD 音轨。仍要上传吗？',
      )) {
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    if (platform === 'psp' && /\.iso$/i.test(uploadSourceFile.name)) {
      let unavailable = ''
      try {
        const capability = await pspConversionCapability()
        if (capability.available && uploadSourceFile.size <= capability.maxIsoBytes) {
          pspIsoToChd = true
          finalKey = pspChdKey(key)
        } else {
          unavailable = capability.reason || `ISO 超过后台上限 ${human(capability.maxIsoBytes)}`
        }
      } catch (error) {
        unavailable = error instanceof Error ? error.message : '无法连接后台转换服务'
      }
      if (!pspIsoToChd) {
        const direct = window.confirm(
          `这份 PSP ISO 暂时不能自动转成 CHD：${unavailable}\n\n` +
          '可以继续按原始 ISO 上传，但玩家会消耗更多流量。仍然直接上传 ISO 吗？',
        )
        if (!direct) {
          if (inputRef.current) inputRef.current.value = ''
          return
        }
      }
    }
    setMsg(null)
    let allowOverwrite = false
    if (pspIsoToChd || psxIsoToChd) {
      try {
        const choice = await confirmConvertedUpload(finalKey)
        if (!choice.proceed) {
          if (inputRef.current) inputRef.current.value = ''
          return
        }
        allowOverwrite = choice.overwrite
      } catch (error) {
        setMsg({ ok: false, text: `无法确认目标 CHD 是否已存在，已取消转换以避免覆盖：${error instanceof Error ? error.message : String(error)}` })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    } else if (!(await confirmUpload(finalKey, uploadSourceFile))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    let languageSockdrivePreparation: Awaited<ReturnType<typeof prepareLanguageSockdrive>> = null
    if (oneClickSockdrive) {
      try {
        languageSockdrivePreparation = await prepareLanguageSockdrive(uploadSourceFile)
      } catch (error) {
        setMsg({ ok: false, text: `尚未上传：${error instanceof Error ? error.message : '流式盘预检失败'}` })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    setProgress(0)
    if (oneClickSockdrive) setMsg({ ok: true, text: '正在上传一次原始 ZIP；完成后同时生成完整回退包与流式盘…' })
    try {
      await trackUploadActivity(`ROM 上传、识别与发布：${file.name}`, async () => {
        if ((pspIsoToChd || psxIsoToChd) && lang) {
          const discPlatform: 'psx' | 'psp' = psxIsoToChd ? 'psx' : 'psp'
          activeDiscPlatform = discPlatform
          // staging 身份必须绑定完整任务意图；不同 overwrite / 绑定快照不能共用一个 ISO key，
          // 否则另一个标签页的 409 冲突清理可能误删正在转换的源对象。
          const stagingIdentity = JSON.stringify({
            targetKey: finalKey,
            gameSlug: persistedSlug || '',
            lang,
            expectedCurrentKey: persistedSlug ? oldKey : '',
            overwrite: allowOverwrite,
          })
          const stagingKey = psxIsoToChd
            ? await psxStagingKey(uploadSourceFile, slug, lang, stagingIdentity)
            : await pspStagingKey(uploadSourceFile, slug, lang, stagingIdentity)
          setMsg({ ok: true, text: `正在断点上传临时 ISO；上传后服务器会自动转为 ${finalKey}` })
          await uploadRom(uploadSourceFile, stagingKey, (pct, at) => {
            // 临时 ISO 上传占前 45%，服务器下载 / 转换 / 校验 / 发布占后 55%。
            setProgress(Math.round(pct * 0.45))
            if (at) setStage(at)
          })
          setStage(null)
          setProgress(45)
          setMsg({ ok: true, text: 'ISO 已到 R2，正在创建持久转换任务…' })
          const request = {
            platform: discPlatform,
            sourceKey: stagingKey,
            targetKey: finalKey,
            sourceSize: uploadSourceFile.size,
            // 新建表单里的 slug 还没入库，可能正好撞到一款旧游戏；只给真实存在的编辑对象做自动绑定。
            ...(persistedSlug ? { gameSlug: persistedSlug, lang, expectedCurrentKey: oldKey } : {}),
            // 只有确实看到了目标并得到确认，才允许任务覆盖；探测时不存在就保持禁止覆盖。
            overwrite: allowOverwrite,
          }
          // 先保存创建请求；上传已完成后刷新或遇到回程断线，都能用同一 sourceKey 找回幂等任务。
          if (persistedSlug) {
            rememberPendingDiscConversion(discPlatform, slug, lang, request)
            if (psxIsoToChd) rememberPsxConversion(slug, lang, null)
            else rememberPspConversion(slug, lang, null)
          }
          let job: Awaited<ReturnType<typeof createPspConversion>>
          try {
            job = psxIsoToChd ? await createPsxConversion(request) : await createPspConversion(request)
          } catch (error) {
            const rejected = await cleanupRejectedDiscSource(discPlatform, slug, lang, request, error)
            if (rejected.warning) {
              throw new Error(`${error instanceof Error ? error.message : '转换任务创建失败'}；${rejected.warning}`)
            }
            throw error
          }
          if (psxIsoToChd) rememberPsxConversion(slug, lang, job.id)
          else rememberPspConversion(slug, lang, job.id)
          activeDiscJobId = job.id
          setFailedDiscTask(null)
          clearDiscStagingKey(discPlatform, slug, lang, stagingKey)
          const onUpdate = (next: typeof job) => {
            setProgress(45 + Math.round(next.progress * 0.55))
            const label = psxIsoToChd ? psxConversionLabel(next) : pspConversionLabel(next)
            setMsg({ ok: true, text: `${label} ${next.progress}%${next.message ? `；${next.message}` : ''}` })
          }
          const completed = psxIsoToChd
            ? await waitForPsxConversion(job.id, onUpdate)
            : await waitForPspConversion(job.id, onUpdate)
          if (persistedSlug) clearPendingDiscConversion(discPlatform, slug, lang)
          if (psxIsoToChd) rememberPsxConversion(slug, lang, null)
          else rememberPspConversion(slug, lang, null)
          if (valueRef.current === originalKeyValue) onChange(completed.targetKey)
          const removed = await cleanupSuperseded(oldKey, completed.targetKey, allBoundKeys)
          const ratio = completed.outputSize && completed.sourceSize
            ? `；压缩后 ${(completed.outputSize / completed.sourceSize * 100).toFixed(1)}%`
            : ''
          setMsg({
            ok: true,
            text: `${psxIsoToChd ? 'PS1 CD CHD' : 'PSP CHD'} 已校验并发布：${completed.targetKey}（${human(completed.outputSize ?? 0)}）${ratio}` +
              (completed.bound ? '；已原子绑定到游戏' : `；${completed.message || '请保存表单完成绑定'}`) +
              (valueRef.current !== originalKeyValue ? '；ROM 键在任务期间被修改，已保留你的编辑，请核对数据库绑定后再保存' : '') +
              (removed ? `；旧文件 ${removed} 已删除` : ''),
          })
          return
        }
        let uploadFile: Blob = uploadSourceFile
        let packedBlob: Blob | null = null
        let packCodecLabel = ''
        if (needsPacking) {
          /*
            街机：8BG 头里的 originalName 就是播放器交给核心的 EJS_gameName（FBNeo / MAME 靠它认驱动）。
            以前未识别的包写的是原始文件名（如 wofcn_fix.zip），而对象 key 复用了旧槽 wofcn.zip.8bg ——
            后台看 key 一切正常，核心拿到的却是 wofcn_fix.zip，报 Romset is unknown。
            头里的名字一律取对象 key 的末段，两边永远一致。
          */
          const arcadeHeaderName = isArcade && !isPlayArcadeBundle
            ? (plainKey.split('/').pop() || '').replace(/\.8bg$/i, '')
            : ''
          const originalName = arcadeHeaderName || sniffed || uploadSourceFile.name
          const codec = recommendedRomPackCodec(originalName)
          packCodecLabel = codec === 'store' ? '仅 AES-256-GCM（已压缩容器不重复压缩）' : 'Zstd 19 + AES-256-GCM'
          setMsg({
            ok: true,
            text: codec === 'store'
              ? `正在分块加密 ${originalName}；ZIP/CHD 已压缩，不再重复跑 Zstd…`
              : `正在用 Zstd 19 压缩并加密 ${originalName}…`,
          })
          const packed = await trackUploadActivity(`本机压缩并加密：${originalName}`, () =>
            packRomForUpload(uploadSourceFile, originalName, ({ loaded, total }) => {
              // 打包与上传各占一半；AES/Zstd 的单块内部没有细进度，按已完成的 8MB 块推进。
              setProgress(Math.min(49, Math.round((loaded / Math.max(1, total)) * 50)))
            }, codec),
          )
          packedBlob = packed.blob
          uploadFile = new File([packed.blob], key.split('/').pop() || `${uploadSourceFile.name}.8bg`, {
            type: packed.blob.type,
            lastModified: uploadSourceFile.lastModified,
          })
          if (packed.reused) {
            setMsg({ ok: true, text: '源 ROM 校验一致，已复用上次生成的加密包，正在从已完成分片继续上传…' })
          } else if (packed.workers > 1) {
            setMsg({ ok: true, text: `本地已用 ${packed.workers} 路并行完成分块处理，正在自适应并发上传…` })
          }
        }
        const result = await uploadRom(uploadFile, finalKey, (pct, at) => {
          setProgress(oneClickSockdrive ? Math.round(pct * 0.45) : needsPacking ? 50 + Math.round(pct / 2) : pct)
          if (at) setStage(at)
        })
        // 已经确认 R2 收到完整对象，马上释放可能很大的重试缓存；只有失败才需要把它留给下一次。
        if (packedBlob) releasePackedRomUpload(packedBlob)
        onChange(result.key)
        const removed = await cleanupSuperseded(oldKey, result.key, allBoundKeys)
        let streamSuffix = ''
        let streamFailure = ''
        if (oneClickSockdrive) {
          try {
            if (!languageSockdrivePreparation) throw new Error('流式盘预检结果丢失；完整回退包已上传')
            streamSuffix = await publishLanguageSockdrive(uploadSourceFile, result.key, oldKey, result.etag, languageSockdrivePreparation)
          } catch (error) {
            streamFailure = error instanceof Error ? error.message : '流式盘转换没有启动'
          }
        }
        setMsg({
          ok: !streamFailure,
          text:
            `已上传到 R2：${result.key}（${human(result.size)}）` +
            (needsPacking ? `；${packCodecLabel}` : importedPacked ? '；已解开旧 8BG 容器并以明文上传' : '') +
            (sniffed ? `；已按识别结果命名为 ${sniffed}` : '') +
            (isArcade && sniffed && oldKey !== result.key ? '；当前语言已改绑到标准 romset 对象，请保存游戏条目' : '') +
            (flattenedArcadeFiles ? `；已自动拍平 ${flattenedArcadeFiles} 个子目录 ROM 文件` : '') +
            rebuiltMameSet +
            (removed ? `；旧文件 ${removed} 已删除` : '') +
            streamSuffix +
            (streamFailure ? `；完整回退包可用，但流式盘未完成：${streamFailure}` : ''),
        })
      })
    } catch (err) {
      if (activeDiscJobId && activeDiscPlatform) rememberFailedDiscTask(activeDiscJobId, activeDiscPlatform)
      else if (activeDiscPlatform && persistedSlug && lang && rememberedPendingDiscConversion(activeDiscPlatform, slug, lang)) {
        rememberFailedDiscTask(PENDING_DISC_CREATE_RETRY, activeDiscPlatform)
      }
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setProgress(null)
      setStage(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const handleFileSelection = async (file: File | undefined) => {
    if (!file) return
    setBusySelecting(true)
    try {
      await onFile(file)
    } catch (error) {
      setMsg({ ok: false, text: error instanceof Error ? error.message : '处理所选文件失败' })
      if (inputRef.current) inputRef.current.value = ''
    } finally {
      setBusySelecting(false)
    }
  }

  /** 旧 PS1 CHD 只迁移对象格式；原 `.8bg` 对象保留，游戏绑定仍等管理员保存表单才切换。 */
  const migrateBoundPsxPack = async () => {
    const sourceKey = valueRef.current.trim()
    if (platform !== 'psx' || !isLegacyPsxPackKey(sourceKey) || !canUpload) return
    const aborter = new AbortController()
    psxMigrationAbort.current = aborter
    setBusySelecting(true)
    setMsg({ ok: true, text: '正在核对旧 PS1 镜像版本…' })
    try {
      const sourceUrl = romUrlForKey(sourceKey)
      const probe = await probeRom(sourceUrl, 4_000, false, { retry: false })
      if (aborter.signal.aborted) return
      if (!probe.url || !probe.size) throw new Error('暂时无法读取旧镜像的版本或大小，请稍后重试')
      if (!window.confirm(
        `${sourceKey}\n\n` +
          `将下载并解密旧镜像（${human(probe.size)}），再上传成可按需读取的裸 CHD。` +
          '原 8BG 对象会保留；新文件上传后仍需保存游戏条目才会切换玩家绑定。\n\n继续迁移吗？',
      )) return

      setProgress(0)
      setMsg({ ok: true, text: `正在断点下载旧镜像（${human(probe.size)}）；完成后会自动解包并上传裸 CHD…` })
      await trackUploadActivity(`旧 PS1 CHD 迁移：${sourceKey}`, async () => {
        const file = await downloadLegacyPsxPackForMigration(sourceKey, {
          urlForKey: romUrlForKey,
          probe: async () => probe,
          download: (url, size, onProgress, signal) => fetchBlobWithProgress(url, {
            phase: 'rom',
            signal,
            alternateUrls: alternateRomUrls(url),
            resumeKey: romCacheKey(url),
            maxBytes: size,
            check: (response) => {
              if (/text\/html|application\/xhtml/i.test(response.headers.get('content-type') ?? '')) {
                throw new Error('旧 PS1 镜像地址返回了网页，不是 8BG 文件')
              }
            },
            onProgress: ({ loaded, total }) => onProgress?.(loaded ?? 0, total ?? size),
          }),
        }, (loaded, total) => {
          setProgress(Math.min(24, Math.round((loaded / Math.max(1, total)) * 24)))
        }, aborter.signal)

        if (aborter.signal.aborted) return
        const { header } = await inspectRomPackBlob(file)
        if (!/\.chd$/i.test(header.originalName)) throw new Error(`旧容器内是 ${header.originalName}，不是 CHD；未上传`)
        if (header.originalSize > 1024 * 1024 * 1024) throw new Error('解密后的 CHD 超过流式读盘上限 1 GiB；未上传')

        if (valueRef.current.trim() !== sourceKey) throw new Error('下载期间 ROM 绑定已变化；文件未上传')
        // 上面的迁移确认已经明确告知完整下载量与裸 CHD 上传，不再重复弹同一类体积确认。
        await onFile(file, true)
      })
    } catch (error) {
      if (!aborter.signal.aborted) {
        setMsg({ ok: false, text: error instanceof Error ? `旧 PS1 镜像迁移失败：${error.message}` : '旧 PS1 镜像迁移失败' })
      }
    } finally {
      if (psxMigrationAbort.current === aborter) psxMigrationAbort.current = null
      if (!aborter.signal.aborted) {
        setProgress(null)
        setStage(null)
        setBusySelecting(false)
      }
    }
  }

  const retryDiscConversion = async () => {
    if (!failedDiscJobId) return
    const retryId = failedDiscJobId
    const retryPendingCreate = retryId === PENDING_DISC_CREATE_RETRY
    const startingKey = valueRef.current
    let pendingRequest: import('@/services/pspConversion').CreatePspConversion | null = null
    setProgress(45)
    setMsg({ ok: true, text: retryPendingCreate ? '正在用已上传 ISO 恢复转换任务…' : `正在重试 ${platform === 'psx' ? 'PS1 ISO → CD CHD' : 'PSP ISO → CHD'}；会复用已上传 ISO…` })
    try {
      pendingRequest = retryPendingCreate && slug && lang
        ? rememberedPendingDiscConversion(platform === 'psx' ? 'psx' : 'psp', slug, lang)
        : null
      if (retryPendingCreate && !pendingRequest) throw new Error('已上传 ISO 的恢复请求已过期；请重新选择文件上传')
      const job = retryPendingCreate
        ? platform === 'psx'
          ? await createPsxConversion(pendingRequest!)
          : await createPspConversion(pendingRequest!)
        : await retryPspConversion(retryId)
      rememberFailedDiscTask(job.id, platform === 'psx' ? 'psx' : 'psp')
      if (slug && lang) {
        if (platform === 'psx') rememberPsxConversion(slug, lang, job.id)
        else rememberPspConversion(slug, lang, job.id)
      }
      const onUpdate = (next: typeof job) => {
        setProgress(45 + Math.round(next.progress * 0.55))
        const label = platform === 'psx' ? psxConversionLabel(next) : pspConversionLabel(next)
        setMsg({ ok: true, text: `${label} ${next.progress}%${next.message ? `；${next.message}` : ''}` })
      }
      const completed = platform === 'psx'
        ? await waitForPsxConversion(job.id, onUpdate)
        : await waitForPspConversion(job.id, onUpdate)
      if (valueRef.current === startingKey) onChange(completed.targetKey)
      if (slug && lang) {
        clearPendingDiscConversion(platform === 'psx' ? 'psx' : 'psp', slug, lang)
        if (platform === 'psx') rememberPsxConversion(slug, lang, null)
        else rememberPspConversion(slug, lang, null)
      }
      setFailedDiscTask(null)
      setProgress(null)
      setMsg({
        ok: true,
        text: `${platform === 'psx' ? 'PS1 CD CHD' : 'PSP CHD'} 已完成：${completed.targetKey}（${human(completed.outputSize ?? 0)}）` +
          (completed.bound ? '；已原子绑定到游戏' : `；${completed.message || '请保存表单完成绑定'}`) +
          (valueRef.current !== startingKey ? '；ROM 键在重试期间被修改，已保留你的编辑，请核对数据库绑定后再保存' : ''),
      })
    } catch (error) {
      const rejected = retryPendingCreate && pendingRequest
        ? await cleanupRejectedDiscSource(platform === 'psx' ? 'psx' : 'psp', slug, lang || '', pendingRequest, error)
        : { handled: false }
      if (rejected.handled) setFailedDiscTask(null)
      setProgress(null)
      setMsg({
        ok: false,
        text: `${error instanceof Error ? error.message : '转换重试失败'}${rejected.warning ? `；${rejected.warning}` : ''}`,
      })
    }
  }

  /** 面板上点「上传整包」 */
  const runBundle = async () => {
    if (!pending) return
    const dependencies = pending.plan.files.filter((file) => file.include && file.path !== pending.plan.main)
    if (dependencies.length > 512) {
      setMsg({ ok: false, text: '单个 Flash 包最多登记 512 个依赖文件；请先从 ZIP 中移除网页不需要的文件' })
      return
    }
    if (pending.plan.files.some((file) => file.include && (file.path.length > 500 || INVALID_FLASH_BUNDLE_PATH.test(file.path) || file.path.split('/').some((part) => !part || part === '.' || part === '..')))) {
      setMsg({ ok: false, text: '包内路径过长或含反斜杠、问号、井号、控制字符、空目录段 / 点目录，浏览器无法可靠按相对路径请求；请先在 ZIP 中修正' })
      return
    }
    const oldKey = value.trim()
    setMsg(null)
    setBundleAt({ done: 0, total: pending.plan.files.filter((f) => f.include).length, active: 0, path: '', pct: 0 })
    try {
      const r = await uploadSwfBundle({
        zip: pending.zip,
        files: pending.plan.files,
        main: pending.plan.main,
        dir: pending.dir,
        onProgress: setBundleAt,
      })
      if (!r) {
        setMsg({ ok: false, text: '已取消，什么都没传' })
        return
      }
      onChange(r.mainKey)
      onAssetsChange(dependencies.map((file) => file.path))
      onBundleEntryChange(pending.plan.main)
      // 旧 ROM 还在同一个包目录里的话，孤儿清理那步已经处理过了，别再问第二遍
      const removedOld = dirOfKey(oldKey) === pending.dir ? null : await cleanupSuperseded(oldKey, r.mainKey, allBoundKeys)
      setMsg({
        ok: true,
        text:
          `已上传 ${r.keys.length} 个文件（${human(r.bytes)}）到 ${pending.dir}/，主 SWF 绑定为 ${r.mainKey}` +
          (r.removed.length ? `；清理了 ${r.removed.length} 个旧文件` : '') +
          (r.cleanupFailed ? `；${r.cleanupFailed} 个旧文件未能自动清理，请在 ROM 存储中核查` : '') +
          (removedOld ? `；旧 ROM ${removedOld} 已删除` : ''),
      })
      setPending(null)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setBundleAt(null)
    }
  }

  /**
   * 备用地址同样走全库安全删除：主表单的 deleteBoundRom 会把这个 key 从所有游戏的主 / 语言 / 备用槽摘掉，
   * 并同步清掉表单草稿。以前这里只能改文本框，清空后 R2 上的文件就成了没人认领的孤儿。
   */
  const removeBackup = async () => {
    const key = backupValue.trim()
    if (!key) return
    setMsg(null)
    if (!(allowStorage && isDeletableKey(key))) {
      onBackupChange('')
      setMsg({ ok: true, text: '已清空备用地址；外部文件不会被删除' })
      return
    }
    if (!canUpload) {
      setMsg({ ok: false, text: '请先在“ROM 存储”页配置 Worker 地址和口令，才能解绑并删除 R2 文件' })
      return
    }
    if (!onDeleteRom) {
      setMsg({ ok: false, text: '当前窗口无法安全检查全库引用，已阻止删除' })
      return
    }
    try {
      const result = await onDeleteRom(key)
      if (result) setMsg({ ok: true, text: `已解绑备用地址并删除 ${result.removed} 个 R2 对象（影响 ${result.unboundGames} 款游戏）` })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '解绑并删除失败' })
    }
  }

  /** 删除 R2 ROM 时经父表单先解除全库引用；外部地址 / 站内静态文件只允许解绑。 */
  const removeRom = async () => {
    const key = value.trim()
    if (!key) return
    setMsg(null)

    if (allowStorage && isDeletableKey(key)) {
      if (!canUpload) {
        setMsg({ ok: false, text: '请先在“ROM 存储”页配置 Worker 地址和口令，才能解绑并删除 R2 文件' })
        return
      }
      if (!onDeleteRom) {
        setMsg({ ok: false, text: '当前窗口无法安全检查全库引用，已阻止删除' })
        return
      }
      try {
        const result = await onDeleteRom(key)
        if (result) setMsg({ ok: true, text: `已解绑并删除 ${result.removed} 个 R2 对象（影响 ${result.unboundGames} 款游戏）` })
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : '解绑并删除失败' })
      }
      return
    }

    const sharedBy = allBoundKeys.filter((k) => k === key).length
    const shared = sharedBy > 1 ? `当前游戏还有 ${sharedBy - 1} 个槽位在使用它；` : ''
    if (!window.confirm(`${key}\n\n这个地址不是可由本站删除的 R2 ROM，只解除当前槽位的绑定，原文件会保留。${shared}\n\n继续吗？`)) return
    onChange('')
    setMsg({ ok: true, text: '已解除绑定，原文件未删除' })
  }

  return (
    <div className="space-y-2">
      <Field
        label={label ?? (isHtml5 ? '网页入口 URL' : 'ROM 文件')}
        hint={
          isHtml5
            ? '只填写你有权嵌入的 HTTPS 游戏网址；裸域名会自动补 HTTPS。带 JS、WASM、图片等素材的项目请先完整部署，再填 index.html 地址'
            : canUpload
            ? value.trim() && !/^https?:/i.test(value)
              ? isArcade
                ? '街机 ZIP 会先按成员 CRC 认 romset。识别到标准包名时会绑定到正确的 romset 对象（而非把新内容写进当前可能错误的文件名）；只有当前 key 本来就是该标准名时才原地覆盖。上传成功后请保存游戏条目。'
                : allBoundKeys.filter((bound) => bound === value.trim()).length > 1
                ? `这个文件还被其他语言槽使用；重新上传会改存 ${defKey(exampleName)}，不会覆盖共用文件`
                : isBundleKey(value.trim())
                ? `这一槽绑的是多 SWF 包里的 ${value.trim().split('/').pop()}；再传一个 zip 会原地更新 ${dirOfKey(value.trim())}/`
                : `再次上传会原地覆盖已绑定的 ${value.trim()}；想换存放位置就先改这里的 key 或清空`
              : oneClickSockdrive
              ? `只需选择一次原始 ZIP。支持时浏览器只上传一次，由 R2 桶内复制私有源；服务器制作版本化 Sockdrive 并原子绑定`
              : isArcade
              ? `街机 ROM 会**自动识别 romset**：按 ZIP 中央目录的文件名和 CRC 核验。已支持的 MAME 专用包会自动选核心/BIOS；FBNeo 命中后按 romset 短名存（如 ${defKey('kof97.zip')}）。未知或不完整包不会猜名`
              : isFlash
                ? `单个 .swf 存成 ${defKey('x.swf')}；多 SWF 的游戏直接选 .zip，整包会传到 ${bundleDirFor(platform, slug, lang)}/ 下`
                : isStreamingDisc
                  ? `直接上传镜像会存到 ${defKey(exampleName)} 这样的位置并自动绑定；不要套 ZIP。也可手填支持 HTTP Range 的完整 URL`
                : platform === 'psx'
                  ? `单数据轨 ISO 优先在服务器转成可 Range 流式游玩的 CD CHD；现成 CHD 可按需读盘。旧 8BG 导入后会先解包再上传明文。双盘 / 多盘请选择下方入口，按盘片顺序选择 2–${PSX_M3U_MAX_DISCS} 张 CHD，系统会生成 M3U 并在全部盘上传后才绑定。带 CD 音轨的原盘请先从 BIN/CUE 转 CHD，单独 ISO 无法保留音乐`
                : `新上传会以明文存到 ${defKey(exampleName)} 并自动绑定；旧 8BG 导入后也会解包成明文对象`
            : '手填对象 key 或完整 URL；要直接上传，请先在「ROM 存储」页配置 Worker 地址与口令'
        }
      >
        <div className="flex gap-2">
          <input
            className={cx(inputClass, 'font-mono')}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={busySelecting || progress !== null}
            placeholder={isHtml5 ? 'https://game.example.com/' : defKey(isFlash ? 'x.swf' : exampleName)}
          />
          {!isHtml5 && (
            <>
              <input ref={inputRef} type="file" accept={accept} className="hidden" disabled={busySelecting || progress !== null} onChange={(e) => void handleFileSelection(e.target.files?.[0])} />
              <button
                type="button"
                className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
                disabled={!canUpload || busySelecting || progress !== null || bundleAt !== null}
                onClick={() => inputRef.current?.click()}
                title={canUpload ? (oneClickSockdrive ? '选择原始 ZIP：一次上传完整回退包，并在 R2 内准备流式盘源' : isFlash ? '选择 .swf，或选 .zip 上传多 SWF 整包' : isStreamingDisc ? '选择平台支持的单文件光盘镜像并上传到 R2' : '选择文件并上传到 R2') : '需要先配置 Worker'}
              >
                {busySelecting && progress === null
                  ? '检查文件…'
                  : progress === null
                    ? (oneClickSockdrive ? '☁️ 完整包 + 流式盘' : isFlash ? '☁️ 上传 SWF / ZIP' : '☁️ 上传到 R2')
                    : `处理中 ${progress}%`}
              </button>
            </>
          )}
          {failedDiscJobId && progress === null && (
            <button
              type="button"
              className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
              onClick={() => void retryDiscConversion()}
              disabled={busySelecting}
            >
              {failedDiscJobId === PENDING_DISC_CREATE_RETRY
                ? '🔁 重试创建任务（无需重传 ISO）'
                : '🔁 重试转换（复用已上传 ISO）'}
            </button>
          )}
          {platform === 'psx' && isLegacyPsxPackKey(value) && (
            <button
              type="button"
              className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
              onClick={() => void migrateBoundPsxPack()}
              disabled={!canUpload || busySelecting || progress !== null || bundleAt !== null}
              title="断点下载并校验当前旧 8BG 镜像，自动解包后上传裸 CHD；旧对象保留，保存游戏条目后才切换绑定"
            >
              🔄 迁移为流式 CHD
            </button>
          )}
          {value && !progress && !busySelecting && (
            isHtml5 ? (
              <a href={normalizeHtml5Entry(value)} target="_blank" rel="noreferrer" className={cx(btnClass.secondary, 'shrink-0')} title="在新标签页打开网页入口">
                打开
              </a>
            ) : (
              <RomOpenLink href={romUrlForKey(value)} className={cx(btnClass.secondary, 'shrink-0')} title="在新标签页打开文件地址">
                打开
              </RomOpenLink>
            )
          )}
          {value && !progress && !busySelecting && bundleAt === null && (
            <button
              type="button"
              className={cx(btnClass.danger, 'shrink-0')}
              onClick={() => void removeRom()}
              disabled={busySelecting || deletingRom || (allowStorage && isDeletableKey(value) && !canUpload)}
              title={allowStorage && isDeletableKey(value)
                ? canUpload ? '检查全库引用后解除绑定并永久删除 R2 文件' : '请先配置 Worker 地址和口令，才能删除 R2 文件'
                : '只解除当前槽位绑定；外部文件不会被删除'}
            >
              {allowStorage && isDeletableKey(value) ? deletingRom ? '删除中…' : '解绑并删除' : '解绑'}
            </button>
          )}
        </div>
        {platform === 'psx' && (
          <div className="grid gap-2 rounded-md border border-line p-2">
            <input
              ref={multiDiscInputRef}
              type="file"
              accept=".chd,application/octet-stream"
              multiple
              className="hidden"
              disabled={busySelecting || progress !== null}
              onChange={(event) => onMultiDiscFiles(event.target.files ? Array.from(event.target.files) : undefined)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
                disabled={!canUpload || !lang || busySelecting || progress !== null || bundleAt !== null}
                onClick={() => multiDiscInputRef.current?.click()}
                title={!lang ? '先选择 ROM 语言槽' : canUpload ? `选择 2–${PSX_M3U_MAX_DISCS} 张裸 CHD，然后确认盘序再上传` : '需要先配置 Worker'}
              >
                📀 选择双盘 / 多盘组
              </button>
              <span className="text-[11px] text-dim">裸 CHD v5；上传前可调整顺序。全部盘上传成功后才发布清单并绑定。</span>
            </div>
            {multiDiscFiles.length > 0 && (
              <>
                <ol className="grid gap-1.5">
                  {multiDiscFiles.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex min-w-0 items-center gap-2 rounded-md bg-surface-muted px-2 py-1.5 text-xs">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand/15 font-semibold text-brand">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                      <span className="shrink-0 text-dim">{human(file.size)}</span>
                      <button type="button" className={cx(btnClass.small, 'h-8 min-w-8 border border-line bg-surface-2 text-fg hover:border-line-strong disabled:opacity-50')} disabled={index === 0 || busySelecting || progress !== null} onClick={() => moveMultiDiscFile(index, -1)} aria-label={`将第 ${index + 1} 张上移`} title="上移">↑</button>
                      <button type="button" className={cx(btnClass.small, 'h-8 min-w-8 border border-line bg-surface-2 text-fg hover:border-line-strong disabled:opacity-50')} disabled={index === multiDiscFiles.length - 1 || busySelecting || progress !== null} onClick={() => moveMultiDiscFile(index, 1)} aria-label={`将第 ${index + 1} 张下移`} title="下移">↓</button>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={cx(btnClass.primary, 'shrink-0')} disabled={!canUpload || busySelecting || progress !== null || bundleAt !== null} onClick={() => void uploadMultiDiscFiles()}>
                    ☁️ 确认盘序并上传 {multiDiscFiles.length} 张盘
                  </button>
                  <button type="button" className={cx(btnClass.small, 'h-9 rounded-lg border border-line px-3 text-sm text-muted hover:bg-surface-2 disabled:opacity-50')} disabled={busySelecting || progress !== null} onClick={() => { multiDiscUploadSession.current = null; setMultiDiscFiles([]) }}>
                    清除选择
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {!isHtml5 && value.trim() && (
          <details className="rounded-md border border-line p-2 text-xs text-muted">
            <summary className="cursor-pointer select-none font-medium text-fg">
              同语言备用地址{backupValue.trim() ? '（已配置）' : '（可选）'}
            </summary>
            <p className="mt-2 text-[11px] text-dim">
              主地址 404、超时、跨域失败或暂时断网时，播放器先尝试这里；备用也失败才回退到其他语言。建议主、备放在不同域名。
            </p>
            <div className="mt-2 flex gap-2">
              <input
                className={cx(inputClass, 'font-mono')}
                value={backupValue}
                onChange={(e) => onBackupChange(e.target.value)}
                placeholder="R2 对象 key 或完整 HTTPS URL"
              />
              {backupValue.trim() && (
                <RomOpenLink
                  href={romUrlForKey(backupValue.trim())}
                  className={cx(btnClass.secondary, 'shrink-0')}
                >
                  打开
                </RomOpenLink>
              )}
              <button
                type="button"
                className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
                disabled={busySelecting || progress !== null || health?.checking}
                onClick={() => void checkHealth()}
              >
                {health?.checking ? '检测中…' : '检测主/备'}
              </button>
              {backupValue.trim() && (
                <button
                  type="button"
                  className={cx(btnClass.danger, 'shrink-0 whitespace-nowrap')}
                  onClick={() => void removeBackup()}
                  disabled={busySelecting || progress !== null || deletingRom || (allowStorage && isDeletableKey(backupValue) && !canUpload)}
                  title={allowStorage && isDeletableKey(backupValue)
                    ? canUpload ? '检查全库引用后解除备用地址并永久删除 R2 文件' : '请先配置 Worker 地址和口令，才能删除 R2 文件'
                    : '只清空备用地址；外部文件不会被删除'}
                >
                  {allowStorage && isDeletableKey(backupValue) ? deletingRom ? '删除中…' : '解绑并删除' : '解绑'}
                </button>
              )}
            </div>
            {allowStorage && isDeletableKey(backupValue) && (
              <p className="mt-1 text-[11px] text-dim">只想换掉备用地址、保留文件时，直接改写或清空上面的输入框即可。</p>
            )}
            {health && !health.checking && (
              <p className="mt-2 space-x-3">
                <span>主地址：{healthText(health.primary)}</span>
                {backupValue.trim() && <span>备用地址：{healthText(health.backup)}</span>}
              </p>
            )}
          </details>
        )}
        {!isHtml5 && !isStreamingDisc && /^https?:\/\//i.test(value) && (
          <div className="space-y-2 rounded-md border border-line p-2 text-xs text-muted">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(archiveRef)}
                onChange={(e) => {
                  const source = value.split('#')[0]
                  onChange(e.target.checked ? `${source}#rom=${impliedRomName(source) ? 'auto' : ''}&v=1` : (archiveRef?.sourceUrl ?? value))
                }}
              />
              外站链接是外层 ZIP；在玩家浏览器里解出单个 ROM
            </label>
            {archiveRef && (
              <>
                {impliedRomName(archiveRef.sourceUrl) && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={archiveRef.auto}
                      onChange={(e) => {
                        const params = new URLSearchParams(value.slice(value.indexOf('#') + 1))
                        params.set('rom', e.target.checked ? 'auto' : '')
                        onChange(`${archiveRef.sourceUrl}#${params}`)
                      }}
                    />
                    自动选择 ZIP 内唯一的 .{impliedRomName(archiveRef.sourceUrl).split('.').pop()} 文件
                  </label>
                )}
              <div className="grid gap-2 sm:grid-cols-2">
                {!archiveRef.auto && <label className="space-y-1">
                  <span className="block">ZIP 内文件名（含文件夹）</span>
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={archiveRef.entry}
                    onChange={(e) => {
                      const params = new URLSearchParams(value.slice(value.indexOf('#') + 1))
                      params.set('rom', e.target.value)
                      onChange(`${archiveRef.sourceUrl}#${params}`)
                    }}
                    placeholder={platform === 'arcade' ? 'romset.zip' : 'folder/game.nes'}
                  />
                </label>}
                <label className="space-y-1">
                  <span className="block">缓存版本（可选）</span>
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={new URLSearchParams(value.slice(value.indexOf('#') + 1)).get('v') ?? ''}
                    onChange={(e) => {
                      const params = new URLSearchParams(value.slice(value.indexOf('#') + 1))
                      if (e.target.value) params.set('v', e.target.value)
                      else params.delete('v')
                      onChange(`${archiveRef.sourceUrl}#${params}`)
                    }}
                    placeholder="源站不提供 ETag 时填 1"
                  />
                </label>
              </div>
              </>
            )}
            {archiveRef && <p>只适合 ZIP 中有一个可独立运行的 ROM；本站不存文件，玩家浏览器会尝试缓存解出的文件，配额不足仍可本次游玩。源站需允许跨域 GET。外层 ZIP 上限 256 MB、解出文件上限 512 MB；源文件更新时请更改缓存版本。街机原生 romset ZIP 不需要勾选。</p>}
          </div>
        )}
        {progress !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        {progress !== null && stageText(stage) && <p className="mt-1 font-mono text-[11px] text-dim">{stageText(stage)}</p>}
        {msg && <p className={cx('mt-2 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
        {isFlash && value.trim() && isBundleKey(value.trim()) && (
          <div className="mt-2 space-y-2 rounded-md border border-line p-2 text-xs text-muted">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Flash 依赖清单：{assetsValue.length} 个文件</span>
              <div className="flex gap-2">
                <button type="button" className={btnClass.secondary} disabled={!canUpload || busySelecting || scanningBundle || progress !== null || bundleAt !== null} onClick={() => void scanFlashAssets()}>
                  {scanningBundle ? '扫描中…' : '扫描并登记同目录资源'}
                </button>
                {assetsValue.length > 0 && <button type="button" className={btnClass.secondary} onClick={() => onAssetsChange([])}>清空依赖</button>}
              </div>
            </div>
            <label className="flex flex-wrap items-center gap-2">
              <span>入口包内路径</span>
              <input className={cx(inputClass, 'min-w-48 flex-1 font-mono')} value={bundleEntryValue} onChange={(event) => onBundleEntryChange(event.target.value)} placeholder={value.slice(dirOfKey(value).length + 1)} />
            </label>
            <p>开放 API 会按这份白名单提供入口 SWF 的相对依赖；扫描结果保存前只在当前表单生效。</p>
            {assetsValue.length > 0 && <p className="break-all font-mono text-[11px]">{assetsValue.slice(0, 12).join(' · ')}{assetsValue.length > 12 ? ` · …另有 ${assetsValue.length - 12} 个` : ''}</p>}
          </div>
        )}
        {romset && (
          <RomsetHint
            found={romset}
            onApplyHack={onApplyHack}
          />
        )}
        {mameCatalogSet && (
          <div className="rounded-md border border-online/30 bg-online/5 p-2 text-xs text-muted">
            <p className="font-semibold text-online">
              ✓ 已精确识别：{mameCatalogSet.board} · {mameCatalogSet.romset}.zip · {mameCatalogSet.title}（{mameCatalogSet.year}，{mameCatalogSet.roms.length} 个 ROM 按 CRC 匹配{mameCatalogSet.parent ? `，克隆集，父集 ${mameCatalogSet.parent}` : ''}）
            </p>
            <p className="mt-1">
              建议使用 MAME 当前版（已自动选择，手动选过的核心不会被改）。
              {mameCatalogSet.rebuiltFrom
                ? ` 原包 ${mameCatalogSet.rebuiltFrom} 是 merged / 非标准包，已只抽出这个版本的 ROM，按 MAME 原名重组为 ${mameCatalogSet.romset}.zip（压缩数据原样复用，不重压）。`
                : ''}
              {mameCatalogSet.bundledDevices.length
                ? ` 包里自带的设备 ROM（${mameCatalogSet.bundledDevices.map((device) => device.shortname).join('、')}）已一并放进 ZIP，不需要另挂 BIOS 包。`
                : ''}
              {mameCatalogSet.missingDevices.length === 1
                ? <> 还需要设备 ROM <code>{describeMameCatalogDevice(mameCatalogSet.missingDevices[0])}</code>：「BIOS 包（系统名）」已自动填 <code>{mameCatalogSet.missingDevices[0].shortname}</code>，请在“ROM 存储 → 街机 BIOS 包”上传并绑定 <code>{mameCatalogSet.missingDevices[0].shortname}.zip</code>，否则 MAME 报 required files are missing。</>
                : ''}
              {mameCatalogSet.buttons ? ` 已按 MAME 输入定义把「街机动作键」设为 ${mameCatalogSet.buttons} 键。` : ''}
            </p>
            {mameCatalogStatusNote(mameCatalogSet) && (
              <p className="mt-1 text-live">⚠️ {mameCatalogStatusNote(mameCatalogSet)}</p>
            )}
            {mameCatalogSet.board.startsWith('Sega Model 2') && (
              <p className="mt-1 text-live">
                ⚠️ Model 2 是 3D 板：MAME 在浏览器里逐条解释执行 i960 主 CPU 和几何协处理器，比 2D 街机重得多。
                桌面端新机器可能接近满速，手机和老电脑大概率掉帧；上架前请在目标设备上实测到正式对战。
              </p>
            )}
          </div>
        )}
        {mameRomset && (
          <div className="rounded-md border border-online/30 bg-online/5 p-2 text-xs text-muted">
            <p className="font-semibold text-online">
              ✓ 已精确识别：{mameRomset.board} · {mameRomset.romset}.zip · {mameRomset.title}（{mameRomset.matchedFiles}/{mameRomset.totalFiles} 个 ROM CRC 匹配{mameRomset.parent ? `，克隆集，父集 ${mameRomset.parent}` : ''}）
            </p>
            <p className="mt-1">
              建议使用 MAME 当前版（已自动选择，手动选过的核心不会被改）。
              {mameRomset.bios
                ? <>所需 BIOS set 是 <code>{mameRomset.bios}</code>（空字段会自动填写，已有手动值不会覆盖）；请在“ROM 存储 → 街机 BIOS 包”上传并绑定 <code>{mameRomset.bios}.zip</code>。</>
                : <>这块板子不需要 BIOS 包。</>}
              {mameRomset.nestedExtras > 0
                ? ` 原始 ZIP 会保持不变；另外 ${mameRomset.nestedExtras} 个子目录成员仍留在原处，MAME 以 ${mameRomset.romset}.zip 只读取根目录的 ROM。`
                : ''}
              {mameRomset.buttons ? ` 已按四键格斗把「街机动作键」设为 ${mameRomset.buttons} 键。` : ''}
            </p>
            {namcoMameStatusNote(mameRomset) && (
              <p className="mt-1 text-live">⚠️ {namcoMameStatusNote(mameRomset)}</p>
            )}
          </div>
        )}
        {mameMedia && (
          <div className="rounded-md border border-online/30 bg-online/5 p-2 text-xs text-muted">
            <p className="font-semibold text-online">
              ✓ 已精确识别：{mameMedia.board} · {mameMedia.romset}.zip（需要额外媒体盘）
            </p>
            <p className="mt-1">
              已推荐 <code>mame-current</code>。这份 ZIP 本身不是完整游戏，保存前还要在下方上传并绑定
              {' '}<code>{mameMedia.disks.map((disk) => `${disk.romset}/${disk.name}.chd`).join('、')}</code>；
              CHD 是游戏专属媒体，不是 BIOS，系统会先核对文件头和 SHA-1。
            </p>
            <p className="mt-1">
              这份 ROM 会存为 <code>{romPackKey(defKey(`${mameMedia.romset}.zip`))}</code>。
              MAME 用 ZIP 文件名识别驱动，所以不会把已识别的 <code>{mameMedia.romset}.zip</code> 误覆盖到当前任意名称；
              上传成功后会更新当前语言的绑定，最后点击保存即可生效。
            </p>
          </div>
        )}
        {!canUpload && allowStorage && (
          <p className="mt-1 text-[11px] text-dim">
            <Link to="/admin/roms" className="text-brand-hover hover:underline">
              去配置 Worker →
            </Link>
          </p>
        )}
        {!allowStorage && <p className="mt-1 text-[11px] text-dim">个人库可手填已有 key / URL，但不能上传或删除 ROM 文件。</p>}
      </Field>
      {pending && (
        <SwfBundlePanel
          bundle={pending}
          progress={bundleAt}
          onPlan={(plan) => setPending((b) => (b ? { ...b, plan } : b))}
          onDir={(dir) => setPending((b) => (b ? { ...b, dir } : b))}
          onCancel={() => setPending(null)}
          onConfirm={() => void runBundle()}
        />
      )}
    </div>
  )
}

/**
 * 多 SWF 包的确认面板：先让管理员看清楚「要往哪个目录传哪些文件、哪个是主 SWF」，
 * 再动手传。整包动辄二三十兆、十几个文件，传错了清理起来很烦，值得多这一步。
 */
function SwfBundlePanel({
  bundle,
  progress,
  onPlan,
  onDir,
  onCancel,
  onConfirm,
}: {
  bundle: PendingBundle
  progress: BundleUploadProgress | null
  onPlan: (plan: SwfBundlePlan) => void
  onDir: (dir: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { plan, dir } = bundle
  const on = plan.files.filter((f) => f.include)
  const swfs = on.filter((f) => /\.swf$/i.test(f.path)).map((f) => f.path)
  const warnings = bundleWarnings(plan)
  const busy = progress !== null

  const toggle = (path: string) => {
    const files: SwfBundleFile[] = plan.files.map((f) => (f.path === path ? { ...f, include: !f.include, note: undefined } : f))
    // 主 SWF 被取消勾选就得重挑一个，否则会带着一个「不上传的主文件」去上传
    const stillOn = files.filter((f) => f.include).map((f) => f.path)
    const main = stillOn.includes(plan.main) ? plan.main : pickMainSwf(stillOn)
    onPlan({ ...plan, files, main })
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">
          多 SWF 包 <span className="font-normal text-muted">{bundle.name}</span>
        </p>
        <span className="text-xs text-muted">
          勾选 {on.length} / {plan.files.length} 个文件 · {human(bundleBytes(plan.files))}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-dim">
        整包传到同一个目录，主 SWF 绑成这一槽的 ROM —— 播放器加载远程 ROM 时会把 base 设成它所在的目录，
        游戏里 <code className="font-mono">loadMovie(&apos;CG.swf&apos;)</code> 这类相对路径才解析得回来。
        {plan.strippedRoot && <> 已剥掉包里多套的一层目录 <code className="font-mono">{plan.strippedRoot}/</code>。</>}
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">包目录</span>
          <input className={cx(inputClass, 'font-mono text-xs')} value={dir} disabled={busy} onChange={(e) => onDir(e.target.value.replace(/^\/+|\/+$/g, ''))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">主 SWF（绑成 ROM 的那个）</span>
          <select
            className={cx(inputClass, 'font-mono text-xs')}
            value={plan.main}
            disabled={busy}
            onChange={(e) => onPlan({ ...plan, main: e.target.value })}
          >
            {swfs.length === 0 && <option value="">包里没有 .swf</option>}
            {swfs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {warnings.map((w) => (
        <p key={w} className="mt-2 text-xs text-live">
          ⚠ {w}
        </p>
      ))}

      <ul className="mt-3 max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {plan.files.map((f) => (
          <li key={f.path} className="flex items-center gap-2 px-2 py-1 text-xs">
            <input type="checkbox" checked={f.include} disabled={busy} onChange={() => toggle(f.path)} className="shrink-0" />
            <span className={cx('min-w-0 flex-1 truncate font-mono', f.include ? 'text-fg' : 'text-dim line-through')} title={f.path}>
              {f.path}
            </span>
            {f.path === plan.main && f.include && <span className="shrink-0 rounded bg-brand/20 px-1 text-[10px] text-brand-hover">主</span>}
            {f.note && <span className="shrink-0 text-[10px] text-dim">{f.note}</span>}
            <span className="shrink-0 tabular-nums text-muted">{human(f.size)}</span>
          </li>
        ))}
      </ul>

      {progress ? (
        <div className="mt-3">
          <p className="text-xs text-muted">
            上传中 {progress.done}/{progress.total} · {progress.pct}%{progress.active > 1 ? ` · 并行 ${progress.active} 个文件` : ''}
            {progress.path && <span className="ml-1 font-mono text-dim">{progress.path}</span>}
          </p>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${progress.pct}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" className={btnClass.primary} disabled={!on.length || !plan.main} onClick={onConfirm}>
            上传整包（{on.length} 个文件）
          </button>
          <button type="button" className={btnClass.secondary} onClick={onCancel}>
            取消
          </button>
        </div>
      )}
    </div>
  )
}


/**
 * 封面图 / 视频字段：可手填 key/URL，也可选文件上传到 R2（通过 Worker）。
 * 封面预览与前台卡片保持 1:1，视频仍按 4:3；删除时同时处理绑定和可管理的 R2 对象。
 */
function MediaField({
  kind,
  label,
  hint,
  value,
  slug,
  onChange,
  allBoundKeys,
  allowStorage,
}: {
  kind: 'covers' | 'videos'
  label: string
  hint: string
  value: string
  slug: string
  onChange: (key: string) => void
  allBoundKeys: string[]
  allowStorage: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = allowStorage && Boolean(cfg.api && cfg.token)
  const accept = kind === 'videos' ? 'video/*' : 'image/*'
  const previewUrl = value ? romUrlForKey(value) : ''

  /**
   * 把封面 key 的图片后缀换成压缩后**真正的**那个（.webp；浏览器不支持 WebP 编码时是 .jpg）。
   * 免得 covers/contra.jpg 这个 key 里头装着 webp 字节，后缀和内容对不上。
   */
  function withImageExt(key: string, ext: string): string {
    return key.replace(/\.(png|jpe?g|gif|webp|bmp|avif)$/i, '') + ext
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setMsg(null)
    try {
      const oldKey = value.trim()
      const isCover = kind === 'covers'
      // 封面图先压成 300×300（按短边居中裁切，不拉伸）再传，见 imageResize.ts；视频原样走 R2。
      const compressed = isCover
        ? await trackUploadActivity('本机压缩封面图片', () => compressCoverToWebp(file))
        : null
      const targetFile: Blob = compressed ? compressed.blob : file
      /**
       * 同 RomField：复用已绑定的 key，避免 covers/slug.jpg 与 covers/slug.png 并存。
       *
       * ⚠️ 没有已绑定 key 时必须把**原文件名**交给 defaultMediaKey。slug 为空
       * （新建游戏、标识还没填）时它会退回用文件名 —— 这里要是写死 'cover.webp'，
       * 每一款新游戏的封面都会落到同一个 covers/cover.webp 上，后传的把先传的盖掉。
       */
      const baseKey =
        oldKey && !/^https?:/i.test(oldKey) ? oldKey : defaultMediaKey(kind, slug, file.name)
      const key = compressed ? withImageExt(baseKey, compressed.ext) : baseKey
      if (!(await confirmUpload(key, targetFile))) return
      setProgress(0)
      await trackUploadActivity(`${isCover ? '封面' : '视频'}上传与绑定：${file.name}`, async () => {
        const result = await uploadRom(targetFile, key, setProgress)
        // R2 只存 300px 主图；96/160/240/480 响应档在公开图片域按需生成，避免额外对象占空间。
        onChange(result.key)
        const removed = await cleanupSuperseded(oldKey, result.key, allBoundKeys)
        const note = !compressed
          ? ''
          : compressed.fellBackToJpeg
            ? '（已压成 300×300，但这个浏览器不支持 WebP 编码，存的是 JPEG）'
            : `（已从 ${compressed.sourceWidth}×${compressed.sourceHeight} 压成 300×300 WebP）`
        setMsg({
          ok: true,
          text: `已上传：${result.key}（${human(result.size)}）${note}${removed ? `；旧文件 ${removed} 已删除` : ''}`,
        })
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setProgress(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const removeMedia = async () => {
    const key = value.trim()
    if (!key) return
    setMsg(null)

    const sharedBy = allBoundKeys.filter((bound) => bound === key).length
    const shared = sharedBy > 1 ? `当前游戏还有 ${sharedBy - 1} 个字段在使用它；` : ''
    if (!window.confirm(`${key}\n\n只解除这个${kind === 'covers' ? '封面' : '视频'}绑定，原文件会保留。${shared}这样不会误删其它游戏共用的资源。\n\n继续吗？`)) return
    onChange('')
    setMsg({ ok: true, text: '已解除绑定，原文件安全保留' })
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={500}
          placeholder={defaultMediaKey(kind, slug || '<slug>', kind === 'videos' ? 'x.mp4' : 'x.jpg')}
        />
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!canUpload || progress !== null}
          onClick={() => inputRef.current?.click()}
          title={canUpload ? '选择文件并上传到 R2' : '需要先配置 Worker'}
        >
          {progress === null ? '☁️ 上传' : `上传中 ${progress}%`}
        </button>
        {value && progress === null && (
          <button
            type="button"
            className={cx(btnClass.danger, 'shrink-0')}
            onClick={() => void removeMedia()}
            title="解除当前绑定；原文件会保留"
          >
            解绑
          </button>
        )}
      </div>
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {previewUrl && (
        <div className={cx('mt-2 w-40 overflow-hidden rounded-lg border border-line bg-black', kind === 'covers' ? 'aspect-square' : 'aspect-[4/3]')}>
          {kind === 'videos' ? (
            <video src={previewUrl} className="h-full w-full object-cover" muted loop playsInline controls />
          ) : (
            <img src={previewUrl} alt="预览" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          )}
        </div>
      )}
      {msg && <p className={cx('mt-2 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
      {!canUpload && allowStorage && (
        <p className="mt-1 text-[11px] text-dim">
          直接上传需先在{' '}
          <Link to="/admin/roms" className="text-brand-hover hover:underline">
            ROM 存储
          </Link>{' '}
          页配置 Worker 地址与口令；也可以手填图片 / 视频的完整 URL。
        </p>
      )}
      {!allowStorage && <p className="mt-1 text-[11px] text-dim">个人库可手填图片 / 视频 URL，但不能上传或删除对象存储文件。</p>}
    </Field>
  )
}

/**
 * 街机 ROM 识别结果的展示。
 *
 * 三种情况，说的话完全不一样：
 *   完全命中  —— 文件已经自动改成 romset 短名了，告诉一声就行
 *   部分命中  —— 多半是残缺包或者别的版本，把候选摆出来让管理员自己判断，
 *                 顺便说清楚差在哪（12/13 这种数字比任何形容词都有用）
 *   认不出来  —— 索引里没有。可能是自制/魔改 ROM，也可能包本身有问题
 *
 * BIOS 缺失单独用红字说 —— Neo Geo 没 BIOS 的报错（sp-s3.sp1 … is missing）
 * 长得完全不像「你少传了个文件」，不提前拦一下，管理员会一路查到怀疑人生。
 */
function RomsetHint({
  found,
  onApplyHack,
}: {
  found: RomsetIdentification
  /** 一键把识别到的改版包写进表单（ROM 名 + RomData） */
  onApplyHack?: (hack: NonNullable<RomsetIdentification['hack']>) => void
}) {
  const top = found.candidates[0]
  const hit = found.confident
  const hack = found.hack
  const fbneoCoreKnown = found.candidates.some((candidate) => candidate.coverage === 1)
  return (
    <div className="mt-2 space-y-1 text-xs">
      {hack ? (
        /*
          已知改版包。这一支要说清楚三件事，因为它和「原版包」的处理完全不同：
          它叫什么、借哪个驱动跑、以及为什么必须配一份 RomData。
          不摆候选列表 —— 改版包的身份是指纹确定的，摆「最接近谁」只会误导人
          （这一条规则本身就是为了收拾「最接近 wofch 19/29」那种错答案）。
        */
        <div className="text-online">
          <p>
            ✓ 识别为已知改版包：<span className="font-semibold">{hack.title}</span>
          </p>
          <p className="mt-0.5 text-dim">
            包名应为 <span className="font-mono">{hack.zipName}.zip</span>，借
            <span className="font-mono"> {hack.driver} </span>驱动运行
            {hack.note && <span>（{hack.note}）</span>}。
          </p>
          {hack.romData && hack.romDataScope === 'rom' ? (
            <p className="mt-1 text-dim">
              这份 ROM 会按内容指纹自动套用专属 RomData 和图形补丁；配置不会写进游戏共用字段，因此不会影响其它语言版本。
            </p>
          ) : hack.romData ? (
            <p className="mt-1">
              <button
                type="button"
                onClick={() => onApplyHack?.(hack)}
                className="rounded-md border border-brand px-2 py-1 font-semibold text-brand-hover hover:bg-brand-soft"
              >
                填好 RomData
              </button>
              <span className="ml-2 text-dim">FBNeo 驱动表里没有它，不配 RomData 一定报 Romset is unknown。</span>
            </p>
          ) : (
            <p className="mt-0.5 text-live">
              ⚠️ 认得出，但还没有可用的加载方案（缺 RomData）—— 现在传上去也跑不起来。
            </p>
          )}
        </div>
      ) : hit ? (
        <p className="text-online">
          ✓ 识别为 <span className="font-mono font-semibold">{hit.name}</span>
          （{hit.matched}/{hit.total} 个 ROM 全部匹配）
          {hit.parent && <span className="text-dim">，属于 {hit.parent} 的变体</span>}
          {hit.bios && <span className="text-dim">，需要 BIOS {hit.bios}</span>}
        </p>
      ) : (
        <div className="text-live">
          <p>
            ⚠️ {fbneoCoreKnown
              ? '已确认这组 ROM 属于 FBNeo 支持范围，但克隆版本的 romset 名有歧义，不能安全地自动改包名。'
              : `没能确定 romset。最接近的是 ${top.name}，但只匹配上 ${top.matched}/${top.total} 个 ROM —— 包可能残缺、或者是另一个版本。`}
          </p>
          {found.candidates.length > 1 && (
            <p className="mt-0.5 text-dim">
              其它候选：
              {found.candidates.slice(1, 4).map((c) => (
                <span key={c.name} className="ml-1 font-mono">
                  {c.name}（{c.matched}/{c.total}）
                </span>
              ))}
            </p>
          )}
          <p className="mt-0.5 text-dim">
            {fbneoCoreKnown
              ? '核心已自动选择 FBNeo；文件名保持原样以避免误认。请确认正确的 romset 短名后再改上方 key。'
              : '文件名保持原样上传了。核心只认 romset 短名，名字不对会报 Romset is unknown —— 确认是哪个版本后，手动把上面的 key 改成 <romset>.zip。'}
          </p>
        </div>
      )}
    </div>
  )
}
