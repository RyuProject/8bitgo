import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Game, GenreId, PlatformId } from '@/types'
import { ROM_LANGS, ROM_LANG_LABEL, type RomLang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { genres } from '@/data/genres'
import { cx } from '@/lib/format'
import {
  defaultKeyFor,
  defaultMediaKey,
  defaultRomKeyForLang,
  getRomConfig,
  romUrlForKey,
  uploadRom,
} from '@/services/roms'
import { confirmUpload, cleanupSuperseded, human } from './uploadGuards'
import { coreOptionsFor } from '@/config/emulators'
import { FEATURES } from '@/config/features'
import { isPlayable } from '@/emulator'
import { Field, btnClass, inputClass } from './ui'

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
      developer: form.developer.trim() || '未知',
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
        <Field label="开发商">
          <input className={inputClass} value={form.developer} onChange={(e) => set('developer', e.target.value)} placeholder="Nintendo" />
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
            标题也会从「最多人玩」变成「编辑精选」。全部留空则退回按游玩次数自动排。
          </p>
        </Field>
      </div>

      <div className="space-y-3 rounded-xl border border-line p-3">
        <div>
          <p className="text-sm font-semibold">ROM 文件（按语言）</p>
          <p className="mt-0.5 text-xs text-muted">
            玩家会按站点语言自动加载对应语言的 ROM；该语言没有专属 ROM 时回退到 <span className="font-medium text-fg">English ROM</span>（英语即通用 / 回退 ROM）。
          </p>
        </div>
        {ROM_LANGS.map((lang) => (
          <RomField
            key={lang}
            lang={lang}
            label={lang === 'en' ? 'English ROM（通用 / 回退）' : `${ROM_LANG_LABEL[lang]} ROM`}
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
          hint="4:3 横版最佳；留空用程序生成的渐变封面。可上传或手填 key / URL"
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
 * ROM 字段：可手填 key，也可以选文件直接上传到 R2（通过 Worker），成功后自动填入 key。
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
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
  const accept = (platformMap[platform]?.romExtensions ?? ['.zip']).join(',')
  const defKey = (fileName: string) => (lang ? defaultRomKeyForLang(platform, slug, lang, fileName) : defaultKeyFor(platform, slug, fileName))

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const oldKey = value.trim()
    // 字段里已有 key（且不是完整 URL）就复用它 —— 同一个槽位始终对着同一个对象，
    // 这样重传就是原地覆盖，不会又生出一份
    const key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : defKey(file.name)
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
        text: `已上传到 R2：${result.key}（${human(result.size)}）${removed ? `；旧文件 ${removed} 已删除` : ''}`,
      })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '上传失败' })
    } finally {
      setProgress(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Field
      label={label ?? 'ROM 文件'}
      hint={
        canUpload
          ? value.trim() && !/^https?:/i.test(value)
            ? `再次上传会原地覆盖已绑定的 ${value.trim()}；想换存放位置就先改这里的 key 或清空`
            : `上传会存到 ${defKey('x.zip')} 这样的位置（扩展名跟随所选文件）并自动绑定；也可手填已有文件的 key 或完整 URL。留空则该语言不单独提供`
          : '手填对象 key 或完整 URL；要直接上传，请先在「ROM 存储」页配置 Worker 地址与口令'
      }
    >
      <div className="flex gap-2">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defKey('x.zip')}
        />
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!canUpload || progress !== null}
          onClick={() => inputRef.current?.click()}
          title={canUpload ? '选择文件并上传到 R2' : '需要先配置 Worker'}
        >
          {progress === null ? '☁️ 上传到 R2' : `上传中 ${progress}%`}
        </button>
        {value && !progress && (
          <a href={romUrlForKey(value)} target="_blank" rel="noreferrer" className={cx(btnClass.secondary, 'shrink-0')} title="在新标签页打开文件地址">
            打开
          </a>
        )}
      </div>
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {msg && <p className={cx('mt-2 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
      {!canUpload && (
        <p className="mt-1 text-[11px] text-dim">
          <Link to="/admin/roms" className="text-brand-hover hover:underline">
            去配置 Worker →
          </Link>
        </p>
      )}
    </Field>
  )
}


/**
 * 封面图 / 视频字段：可手填 key/URL，也可选文件上传到 R2（通过 Worker），成功后自动填入 key，并显示 4:3 预览。
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
      </div>
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {previewUrl && (
        <div className="mt-2 aspect-[4/3] w-40 overflow-hidden rounded-lg border border-line bg-black">
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
