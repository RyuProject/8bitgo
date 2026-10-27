import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PlatformId } from '@/types'
import { platforms } from '@/data/platforms'
import { cx } from '@/lib/format'
import { getRomApi, getRomPrefix, probeUrl, romUrlForKey, safeFileName, uploadRom } from '@/services/roms'
import { cleanupSuperseded, confirmUpload } from './uploadGuards'
import {
  bindBiosSet,
  bindPlatformBios,
  biosSetKey,
  fetchPlatformBios,
  unbindBiosSet,
  unbindPlatformBios,
  type PlatformBiosMap,
} from '@/services/platformBios'
import { biosNameOfUrl } from '@/emulator/biosPlan'
import { assertValidZipBlob } from '@/lib/unzip'
import { namcoC76BiosProblem } from '@/lib/namcoSystem11'
import { arcadeArchiveLayoutProblem } from '@/lib/arcadeArchive'
import { Card, btnClass, inputClass } from './ui'

/**
 * 平台级 BIOS 与街机 BIOS 系统包。
 *
 * 有些平台不给 BIOS 根本起不来 —— Neo Geo 最典型：拳皇、合金弹头、侍魂全都要
 * `neogeo.zip`，缺了核心直接报错，和 ROM 对不对没关系。
 *
 * ## 为什么要分成两档（2026-09-18）
 *
 * 「一份 BIOS 整个平台共用」这句话对 PS1 成立，对**街机**不成立：arcade 这一个平台
 * 底下其实是好几套硬件 —— Neo Geo 要 `neogeo.zip`，IGS 的 PGM 板子要 `pgm.zip`
 * （三国战纪、西游释厄传那一批），而引擎只吃**一个** BIOS 地址（`EJS_biosUrl`）。
 * 于是不管 arcade 那一格填哪一份，另一类游戏必然报「缺文件」。
 *
 * 所以多了一档「按系统绑」：键写成 `bios:<系统名>`，一款游戏需要哪一份由它自己的
 * `games.arcade_bios` 说了算（自动识别填，管理员可以手工改）。
 *
 * ⚠️ 平台级那一格**留着不动**：它现在是「这个平台默认给哪份」，也是老数据（还没填
 * arcade_bios 的游戏）唯一的 BIOS 来源。删了它，所有 Neo Geo 游戏当天全部起不来。
 */
const NEED_BIOS: Array<{ id: PlatformId; hint: string }> = [
  { id: 'psx', hint: '旧版 / PCSX 平台级回退 BIOS。Beetle PSX 会优先使用下方对应区域 BIOS；日版通常需要 scph5500.bin，单独 scph1001.bin 不能替代。' },
  { id: 'segaCD', hint: '必须提供对应区域的 Mega CD / Sega CD BIOS；多区域可打包成 ZIP，文件放在根目录' },
  { id: 'pce', hint: 'HuCard 不需要；运行 PC Engine CD 游戏时需要 System Card 3（syscard3.pce）' },
  { id: 'atari5200', hint: '多数游戏需要 Atari 5200 BIOS（常见文件名 5200.rom）' },
  { id: 'lynx', hint: 'Handy 核心通常需要 lynxboot.img；若使用无 BIOS 启动的 homebrew 可留空' },
  { id: 'amiga', hint: '需要与机型匹配的 Kickstart ROM；多版本可打包成 ZIP，文件放在根目录' },
]

type BiosSection = 'platform' | 'psx' | 'arcade'

const BIOS_SECTIONS: Array<{ id: BiosSection; label: string; description: string }> = [
  { id: 'platform', label: '平台默认', description: '一份 BIOS 供同平台的游戏共用' },
  { id: 'psx', label: 'PS1 区域', description: '按日、美、欧版游戏自动选择' },
  { id: 'arcade', label: '街机板卡', description: '按 Neo Geo、PGM 等硬件系统选择' },
]

