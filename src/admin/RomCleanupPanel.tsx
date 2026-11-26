import { useEffect, useMemo, useRef, useState } from 'react'
import type { Game } from '@/types'
import { api, apiEnabled } from '@/services/api'
import { fetchAdminGames } from '@/services/store'
import { deleteRomObjectsExactly, getRomConfig, getRomPrefix, listRomObjects, type RomObject } from '@/services/roms'
import { cx } from '@/lib/format'
import {
  buildObjectReferenceIndex,
  referencesForObject,
  scanUnreferencedObjects,
  type CleanupScan,
  type ObjectReferenceIndex,
  type PlatformBiosRefs,
} from './romDeletePlan'
import { Card, btnClass } from './ui'

/** Sockdrive 流式盘不在 ROM 前缀下，但同样是游戏绑定的 R2 对象。 */
const SOCKDRIVE_PREFIX = 'sockdrives'

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 翻完全库（含下架）；少一页都不能拿来证明「没人引用」。 */
async function loadAllGames(signal?: AbortSignal): Promise<Game[]> {
  const first = await fetchAdminGames({ page: 1, pageSize: 100 }, signal)
  const games = [...first.items]
  for (let page = 2; page <= first.totalPages; page++) {
    games.push(...(await fetchAdminGames({ page, pageSize: 100 }, signal)).items)
  }
  if (games.length !== first.total) {
    throw new Error(`全库引用检查不完整（读取 ${games.length} / ${first.total} 款游戏），已停止`)
  }
  return games
}

/** 全库游戏 + 平台 BIOS → 引用索引。BIOS 读不到就停：fetchPlatformBios 失败会静默给空表，不能用。 */
async function loadReferenceIndex(signal?: AbortSignal): Promise<ObjectReferenceIndex> {
  const [games, platformBios] = await Promise.all([
    loadAllGames(signal),
    api.get<PlatformBiosRefs>('/api/platform-bios/map', false, signal).catch((err: unknown) => {
      if (signal?.aborted) throw err
      throw new Error('读取平台 BIOS 绑定失败，无法确认对象没被 BIOS 使用；已停止')
    }),
  ])
  return buildObjectReferenceIndex(games, platformBios ?? {})
}

/**
 * 只列 ROM 前缀与 sockdrives/ 两个目录。前缀为空时拒绝：那会把封面、数据库备份、网页游戏包
 * 一起当成「没人引用的 ROM」端上来。
 */
async function listCleanupObjects(signal?: AbortSignal): Promise<RomObject[]> {
  const prefix = getRomPrefix()
  if (!prefix) throw new Error('ROM key 前缀为空，无法把扫描范围限制在 ROM 目录；请先在连接配置里填写前缀（通常是 roms）')
  const lists = await Promise.all([listRomObjects(prefix, signal), listRomObjects(SOCKDRIVE_PREFIX, signal)])
  return lists.flat().filter((object) => !object.bucket || object.bucket === 'ROMS')
}

