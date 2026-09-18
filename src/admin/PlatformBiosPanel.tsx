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
  { id: 'arcade', hint: 'Neo Geo 系（拳皇 / 合金弹头 / 侍魂）必须要 neogeo.zip；CPS 系不需要' },
  { id: 'psx', hint: '多数核心可以不用 BIOS，但用真 BIOS 兼容性更好' },
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
]

/**
 * BIOS 在对象存储里的默认位置：<前缀>/bios/<原文件名>
 *
 * ⚠️ 这里**必须保留原文件名**，不能像以前那样用 <平台>.zip。
 *
 * 模拟器核心是按**固定文件名**找 BIOS 的：FBNeo 找 `neogeo.zip`、`pgm.zip`，PS1 核心找
 * `scph5501.bin`。而播放器把 BIOS 的 URL 原样交给核心（EJS_biosUrl），
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
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        {title}
        {value ? (
          <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">已绑定</span>
        ) : coveredBy ? (
          /*
            「平台 BIOS 已提供」而不是红的「未绑定」：引擎只有一个 BIOS 槽位
            （EJS_biosUrl），平台那格填的**正好就是**这份系统包时，播放器压根不会再下一遍
            （见 emulator/biosPlan.ts 里那条判断）。标红只会让人以为缺东西、跑去绑一份
            一模一样的 —— 那正是「neogeo 在两张卡里各出现一次」的来源。
          */
          <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">平台 BIOS 已提供</span>
        ) : (
          <span className="rounded bg-live/15 px-1.5 py-0.5 text-xs text-live">未绑定</span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-dim">{hint}</p>
      {!value && coveredBy && <p className="mt-1 text-[11px] leading-relaxed text-online">{coveredBy}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          /*
            key 绑在已绑定的 key 上：输入框是非受控的（defaultValue），绑定成功后
            组件重渲染并不会把新值写回输入框 —— 上传完这里还显示上传前的旧文本，
            看着像"没生效"。换 key 强制重建这一个 input 就对了。
          */
          key={value}
          className={cx(inputClass, 'min-w-0 flex-1')}
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
          accept=".zip,.bin,.rom"
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
        {value && (
          <>
            <a
              className="text-xs text-brand-hover hover:underline"
              href={romUrlForKey(value)}
              target="_blank"
              rel="noreferrer"
            >
              打开
            </a>
            <button type="button" className="text-xs text-live hover:underline" onClick={onUnbind}>
              解绑
            </button>
          </>
        )}
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
      {value && probe === 'ok' && <p className="mt-1 text-[11px] text-online">✓ 文件可访问</p>}

      {value &&
        (romUrlForKey(value) ? (
          <p className="mt-1 truncate text-[11px] text-dim">实际地址：{romUrlForKey(value)}</p>
        ) : (
          <p className="mt-1 text-[11px] text-live">
            这个 key 拼不出可访问地址（「ROM 存储」里的公开访问地址还没填）。
            现在启动游戏不会带上 BIOS，Neo Geo 会报「缺文件」——但真正的原因在这儿。
          </p>
        ))}
    </div>
  )
}