/**
 * 常见的街机 BIOS 系统包。列出来的是**真有人玩**的那几个：
 * romset 索引里 682 个游戏指向 neogeo、173 个指向 pgm，其余 16 种系统加起来不到 300 个。
 *
 * 其它系统（`skns`、`decocass`、`cchip`…）用下面那个「添加其它系统」的输入框加 ——
 * 18 种全列出来，只会让真正要填的那两行淹在噪声里。
 */
const ARCADE_BIOS_SETS: Array<{ name: string; hint: string }> = [
  {
    name: 'neogeo',
    hint: 'Neo Geo 全系（拳皇 / 合金弹头 / 侍魂 / 月华剑士）。文件必须是 neogeo.zip',
  },
  {
    name: 'pgm',
    hint: 'IGS PGM 板子：三国战纪（orlegend / kov）、西游释厄传（drgw2）等 173 款。文件必须是 pgm.zip',
  },
  {
    name: 'namcoc76',
    hint: 'Namco System 11（如 Tekken）；上传前会校验 ZIP 根目录中的 c76.bin（16 KiB / CRC 399faac7），对象会固定保存为 namcoc76.zip。',
  },
]

function arcadeBiosFileNameForBinding(id: string): string | undefined {
  const name = id.startsWith('bios:') ? id.slice('bios:'.length) : ''
  return ARCADE_BIOS_SETS.some((set) => set.name === name) ? `${name}.zip` : undefined
}

/** Beetle PSX 按地区寻找固定文件名；上传文件原名可以不同，存储 key 不能变。 */
const PSX_BIOS_REGIONS: Array<{ name: string; label: string; fileName: string; hint: string }> = [
  { name: 'psx-jp', label: '日本版 BIOS', fileName: 'scph5500.bin', hint: 'NTSC-J：核心要求 scph5500.bin；SLPS / SLPM / SCPS 等编号会自动选用。' },
  { name: 'psx-us', label: '美版 BIOS', fileName: 'scph5501.bin', hint: 'NTSC-U：核心要求 scph5501.bin；SLUS / SCUS 等编号会自动选用。' },
  { name: 'psx-eu', label: '欧版 BIOS', fileName: 'scph5502.bin', hint: 'PAL：核心要求 scph5502.bin；SLES / SCES 等编号会自动选用。' },
]

function psxBiosFileNameForBinding(id: string): string | undefined {
  return PSX_BIOS_REGIONS.find((region) => biosSetKey(region.name) === id)?.fileName
}

