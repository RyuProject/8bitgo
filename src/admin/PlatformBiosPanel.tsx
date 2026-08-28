import { useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@/types'
import { platforms } from '@/data/platforms'
import { cx } from '@/lib/format'
import { getRomApi, getRomPrefix, romUrlForKey, uploadRom, safeFileName } from '@/services/roms'
import { cleanupSuperseded, confirmUpload } from './uploadGuards'
import {
  bindPlatformBios,
  fetchPlatformBios,
  unbindPlatformBios,
  type PlatformBiosMap,
} from '@/services/platformBios'
import { Card, btnClass, inputClass } from './ui'

/**
 * 平台级 BIOS。
 *
 * 有些平台不给 BIOS 根本起不来 —— Neo Geo 最典型：拳皇、合金弹头、侍魂全都要
 * `neogeo.zip`，缺了核心直接报错，和 ROM 对不对没关系。
 * 同一份 BIOS 整个平台共用，所以按平台传一次，而不是挂到每一款游戏上。
 *
 * 只列出「已知需要 BIOS」的平台（NEED_BIOS）：把十几个平台全列出来，
 * 等于让人在一堆不需要填的格子里找那一个要填的。
 */
const NEED_BIOS: Array<{ id: PlatformId; hint: string }> = [
  { id: 'arcade', hint: 'Neo Geo 系（拳皇 / 合金弹头 / 侍魂）必须要 neogeo.zip；CPS 系不需要' },
  { id: 'psx', hint: '多数核心可以不用 BIOS，但用真 BIOS 兼容性更好' },
]

/**
 * BIOS 在对象存储里的默认位置：<前缀>/bios/<原文件名>
 *
 * ⚠️ 这里**必须保留原文件名**，不能像以前那样用 <平台>.zip。
 *
 * 模拟器核心是按**固定文件名**找 BIOS 的：FBNeo 找 `neogeo.zip`，PS1 核心找
 * `scph5501.bin`。而播放器把 BIOS 的 URL 原样交给核心（EJS_biosUrl），
 * 核心看到的文件名就是 URL 最后那一段 —— 存成 `bios/arcade.zip` 的话，
 * 文件明明在，核心却报「sp-s3.sp1 / sm1.sm1 / sfix.sfix / 000-lo.lo is missing」，
 * 因为它要的 neogeo.zip 根本不存在。这个坑踩过，别再改回去。
 */
function defaultBiosKey(_platform: string, fileName: string): string {
  const prefix = getRomPrefix()
  return `${prefix ? `${prefix}/` : ''}bios/${safeFileName(fileName)}`
}

export function PlatformBiosPanel() {
  const [map, setMap] = useState<PlatformBiosMap>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pct, setPct] = useState<Record<string, number>>({})
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

  const rows = NEED_BIOS.map((n) => ({
    ...n,
    platform: platforms.find((p) => p.id === n.id),
    key: map[n.id] ?? '',
  })).filter((r) => r.platform)

  async function upload(platform: PlatformId, file: File) {
    setBusy(platform)
    setMsg(null)
    try {
      // 已经绑过 BIOS 就复用同一个 key —— 原来无条件按文件名重算，
      // 传完 bios.bin 再传 bios.zip 会在 R2 里留下两份，旧的那份永远没人引用
      const oldKey = (map[platform] ?? '').trim()
      const key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : defaultBiosKey(platform, file.name)
      if (!(await confirmUpload(key, file))) return
      await uploadRom(file, key, (p) => setPct((s) => ({ ...s, [platform]: p })))
      await bindPlatformBios(platform, key)
      setMap((m) => ({ ...m, [platform]: key }))
      // 同一份 BIOS 可能被多个平台共用（比如几个街机核心），所以把整张表传进去判断
      const removed = await cleanupSuperseded(oldKey, key, Object.values(map).filter(Boolean) as string[])
      setMsg({ ok: true, text: `已上传并绑定：${key}${removed ? `；旧文件 ${removed} 已删除` : ''}` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '上传失败' })
    } finally {
      setBusy(null)
      setPct((s) => ({ ...s, [platform]: 0 }))
    }
  }

  async function bindManual(platform: PlatformId, key: string) {
    setBusy(platform)
    setMsg(null)
    try {
      await bindPlatformBios(platform, key.trim())
      setMap((m) => ({ ...m, [platform]: key.trim() }))
      setMsg({ ok: true, text: '已绑定' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '绑定失败' })
    } finally {
      setBusy(null)
    }
  }

  async function unbind(platform: PlatformId) {
    setBusy(platform)
    setMsg(null)
    try {
      await unbindPlatformBios(platform)
      setMap((m) => {
        const next = { ...m }
        delete next[platform]
        return next
      })
      setMsg({ ok: true, text: '已解绑（文件仍留在存储里）' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '解绑失败' })
    } finally {
      setBusy(null)
    }
  }

  return (
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

      {loading ? (
        <p className="mt-3 text-sm text-muted">正在读取…</p>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base" aria-hidden>
                  {r.platform!.icon}
                </span>
                <span className="font-semibold">{r.platform!.nameZh}</span>
                {r.key ? (
                  <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">已绑定</span>
                ) : (
                  <span className="rounded bg-live/15 px-1.5 py-0.5 text-xs text-live">未绑定</span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-dim">{r.hint}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className={cx(inputClass, 'min-w-0 flex-1')}
                  placeholder="/bios/neogeo.zip 或对象存储 key"
                  defaultValue={r.key}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== r.key) void bindManual(r.id, v)
                  }}
                />
                <input
                  ref={(el) => {
                    fileRefs.current[r.id] = el
                  }}
                  type="file"
                  accept=".zip,.bin,.rom"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) void upload(r.id, f)
                  }}
                />
                <button
                  type="button"
                  className={btnClass.secondary}
                  disabled={busy === r.id || !getRomApi()}
                  onClick={() => fileRefs.current[r.id]?.click()}
                >
                  {busy === r.id ? `上传中 ${pct[r.id] ?? 0}%` : '上传文件'}
                </button>
                {r.key && (
                  <>
                    <a
                      className="text-xs text-brand-hover hover:underline"
                      href={romUrlForKey(r.key)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开
                    </a>
                    <button type="button" className="text-xs text-live hover:underline" onClick={() => void unbind(r.id)}>
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
              {r.key &&
                (romUrlForKey(r.key) ? (
                  <p className="mt-1 truncate text-[11px] text-dim">实际地址：{romUrlForKey(r.key)}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-live">
                    这个 key 拼不出可访问地址（「ROM 存储」里的公开访问地址还没填）。
                    现在启动游戏不会带上 BIOS，Neo Geo 会报「缺文件」——但真正的原因在这儿。
                  </p>
                ))}
            </div>
          ))}
        </div>
      )}

      {msg && <p className={cx('mt-3 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
    </Card>
  )
}