export function RomCleanupPanel({ onDeleted }: { onDeleted?: (keys: string[]) => void }) {
  const [scan, setScan] = useState<CleanupScan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const cfg = getRomConfig()
  const ready = apiEnabled() && Boolean(cfg.api && cfg.token)

  const runScan = async () => {
    if (busyRef.current) return
    busyRef.current = true
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setScanning(true)
    setMessage(null)
    try {
      const [index, objects] = await Promise.all([loadReferenceIndex(controller.signal), listCleanupObjects(controller.signal)])
      const result = scanUnreferencedObjects(objects, index)
      setScan(result)
      // 默认一个都不勾：未引用 ≠ 没用（比如刚换下来、特意留作回滚的旧包），让管理员逐项或「全选」确认。
      setSelected(new Set())
    } catch (err) {
      if (!controller.signal.aborted) setMessage({ ok: false, text: err instanceof Error ? err.message : '扫描失败' })
    } finally {
      busyRef.current = false
      setScanning(false)
    }
  }

  const chosen = useMemo(() => scan?.orphans.filter((group) => selected.has(group.id)) ?? [], [scan, selected])
  const chosenKeys = chosen.flatMap((group) => group.keys)
  const chosenBytes = chosen.reduce((sum, group) => sum + group.size, 0)
  const orphanBytes = scan?.orphans.reduce((sum, group) => sum + group.size, 0) ?? 0
  const orphanObjects = scan?.orphans.reduce((sum, group) => sum + group.keys.length, 0) ?? 0

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const removeSelected = async () => {
    if (busyRef.current || !chosen.length) return
    const ok = window.confirm(
      `确定从 R2 永久删除选中的 ${chosen.length} 组、共 ${chosenKeys.length} 个对象（${formatBytes(chosenBytes)}）？此操作不可恢复。\n\n` +
      '删除前会重新读取全库游戏与平台 BIOS 复核；复核期间若有对象被重新绑定，整批取消。',
    )
    if (!ok) return
    busyRef.current = true
    setDeleting(true)
    setMessage(null)
    try {
      // 扫描到点删除之间可能有人刚绑了其中某个文件；只删扫描时那份精确清单，并在删前再核一次。
      const index = await loadReferenceIndex()
      const nowReferenced = chosenKeys.filter((key) => referencesForObject(index, key).length)
      if (nowReferenced.length) {
        throw new Error(`复核发现 ${nowReferenced.length} 个对象已被重新引用（如 ${nowReferenced.slice(0, 3).join('、')}），整批已取消；请重新扫描`)
      }
      const result = await deleteRomObjectsExactly(chosenKeys)
      const removed = new Set(result.removed)
      setScan((current) => current && {
        ...current,
        orphans: current.orphans.filter((group) => !group.keys.every((key) => removed.has(key))),
      })
      setSelected((current) => new Set([...current].filter((id) => !chosen.some((group) => group.id === id && group.keys.every((key) => removed.has(key))))))
      onDeleted?.(result.removed)
      setMessage(result.failed.length
        ? { ok: false, text: `已删除 ${result.removed.length} 个对象；${result.failed.length} 个删除失败（如 ${result.failed.slice(0, 3).join('、')}），请重新扫描后重试` }
        : { ok: true, text: `已删除 ${result.removed.length} 个对象，释放约 ${formatBytes(chosenBytes)}` })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : '删除失败' })
    } finally {
      busyRef.current = false
      setDeleting(false)
    }
  }

  return (
    <Card
      title="清理未引用文件"
      extra={
        <button type="button" className={btnClass.secondary} onClick={() => void runScan()} disabled={!ready || scanning || deleting}>
          {scanning ? '扫描中…' : scan ? '重新扫描' : '扫描'}
        </button>
      }
    >
      <p className="text-xs leading-relaxed text-muted">
        扫描 <code className="font-mono">{getRomPrefix() || '（未设前缀）'}/</code> 与 <code className="font-mono">{SOCKDRIVE_PREFIX}/</code>，
        对照全库游戏（含下架）的主 / 语言 / 备用 ROM（含 8BG 派生与原件）、多文件包目录、DOS 系统盘 / 附加文件 / 流式盘、MAME 媒体盘和平台 BIOS。
        解绑、替换 ROM、重新转换流式盘后留下的旧文件会出现在这里。72 小时内上传的只列出、不勾选；删除前会重新读取全库复核一次。
      </p>
      {!ready && <p className="mt-2 text-xs text-live">需要后端 API 与 Worker 地址 + 口令都配置好才能扫描。</p>}
      {message && (
        <p className={cx('mt-3 rounded-lg px-3 py-2 text-sm', message.ok ? 'bg-online/15 text-online' : 'bg-live/15 text-live')}>{message.text}</p>
      )}
      {scan && (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            未引用：<span className="font-semibold">{scan.orphans.length}</span> 组 / {orphanObjects} 个对象 / {formatBytes(orphanBytes)}
            <span className="ml-2 text-xs text-dim">（仍被引用的对象 {scan.referencedCount} 个）</span>
          </p>
          {scan.orphans.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={cx(btnClass.small, 'text-muted underline underline-offset-2 hover:text-fg')} onClick={() => setSelected(new Set(scan.orphans.map((group) => group.id)))}>
                  全选
                </button>
                <button type="button" className={cx(btnClass.small, 'text-muted underline underline-offset-2 hover:text-fg')} onClick={() => setSelected(new Set())}>
                  全不选
                </button>
                <button type="button" className={btnClass.danger} onClick={() => void removeSelected()} disabled={deleting || scanning || !chosen.length}>
                  {deleting ? '删除中…' : `删除选中（${chosen.length} 组，${formatBytes(chosenBytes)}）`}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="w-8 pb-2" />
                      <th className="pb-2 font-medium">文件 / 目录</th>
                      <th className="pb-2 text-right font-medium">对象数</th>
                      <th className="pb-2 text-right font-medium">大小</th>
                      <th className="pb-2 text-right font-medium">最后上传</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {scan.orphans.map((group) => (
                      <tr key={group.id}>
                        <td className="py-1.5">
                          <input type="checkbox" checked={selected.has(group.id)} onChange={() => toggle(group.id)} aria-label={`选择 ${group.id}`} />
                        </td>
                        <td className="break-all py-1.5 font-mono text-xs">{group.id}</td>
                        <td className="py-1.5 text-right tabular-nums">{group.keys.length}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatBytes(group.size)}</td>
                        <td className="py-1.5 text-right text-xs text-muted">{group.uploaded?.slice(0, 10) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {scan.recent.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer select-none">72 小时内上传、暂不清理（{scan.recent.length} 组）</summary>
              <ul className="mt-2 space-y-1 font-mono">
                {scan.recent.map((group) => (
                  <li key={group.id} className="break-all">{group.id} · {formatBytes(group.size)} · {group.uploaded?.slice(0, 16) ?? '时间未知'}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  )
}
