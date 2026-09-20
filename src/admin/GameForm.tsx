import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { FlashControlButton, Game, GenreId, PlatformId } from '@/types'
import { ROM_LANGS, ROM_LANG_LABEL, type RomLang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { genres } from '@/data/genres'
import { cx } from '@/lib/format'
import {
  bundleDirFor,
  defaultKeyFor,
  defaultMediaKey,
  defaultRomKeyForLang,
  dirOfKey,
  getRomConfig,
  isBundleKey,
  keepsOriginalFileName,
  listRomObjects,
  clearRomProbeCache,
  coverThumbKey,
  probeRom,
  romUrlForKey,
  uploadRom,
  type UploadStage,
} from '@/services/roms'
import { bundleBytes, bundleWarnings, pickMainSwf, planSwfBundleFromZip, type SwfBundleFile, type SwfBundlePlan } from '@/lib/swfBundle'
import { assertValidZip, extractZipEntry, listZipEntries, isZip } from '@/lib/unzip'
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
import { identifyArcadeRomset, type RomsetIdentification } from '@/lib/arcadeRomset'
import type { ArcadeHack } from '@/data/arcadeHacks'
import { biosSetUrlSync, platformBiosUrlSync, fetchPlatformBios, loadedPlatformBios } from '@/services/platformBios'
// 「平台级那份是不是正好要的这个系统」这条规则和播放器共用一份实现，别各写一份
import { biosNameOfUrl } from '@/emulator/biosPlan'
import { uploadSwfBundle, type BundleUploadProgress } from './swfUpload'
import { compressCoverToWebp } from '@/lib/imageResize'
import { confirmUpload, confirmDiscImage, cleanupSuperseded, deleteRomObjects, human, isDeletableKey } from './uploadGuards'
import { coreOptionsFor } from '@/config/emulators'
import { FEATURES } from '@/config/features'
import { isPlayable } from '@/emulator'
import { NETPLAY_MAX_PLAYERS } from '../../shared/netplay-players.js'
import { normalizeDevelopers } from '@/lib/developers'
import { Field, btnClass, inputClass } from './ui'
import { mergeDosboxConfigOverride, normalizeDosboxConfigOverride } from '../../shared/dosbox-config.js'
import { normalizeDosStartupCommands } from '../../shared/dos-startup-commands.js'
import { probeRange } from '@/emulator/remoteDisc'
import { isRomPackBytes, isRomPackUrl, packRomForUpload, romPackKey, verifyRomPackBlob } from '@/services/romPack'

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
  { label: '⚡ 省内存（Win 3.x）', config: '[dosbox]\nmemsize=32' },
  { label: '⚡ FM 音乐省 CPU', config: '[sblaster]\noplemu=fast' },
] as const

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

