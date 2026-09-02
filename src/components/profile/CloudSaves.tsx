/**
 * 「我的云存档」：列出、下载、删除。
 *
 * 只做这三件事，不做「上传存档」——存档是引擎内存快照（或 DOS 的文件系统变更包），
 * 一份从别处拿来的文件很可能来自不同的核心版本，读进去要么崩要么把进度写坏。
 * 存档只从游戏里产生，这里只负责管理。
 *
 * 两个地方必须用「只动云端」的那一对，不能用游戏里那一对：
 *   下载 → fetchCloudSave，不是 pullSave。pullSave 云端取不到时会退回浏览器里的那份，
 *          而这个列表是从服务器拉的 —— 点下载却给一份本地存档，等于贴错标签。
 *   删除 → deleteCloudSave，不是 deleteSave。deleteSave 两边都删，
 *          而这里的确认框写的是「浏览器里的那份不受影响」，说一套做一套；
 *          更糟的是删掉了玩家在这台机器上唯一的进度备份。
 *
 * 下载也不能直接给 <a href>：云存档接口要带 Authorization 头，
 * 浏览器发普通链接请求时不会带上任何自定义头，点下去只会拿到一句 401。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { formatBytes } from '@/lib/emulator'
import { downloadBlob } from '@/emulator/recorder'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { gameTitle, platformLabel } from '@/services/i18nData'
import { useGamesBySlugs } from '@/services/gameCache'
import { deleteCloudSave, fetchCloudSave, listCloudSaves, type SaveMeta } from '@/services/saves'
import { Notice, Panel } from './shared'

/** 存档的唯一坐标。同一款游戏的不同存档位是不同的行 */
function keyOf(s: SaveMeta) {
  return `${s.runtime}/${s.gameSlug}/${s.slot}`
}

export function CloudSaves() {
  const t = useT()
  const lang = useLang()
  const [saves, setSaves] = useState<SaveMeta[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setSaves(await listCloudSaves())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 存档列表里的 slug 可能是 `local:文件名`（玩家自己拖进来的 ROM，站内没有这款游戏），
  // 那种取不到游戏信息，下面按「本地文件」显示
  const slugs = (saves ?? []).map((s) => s.gameSlug).filter((s) => !s.startsWith('local:'))
  const games = useGamesBySlugs(slugs)
  const titleOf = (slug: string) => {
    if (slug.startsWith('local:')) return slug.slice('local:'.length) || t.account.savesLocalGame
    const g = games.find((x) => x.slug === slug)
    return g ? gameTitle(g, lang) : slug
  }
  const platformOf = (slug: string) => games.find((x) => x.slug === slug)?.platform ?? null

  const download = async (s: SaveMeta) => {
    setError(null)
    setBusy(keyOf(s))
    try {
      const got = await fetchCloudSave(s.runtime, s.gameSlug, s.slot)
      if (!got) throw new Error(t.profile.saveFailed)
      /**
       * 用现成的 downloadBlob，不要在这里自己拼 <a>。
       *
       * 以前这里是自己拼的，两个毛病：anchor 没进 DOM（部分浏览器不触发下载），
       * 而且 a.click() 之后**同步**就 revokeObjectURL —— Safari 来不及去取那个 blob，
       * 下下来是个空文件。downloadBlob 两点都处理好了（appendChild + 延后 revoke，
       * 见 emulator/recorder.ts）。
       */
      downloadBlob(
        new Blob([got.data as BlobPart], { type: 'application/octet-stream' }),
        `${s.gameSlug.replace(/[^\w.-]+/g, '_')}-${s.runtime}-${s.slot}.sav`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (s: SaveMeta) => {
    if (!window.confirm(t.account.savesDeleteConfirm)) return
    setError(null)
    setBusy(keyOf(s))
    try {
      await deleteCloudSave(s.runtime, s.gameSlug, s.slot)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    } finally {
      setBusy(null)
    }
  }

  const total = (saves ?? []).reduce((n, s) => n + s.size, 0)
  const dateFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <Panel
      title={t.account.savesTitle}
      desc={
        saves?.length
          ? `${t.account.savesSubtitle} · ${fmt(t.account.savesSummary, { n: saves.length, size: formatBytes(total) })}`
          : t.account.savesSubtitle
      }
    >
      {error && <div className="mb-3"><Notice text={error} /></div>}

      {saves === null ? (
        // 列表还没回来时占住位置，避免「空状态」闪一下又被列表顶掉
        <ul className="space-y-2" aria-busy="true">
          {[0, 1].map((i) => (
            <li key={i} className="h-14 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </ul>
      ) : saves.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          {t.account.savesEmpty}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {saves.map((s) => {
            const platform = platformOf(s.gameSlug)
            const isLocal = s.gameSlug.startsWith('local:')
            const working = busy === keyOf(s)
            return (
              <li key={keyOf(s)} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">
                    {isLocal ? (
                      titleOf(s.gameSlug)
                    ) : (
                      <Link to={`/games/${s.gameSlug}`} className="hover:text-brand-hover hover:underline">
                        {titleOf(s.gameSlug)}
                      </Link>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {isLocal ? t.account.savesLocalGame : platform ? platformLabel(t, platform, platform) : s.runtime}
                    {' · '}
                    {fmt(t.account.savesSlot, { n: s.slot })}
                    {' · '}
                    {formatBytes(s.size)}
                    {' · '}
                    {dateFmt.format(new Date(s.updatedAt))}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <SaveAction onClick={() => download(s)} disabled={working}>
                    {t.account.savesDownload}
                  </SaveAction>
                  <SaveAction onClick={() => remove(s)} disabled={working} danger>
                    {t.account.savesDelete}
                  </SaveAction>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function SaveAction({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'h-8 rounded-lg border px-2.5 text-xs font-bold transition disabled:opacity-40',
        danger
          ? 'border-live/40 text-live hover:bg-live/10'
          : 'border-line-strong text-fg hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  )
}