function keyFileName(value: string): string {
  const raw = value.split(/[?#]/, 1)[0].split('/').pop() ?? ''
  try {
    return decodeURIComponent(raw).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/**
 * BIOS 在对象存储里的默认位置：<前缀>/bios/<原文件名>
 *
 * ⚠️ 这里**必须保留原文件名**，不能像以前那样用 <平台>.zip。
 *
 * 模拟器核心是按**固定文件名**找 BIOS 的：FBNeo 找 `neogeo.zip`、`pgm.zip`，PS1 的 Beetle
 * 按游戏区域找 `scph5500.bin` / `scph5501.bin` / `scph5502.bin`。播放器把 BIOS 的 URL 原样交给核心（EJS_biosUrl），
 * 核心看到的文件名就是 URL 最后那一段 —— 存成 `bios/arcade.zip` 的话，
 * 文件明明在，核心却报「sp-s3.sp1 / sm1.sm1 / sfix.sfix / 000-lo.lo is missing」，
 * 因为它要的 neogeo.zip 根本不存在。这个坑踩过，别再改回去。
 */
function defaultBiosKey(_platform: string, fileName: string): string {
  const prefix = getRomPrefix()
  return `${prefix ? `${prefix}/` : ''}bios/${safeFileName(fileName)}`
}

/** 一行 BIOS 绑定：key 输入 + 上传 + 探活 + 打开 / 解绑。平台级和系统级共用同一套 UI */
function BiosRow({
  title,
  hint,
  value,
  placeholder,
  busy,
  pct,
  probe,
  onBind,
  onUpload,
  onUnbind,
  registerFileInput,
  onPickFile,
  coveredBy,
}: {
  title: ReactNode
  hint: string
  /** 已绑定的对象 key；空串 = 未绑定 */
  value: string
  placeholder: string
  busy: boolean
  pct: number
  probe?: 'checking' | 'ok' | 'missing'
  onBind: (key: string) => void
  onUpload: (file: File) => void
  onUnbind: () => void
  registerFileInput: (el: HTMLInputElement | null) => void
  /** 点「上传文件」时去戳本行那个隐藏 input（ref 存在父层，按 id 取） */
  onPickFile: () => void
  /**
   * 未绑定时的一句说明：这份 BIOS 由**别处**提供（平台级那份的文件名正好就是它）。
   * 有它就说明「未绑定」是假警报，见下面徽标那一段。
   */
  coveredBy?: string
}) {
  const status = value
    ? probe === 'missing'
      ? { label: '地址异常', className: 'bg-live/15 text-live' }
      : probe === 'checking'
        ? { label: '检查中', className: 'bg-surface-2 text-muted' }
        : { label: '已就绪', className: 'bg-online/15 text-online' }
    : coveredBy
      ? { label: '由默认项提供', className: 'bg-online/15 text-online' }
      : { label: '待配置', className: 'bg-surface-2 text-dim' }

  return (
    <article className="rounded-xl border border-line bg-surface-2/35 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {title}
            <span className={cx('rounded px-1.5 py-0.5 text-xs', status.className)}>{status.label}</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-dim">{hint}</p>
          {!value && coveredBy && <p className="mt-1 text-[11px] leading-relaxed text-online">{coveredBy}</p>}
        </div>
        {value && (
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <a className="text-brand-hover hover:underline" href={romUrlForKey(value)} target="_blank" rel="noreferrer">
              打开
            </a>
            <button type="button" className="text-live hover:underline" onClick={onUnbind}>
              解绑
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          /*
            key 绑在已绑定的 key 上：输入框是非受控的（defaultValue），绑定成功后
            组件重渲染并不会把新值写回输入框 —— 上传完这里还显示上传前的旧文本，
            看着像"没生效"。换 key 强制重建这一个 input 就对了。
          */
          key={value}
          className={cx(inputClass, 'min-w-0 flex-1')}
          aria-label="BIOS 对象 key 或项目路径"
          placeholder={placeholder}
          defaultValue={value}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v && v !== value) onBind(v)
          }}
        />
        <input
          ref={registerFileInput}
          type="file"
          accept=".zip,.bin,.rom,.img,.pce"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onUpload(f)
          }}
        />
        <button type="button" className={btnClass.secondary} disabled={busy || !getRomApi()} onClick={onPickFile}>
          {busy ? `上传中 ${pct}%` : '上传文件'}
        </button>
      </div>

      {/*
        填了 key 却拼不出地址是个哑巴陷阱：播放器只会悄悄不传 BIOS，
        游戏最后报的是「缺文件」，让人以为是 ROM 的问题，
        实际上是 ROM 存储的公开地址没配。这里必须说破。
      */}
      {value && probe === 'missing' && romUrlForKey(value) && (
        <p className="mt-1 text-[11px] font-medium text-live">
          ⚠️ 这个地址取不到文件（404 或不可达）。绑定只是存了个字符串，文件没传上去照样是空的 ——
          点「上传文件」把 BIOS 传到这个 key 上，或者把 key 改成文件真正所在的位置。
        </p>
      )}
      {value && probe === 'ok' && <p className="mt-2 text-[11px] text-online">✓ 文件可访问</p>}

      {value &&
        (romUrlForKey(value) ? (
          <details className="mt-2 text-[11px] text-dim">
            <summary className="cursor-pointer select-none hover:text-muted">查看实际地址</summary>
            <p className="mt-1 break-all">{romUrlForKey(value)}</p>
          </details>
        ) : (
          <p className="mt-1 text-[11px] text-live">
            这个 key 拼不出可访问地址（「ROM 存储」里的公开访问地址还没填）。
            现在启动游戏不会带上 BIOS，Neo Geo 会报「缺文件」——但真正的原因在这儿。
          </p>
        ))}
    </article>
  )
}

export function PlatformBiosPanel() {
  const [map, setMap] = useState<PlatformBiosMap>({})
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState<BiosSection>('platform')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pct, setPct] = useState<Record<string, number>>({})
  /** 管理员手工加进列表的其它系统名（见 ARCADE_BIOS_SETS 的说明） */
  const [extraSets, setExtraSets] = useState<string[]>([])
  const [newSet, setNewSet] = useState('')
  /**
   * 每个已绑 key 的「文件到底在不在」。
   *
   * 绑定只是存了一个字符串，后台从来不验证那个地址上真有东西 —— 于是「填了但文件 404」
   * 这种状态可以一直躺着，直到玩家启动游戏才以「缺 BIOS 文件」的面目冒出来，
   * 而那个报错看上去像是 ROM 的问题。这里当场探一下，把哑巴陷阱变成明说。
   */
  const [probe, setProbe] = useState<Record<string, 'checking' | 'ok' | 'missing'>>({})
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    let alive = true
    void fetchPlatformBios(true).then((m) => {
      if (!alive) return
      setMap(m)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  /** 探一个绑定的地址通不通；拼不出地址就不用探了 */
  const checkKey = useCallback(async (id: string, key: string) => {
    const url = key ? romUrlForKey(key) : ''
    if (!url) {
      setProbe((s) => ({ ...s, [id]: 'missing' }))
      return
    }
    setProbe((s) => ({ ...s, [id]: 'checking' }))
    const ok = await probeUrl(url)
    setProbe((s) => ({ ...s, [id]: ok ? 'ok' : 'missing' }))
  }, [])

  useEffect(() => {
    for (const [id, key] of Object.entries(map)) {
      if (key) void checkKey(id, key)
    }
  }, [map, checkKey])

  /**
   * 上传并绑定。`id` 是平台 id 或 `bios:<系统名>` —— 两条路的落库方式不同，
   * 其余（复用旧 key、文件名对不上要问一句、传完删旧文件）完全一样。
   */
  async function upload(id: string, file: File) {
    setBusy(id)
    setMsg(null)
    try {
      if (id === 'bios:namcoc76') {
        const entries = await assertValidZipBlob(file, 'Namco C76 BIOS')
        const problem = namcoC76BiosProblem(entries)
        if (problem) throw new Error(problem)
      } else if ((id === 'arcade' || id.startsWith('bios:')) && /\.zip$/i.test(file.name)) {
        /*
          其它街机 BIOS 包（neogeo / pgm …）以前不做任何检查：成员套一层目录的 neogeo.zip 能传上去，
          之后**每一款** Neo Geo 游戏都报 sp-s3.sp1 缺失 —— 核心只读 ZIP 根目录。
        */
        const entries = await assertValidZipBlob(file, '街机 BIOS')
        const problem = arcadeArchiveLayoutProblem(entries)
        if (problem) throw new Error(problem)
      }
      // 已经绑过 BIOS 就复用同一个 key —— 原来无条件按文件名重算，
      // 传完 bios.bin 再传 bios.zip 会在 R2 里留下两份，旧的那份永远没人引用
      const oldKey = (map as Record<string, string | undefined>)[id]?.trim() ?? ''
      const requiredFileName = psxBiosFileNameForBinding(id) ?? arcadeBiosFileNameForBinding(id)
      const suggested = defaultBiosKey(id, requiredFileName ?? file.name)
      const oldKeyHasExpectedName = !requiredFileName || keyFileName(oldKey) === requiredFileName
      let key = oldKey && !/^https?:/i.test(oldKey) && oldKeyHasExpectedName ? oldKey : suggested
      /**
       * 沿用旧 key 有个前提：旧 key 的文件名得是对的。
       *
       * 核心是按**固定文件名**找 BIOS 的，所以一个错的旧 key（比如历史遗留的
       * bios/arcade.zip）会一直粘着不放 —— 你重传多少次，文件还是落在错的名字上，
       * 传上去也用不了。名字对不上就问一句，别默默沿用。
       */
      const expectedName = requiredFileName ?? safeFileName(file.name)
      if (oldKey && key !== suggested && keyFileName(oldKey) !== expectedName.toLowerCase()) {
        const move = window.confirm(
          `当前绑定的是：\n  ${oldKey}\n你上传的文件叫：\n  ${file.name}\n\n` +
            `模拟器核心需要固定文件名 ${expectedName}，沿用旧位置的话 BIOS 可能无法识别。\n\n` +
            `确定 = 改传到 ${suggested}（传完会问要不要删旧文件）\n取消 = 仍然覆盖 ${oldKey}`,
        )
        if (move) key = suggested
      }
      if (!(await confirmUpload(key, file))) return
      await uploadRom(file, key, (p) => setPct((s) => ({ ...s, [id]: p })))
      await bind(id, key)
      // 同一份 BIOS 可能被多个平台 / 系统共用，所以把整张表传进去判断
      const removed = await cleanupSuperseded(oldKey, key, Object.values(map).filter(Boolean) as string[])
      void checkKey(id, key)
      setMsg({ ok: true, text: `已上传并绑定：${key}${removed ? `；旧文件 ${removed} 已删除` : ''}` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '上传失败' })
    } finally {
      setBusy(null)
      setPct((s) => ({ ...s, [id]: 0 }))
    }
  }

  /** 按 id 分派到对应的绑定接口 */
  async function bind(id: string, key: string) {
    if (id.startsWith('bios:')) await bindBiosSet(id.slice('bios:'.length), key)
    else await bindPlatformBios(id as PlatformId, key)
    setMap((m) => ({ ...m, [id]: key }))
  }

  async function bindManual(id: string, key: string) {
    setBusy(id)
    setMsg(null)
    try {
      const requiredFileName = psxBiosFileNameForBinding(id) ?? arcadeBiosFileNameForBinding(id)
      if (key.trim() && requiredFileName && keyFileName(key.trim()) !== requiredFileName) {
        const reason = id.startsWith('bios:') ? '街机核心按 BIOS set 文件名查找它' : 'Beetle PSX 按区域查找它'
        throw new Error(`这个 BIOS 的地址末尾必须是 ${requiredFileName}，否则${reason}。`)
      }
      await bind(id, key.trim())
      void checkKey(id, key.trim())
      setMsg({ ok: true, text: '已绑定' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '绑定失败' })
    } finally {
      setBusy(null)
    }
  }

  async function unbind(id: string) {
    setBusy(id)
    setMsg(null)
    try {
      if (id.startsWith('bios:')) await unbindBiosSet(id.slice('bios:'.length))
      else await unbindPlatformBios(id as PlatformId)
      setMap((m) => {
        const next = { ...m }
        delete next[id as PlatformId]
        return next
      })
      setMsg({ ok: true, text: '已解绑（文件仍留在存储里）' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '解绑失败' })
    } finally {
      setBusy(null)
    }
  }

  const rowProps = (id: string) => ({
    value: (map as Record<string, string | undefined>)[id] ?? '',
    busy: busy === id,
    pct: pct[id] ?? 0,
    probe: probe[id],
    onBind: (key: string) => void bindManual(id, key),
    onUpload: (file: File) => void upload(id, file),
    onUnbind: () => void unbind(id),
    registerFileInput: (el: HTMLInputElement | null) => {
      fileRefs.current[id] = el
    },
    onPickFile: () => fileRefs.current[id]?.click(),
  })

  const platformRows = NEED_BIOS.map((n) => ({
    ...n,
    platform: platforms.find((p) => p.id === n.id),
  })).filter((r) => r.platform)

  /**
   * 街机 BIOS 系统包那一列：预置的两个 + 管理员手工加过的 + **已经绑过 key 的**。
   * 最后一项很重要：手工加进来又绑好的系统，下次打开这一页不能消失。
   */
  const boundSets = Object.keys(map)
    .filter((k) => k.startsWith('bios:'))
    .map((k) => k.slice('bios:'.length))
    .filter((name) => !PSX_BIOS_REGIONS.some((region) => region.name === name))
  const setNames = Array.from(
    new Set([...ARCADE_BIOS_SETS.map((s) => s.name), ...extraSets, ...boundSets]),
  )
  /**
   * 平台级那份 BIOS 的文件名对应的是哪个系统名（`roms/bios/neogeo.zip` → `neogeo`）。
   *
   * 引擎只有一个 BIOS 槽位（EJS_biosUrl）：平台那格填的**正好是**某个系统包时，
   * 播放器不会再单独下那一份（见 emulator/biosPlan.ts 的那条判断）。所以那一行不该
   * 红着「未绑定」吓人 —— 用户看到的现象就是「neogeo 怎么在两张卡里各出现一次」，
   * 然后去绑一份一模一样的。这里按同一条规则标成「平台 BIOS 已提供」。
   *
   * 仍然可以绑（系统级优先），只是不再伪装成「缺东西」。
   */
  const coveredSet = biosNameOfUrl(map.arcade)
  const bindingIds = [
    ...platformRows.map((row) => row.id),
    ...PSX_BIOS_REGIONS.map((region) => biosSetKey(region.name)),
    'arcade',
    ...setNames.map((name) => biosSetKey(name)),
  ]
  const boundCount = bindingIds.filter((id) => Boolean((map as Record<string, string | undefined>)[id])).length
  const failedCount = bindingIds.filter((id) => probe[id] === 'missing').length

  return (
    <>
      <Card
        title="模拟器 BIOS"
        extra={
          loading ? (
            <span className="text-xs text-muted">正在读取…</span>
          ) : (
            <span className={cx('text-xs', failedCount ? 'text-live' : 'text-online')}>
              {failedCount ? `${failedCount} 项地址异常` : `${boundCount} 项已配置`}
            </span>
          )
        }
      >
        <p className="text-xs leading-relaxed text-muted">
          只需绑定模拟器实际需要的文件；上传会保留核心识别所需的文件名。平台默认、PS1 区域和街机板卡分别管理，避免同一份 BIOS 重复绑定。
          {!getRomApi() && <span className="ml-1 text-live">（未配置 Worker，只能手填路径或对象 key）</span>}
        </p>

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="BIOS 分类">
          {BIOS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              className={cx(
                'rounded-lg px-3 py-2 text-left text-xs transition',
                section === item.id ? 'bg-brand text-white shadow-sm' : 'bg-surface-2 text-muted hover:text-fg',
              )}
              onClick={() => setSection(item.id)}
            >
              <span className="block font-semibold">{item.label}</span>
              <span className={cx('mt-0.5 block text-[11px]', section === item.id ? 'text-white/80' : 'text-dim')}>{item.description}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <p className="mt-5 text-sm text-muted">正在读取 BIOS 绑定…</p>
        ) : (
          <div className="mt-4 space-y-3" role="tabpanel">
            {section === 'platform' && (
              <>
                <p className="text-[11px] leading-relaxed text-dim">
                  一个绑定供该平台全部游戏使用。文件可放进 <code className="rounded bg-surface-2 px-1">public/bios/</code>，也可以上传到对象存储；后者不需要跟着每次部署复制。
                </p>
                {platformRows.map((r) => (
                  <BiosRow
                    key={r.id}
                    title={
                      <>
                        <span className="text-base" aria-hidden>{r.platform!.icon}</span>
                        <span className="font-semibold">{r.platform!.nameZh}</span>
                      </>
                    }
                    hint={r.hint}
                    placeholder="/bios/文件名 或对象存储 key"
                    {...rowProps(r.id)}
                  />
                ))}
              </>
            )}

            {section === 'psx' && (
              <>
                <p className="text-[11px] leading-relaxed text-dim">
                  优先配置日、美、欧三份 BIOS；播放器会按光盘地区自动选择。日版文件必须保留为 <code className="rounded bg-surface-2 px-1">scph5500.bin</code>。无法识别地区或对应文件缺失时，才会回退到“平台默认”里的 PS1 BIOS。多区域 ZIP 也可以，内部文件必须放在压缩包根目录并保留标准文件名。
                </p>
                {PSX_BIOS_REGIONS.map((region) => (
                  <BiosRow
                    key={region.name}
                    title={<span className="font-semibold">{region.label}</span>}
                    hint={region.hint}
                    placeholder={`roms/bios/${region.fileName}`}
                    {...rowProps(biosSetKey(region.name))}
                  />
                ))}
              </>
            )}

            {section === 'arcade' && (
              <>
                <p className="text-[11px] leading-relaxed text-dim">
                  每款街机 ROM 会标注自己需要的硬件系统；请按系统各绑一份，而不是把 PGM、Neo Geo、Namco C76 等都塞到“街机平台默认”里。系统名和 ZIP 文件名必须与核心使用的 romset 一致。
                </p>
                {setNames.map((name) => (
                  <BiosRow
                    key={name}
                    title={
                      <>
                        <span className="text-base" aria-hidden>🎛️</span>
                        <span className="font-mono font-semibold">{name}</span>
                      </>
                    }
                    hint={ARCADE_BIOS_SETS.find((s) => s.name === name)?.hint ?? `系统包 ${name}（手工添加）`}
                    placeholder={`bios/${name}.zip 或对象存储 key`}
                    coveredBy={
                      name === coveredSet
                        ? `旧条目的默认 BIOS 已指向 ${map.arcade}；这份系统包已可用，无需重复绑定。单独绑定后会优先使用系统级文件。`
                        : undefined
                    }
                    {...rowProps(biosSetKey(name))}
                  />
                ))}

                <details className="rounded-xl border border-line p-3">
                  <summary className="cursor-pointer text-sm font-medium hover:text-brand-hover">添加其它街机 BIOS 系统</summary>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className={cx(inputClass, 'max-w-[12rem] font-mono')}
                      placeholder="系统名，如 skns"
                      value={newSet}
                      onChange={(e) => setNewSet(e.target.value)}
                    />
                    <button
                      type="button"
                      className={btnClass.secondary}
                      disabled={!/^[a-z0-9_]{1,32}$/.test(newSet.trim().toLowerCase())}
                      onClick={() => {
                        const name = newSet.trim().toLowerCase()
                        setExtraSets((s) => (s.includes(name) ? s : [...s, name]))
                        setNewSet('')
                      }}
                    >
                      添加系统
                    </button>
                    <span className="text-[11px] text-dim">只接受小写字母、数字和下划线。</span>
                  </div>
                </details>

                <details className="rounded-xl border border-line p-3">
                  <summary className="cursor-pointer text-sm font-medium hover:text-brand-hover">旧街机条目的默认 BIOS（兼容用）</summary>
                  <p className="mt-2 text-[11px] leading-relaxed text-dim">
                    仅供还没有填写“BIOS 包”字段的历史游戏回退使用。新游戏请在上方按系统绑定；不要把不同硬件的 BIOS 混在这里。
                  </p>
                  <div className="mt-3">
                    <BiosRow
                      title={<span className="font-semibold">街机默认 BIOS</span>}
                      hint="通常是 neogeo.zip；只影响未标注硬件系统的历史街机条目。"
                      placeholder="bios/neogeo.zip 或对象存储 key"
                      {...rowProps('arcade')}
                    />
                  </div>
                </details>
              </>
            )}
          </div>
        )}
      </Card>

      {msg && <p className={cx('mt-3 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
    </>
  )
}