const EMPTY: Game = {
  slug: '',
  title: '',
  titleZh: '',
  platform: 'nes',
  genres: ['action'],
  year: 1990,
  developer: '',
  rating: 0,
  ratingCount: 0,
  plays: 0,
  players: 1,
  multiplayer: false,
  coinReward: 0,
  icon: '🎮',
  cover: '',
  video: '',
  description: '',
  tags: [],
  addedAt: today(),
  bodyControl: false,
  adult: false,
  hidden: false,
  rom: '',
  roms: {},
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

const cloneFlashControls = (value: NonNullable<Game['flashControls']>): NonNullable<Game['flashControls']> =>
  JSON.parse(JSON.stringify(value))

interface Props {
  /** 传入则为编辑模式 */
  initial?: Game
  existingSlugs: string[]
  onSubmit: (game: Game) => void
  onCancel: () => void
}

export function GameForm({ initial, existingSlugs, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<Game>(initial ?? { ...EMPTY, addedAt: today() })
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '))
  const [slugTouched, setSlugTouched] = useState(Boolean(initial))
  const [error, setError] = useState<string | null>(null)
  const isEdit = Boolean(initial)
  /** 该平台可选的核心。没配置的平台不显示这一栏 */
  const coreOptions = coreOptionsFor(form.platform)

  useEffect(() => {
    if (!isEdit && !slugTouched) setForm((f) => ({ ...f, slug: slugify(f.title) }))
  }, [form.title, isEdit, slugTouched])


  /**
   * 这款游戏当前绑定的全部对象 key。
   * **刻意不去重** —— cleanupSuperseded 要靠「同一个 key 出现几次」判断它是不是
   * 被多个槽位共用（比如 en 和 ja 指向同一份 ROM），共用的就不能删。
   */
  const allBoundKeys = [
    form.rom ?? '',
    ...Object.values(form.roms ?? {}),
    ...Object.values(form.romBackups ?? {}),
    form.cover ?? '',
    form.video ?? '',
  ]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)

  const set = <K extends keyof Game>(key: K, value: Game[K]) => setForm((f) => ({ ...f, [key]: value }))

  /*
    打开表单就把 BIOS 绑定表拉下来。

    上传文件的识别那条路本来会顺手拉一次（sniffArcade 里），但**手填系统名**的人不会触发它 ——
    而手填恰恰是识别不出来时唯一的出路（汉化版、驱动表里没有的板子）。
    没拉下来时下面那条即时校验只能闭嘴（宁可不说，也不能对着空表报「没绑定」）。
  */
  useEffect(() => {
    void fetchPlatformBios()
  }, [])

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
  const applyHack = (hack: ArcadeHack, onlyIfEmpty = false) => {
    if (!hack.romData) return
    setForm((f) => (onlyIfEmpty && f.arcadeRomData?.trim() ? f : { ...f, arcadeRomData: hack.romData }))
  }

  const applyDosboxTemplate = (config: string) => {
    try {
      // 先校验当前文本，避免模板按钮把管理员刚输错的一行悄悄带进最终配置。
      const current = normalizeDosboxConfigOverride(form.dosboxConfig)
      set('dosboxConfig', mergeDosboxConfigOverride(current, config).trim())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DOSBox-X 配置格式不正确')
    }
  }

  const toggleGenre = (id: GenreId) =>
    setForm((f) => ({
      ...f,
      genres: f.genres.includes(id) ? f.genres.filter((g) => g !== id) : [...f.genres, id],
    }))

  const setRomLang = (lang: RomLang, key: string) =>
    setForm((f) => {
      const roms = { ...f.roms }
      if (key.trim()) roms[lang] = key.trim()
      else delete roms[lang]
      return { ...f, roms }
    })

  const setDosEntryLang = (lang: RomLang, path: string) =>
    setForm((f) => {
      const dosExecutables = { ...f.dosExecutables }
      if (path) dosExecutables[lang] = path
      else delete dosExecutables[lang]
      return { ...f, dosExecutables }
    })

  const setDosStartupCommandsLang = (lang: RomLang, commands: string) =>
    setForm((f) => {
      const dosStartupCommands = { ...f.dosStartupCommands }
      if (commands) dosStartupCommands[lang] = commands
      else delete dosStartupCommands[lang]
      return { ...f, dosStartupCommands }
    })

  const setRomBackupLang = (lang: RomLang, key: string) =>
    setForm((f) => {
      const romBackups = { ...f.romBackups }
      if (key.trim()) romBackups[lang] = key.trim()
      else delete romBackups[lang]
      return { ...f, romBackups }
    })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const slug = slugify(form.slug || form.title)
    if (!form.title.trim()) return setError('请填写英文标题')
    if (!slug) return setError('slug 不能为空')
    if (!isEdit && existingSlugs.includes(slug)) return setError(`slug「${slug}」已存在，请换一个`)
    if (form.genres.length === 0) return setError('至少选择一个类型')
    const windowsGuest = form.platform === 'dos' && form.dosBackend === 'dosboxX' && Boolean(form.dosSystem?.trim())
    if (windowsGuest && !/\.jsdos(?:[?#].*)?$/i.test(form.dosSystem!.trim())) {
      return setError('Windows 系统镜像必须是 .jsdos 文件、对象 key 或 URL')
    }
    const cleanedDosEntries: Partial<Record<RomLang, string>> = {}
    const cleanedDosStartupCommands: Partial<Record<RomLang, string>> = {}
    for (const l of ROM_LANGS) {
      try {
        const commands = normalizeDosStartupCommands(form.dosStartupCommands?.[l])
        if (commands) {
          if (!form.roms?.[l]?.trim()) return setError(`${ROM_LANG_LABEL[l]} 填了启动前命令，但还没有绑定 ROM ZIP`)
          if (windowsGuest) return setError('共享 Windows 系统模式不能使用 DOS 启动前命令')
          if (/^\s*imgmount\b.*\.cue\b/im.test(commands) && form.dosBackend !== 'dosboxX') {
            return setError(`${ROM_LANG_LABEL[l]} 使用 CUE 光盘镜像，请先在“运行环境”选择 DOSBox-X`)
          }
          cleanedDosStartupCommands[l] = commands
        }
      } catch (err) {
        return setError(`${ROM_LANG_LABEL[l]}：${err instanceof Error ? err.message : '启动前命令无效'}`)
      }
      const raw = form.dosExecutables?.[l]?.trim()
      if (!raw) continue
      if (!form.roms?.[l]?.trim()) return setError(`${ROM_LANG_LABEL[l]} 填了启动文件，但还没有绑定 ROM ZIP`)
      const path = raw.replace(/\\/g, '/').replace(/^\/+/, '')
      // 与服务端 dosExecutableOf 一致；在提交前指出错误，避免后端丢掉无效路径却返回成功。
      // eslint-disable-next-line no-control-regex
      if (path.length > 200 || /[\x00-\x1f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        return setError(`${ROM_LANG_LABEL[l]} 的启动文件路径无效，请填写 ZIP 内的相对路径`)
      }
      cleanedDosEntries[l] = path
    }
    if (windowsGuest && !form.dosExecutable?.trim() && (!Object.keys(form.roms ?? {}).length || ROM_LANGS.some((l) => form.roms?.[l]?.trim() && !cleanedDosEntries[l]))) {
      return setError('共享 Windows 系统模式需要默认自启动 EXE，或为每个已绑定语言填写启动文件')
    }
    let dosboxConfig: string | undefined
    if (form.platform === 'dos' && form.dosBackend === 'dosboxX') {
      try {
        dosboxConfig = normalizeDosboxConfigOverride(form.dosboxConfig) || undefined
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'DOSBox-X 配置格式不正确')
      }
    }

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)

    const cleanedRoms: Partial<Record<RomLang, string>> = {}
    const cleanedRomBackups: Partial<Record<RomLang, string>> = {}
    for (const l of ROM_LANGS) {
      const v = form.roms?.[l]?.trim()
      if (v) cleanedRoms[l] = v
      const backup = form.romBackups?.[l]?.trim()
      if (!backup) continue
      if (!v) return setError(`${ROM_LANG_LABEL[l]} 填了备用地址，但还没有主地址`)
      if (backup === v) return setError(`${ROM_LANG_LABEL[l]} 的备用地址不能和主地址相同`)
      cleanedRomBackups[l] = backup
    }
    for (const value of [form.rom?.trim(), ...Object.values(cleanedRoms), ...Object.values(cleanedRomBackups)]) {
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
        if (form.platform === 'ps2') throw new Error('PS2 镜像需要按需读取，不能整包下载后在浏览器解包')
      } catch (err) {
        return setError(err instanceof Error ? err.message : 'ZIP 内 ROM 路径无效')
      }
    }

    onSubmit({
      ...form,
      slug,
      title: form.title.trim(),
      titleZh: form.titleZh?.trim() || undefined,
      developer: normalizeDevelopers(form.developer) || '未知',
      cover: form.cover?.trim() || undefined,
      video: form.video?.trim() || undefined,
      rom: form.rom?.trim() || undefined,
      roms: Object.keys(cleanedRoms).length ? cleanedRoms : undefined,
      // 空对象也要送出：管理员清空最后一个备用地址时，服务端才能删除旧值。
      romBackups: cleanedRomBackups,
      // 空对象也显式提交：编辑时清空所有语言入口，服务端才知道这是有意清除。
      dosExecutables: form.platform === 'dos' ? cleanedDosEntries : {},
      // 清空最后一个语言命令时也要显式送空对象，服务端才能删掉旧命令。
      dosStartupCommands: form.platform === 'dos' ? cleanedDosStartupCommands : {},
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
      // 普通 DOS 用它生成 autoexec；共享 Windows 3.x 直接运行它，95/98 则写进启动批处理。
      // 旧式“系统和游戏揉在一个 .jsdos”没有共享系统字段，仍按原 bundle 的 conf 启动。
      dosExecutable: form.platform === 'dos' ? form.dosExecutable?.trim() || undefined : undefined,
      // 普通 DOS 是默认值，不落冗余字段；勾选时才明确保存 DOSBox-X。
      dosBackend: form.platform === 'dos' && form.dosBackend === 'dosboxX' ? 'dosboxX' : undefined,
      // 平台仍然保存为 DOS；这些字段只描述 DOSBox-X 里面要启动的客体系统。
      dosSystem: windowsGuest ? form.dosSystem!.trim() : undefined,
      dosWindowsVersion: windowsGuest ? form.dosWindowsVersion ?? '9x' : undefined,
      dosLaunchDelay: windowsGuest ? Math.max(5, Math.min(120, Math.round(Number(form.dosLaunchDelay) || 24))) : undefined,
      // 存档说明只对能存档的普通 DOS 游戏有意义：Windows 客体存的是 qcow2 扇区，
      // 播放器压根不给它「保存进度」按钮，留着这句话只会误导后台编辑
      dosSaveHint: form.platform === 'dos' && !windowsGuest ? form.dosSaveHint?.trim() || undefined : undefined,
      // 街机改版包专用；换成别的平台时要清掉，否则改完平台还留着一份没人读的 dat
      arcadeRomData: form.platform === 'arcade' ? form.arcadeRomData?.trim() || undefined : undefined,
      // 非街机平台一律不带这个字段：留着的话换平台后旧的 BIOS 名会跟着走，
      // 而 mappers 那边只做形状校验，它不知道这款游戏已经不该要 BIOS 了
      arcadeBios: form.platform === 'arcade' ? form.arcadeBios?.trim().toLowerCase() || undefined : undefined,
      /*
        DIP 开关同理：非街机要清掉，否则换完平台还挂着一句没人读的话。

        ⚠️ 这里**不能**像上面的 BIOS 名那样 toLowerCase()：那一栏允许写完整的核心选项键
        （`fbneo-dipswitch-kov-Controls=Mahjong`），而键名是大小写敏感的 ——
        小写化之后就再也匹配不上了，症状是「后台填了、跑起来没反应」。
        组名那一段的大小写无所谓：匹配时两边都归一化（见 dipPlan 的 normName）。
      */
      arcadeDip: form.platform === 'arcade' ? form.arcadeDip?.trim() || undefined : undefined,
      arcadeButtons: form.platform === 'arcade' ? form.arcadeButtons : undefined,
      // 纯鼠标 Flash 留空；有键位时屏幕手柄和实体手柄共用这一份配置。
      flashControls: form.platform === 'flash' ? form.flashControls : undefined,
      dosboxConfig,
      // 空字符串写成 undefined，否则会存一条空的英文简介，
      // 前台判「有没有英文版」时就会误判成有
      descriptionEn: form.descriptionEn?.trim() || undefined,
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="英文标题 *">
          <input className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Super Mario Bros." required />
        </Field>
        <Field label="中文译名">
          <input className={inputClass} value={form.titleZh ?? ''} onChange={(e) => set('titleZh', e.target.value)} placeholder="超级马力欧兄弟" />
        </Field>
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
          <select className={inputClass} value={form.platform} onChange={(e) => set('platform', e.target.value as PlatformId)}>
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
        <Field label="发行年份">
          <input type="number" className={inputClass} value={form.year} onChange={(e) => set('year', Number(e.target.value))} />
        </Field>
        <Field label="开发商" hint="多个开发商用逗号分隔">
          <input className={inputClass} value={form.developer} onChange={(e) => set('developer', e.target.value)} placeholder="Nintendo, HAL Laboratory" />
        </Field>
        <Field label="最大玩家数">
          <select className={inputClass} value={form.players} onChange={(e) => set('players', Number(e.target.value) as Game['players'])}>
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
        {form.platform === 'dos' && (
          <>
            <Field label="运行环境">
              <label className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.dosBackend === 'dosboxX'}
                  onChange={(e) => {
                    setForm((current) => ({
                      ...current,
                      dosBackend: e.target.checked ? 'dosboxX' : undefined,
                      dosWindowsVersion: e.target.checked ? current.dosWindowsVersion ?? '9x' : current.dosWindowsVersion,
                      dosLaunchDelay: e.target.checked ? current.dosLaunchDelay ?? 24 : current.dosLaunchDelay,
                    }))
                  }}
                />
                DOSBox-X（CUE 光盘 / Windows 3.x / 95 / 98）
              </label>
              <p className="mt-1 text-[11px] text-dim">
                数据库平台仍是 DOS。只挂 CUE 光盘时系统镜像留空；要运行 Windows 才需要填写系统镜像。
              </p>
            </Field>
            {form.dosBackend === 'dosboxX' ? (
              <>
                <SystemImageField value={form.dosSystem ?? ''} onChange={(value) => set('dosSystem', value || undefined)} />
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
                    游戏 ZIP 内的相对路径；语言槽有单独入口时优先使用语言槽的值。Windows 3.x 会先打开 EXE 所在目录再运行，请填写类似 ZEEK1.EXE、BIN/GAME.EXE 的 DOS 8.3 英文路径。
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
                  <p className="mt-1 text-[11px] text-dim">检测到 Windows 图形界面后再等待这么久；慢设备可适当调大。</p>
                </Field>
                <Field label="DOSBox-X 配置覆盖" className="col-span-2 sm:col-span-4">
                  <textarea
                    className={cx(inputClass, 'h-44 resize-y py-2 font-mono text-xs leading-5')}
                    value={form.dosboxConfig ?? ''}
                    onChange={(e) => set('dosboxConfig', e.target.value || undefined)}
                    spellCheck={false}
                    placeholder={'[cpu]\ncycles=20000\n\n[gus]\ngus=false'}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {DOSBOX_CONFIG_TEMPLATES.map((template) => (
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
                    只保存需要覆盖的 INI 项；支持硬件、CPU、声卡和灵敏度设置。[autoexec]、鼠标捕获模式与游戏盘挂载由站点保护。
                  </p>
                  <p className="mt-1 text-[11px] text-dim">
                    ⚡ 嫌慢先看这两个：站点默认 <code>cycles=auto</code>，实模式 DOS 游戏会按一个保守的固定速度跑，
                    只有程序进保护模式才自动放开 —— 老游戏卡就点「提速」。Windows 3.x 的共享镜像默认
                    <code>memsize=256</code>，这块内存开机就一次性分配掉，手机上很容易吃不消，点「省内存」降到 32 MB。
                  </p>
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
            <DosExtrasField
              slug={slugify(form.slug || form.title)}
              value={form.dosExtras}
              onChange={(next) => set('dosExtras', next)}
              label={form.dosExtrasLabel ?? ''}
              onLabelChange={(next) => set('dosExtrasLabel', next)}
              labelEn={form.dosExtrasLabelEn ?? ''}
              onLabelEnChange={(next) => set('dosExtrasLabelEn', next)}
            />
            {/* Windows 客体不给「保存进度」按钮（存的是 qcow2 扇区，上游标为不可保存），所以不显示这一项 */}
            {!(form.dosBackend === 'dosboxX' && form.dosSystem?.trim()) && (
              <Field label="存档提示" className="col-span-2 sm:col-span-4">
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
          <Field label="街机动作键" hint="手机屏幕只显示游戏真正使用的按钮">
            <select
              className={inputClass}
              value={form.arcadeButtons ?? 6}
              onChange={(e) => set('arcadeButtons', Number(e.target.value) as Game['arcadeButtons'])}
            >
              <option value={2}>2 键</option>
              <option value={4}>4 键</option>
              <option value={6}>6 键</option>
            </select>
          </Field>
          <Field label="BIOS 包（系统名）" className="col-span-2">
            <input
              className={cx(inputClass, 'font-mono')}
              list="known-arcade-bios"
              value={form.arcadeBios ?? ''}
              onChange={(e) => set('arcadeBios', e.target.value || undefined)}
              spellCheck={false}
              placeholder="neogeo / pgm"
            />
            <datalist id="known-arcade-bios">
              {KNOWN_ARCADE_BIOS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <p className="mt-1 text-[11px] text-dim">
              核心按 <b>set 名</b>找 BIOS 包：Neo Geo 是 <code>neogeo</code>，IGS 的 PGM 板子是 <code>pgm</code>。
              上传 ROM 时识别出来的会自动填上；识别不出来（汉化版、驱动表里没有的板子）就在这里手填。
              留空 = 用平台默认那一份。地址在「ROM 存储 → 街机 BIOS 包」里按系统名绑。
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
                <Link to="/admin/roms" className="ml-1 text-brand-hover hover:underline">
                  去绑定 →
                </Link>
              </p>
            )}
          </Field>
          <Field label="DIP 开关" className="col-span-2">
            <input
              className={cx(inputClass, 'font-mono')}
              value={form.arcadeDip ?? ''}
              onChange={(e) => set('arcadeDip', e.target.value || undefined)}
              spellCheck={false}
              placeholder="mahjong"
            />
            <p className="mt-1 text-[11px] text-dim">
              实机主板上那组拨码。目前只有一处用得上：<b>麻将类游戏</b>出厂是「摇杆」档，
              不拨到麻将面板，方向键和碰吃杠全对不上 —— 而屏幕上不会报任何错，玩家只会觉得游戏坏了。
              填 <code>mahjong</code> 会自动认出「摇杆 / 麻将」那一项并拨过去；
              认不出来时浏览器控制台会把它看到的那几项和取值列出来，照着改写成
              <code>组名=值</code>（例如 <code>Controls=Mahjong</code>，多条用逗号分隔）即可。
              留空 = 不干预。只对走 <b>FBNeo 系核心</b>（fbneo / fbalpha2012）的街机有效 ——
              MAME 2003 系没把 DIP 做成核心选项，填了不会生效（控制台会点名这件事）。
            </p>
          </Field>
          <Field label="RomData（改版包）" className="col-span-2 sm:col-span-4">
            <textarea
              className={cx(inputClass, 'h-44 resize-y py-2 font-mono text-xs leading-5')}
              value={form.arcadeRomData ?? ''}
              onChange={(e) => set('arcadeRomData', e.target.value || undefined)}
              spellCheck={false}
              placeholder={'// 三国志2 中文版\nZipName   wofcn\nDrvName   wofj\nFullName  Warriors of Fate (Chinese)\n\ntk2j_23c.8f  0x080000  0x9b215a68  BRF_ESS BRF_PRG CPS1_68K_PROGRAM_NO_BYTESWAP'}
            />
            <p className="mt-1 text-[11px] text-dim">
              只给<b>不在 FBNeo 驱动表里</b>的包用（汉化版、修改版）。ROM 仍按包名上传（如 wofcn.zip），
              播放器会在它旁边放一份同名 .dat，核心据此把 DrvName 指定的驱动「寄生」成这个包名，
              并整个改用 dat 里的 ROM 清单 —— 和原版对不上的 GFX ROM 就是靠这个加载的。
              必须同时写 ZipName 和 DrvName。骨架可以用 <code>npm run romdata -- &lt;包.zip&gt;</code> 从 zip 直接生成。
            </p>
          </Field>
          </>
        )}
        {form.platform === 'flash' && (
          <FlashControlsField
            value={form.flashControls}
            onChange={(value) => set('flashControls', value)}
          />
        )}
        {coreOptions.length > 0 && (
          <Field label="模拟器核心">
            <select className={inputClass} value={form.core ?? ''} onChange={(e) => set('core', e.target.value || undefined)}>
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
                街机这一个平台底下其实是好几套硬件：拳皇是 Neo Geo（fbneo），街霸 2 是 CPS2。
                报「缺文件 / CRC 不匹配」时先换核心试试——<strong className="text-muted">每个核心认的 romset 版本不一样</strong>，
                往往比换 ROM 有用。MAME 2003-Plus 兼容面最广，但也最慢。
                更老的驱动（如 IGS027A（m027 驱动）的《明星三缺一》mxsqy102tw）只有「MAME 当前版」才带，那种情况就选它。
              </p>
            ) : form.platform === 'nds' ? (
              <p className="mt-1 text-[11px] text-dim">
                melonDS 最准，是默认；但它<strong className="text-muted">一个降档手段都没有</strong>（核心里没有帧跳、
                没有内部分辨率、也没有 JIT——JIT 在网页上架构性地做不到）。
                所以只在<strong className="text-muted">这一款画面不对、或者手机上跑不动</strong>时才换成 DeSmuME：
                它有帧跳和可调分辨率，代价是准确度不如 melonDS。不要为了「提速」全站换过去。
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
        <Field label="首页排序">
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
        </Field>
      </div>

      <div className="space-y-3 rounded-xl border border-line p-3">
        <div>
          <p className="text-sm font-semibold">ROM 文件（按语言）</p>
          <p className="mt-0.5 text-xs text-muted">
            每个语言先探主地址、再探同语言备用地址；两者都失败才依次回退到 <span className="font-medium text-fg">English → 日本語 → 简体中文 → 繁體中文</span>，全部没有时提示“游戏没有当前语言版本”。
          </p>
          {form.platform === 'dos' && (
            <p className="mt-1 text-xs text-muted">DOS 可以像以前一样每种语言上传不同包；若一个 ZIP 内含多语言，只上传一次，再把其他语言槽绑定到同一个 ZIP key，并分别填写 BAT / EXE 等启动文件的包内相对路径。</p>
          )}
          {form.platform === 'ps2' && (
            <p className="mt-1 text-xs text-muted">PS2 直接上传 .iso（也支持 .chd / .cso 等 Play! 格式），不要套 ZIP。播放器会按需分段读盘，R2 与本站 Worker 已支持。</p>
          )}
        </div>
        {ROM_LANGS.map((lang) => (
          <div key={lang} className="space-y-2">
            {form.platform === 'dos' && (
              <>
                <Field label={`${ROM_LANG_LABEL[lang]} 启动文件（ZIP 内）`}>
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
                <Field label={`${ROM_LANG_LABEL[lang]} 启动前命令（ZIP 内）`}>
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
                {ROM_LANGS.some((other) => other !== lang && form.roms?.[other]?.trim()) && (
                  <select
                    className={cx(inputClass, 'text-xs')}
                    value=""
                    onChange={(e) => e.target.value && setRomLang(lang, e.target.value)}
                    aria-label={`给 ${ROM_LANG_LABEL[lang]} 复用已上传的 DOS ZIP`}
                  >
                    <option value="">复用其他语言已绑定的 ZIP（只绑定，不重复上传）</option>
                    {ROM_LANGS.filter((other) => other !== lang && form.roms?.[other]?.trim()).map((other) => (
                      <option key={other} value={form.roms![other]}>{ROM_LANG_LABEL[other]} · {form.roms![other]}</option>
                    ))}
                  </select>
                )}
              </>
            )}
            <RomField
              lang={lang}
              dosEntry={form.platform === 'dos' ? form.dosExecutables?.[lang] : undefined}
              label={lang === 'en' ? 'English ROM（第一回退）' : lang === 'ja' ? '日本語 ROM（第二回退）' : `${ROM_LANG_LABEL[lang]} ROM`}
              value={form.roms?.[lang] ?? ''}
              backupValue={form.romBackups?.[lang] ?? ''}
              platform={form.platform}
              slug={slugify(form.slug || form.title)}
              onChange={(key) => setRomLang(lang, key)}
              onBackupChange={(key) => setRomBackupLang(lang, key)}
              allBoundKeys={allBoundKeys}
              onHackFound={(hack) => applyHack(hack, true)}
              onApplyHack={(hack) => applyHack(hack)}
              // 只填空的：管理员手填过就听他的（汉化版借用别的驱动时人比表准）
              onBiosFound={(name) => setForm((f) => (f.arcadeBios?.trim() ? f : { ...f, arcadeBios: name }))}
            />
          </div>
        ))}
      </div>

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
      />

      <Field label="简介（中文）">
        <textarea
          className={cx(inputClass, 'h-24 resize-y py-2')}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="一两句话介绍这款游戏"
        />
      </Field>

      <Field label="简介（English）">
        <textarea
          className={cx(inputClass, 'h-24 resize-y py-2')}
          value={form.descriptionEn ?? ''}
          onChange={(e) => set('descriptionEn', e.target.value || undefined)}
          placeholder="One or two sentences about this game"
        />
        <p className="mt-1 text-[11px] text-dim">
          留空的话，<strong className="text-muted">所有非中文语种</strong>都会看到上面那段中文。
          填了之后英语、西语、法语、德语、意语、日语访客一律看这一段 ——
          西语访客读英文，也远好过读中文。
        </p>
      </Field>

      <Field label="标签" hint="用逗号分隔，例如：经典, 双人合作">
        <input className={inputClass} value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={form.multiplayer} onChange={(e) => set('multiplayer', e.target.checked)} /> 支持联机 / 双人
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={Boolean(form.bodyControl)} onChange={(e) => set('bodyControl', e.target.checked)} /> 体感控制友好
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={Boolean(form.adult)} onChange={(e) => set('adult', e.target.checked)} /> 成人游戏（需验证年满 18 岁）
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={Boolean(form.hidden)} onChange={(e) => set('hidden', e.target.checked)} /> 下架（前台不显示）
        </label>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-live/15 px-3 py-2 text-sm text-live">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className={btnClass.secondary} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={btnClass.primary}>
          {isEdit ? '保存修改' : '新增游戏'}
        </button>
      </div>
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
  const serialized = value ? JSON.stringify(value) : ''
  const preset = !value
    ? 'mouse'
    : Object.entries(FLASH_CONTROL_PRESETS).find(([, controls]) => JSON.stringify(controls) === serialized)?.[0] ?? 'custom'
  const buttons = Object.keys(FLASH_BUTTON_LABEL) as FlashControlButton[]

  const update = (player: 'p1' | 'p2', button: FlashControlButton, key: string) => {
    const next = cloneFlashControls(value ?? { p1: {} })
    const pad = { ...next[player] }
    if (key) pad[button] = key
    else delete pad[button]
    if (player === 'p1') {
      if (!Object.keys(pad).length) return onChange(undefined)
      next.p1 = pad
    } else if (Object.keys(pad).length) next.p2 = pad
    else delete next.p2
    onChange(next)
  }

  return (
    <Field
      label="Flash 控制方式"
      hint="纯鼠标游戏不要配键位；键位同时用于手机屏幕和实体手柄"
      className="col-span-2 sm:col-span-4"
    >
      <select
        className={inputClass}
        value={preset}
        onChange={(e) => {
          const name = e.target.value
          if (name === 'mouse') onChange(undefined)
          else if (name !== 'custom') onChange(cloneFlashControls(FLASH_CONTROL_PRESETS[name as keyof typeof FLASH_CONTROL_PRESETS]))
        }}
      >
        <option value="mouse">纯鼠标 / 触屏点击（不显示手柄）</option>
        <option value="arrows">方向键</option>
        <option value="arrowsSpace">方向键 + 空格</option>
        <option value="wasdSpace">WASD + 空格</option>
        <option value="fireboy">双人：方向键 + WASD</option>
        {preset === 'custom' && <option value="custom">自定义</option>}
      </select>

      {value && (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3">
          {(['p1', 'p2'] as const).map((player) => {
            const enabled = player === 'p1' || Boolean(value.p2)
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
                          const next = cloneFlashControls(value)
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
                          value={value[player]?.[button] ?? ''}
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
  if (!stage || stage.parts <= 1) return ''
  return `分片 ${stage.done}/${stage.parts}` + (stage.resumed ? ` · 已恢复 ${stage.resumed} 片` : '')
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

function DosExtrasField({
  slug,
  value,
  onChange,
  label,
  onLabelChange,
  labelEn,
  onLabelEnChange,
}: {
  slug: string
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  label: string
  onLabelChange: (value: string | undefined) => void
  labelEn: string
  onLabelEnChange: (value: string | undefined) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
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
    const next = refs.slice()
    const failed: string[] = []
    let done = 0
    for (const item of usable) {
      const path = normalizeExtraPath(item.path)
      const key = `${dir}/${extraObjectName(path)}`
      try {
        if (!(await confirmUpload(key, item.blob))) continue
        setBusy(`${path} 0%`)
        const result = await uploadRom(item.blob, key, (pct) => setBusy(`${path} ${pct}%`))
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
    setBusy(null)
    if (inputRef.current) inputRef.current.value = ''
    write(next)
    const warn = problems.map((p) => p.text).join(' ')
    if (failed.length) setMsg({ ok: false, text: `${done} 个已上传，${failed.length} 个失败：${failed.join('；')}` })
    else if (done) setMsg({ ok: !warn, text: `已上传并绑定 ${done} 个附加文件。${warn}`.trim() })
  }

  return (
    <Field label="附加文件（资料片 / 补丁）" className="col-span-2 sm:col-span-4">
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
function SystemImageField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  /** 分片上传的进度明细（单发 PUT 时一直是 null） */
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [uploadedKeys, setUploadedKeys] = useState<string[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)

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
    <Field label="共享 Windows 系统镜像" className="col-span-2 sm:col-span-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
            {' '}<a className="text-brand hover:underline" href={romUrlForKey(value.trim())} target="_blank" rel="noreferrer">检查文件</a>
          </>
        )}
      </p>
      {!canUpload && <p className="mt-1 text-[11px] text-dim">要直接上传，请先在「ROM 存储」页配置 Worker 地址与口令。</p>}
      {progress !== null && stageText(stage) && <p className="mt-1 font-mono text-[11px] text-dim">{stageText(stage)}</p>}
      {msg && <p className={cx('mt-1 text-xs', msg.ok ? 'text-brand' : 'text-live')}>{msg.text}</p>}
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
 * ROM 字段：可手填 key，也可以选文件直接上传到 R2（通过 Worker），成功后自动填入 key。
 *
 * Flash 还多一条路：选 .zip 时不当成 ROM 传上去，而是在浏览器里解开，
 * 把整包文件传到同一个目录，再把主 SWF 绑成这一槽的 ROM ——
 * 大型 Flash 游戏基本都是「主 SWF + 一堆相对路径加载的素材 SWF」，
 * 单传一个 root.swf 上去只会卡在片头（见 lib/swfBundle.ts 的说明）。
 */
function RomField({
  value,
  backupValue,
  platform,
  slug,
  onChange,
  onBackupChange,
  lang,
  dosEntry,
  label,
  allBoundKeys,
  onHackFound,
  onApplyHack,
  onBiosFound,
}: {
  value: string
  backupValue: string
  platform: PlatformId
  slug: string
  onChange: (key: string) => void
  onBackupChange: (key: string) => void
  lang?: RomLang
  dosEntry?: string
  label?: string
  /** 这款游戏当前绑定的全部对象 key（不去重）—— 判断旧文件是不是还被别的槽位共用 */
  allBoundKeys: string[]
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
  /** 管理员点「套用」时明确要求写入，覆盖也无所谓 */
  onApplyHack?: (hack: ArcadeHack) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  /** 分片上传的进度明细（单发 PUT 时一直是 null） */
  const [stage, setStage] = useState<UploadStage | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, setPending] = useState<PendingBundle | null>(null)
  const [bundleAt, setBundleAt] = useState<BundleUploadProgress | null>(null)
  /** 街机 ROM 的自动识别结果，上传后显示在下面 */
  const [romset, setRomset] = useState<RomsetIdentification | null>(null)
  type HealthOutcome = Awaited<ReturnType<typeof probeRom>> & { rangeSupported?: boolean }
  const [health, setHealth] = useState<{
    checking: boolean
    primary?: HealthOutcome
    backup?: HealthOutcome
  } | null>(null)
  const archiveRef = romArchiveRef(value)
  /** 识别出来的游戏需要 BIOS，但平台还没绑 —— 就是「Neo Geo BIOS 成员缺失」那个坑 */
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
  const isFlash = platform === 'flash'
  const isHtml5 = platform === 'html5'
  const isPs2 = platform === 'ps2'
  /** PS2 保持原来的 Range 光盘路径；HTML5 是目录/页面。其余新上传 ROM 统一进入 8BG。 */
  const shouldPack = !isPs2 && !isHtml5
  /** 街机的 ROM key 保留原文件名 —— FBNeo 靠压缩包名认 romset，见 roms.ts 的 FILENAME_IS_IDENTITY */
  const isArcade = keepsOriginalFileName(platform)
  // Flash 额外收 zip：平台的 romExtensions 保持只有 .swf —— 那个列表还管着
  // 「玩本地 ROM」和格式识别，混进 zip 会让玩家以为拖个 zip 进播放器也能玩
  const accept = [
    ...(isFlash ? ['.swf', '.zip'] : (platformMap[platform]?.romExtensions ?? ['.zip'])),
    ...(shouldPack ? ['.8bg'] : []),
  ].join(',')
  const defKey = (fileName: string) => (lang ? defaultRomKeyForLang(platform, slug, lang, fileName) : defaultKeyFor(platform, slug, fileName))
  const exampleName = isPs2 ? 'game.iso' : 'x.zip'

  useEffect(() => setHealth(null), [value, backupValue])

  /**
   * 检测必须从管理员浏览器发起：让服务端代请求任意后台 URL 会变成 SSRF 入口。
   * 两个源并行探，避免主站超时四秒后才开始等备用站；播放器实际启动时仍按主→备顺序选择。
   */
  const checkHealth = async () => {
    const primaryUrl = value.trim() ? romUrlForKey(value.trim()) : ''
    const backupUrl = backupValue.trim() ? romUrlForKey(backupValue.trim()) : ''
    const urls = [primaryUrl, backupUrl].filter(Boolean)
    if (!urls.length) return
    clearRomProbeCache(urls)
    setHealth({ checking: true })
    const checkOne = async (url: string): Promise<HealthOutcome> => {
      const outcome = await probeRom(url, 6000, isHtml5)
      if (!isPs2 || !outcome.url) return outcome
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 6000)
      try {
        // 普通“文件存在”对 PS2 不够：Play! 要不断按扇区读，必须真的返回 206 + Content-Range。
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
    if (outcome.url && outcome.rangeSupported === false) return '❌ 无法验证 HTTP Range（PS2 必须返回 206）'
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

  /**
   * 街机包的自动识别：读 zip 中央目录里的 CRC，比对 FBNeo 驱动表认出 romset。
   *
   * 只在**完全命中**（该 romset 的成员一个不缺、且没有第二个同样满分的候选）时
   * 才改名 —— 差一个 ROM 就套上父集的名字，换来的是「missing files」，比不改还糟。
   * 顺带查一下这游戏要不要 BIOS、平台绑没绑，缺了当场红字提醒。
   *
   * 整条链路都是尽力而为：索引拉不到、包认不出来，都安安静静走原来的流程。
   */
  const sniffArcade = async (file: File): Promise<string | null> => {
    setRomset(null)
    if (!isArcade || !/\.(zip|7z)$/i.test(file.name)) return null
    try {
      const buf = await file.arrayBuffer()
      if (!isZip(buf)) return null
      const found = await identifyArcadeRomset(listZipEntries(buf))
      if (!found) return null
      setRomset(found)

      /*
        已知改版包优先。它的包名由指纹表说了算（FBNeo 靠包名认游戏，RomData 的
        ZipName 也必须和它一致），不能再走下面那套「覆盖率满分才改名」的判断 ——
        改版包永远不可能在任何 romset 上满分，那是它的定义。
      */
      if (found.hack) {
        onHackFound?.(found.hack)
        return `${found.hack.zipName}.zip`
      }

      const hit = found.confident
      if (!hit) return null

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

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (isFlash && /\.zip$/i.test(file.name)) {
      await openBundle(file)
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (platform === 'dos' && dosEntry?.trim() && /\.zip$/i.test(file.name)) {
      try {
        const wanted = dosEntry.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
        const members = listZipEntries(await file.arrayBuffer())
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
    // 光盘平台：格式和体积先问一句。转 .chd 这件事只有在**上传之前**说才有用
    if (!(await confirmDiscImage(platform, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    // CLI 生成的 8BG 可以直接上传；再包一层会让播放器只拆掉外层，最终把 8BG 密文交给模拟器。
    // 但四字节魔数不够：普通 ROM 可能碰巧以 8BG1 开头，半截包也照样有魔数。现成包在上传前
    // 要把每一块解密、解压和校验一遍，同时确认它使用的是当前服务端仍保留的密钥。
    const hasPackMagic = shouldPack && isRomPackBytes(await file.slice(0, 4).arrayBuffer())
    let alreadyPacked = false
    let packedOriginalName = ''
    if (hasPackMagic) {
      setMsg({ ok: true, text: `正在校验已有 8BG 容器 ${file.name}…` })
      try {
        const header = await verifyRomPackBlob(file, ({ loaded, total }) => {
          setProgress(Math.min(49, Math.round((loaded / Math.max(1, total)) * 50)))
        })
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
    // 上面的 0–49% 只是本地校验；真正上传还没开始，确认弹窗期间不能留一条假进度。
    setProgress(null)
    // 街机：先认 romset。现成 8BG 已经在上面完整验证过，不再把整份密文误当 ZIP 读第二遍；
    // 真正交给核心的包名来自容器头的 originalName。
    const sniffed = alreadyPacked ? (platform === 'arcade' ? packedOriginalName : null) : await sniffArcade(file)
    const needsPacking = shouldPack && !alreadyPacked
    const oldKey = value.trim()
    // 字段里已有 key（且不是完整 URL）就复用它 —— 同一个槽位始终对着同一个对象，
    // 这样重传就是原地覆盖，不会又生出一份。但包目录里的 key 不能复用：
    // 那是「某个包里的一个文件」，单传一个 swf 顶上去会和包里的其它文件对不上。
    // 街机认出了 romset 就一律用它 —— 哪怕字段里已经有 key。
    // 那个旧 key 十有八九正是「文件名不对所以跑不起来」的元凶，复用它等于把错留住。
    // 共用 ZIP 时，本槽重传必须另存为自己的语言 key；复用旧 key 会把其他语言一起覆盖。
    const reusable = oldKey && allBoundKeys.filter((bound) => bound === oldKey).length <= 1 && !/^https?:/i.test(oldKey) && !oldKey.startsWith('/') && !isBundleKey(oldKey)
    // 现成容器的外层文件名可能只是 output.8bg；对象 key 必须按头里的 game.nds / game.zip
    // 生成，运行时选择在下载文件头之前就要靠这层扩展名判断，不能等解密后才知道。
    const plainKey = sniffed ? defKey(sniffed) : reusable ? oldKey : defKey(alreadyPacked ? packedOriginalName : file.name)
    const key = shouldPack ? romPackKey(plainKey) : plainKey
    setMsg(null)
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setProgress(0)
    try {
      let uploadFile: Blob = file
      if (needsPacking) {
        setMsg({ ok: true, text: `正在用 Zstd 19 压缩并加密 ${sniffed || file.name}…` })
        const packed = await packRomForUpload(file, sniffed || file.name, ({ loaded, total }) => {
          // 打包与上传各占进度条一半；Zstd 单块内部没有细进度，按已完成的 8MB 块推进。
          setProgress(Math.min(49, Math.round((loaded / Math.max(1, total)) * 50)))
        })
        uploadFile = new File([packed.blob], key.split('/').pop() || `${file.name}.8bg`, {
          type: packed.blob.type,
          lastModified: file.lastModified,
        })
      }
      const result = await uploadRom(uploadFile, key, (pct, at) => {
        setProgress(needsPacking ? 50 + Math.round(pct / 2) : pct)
        if (at) setStage(at)
      })
      onChange(result.key)
      const migrationBackup = shouldPack && oldKey && oldKey !== result.key && !isRomPackUrl(oldKey)
      if (migrationBackup && !backupValue.trim()) onBackupChange(oldKey)
      // 第一次从明文/ZIP 迁到 8BG 时先留着旧对象。若备用栏空，就自动绑成回退地址；
      // 等线上确认新包可玩后再由管理员删，不能在第一次上传成功时就把唯一退路抹掉。
      const removed = migrationBackup ? null : await cleanupSuperseded(oldKey, result.key, allBoundKeys)
      setMsg({
        ok: true,
        text:
          `已上传到 R2：${result.key}（${human(result.size)}）` +
          (needsPacking ? `；Zstd 19 + AES-256-GCM` : alreadyPacked ? '；沿用已有 8BG 容器' : '') +
          (sniffed ? `；已按识别结果命名为 ${sniffed}` : '') +
          (migrationBackup ? `；旧文件 ${oldKey} 已保留${backupValue.trim() ? '' : '为备用地址'}` : '') +
          (removed ? `；旧文件 ${removed} 已删除` : ''),
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setProgress(null)
      setStage(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  /** 面板上点「上传整包」 */
  const runBundle = async () => {
    if (!pending) return
    const oldKey = value.trim()
    setMsg(null)
    setBundleAt({ done: 0, total: pending.plan.files.filter((f) => f.include).length, path: '', pct: 0 })
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
      // 旧 ROM 还在同一个包目录里的话，孤儿清理那步已经处理过了，别再问第二遍
      const removedOld = dirOfKey(oldKey) === pending.dir ? null : await cleanupSuperseded(oldKey, r.mainKey, allBoundKeys)
      setMsg({
        ok: true,
        text:
          `已上传 ${r.keys.length} 个文件（${human(r.bytes)}）到 ${pending.dir}/，主 SWF 绑定为 ${r.mainKey}` +
          (r.removed.length ? `；清理了 ${r.removed.length} 个旧文件` : '') +
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
   * 删掉这一槽绑定的文件，并解绑。
   *
   * 两道守卫：
   *   1. 同一份文件被这款游戏的多个语言槽共用时**只解绑不删文件** ——
   *      否则删完，另一个语言槽就指向一个不存在的对象了
   *   2. 完整 URL / 站内路径（/bios/… 这种构建产物）不归 R2 管，同样只解绑
   * 多 SWF 包会整个包目录一起删，这个由 deleteRomObjects 处理。
   */
  const removeRom = async () => {
    const key = value.trim()
    if (!key) return
    setMsg(null)

    if (!isDeletableKey(key)) {
      if (!window.confirm(`${key}\n\n这不是对象存储里的文件（完整 URL 或站内路径），只能解除绑定，文件本身不会动。\n\n继续吗？`)) return
      onChange('')
      setMsg({ ok: true, text: '已解除绑定（文件不在 R2 上，未删除）' })
      return
    }

    const sharedBy = allBoundKeys.filter((k) => k === key).length
    if (sharedBy > 1) {
      if (!window.confirm(`${key}\n\n这份文件还被这款游戏的另外 ${sharedBy - 1} 个语言槽引用，删掉会让它们全部失效。\n\n只解除**当前这一槽**的绑定（文件保留）吗？`)) return
      onChange('')
      setMsg({ ok: true, text: '已解除绑定，文件保留（其它语言槽还在用）' })
      return
    }

    const bundle = isBundleKey(key)
    const ok = window.confirm(
      bundle
        ? `${dirOfKey(key)}/\n\n这是多 SWF 包里的文件，会把**整个包目录**从 R2 删掉，然后解除绑定。\n\n此操作不可恢复。别的游戏也在用这个包的话请选取消。`
        : `${key}\n\n从 R2 删除这个文件并解除绑定。\n\n此操作不可恢复。别的游戏也绑了同一个文件的话请选取消。`,
    )
    if (!ok) return

    try {
      const { removed, failed } = await deleteRomObjects([key])
      onChange('')
      setMsg({
        ok: failed.length === 0,
        text: failed.length
          ? `解绑成功，但 ${failed.length} 个文件删除失败：${failed.join('、')}`
          : `已删除 ${removed.length} 个文件并解除绑定`,
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '删除失败' })
    }
  }

  return (
    <div className="space-y-2">
      <Field
        label={label ?? 'ROM 文件'}
        hint={
          canUpload
            ? value.trim() && !/^https?:/i.test(value)
              ? allBoundKeys.filter((bound) => bound === value.trim()).length > 1
                ? `这个文件还被其他语言槽使用；重新上传会改存 ${defKey(exampleName)}，不会覆盖共用文件`
                : isBundleKey(value.trim())
                ? `这一槽绑的是多 SWF 包里的 ${value.trim().split('/').pop()}；再传一个 zip 会原地更新 ${dirOfKey(value.trim())}/`
                : `再次上传会原地覆盖已绑定的 ${value.trim()}；想换存放位置就先改这里的 key 或清空`
              : isArcade
              ? `街机 ROM 会**自动识别 romset**：读包里每个文件的 CRC 比对 FBNeo 驱动表，认出来就按 romset 短名存（如 ${defKey('kof97.zip')}）。核心只认这个名字，认不出时保留原名并给出候选`
              : isFlash
                ? `单个 .swf 存成 ${defKey('x.swf')}；多 SWF 的游戏直接选 .zip，整包会传到 ${bundleDirFor(platform, slug, lang)}/ 下`
                : isHtml5
                  ? `可填写你有权嵌入的 HTTPS 游戏网址；单文件作品也可上传 .html。带 JS、WASM、图片等素材的项目请先完整部署，再填写它的 index.html 地址`
                : isPs2
                  ? `直接上传 ISO 会存到 ${defKey(exampleName)} 这样的位置并自动绑定；不要套 ZIP。也可手填支持 HTTP Range 的完整 URL`
                : `新上传会先做 Zstd 19 + AES-256-GCM，再存到 ${romPackKey(defKey(exampleName))} 并自动绑定；旧 ZIP/ROM 仍可直接填写和运行`
            : isHtml5
              ? '填写你有权嵌入的 HTTPS 游戏网址；目标站点必须允许 iframe 嵌入。单文件上传需先配置 Worker'
              : '手填对象 key 或完整 URL；要直接上传，请先在「ROM 存储」页配置 Worker 地址与口令'
        }
      >
        <div className="flex gap-2">
          <input
            className={cx(inputClass, 'font-mono')}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={isHtml5 ? 'https://game.example.com/' : defKey(isFlash ? 'x.swf' : exampleName)}
          />
          <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <button
            type="button"
            className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
            disabled={!canUpload || progress !== null || bundleAt !== null}
            onClick={() => inputRef.current?.click()}
            title={canUpload ? (isFlash ? '选择 .swf，或选 .zip 上传多 SWF 整包' : isHtml5 ? '上传单文件 HTML 作品' : isPs2 ? '选择 .iso / .chd / .cso 等光盘镜像并上传到 R2' : '选择文件并上传到 R2') : '需要先配置 Worker'}
          >
            {progress === null ? (isFlash ? '☁️ 上传 SWF / ZIP' : isHtml5 ? '☁️ 上传 HTML' : '☁️ 上传到 R2') : `上传中 ${progress}%`}
          </button>
          {value && !progress && (
            <a href={romUrlForKey(value)} target="_blank" rel="noreferrer" className={cx(btnClass.secondary, 'shrink-0')} title="在新标签页打开文件地址">
              打开
            </a>
          )}
          {value && !progress && bundleAt === null && (
            <button
              type="button"
              className={cx(btnClass.danger, 'shrink-0')}
              onClick={() => void removeRom()}
              title={isDeletableKey(value) ? '从 R2 删除文件并解除绑定' : '解除绑定（文件不在 R2 上）'}
            >
              删除
            </button>
          )}
        </div>
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
                <a
                  href={romUrlForKey(backupValue.trim())}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(btnClass.secondary, 'shrink-0')}
                >
                  打开
                </a>
              )}
              <button
                type="button"
                className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
                disabled={health?.checking}
                onClick={() => void checkHealth()}
              >
                {health?.checking ? '检测中…' : '检测主/备'}
              </button>
            </div>
            {health && !health.checking && (
              <p className="mt-2 space-x-3">
                <span>主地址：{healthText(health.primary)}</span>
                {backupValue.trim() && <span>备用地址：{healthText(health.backup)}</span>}
              </p>
            )}
          </details>
        )}
        {!isHtml5 && !isPs2 && /^https?:\/\//i.test(value) && (
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
        {romset && (
          <RomsetHint
            found={romset}
            onApplyHack={onApplyHack}
          />
        )}
        {!canUpload && (
          <p className="mt-1 text-[11px] text-dim">
            <Link to="/admin/roms" className="text-brand-hover hover:underline">
              去配置 Worker →
            </Link>
          </p>
        )}
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
            上传中 {progress.done}/{progress.total} · {progress.pct}%
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
}: {
  kind: 'covers' | 'videos'
  label: string
  hint: string
  value: string
  slug: string
  onChange: (key: string) => void
  allBoundKeys: string[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
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
      const compressed = isCover ? await compressCoverToWebp(file) : null
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
      const result = await uploadRom(targetFile, key, setProgress)
      /*
        缩略图（96×96）跟着主图一起传，给搜索联想、首页样例、详情页背景那些
        小尺寸位置用 —— 它们本来在下载 300×300 的主图。
        ⚠️ 缩略图失败不能牵连主图：主图已经传完、key 也已经写进表单了，
        这里失败了最多是「小图继续用大图」，不该把整个上传报成失败。
      */
      if (isCover && compressed?.thumb) {
        try {
          await uploadRom(compressed.thumb, coverThumbKey(result.key))
        } catch (err) {
          console.warn('[cover] 缩略图上传失败，小尺寸位置会继续用主图', err)
        }
      }
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
    if (!isDeletableKey(key) || sharedBy > 1 || !canUpload) {
      const reason = !isDeletableKey(key)
        ? '这不是对象存储里的文件，只能解除绑定。'
        : sharedBy > 1
          ? `这个文件还被当前游戏的另外 ${sharedBy - 1} 个字段引用，只能解除当前绑定并保留文件。`
          : '尚未配置 Worker，无法删除对象存储里的文件，只能解除绑定。'
      if (!window.confirm(`${key}\n\n${reason}\n\n继续吗？`)) return
      onChange('')
      setMsg({ ok: true, text: '已解除绑定，原文件保留' })
      return
    }

    if (!window.confirm(`${key}\n\n从 R2 删除这个${kind === 'covers' ? '封面图片' : '视频'}并解除绑定？此操作不可恢复。`)) return
    try {
      // 封面的缩略图（96×96）是主图的附属品，一起删，别留成孤儿
      const { removed, failed } = await deleteRomObjects([key, coverThumbKey(key)].filter(Boolean))
      onChange('')
      setMsg({
        ok: failed.length === 0,
        text: failed.length ? '绑定已解除，但 R2 文件删除失败' : `已删除文件并解除绑定（${removed.length} 个对象）`,
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '删除失败' })
    }
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
            title={isDeletableKey(value) ? '从 R2 删除文件并解除绑定' : '解除绑定'}
          >
            删除
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
      {!canUpload && (
        <p className="mt-1 text-[11px] text-dim">
          直接上传需先在{' '}
          <Link to="/admin/roms" className="text-brand-hover hover:underline">
            ROM 存储
          </Link>{' '}
          页配置 Worker 地址与口令；也可以手填图片 / 视频的完整 URL。
        </p>
      )}
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
          {hack.romData ? (
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
            ⚠️ 没能确定 romset。最接近的是 <span className="font-mono">{top.name}</span>，
            但只匹配上 {top.matched}/{top.total} 个 ROM —— 包可能残缺、或者是另一个版本。
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
            文件名保持原样上传了。核心只认 romset 短名，名字不对会报 Romset is unknown —— 确认是哪个版本后，手动把上面的 key 改成 &lt;romset&gt;.zip。
          </p>
        </div>
      )}
    </div>
  )
}
