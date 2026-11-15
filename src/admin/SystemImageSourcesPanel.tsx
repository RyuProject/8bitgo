import { useEffect, useMemo, useState } from 'react'
import {
  DOS_SYSTEM_IMAGE_CATALOG,
  DOS_SYSTEM_IMAGE_MAX_MIRRORS,
} from '../../shared/dos-system-images.js'
import {
  fetchAdminSystemImageSettings,
  probeSystemImageMirror,
  saveAdminSystemImageSettings,
  verifySystemImageMirror,
  type AdminSystemImageSettings,
  type ConfiguredSystemMirror,
} from '@/services/systemImageSources'
import { Card, btnClass, inputClass } from './ui'

type Feedback = { kind: 'ok' | 'error' | 'busy' | 'dirty'; text: string }

function newMirror(): ConfiguredSystemMirror {
  return {
    id: `mirror-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: '新镜像',
    url: '',
    enabled: true,
    verifiedSha256: '',
  }
}

function shortHash(value: string): string {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : '尚未校验'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 系统镜像外部副本管理：所有可用性与文件一致性检查都从当前管理员浏览器发起。 */
export function SystemImageSourcesPanel() {
  const [settings, setSettings] = useState<AdminSystemImageSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({})
  const [pageError, setPageError] = useState('')

  useEffect(() => {
    let alive = true
    void fetchAdminSystemImageSettings()
      .then((value) => {
        if (alive) setSettings(value)
      })
      .catch((error: unknown) => {
        if (alive) setPageError(errorText(error))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const verifiedCount = useMemo(() => {
    if (!settings) return 0
    return Object.values(settings.files).reduce(
      (count, file) => count + file.mirrors.filter((mirror) => file.sha256 && mirror.verifiedSha256 === file.sha256).length,
      0,
    )
  }, [settings])

  function updateFile(fileName: string, update: (current: AdminSystemImageSettings['files'][string]) => AdminSystemImageSettings['files'][string]) {
    setSettings((current) => {
      if (!current) return current
      const previous = current.files[fileName] ?? { sha256: '', mirrors: [] }
      return { ...current, files: { ...current.files, [fileName]: update(previous) } }
    })
  }

  function updateMirror(fileName: string, id: string, patch: Partial<ConfiguredSystemMirror>) {
    updateFile(fileName, (current) => ({
      ...current,
      mirrors: current.mirrors.map((mirror) => {
        if (mirror.id !== id) return mirror
        const changedUrl = patch.url !== undefined && patch.url !== mirror.url
        return { ...mirror, ...patch, ...(changedUrl ? { verifiedSha256: '' } : {}) }
      }),
    }))
    setFeedback((current) => ({ ...current, [`${fileName}:${id}`]: { kind: 'dirty', text: '配置已修改；保存后生效，改地址后需重新完整校验' } }))
  }

  async function runProbe(fileName: string, mirror: ConfiguredSystemMirror) {
    const key = `${fileName}:${mirror.id}`
    setFeedback((current) => ({ ...current, [key]: { kind: 'busy', text: '正在从当前浏览器测速…' } }))
    try {
      const result = await probeSystemImageMirror(mirror.url)
      setFeedback((current) => ({
        ...current,
        [key]: { kind: 'ok', text: `可读取，首块 ${(result.bytes / 1024).toFixed(0)} KB，约 ${result.mbps.toFixed(2)} Mbps / ${Math.round(result.elapsedMs)} ms` },
      }))
    } catch (error) {
      setFeedback((current) => ({ ...current, [key]: { kind: 'error', text: errorText(error) } }))
    }
  }

  async function runVerify(fileName: string, mirror: ConfiguredSystemMirror) {
    const key = `${fileName}:${mirror.id}`
    setFeedback((current) => ({
      ...current,
      [key]: { kind: 'busy', text: '正在顺序下载 R2 原件与副本并计算 SHA-256；此操作会读取两份完整镜像…' },
    }))
    try {
      const result = await verifySystemImageMirror(fileName, mirror.url)
      updateFile(fileName, (current) => ({
        ...current,
        sha256: result.sha256,
        r2Version: result.r2Version,
        mirrors: current.mirrors.map((item) => item.id === mirror.id ? { ...item, verifiedSha256: result.sha256 } : item),
      }))
      setFeedback((current) => ({
        ...current,
        [key]: { kind: 'ok', text: `副本与 R2 原件完全一致（${(result.bytes / 1024 / 1024).toFixed(1)} MB）。已记录 R2 版本指纹；R2 对象更新后旧副本会自动停用。点击“保存配置”后供玩家使用。` },
      }))
    } catch (error) {
      setFeedback((current) => ({ ...current, [key]: { kind: 'error', text: errorText(error) } }))
    }
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    setPageError('')
    try {
      setSettings(await saveAdminSystemImageSettings(settings))
      setFeedback((current) => ({ ...current, saved: { kind: 'ok', text: '镜像源配置已保存；玩家下次开局会读取新配置。' } }))
    } catch (error) {
      setPageError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="DOS / Windows 系统镜像源"
      extra={
        <button type="button" className={btnClass.primary} onClick={() => void save()} disabled={!settings || loading || saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-5 text-muted">
          玩家开局时会并行探测可用来源并优先下载响应最快的一份。外部地址只有在当前浏览器能读取 Range 请求、且完整 SHA-256 与 R2 原件一致后才会启用。主资源域和同源 R2 兜底始终保留，不能删除。
          <span className="ml-2">已校验副本：{verifiedCount}</span>
        </p>

        {loading && <p className="text-sm text-muted">正在读取镜像源配置…</p>}
        {pageError && <p role="alert" className="rounded-lg border border-live/30 bg-live/10 px-3 py-2 text-sm text-live">{pageError}</p>}
        {feedback.saved && <p className="text-xs text-emerald-400">{feedback.saved.text}</p>}

        {settings && DOS_SYSTEM_IMAGE_CATALOG.map(({ file, label }) => {
          const fileSettings = settings.files[file] ?? { sha256: '', r2Version: '', mirrors: [] }
          return (
            <section key={file} className="rounded-xl border border-line bg-surface-2 p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{label}</h3>
                  <p className="mt-1 break-all text-[11px] text-dim">{file}</p>
                  <p className="mt-1 text-[11px] text-muted">R2 原件指纹：{shortHash(fileSettings.sha256)}</p>
                </div>
                <button
                  type="button"
                  className={btnClass.secondary}
                  disabled={fileSettings.mirrors.length >= DOS_SYSTEM_IMAGE_MAX_MIRRORS}
                  onClick={() => updateFile(file, (current) => ({ ...current, mirrors: [...current.mirrors, newMirror()] }))}
                >
                  添加副本（{fileSettings.mirrors.length}/{DOS_SYSTEM_IMAGE_MAX_MIRRORS}）
                </button>
              </div>

              {fileSettings.mirrors.length === 0 ? (
                <p className="mt-3 text-xs text-muted">尚未配置外部副本；玩家仍会使用主资源域与固定 R2 兜底。</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {fileSettings.mirrors.map((mirror) => {
                    const key = `${file}:${mirror.id}`
                    const status = feedback[key]
                    const isVerified = Boolean(fileSettings.sha256 && mirror.verifiedSha256 === fileSettings.sha256)
                    return (
                      <div key={mirror.id} className="rounded-lg border border-line bg-surface p-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-muted">显示名称</span>
                            <input className={inputClass} disabled={status?.kind === 'busy'} value={mirror.label} maxLength={64} onChange={(event) => updateMirror(file, mirror.id, { label: event.target.value })} />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-muted">HTTPS 副本地址</span>
                            <input className={inputClass} disabled={status?.kind === 'busy'} value={mirror.url} maxLength={2048} placeholder="https://…/system.jsdos" onChange={(event) => updateMirror(file, mirror.id, { url: event.target.value })} />
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <label className="inline-flex h-8 items-center gap-2 text-xs text-muted">
                            <input type="checkbox" disabled={status?.kind === 'busy'} checked={mirror.enabled} onChange={(event) => updateMirror(file, mirror.id, { enabled: event.target.checked })} />
                            启用
                          </label>
                          <span className={`text-[11px] ${isVerified ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {isVerified ? `已校验 ${shortHash(mirror.verifiedSha256)}` : '尚未通过 R2 原件校验，不会供玩家使用'}
                          </span>
                          <span className="flex-1" />
                          <button type="button" className={btnClass.secondary} disabled={!mirror.url || status?.kind === 'busy'} onClick={() => void runProbe(file, mirror)}>
                            测速
                          </button>
                          <button type="button" className={btnClass.secondary} disabled={!mirror.url || status?.kind === 'busy'} onClick={() => void runVerify(file, mirror)}>
                            完整校验
                          </button>
                          <button
                            type="button"
                            className={btnClass.danger}
                            onClick={() => updateFile(file, (current) => ({ ...current, mirrors: current.mirrors.filter((item) => item.id !== mirror.id) }))}
                          >
                            删除
                          </button>
                        </div>
                        {status && <p className={`mt-2 break-words text-[11px] ${status.kind === 'error' ? 'text-live' : status.kind === 'ok' ? 'text-emerald-400' : 'text-muted'}`}>{status.text}</p>}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </Card>
  )
}
