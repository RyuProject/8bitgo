import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Game, GenreId, PlatformId } from '@/types'
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
  romUrlForKey,
  uploadRom,
} from '@/services/roms'
import { bundleBytes, bundleWarnings, pickMainSwf, planSwfBundleFromZip, type SwfBundleFile, type SwfBundlePlan } from '@/lib/swfBundle'
import { listZipEntries, isZip } from '@/lib/unzip'
import { identifyArcadeRomset, type RomsetIdentification } from '@/lib/arcadeRomset'
import { platformBiosUrlSync, fetchPlatformBios } from '@/services/platformBios'
import { uploadSwfBundle, type BundleUploadProgress } from './swfUpload'
import { confirmUpload, cleanupSuperseded, deleteRomObjects, human, isDeletableKey } from './uploadGuards'
import { coreOptionsFor } from '@/config/emulators'
import { FEATURES } from '@/config/features'
import { isPlayable } from '@/emulator'
import { normalizeDevelopers } from '@/lib/developers'
import { Field, btnClass, inputClass } from './ui'
import { mergeDosboxConfigOverride, normalizeDosboxConfigOverride } from '../../shared/dosbox-config.js'

const DOSBOX_CONFIG_TEMPLATES = [
  { label: '关闭 GUS', config: '[gus]\ngus=false' },
  { label: '鼠标 1:1', config: '[sdl]\nsensitivity=100\nraw_mouse_input=true' },
  { label: 'CPU 兼容模式', config: '[cpu]\ncore=normal' },
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

const today = () => new Date().toISOString().slice(0, 10)

const EMPTY: Game = {
  slug: '',
  title: '',
  titleZh: '',
  platform: 'nes',
  genres: ['action'],
  year: 1990,
  developer: '',
  rating: 4.5,
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
    form.cover ?? '',
    form.video ?? '',
  ]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean)

  const set = <K extends keyof Game>(key: K, value: Game[K]) => setForm((f) => ({ ...f, [key]: value }))

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
      const roms = { ...(f.roms ?? {}) }
      if (key.trim()) roms[lang] = key.trim()
      else delete roms[lang]
      return { ...f, roms }
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
    if (windowsGuest && !form.dosExecutable?.trim()) {
      return setError('共享 Windows 系统模式必须填写 ZIP 内的自启动 EXE')
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
    for (const l of ROM_LANGS) {
      const v = form.roms?.[l]?.trim()
      if (v) cleanedRoms[l] = v
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
      tags: tags.length ? tags : undefined,
      // rating / ratingCount / plays 都不在表单里填：
      // plays 由后端在玩家真正开始游戏时累加，评分字段留给将来的真实评分系统。
      // 编辑时原样带回，新建时是 0。
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
            {[1, 2, 3, 4].map((n) => (
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
                Windows 3.x / 95 / 98（DOSBox-X）
              </label>
              <p className="mt-1 text-[11px] text-dim">
                数据库平台仍是 DOS。勾选后可让多款游戏共用一份 Windows 系统镜像；每款游戏的 ROM 仍上传普通 ZIP。
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
                <Field label="Windows 自启动 EXE">
                  <input
                    className={cx(inputClass, 'font-mono')}
                    value={form.dosExecutable ?? ''}
                    onChange={(e) => set('dosExecutable', e.target.value || undefined)}
                    placeholder="WINDEPTH.EXE 或 BIN/GAME.EXE"
                  />
                  <p className="mt-1 text-[11px] text-dim">
                    游戏 ZIP 内的相对路径。Windows 3.x 会先打开 EXE 所在目录再运行，请填写类似 ZEEK1.EXE、BIN/GAME.EXE 的 DOS 8.3 英文路径。
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
                </Field>
              </>
            ) : (
              <Field label="启动程序">
                <input
                  className={inputClass}
                  value={form.dosExecutable ?? ''}
                  onChange={(e) => set('dosExecutable', e.target.value || undefined)}
                  placeholder="PARANOID.COM 或 NFS/TNFS.EXE"
                />
                <p className="mt-1 text-[11px] text-dim">
                  zip 包内的相对路径。留空 = 自动猜测 —— 共享软件的包里常混着安装器（INSTALL / MAKEEVAL），猜错时填这里一锤定音
                </p>
              </Field>
            )}
          </>
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
            <p className="mt-1 text-[11px] text-dim">
              街机这一个平台底下其实是好几套硬件：拳皇是 Neo Geo（fbneo），街霸 2 是 CPS2。
              报「缺文件 / CRC 不匹配」时先换核心试试——<strong className="text-muted">每个核心认的 romset 版本不一样</strong>，
              往往比换 ROM 有用。
            </p>
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
            填数字就会出现在首页第一栏，小的排前面。只要有任意一款填了，那一栏就<strong className="text-muted">只出填了的这些</strong>，
            标题也会从「最多人玩」变成「最热门的游戏」。全部留空则退回按游玩次数自动排。
          </p>
        </Field>
      </div>

      <div className="space-y-3 rounded-xl border border-line p-3">
        <div>
          <p className="text-sm font-semibold">ROM 文件（按语言）</p>
          <p className="mt-0.5 text-xs text-muted">
            玩家会先加载站点语言对应的 ROM；没有时依次回退到 <span className="font-medium text-fg">English → 日本語 → 简体中文 → 繁體中文</span>，全部没有时提示“游戏没有当前语言版本”。
          </p>
        </div>
        {ROM_LANGS.map((lang) => (
          <RomField
            key={lang}
            lang={lang}
            label={lang === 'en' ? 'English ROM（第一回退）' : lang === 'ja' ? '日本語 ROM（第二回退）' : `${ROM_LANG_LABEL[lang]} ROM`}
            value={form.roms?.[lang] ?? ''}
            platform={form.platform}
            slug={slugify(form.slug || form.title)}
            onChange={(key) => setRomLang(lang, key)}
            allBoundKeys={allBoundKeys}
          />
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
      const result = await uploadRom(file, key, setProgress)
      onChange(result.key)
      setUploadedKeys((keys) => [result.key, ...keys.filter((item) => item !== result.key)])
      setMsg({ ok: true, text: `系统镜像已上传并绑定：${result.key}（${human(result.size)}）` })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '系统镜像上传失败' })
    } finally {
      setProgress(null)
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
  platform,
  slug,
  onChange,
  lang,
  label,
  allBoundKeys,
}: {
  value: string
  platform: PlatformId
  slug: string
  onChange: (key: string) => void
  lang?: RomLang
  label?: string
  /** 这款游戏当前绑定的全部对象 key（不去重）—— 判断旧文件是不是还被别的槽位共用 */
  allBoundKeys: string[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, setPending] = useState<PendingBundle | null>(null)
  const [bundleAt, setBundleAt] = useState<BundleUploadProgress | null>(null)
  /** 街机 ROM 的自动识别结果，上传后显示在下面 */
  const [romset, setRomset] = useState<RomsetIdentification | null>(null)
  /** 识别出来的游戏需要 BIOS，但平台还没绑 —— 就是「Neo Geo BIOS 成员缺失」那个坑 */
  const [biosMissing, setBiosMissing] = useState<string | null>(null)
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
  const isFlash = platform === 'flash'
  const isHtml5 = platform === 'html5'
  /** 街机的 ROM key 保留原文件名 —— FBNeo 靠压缩包名认 romset，见 roms.ts 的 FILENAME_IS_IDENTITY */
  const isArcade = keepsOriginalFileName(platform)
  // Flash 额外收 zip：平台的 romExtensions 保持只有 .swf —— 那个列表还管着
  // 「玩本地 ROM」和格式识别，混进 zip 会让玩家以为拖个 zip 进播放器也能玩
  const accept = isFlash ? '.swf,.zip' : (platformMap[platform]?.romExtensions ?? ['.zip']).join(',')
  const defKey = (fileName: string) => (lang ? defaultRomKeyForLang(platform, slug, lang, fileName) : defaultKeyFor(platform, slug, fileName))
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
    setBiosMissing(null)
    if (!isArcade || !/\.(zip|7z)$/i.test(file.name)) return null
    try {
      const buf = await file.arrayBuffer()
      if (!isZip(buf)) return null
      const found = await identifyArcadeRomset(listZipEntries(buf))
      if (!found) return null
      setRomset(found)
      const hit = found.confident
      if (!hit) return null

      if (hit.bios) {
        // 缓存可能还没拉过（后台刚打开就传文件），拉一次再判断
        await fetchPlatformBios()
        if (!platformBiosUrlSync(platform)) setBiosMissing(hit.bios)
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
    // 街机：先认 romset。认出来就用 romset 短名当文件名，这是核心唯一认的东西
    const sniffed = await sniffArcade(file)
    const oldKey = value.trim()
    // 字段里已有 key（且不是完整 URL）就复用它 —— 同一个槽位始终对着同一个对象，
    // 这样重传就是原地覆盖，不会又生出一份。但包目录里的 key 不能复用：
    // 那是「某个包里的一个文件」，单传一个 swf 顶上去会和包里的其它文件对不上。
    // 街机认出了 romset 就一律用它 —— 哪怕字段里已经有 key。
    // 那个旧 key 十有八九正是「文件名不对所以跑不起来」的元凶，复用它等于把错留住。
    const reusable = oldKey && !/^https?:/i.test(oldKey) && !isBundleKey(oldKey)
    const key = sniffed ? defKey(sniffed) : reusable ? oldKey : defKey(file.name)
    setMsg(null)
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setProgress(0)
    try {
      const result = await uploadRom(file, key, setProgress)
      onChange(result.key)
      const removed = await cleanupSuperseded(oldKey, result.key, allBoundKeys)
      setMsg({
        ok: true,
        text:
          `已上传到 R2：${result.key}（${human(result.size)}）` +
          (sniffed ? `；已按识别结果命名为 ${sniffed}` : '') +
          (removed ? `；旧文件 ${removed} 已删除` : ''),
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setProgress(null)
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
              ? isBundleKey(value.trim())
                ? `这一槽绑的是多 SWF 包里的 ${value.trim().split('/').pop()}；再传一个 zip 会原地更新 ${dirOfKey(value.trim())}/`
                : `再次上传会原地覆盖已绑定的 ${value.trim()}；想换存放位置就先改这里的 key 或清空`
              : isArcade
              ? `街机 ROM 会**自动识别 romset**：读包里每个文件的 CRC 比对 FBNeo 驱动表，认出来就按 romset 短名存（如 ${defKey('kof97.zip')}）。核心只认这个名字，认不出时保留原名并给出候选`
              : isFlash
                ? `单个 .swf 存成 ${defKey('x.swf')}；多 SWF 的游戏直接选 .zip，整包会传到 ${bundleDirFor(platform, slug, lang)}/ 下`
                : isHtml5
                  ? `可填写你有权嵌入的 HTTPS 游戏网址；单文件作品也可上传 .html。带 JS、WASM、图片等素材的项目请先完整部署，再填写它的 index.html 地址`
                : `上传会存到 ${defKey('x.zip')} 这样的位置（扩展名跟随所选文件）并自动绑定；也可手填已有文件的 key 或完整 URL。留空则该语言不单独提供`
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
            placeholder={isHtml5 ? 'https://game.example.com/' : defKey(isFlash ? 'x.swf' : 'x.zip')}
          />
          <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <button
            type="button"
            className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
            disabled={!canUpload || progress !== null || bundleAt !== null}
            onClick={() => inputRef.current?.click()}
            title={canUpload ? (isFlash ? '选择 .swf，或选 .zip 上传多 SWF 整包' : isHtml5 ? '上传单文件 HTML 作品' : '选择文件并上传到 R2') : '需要先配置 Worker'}
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
        {progress !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        {msg && <p className={cx('mt-2 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
        {romset && <RomsetHint found={romset} biosMissing={biosMissing} platform={platform} />}
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

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const oldKey = value.trim()
    // 同 RomField：复用已绑定的 key，避免 covers/slug.jpg 与 covers/slug.png 并存
    const key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : defaultMediaKey(kind, slug, file.name)
    setMsg(null)
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setProgress(0)
    try {
      const result = await uploadRom(file, key, setProgress)
      onChange(result.key)
      const removed = await cleanupSuperseded(oldKey, result.key, allBoundKeys)
      setMsg({ ok: true, text: `已上传：${result.key}（${human(result.size)}）${removed ? `；旧文件 ${removed} 已删除` : ''}` })
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
      const { removed, failed } = await deleteRomObjects([key])
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
  biosMissing,
  platform,
}: {
  found: RomsetIdentification
  biosMissing: string | null
  platform: PlatformId
}) {
  const top = found.candidates[0]
  const hit = found.confident
  return (
    <div className="mt-2 space-y-1 text-xs">
      {hit ? (
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
      {biosMissing && (
        <p className="text-live">
          ⚠️ 这游戏需要 <span className="font-mono">{biosMissing}</span> BIOS，但「{platform}」平台还没绑定 BIOS —— 现在直接开会报「四个 Neo Geo BIOS 成员缺失」。
          <Link to="/admin/roms" className="ml-1 text-brand-hover hover:underline">
            去绑定 →
          </Link>
        </p>
      )}
    </div>
  )
}