export function PlatformBiosPanel() {
  const [map, setMap] = useState<PlatformBiosMap>({})
  const [loading, setLoading] = useState(true)
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
      // 已经绑过 BIOS 就复用同一个 key —— 原来无条件按文件名重算，
      // 传完 bios.bin 再传 bios.zip 会在 R2 里留下两份，旧的那份永远没人引用
      const oldKey = (map[id as PlatformId] ?? '').trim()
      const suggested = defaultBiosKey(id, file.name)
      let key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : suggested
      /**
       * 沿用旧 key 有个前提：旧 key 的文件名得是对的。
       *
       * 核心是按**固定文件名**找 BIOS 的，所以一个错的旧 key（比如历史遗留的
       * bios/arcade.zip）会一直粘着不放 —— 你重传多少次，文件还是落在错的名字上，
       * 传上去也用不了。名字对不上就问一句，别默默沿用。
       */
      const oldName = oldKey.split('/').pop() ?? ''
      if (oldKey && key !== suggested && oldName !== safeFileName(file.name)) {
        const move = window.confirm(
          `当前绑定的是：\n  ${oldKey}\n你上传的文件叫：\n  ${file.name}\n\n` +
            `模拟器核心是按文件名找 BIOS 的，沿用旧位置的话文件传上去也用不了。\n\n` +
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
    value: map[id as PlatformId] ?? '',
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

  return (
    <>
      <Card title="平台 BIOS">
        <p className="text-xs leading-relaxed text-muted">
          有些平台不给 BIOS 就起不来，这跟 ROM 对不对无关。传一次，该平台所有游戏共用。
          {!getRomApi() && <span className="ml-1 text-live">（尚未配置 Worker 地址，只能手填路径 / key）</span>}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-dim">
          两种放法都行：<strong className="text-muted">放进项目</strong>（文件丢进{' '}
          <code className="rounded bg-surface-2 px-1">public/bios/</code>，这里填{' '}
          <code className="rounded bg-surface-2 px-1">/bios/neogeo.zip</code>，改完要重新构建），
          或<strong className="text-muted">上传到对象存储</strong>（点下面的按钮，填的是对象 key）。
          前者简单，但构建机上必须也有这个文件；后者只存一份，部署时不用管。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-live">
          ⚠️ 不管哪种放法，<strong>地址最后一段必须是核心要找的那个文件名</strong>：街机是{' '}
          <code className="rounded bg-surface-2 px-1">neogeo.zip</code>，PS1 是{' '}
          <code className="rounded bg-surface-2 px-1">scph5501.bin</code>。核心按固定文件名找 BIOS，
          存成 <code className="rounded bg-surface-2 px-1">bios/arcade.zip</code> 的话文件明明在，
          核心却会报「sp-s3.sp1 … is missing」。上传时会自动保留原文件名，别手动改成别的。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-dim">
          街机上还有一类<strong className="text-muted">不在这张卡里填</strong>：同一个平台底下的
          <strong className="text-muted">另一套硬件</strong> —— IGS 的 PGM 板子（三国战纪 / 西游释厄传那一批）
          要的是 <code className="rounded bg-surface-2 px-1">pgm.zip</code>，而这张卡一个平台只存一份。
          那些按<strong className="text-muted">系统名</strong>绑在下面的「街机 BIOS 包（按系统）」里，
          这里留 neogeo 那份就行。
        </p>

        {loading ? (
          <p className="mt-3 text-sm text-muted">正在读取…</p>
        ) : (
          <div className="mt-3 space-y-3">
            {platformRows.map((r) => (
              <BiosRow
                key={r.id}
                title={
                  <>
                    <span className="text-base" aria-hidden>
                      {r.platform!.icon}
                    </span>
                    <span className="font-semibold">{r.platform!.nameZh}</span>
                  </>
                }
                hint={r.hint}
                placeholder="/bios/neogeo.zip 或对象存储 key"
                {...rowProps(r.id)}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title="街机 BIOS 包（按系统）">
        <p className="text-xs leading-relaxed text-muted">
          街机这一个平台底下其实是好几套硬件，而引擎只吃一个 BIOS 地址 —— 平台那一格填了{' '}
          <code className="rounded bg-surface-2 px-1">neogeo.zip</code>，
          IGS 的 PGM 板子（三国战纪、西游释厄传）就永远起不来。
          这里按<strong>系统名</strong>各绑一份：游戏需要哪一份由它自己的「BIOS 包」字段说了算
          （上传 ROM 时自动识别填好，后台也可以手工改，识别不出来的自己填）。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-dim">
          ⚠️ 系统名必须是核心要找的那个 set 名，文件也必须叫那个名字：Neo Geo 是{' '}
          <code className="rounded bg-surface-2 px-1">neogeo</code> /{' '}
          <code className="rounded bg-surface-2 px-1">neogeo.zip</code>，
          PGM 是 <code className="rounded bg-surface-2 px-1">pgm</code> /{' '}
          <code className="rounded bg-surface-2 px-1">pgm.zip</code>。
          从别处（MAME 之类）随便拿一份 pgm 的 BIOS 包常常会因为 CRC 对不上而报缺文件 ——
          要和核心同一批的 romset。
        </p>

        {loading ? (
          <p className="mt-3 text-sm text-muted">正在读取…</p>
        ) : (
          <div className="mt-3 space-y-3">
            {setNames.map((name) => (
              <BiosRow
                key={name}
                title={
                  <>
                    <span className="text-base" aria-hidden>
                      🎛️
                    </span>
                    <span className="font-mono font-semibold">{name}</span>
                  </>
                }
                hint={ARCADE_BIOS_SETS.find((s) => s.name === name)?.hint ?? `系统包 ${name}（自己加的）`}
                placeholder={`bios/${name}.zip 或对象存储 key`}
                coveredBy={
                  name === coveredSet
                    ? `平台那格填的是 ${map.arcade}，文件名正好就是它 —— 引擎已经拿到了，这里不用再绑一份。要单独给这个系统换一份也可以，绑了播放器优先用它。`
                    : undefined
                }
                {...rowProps(biosSetKey(name))}
              />
            ))}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                className={cx(inputClass, 'max-w-[12rem] font-mono')}
                placeholder="其它系统名，如 skns"
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
                添加
              </button>
              <span className="text-[11px] text-dim">
                系统名只认小写字母、数字和下划线（romset 索引里那 18 种就是这些名字）
              </span>
            </div>
          </div>
        )}
      </Card>

      {msg && <p className={cx('mt-3 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
    </>
  )
}
