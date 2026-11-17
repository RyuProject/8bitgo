import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, apiEnabled } from '@/services/api'
import { copyText } from '@/lib/clipboard'
import { cx } from '@/lib/format'
import { Card, Field, btnClass, inputClass } from './ui'
import { HOTFIX_ACTIONS, type HotfixAction, type HotfixScope } from '../../shared/hotfix.js'

/**
 * 后台：AI 修补。
 *
 * 一、填 MiniMax API Key（加密存库，这里只能看到末四位）；
 * 二、定「自动应用」的档位：AI 分诊之后哪些修补直接生效、哪些等你点批准；
 * 三、看修补记录：生效中 / 待批准 / 已撤销 / 已固化，每条都能「复制给 Claude」做永久修复。
 *
 * AI 只能从白名单里挑播放器已有的退路（换核心、改走主站、关引擎缓存、ROM 放内存、显示提示……），
 * 不能写代码 —— 诊断包内容来自玩家浏览器，可以伪造，让 AI 写代码再下发等于开了远程执行的口子。
 * 白名单与校验在 shared/hotfix.js，服务端流程在 server/src/ai-hotfix.js。
 */

type AutoApply = 'off' | 'safe' | 'all'
type Region = 'global' | 'cn'

interface AiConfig {
  enabled: boolean
  region: Region
  model: string
  autoApply: AutoApply
  minVisits: number
  windowMinutes: number
  ttlHours: number
  maxCallsPerHour: number
  minConfidence: number
  revokeAfterVisits: number
  includeSlow: boolean
  key: { configured: boolean; source: 'db' | 'env' | null; hint: string; broken: boolean }
  canStoreKey: boolean
}

type HotfixStatus = 'analyzing' | 'proposed' | 'active' | 'revoked' | 'expired' | 'resolved' | 'recorded' | 'failed'

interface HotfixItem {
  id: string
  signature: string
  signatureText: string
  source: 'ai' | 'ai-split' | 'manual'
  status: HotfixStatus
  risk: 'safe' | 'risky'
  confidence: number | null
  scope: HotfixScope
  actions: HotfixAction[]
  diagnosis: string
  permanentFix: string
  playerImpact: string
  dropped: string[]
  model: string
  error: string
  ttlHours: number
  visitsAtTrigger: number
  statusNote: string
  createdAt: string | null
  appliedAt: string | null
  expiresAt: string | null
  closedAt: string | null
  effect: { failedVisitsWithHotfix: number | null; sameSignatureVisitsSince: number; visitsAtTrigger: number } | null
}

const STATUS_LABEL: Record<HotfixStatus, string> = {
  analyzing: '分析中',
  proposed: '待批准',
  active: '生效中',
  revoked: '已撤销',
  expired: '已过期',
  resolved: '已固化',
  recorded: '仅记录',
  failed: '分析失败',
}

const STATUS_TONE: Record<HotfixStatus, string> = {
  analyzing: 'bg-brand/10 text-brand-hover',
  proposed: 'bg-yellow-500/10 text-yellow-400',
  active: 'bg-emerald-500/15 text-emerald-400',
  revoked: 'bg-surface-2 text-muted',
  expired: 'bg-surface-2 text-muted',
  resolved: 'bg-brand/15 text-brand-hover',
  recorded: 'bg-surface-2 text-muted',
  failed: 'bg-live/10 text-live',
}

const STATUS_FILTERS: Array<{ id: '' | HotfixStatus; label: string }> = [
  { id: '', label: '全部' },
  { id: 'active', label: '生效中' },
  { id: 'proposed', label: '待批准' },
  { id: 'recorded', label: '仅记录' },
  { id: 'revoked', label: '已撤销' },
  { id: 'resolved', label: '已固化' },
  { id: 'failed', label: '分析失败' },
]

const AUTO_APPLY_OPTIONS: Array<{ id: AutoApply; label: string; hint: string }> = [
  { id: 'off', label: '只建议', hint: '所有修补都等你点「批准」才生效' },
  { id: 'safe', label: '安全的自动生效（推荐）', hint: '换线路 / ROM 放内存 / 关缓存 / 玩家提示 立即生效；同一次提案里的换核心、换运行时拆成另一条等你批准' },
  { id: 'all', label: '全部自动生效', hint: '包括换核心、换运行时。见效最快；不对症时这款游戏命中的玩家都会受影响（会自动撤销）' },
]

function describeAction(action: HotfixAction): string {
  switch (action.type) {
    case 'set_core': return `换核心 → ${action.core}`
    case 'set_runtime': return `换运行时 → ${action.runtime}`
    case 'rom_host': return `ROM 固定走${action.host === 'mirror' ? '大陆镜像' : '主线路'}`
    case 'player_notice': return `玩家提示：${action.template}`
    case 'runtime_origin': return '运行时改走主站'
    case 'disable_engine_cache': return '关闭引擎核心缓存'
    case 'memory_rom': return 'ROM 改放内存'
    default: return String((action as { type?: string }).type ?? '?')
  }
}

const when = (value: string | null) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e))

function NumberField({ label, hint, value, onChange, min, max, step = 1 }: {
  label: string; hint?: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        className={inputClass}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  )
}

function ConfigPanel({ onSaved }: { onSaved: (c: AiConfig) => void }) {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'clear'>('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!apiEnabled()) return
    api.get<{ config: AiConfig }>('/api/admin/ai/config', true)
      .then((r) => {
        setConfig(r.config)
        onSaved(r.config)
      })
      .catch((e: unknown) => {
        const missing = e instanceof ApiError && e.status >= 500
        setMessage({ tone: 'error', text: missing ? `${errorText(e)} —— 刚部署的话先在服务器上跑 cd server && npm run migrate` : errorText(e) })
      })
  }, [onSaved])

  if (!config) {
    return (
      <Card title="MiniMax 接入">
        {message ? <p className="text-sm text-live">{message.text}</p> : <p className="text-sm text-muted">正在读取…</p>}
      </Card>
    )
  }

  const set = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => setConfig({ ...config, [key]: value })

  const save = async (extra: { clearKey?: boolean } = {}) => {
    setBusy(extra.clearKey ? 'clear' : 'save')
    setMessage(null)
    try {
      const { key: _key, canStoreKey: _can, ...settings } = config
      const body = { ...settings, ...extra, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
      const r = await api.put<{ config: AiConfig }>('/api/admin/ai/config', body, true)
      setConfig(r.config)
      onSaved(r.config)
      setApiKey('')
      setMessage({ tone: 'ok', text: extra.clearKey ? '已清除后台保存的 Key' : '已保存' })
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e) })
    } finally {
      setBusy('')
    }
  }

  const test = async () => {
    setBusy('test')
    setMessage(null)
    try {
      const r = await api.post<{ model: string; latencyMs: number; reply: string }>('/api/admin/ai/test', {}, true)
      setMessage({ tone: 'ok', text: `连接正常：${r.model}，${(r.latencyMs / 1000).toFixed(1)} 秒。回复：${r.reply}` })
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e) })
    } finally {
      setBusy('')
    }
  }

  const keyState = config.key.broken
    ? '后台保存的 Key 解不开（服务器的 JWT_SECRET / AI_SETTINGS_SECRET 换过），请重新填写'
    : config.key.configured
      ? `已配置 ${config.key.hint}（来自${config.key.source === 'db' ? '后台' : ' server/.env 的 MINIMAX_API_KEY'}）`
      : '还没有配置'

  return (
    <div className="space-y-4">
      <Card
        title="MiniMax 接入"
        extra={
          <div className="flex gap-2">
            <button type="button" className={btnClass.secondary} onClick={() => void test()} disabled={Boolean(busy) || !config.key.configured}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className={btnClass.primary} onClick={() => void save()} disabled={Boolean(busy)}>
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="API Key" hint={keyState}>
            <input
              type="password"
              autoComplete="off"
              className={inputClass}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config.key.configured ? '留空 = 不改；粘贴新 Key 会替换' : '粘贴 MiniMax 控制台里的 API Key'}
              disabled={!config.canStoreKey}
            />
          </Field>
          <Field label="接入点" hint="国际站与国内站的 Key 不通用，选签发这把 Key 的那一边">
            <select className={inputClass} value={config.region} onChange={(e) => set('region', e.target.value as Region)}>
              <option value="global">国际站 api.minimax.io（platform.minimax.io 的 Key）</option>
              <option value="cn">国内站 api.minimaxi.com（platform.minimaxi.com 的 Key）</option>
            </select>
          </Field>
          <Field label="模型 ID" hint="默认 MiniMax-M3.1-Flash；可改成控制台里可用的其它模型">
            <input className={inputClass} value={config.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
          <Field label="AI 自动分诊" hint="关掉后不会自动调用 MiniMax；错误诊断页的「AI 分诊」按钮仍可手动用">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={config.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              出现聚集的加载失败 / 启动超时就自动分诊
            </label>
          </Field>
        </div>
        {!config.canStoreKey && (
          <p className="mt-3 rounded-lg border border-live/40 bg-live/10 px-3 py-2 text-xs text-fg">
            服务器没有配置 JWT_SECRET 或 AI_SETTINGS_SECRET（至少 16 字符），不能把 Key 加密存进数据库。可以改在 server/.env 写 MINIMAX_API_KEY。
          </p>
        )}
        {config.key.source === 'db' && (
          <button type="button" className={cx(btnClass.small, 'mt-3 text-muted hover:text-live')} onClick={() => void save({ clearKey: true })} disabled={Boolean(busy)}>
            {busy === 'clear' ? '清除中…' : '清除后台保存的 Key'}
          </button>
        )}
        <p className="mt-3 text-[11px] text-dim">
          Key 用服务器密钥加密后存进数据库（备份里没有明文），这里只显示末四位。发给 MiniMax 的只有已经脱敏的诊断包：
          不含 IP、完整 User-Agent、账号和 ROM 地址。
        </p>
        {message && (
          <p className={cx('mt-3 rounded-lg px-3 py-2 text-xs', message.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-live/10 text-live')}>
            {message.text}
          </p>
        )}
      </Card>

      <Card title="自动修补策略">
        <div className="space-y-2">
          {AUTO_APPLY_OPTIONS.map((opt) => (
            <label key={opt.id} className={cx('flex cursor-pointer gap-3 rounded-lg border px-3 py-2', config.autoApply === opt.id ? 'border-brand bg-brand-soft' : 'border-line')}>
              <input type="radio" name="autoApply" checked={config.autoApply === opt.id} onChange={() => set('autoApply', opt.id)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium text-fg">{opt.label}</span>
                <span className="block text-xs text-muted">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField label="触发：不同访问数 ≥" hint="同一故障来自这么多个访问才分诊" value={config.minVisits} min={1} max={100} onChange={(v) => set('minVisits', v)} />
          <NumberField label="统计窗口（分钟）" value={config.windowMinutes} min={5} max={1440} onChange={(v) => set('windowMinutes', v)} />
          <NumberField label="修补有效期（小时）" hint="到期自动失效，最长 72" value={config.ttlHours} min={1} max={72} onChange={(v) => set('ttlHours', v)} />
          <NumberField label="每小时最多分诊" hint="控制 MiniMax 费用" value={config.maxCallsPerHour} min={1} max={120} onChange={(v) => set('maxCallsPerHour', v)} />
          <NumberField label="自动生效的最低置信度" hint="0～1，低于它只建议" value={config.minConfidence} min={0} max={1} step={0.05} onChange={(v) => set('minConfidence', v)} />
          <NumberField label="自动撤销：生效后仍失败的访问 ≥" hint="同一故障达到这个数就撤销；0 = 不自动撤销" value={config.revokeAfterVisits} min={0} max={1000} onChange={(v) => set('revokeAfterVisits', v)} />
          <Field label="慢启动也分诊" hint="默认只看加载失败和启动超时">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={config.includeSlow} onChange={(e) => set('includeSlow', e.target.checked)} />
              包括超过 20 秒的慢启动
            </label>
          </Field>
        </div>
        <p className="mt-3 text-[11px] text-dim">改完点上面的「保存」。同一故障分诊过一次后 6 小时内不再自动分诊。</p>
      </Card>
    </div>
  )
}

function HotfixCard({ item, onChange }: { item: HotfixItem; onChange: (next: HotfixItem) => void }) {
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const act = async (action: 'approve' | 'revoke' | 'resolve' | 'extend', body: object = {}) => {
    setBusy(action)
    setNote('')
    try {
      const r = await api.post<{ item: HotfixItem }>(`/api/admin/ai/hotfixes/${item.id}/${action}`, body, true)
      onChange({ ...r.item, effect: item.effect })
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const copyReport = async () => {
    setBusy('copy')
    setNote('')
    try {
      const r = await api.get<{ markdown: string }>(`/api/admin/ai/hotfixes/${item.id}/report`, true)
      await copyText(r.markdown)
      setNote('已复制，贴给 Claude / Codex 做永久修复')
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cx('rounded px-1.5 py-0.5 font-medium', STATUS_TONE[item.status])}>{STATUS_LABEL[item.status]}</span>
        {item.actions.length > 0 && (
          <span className={cx('rounded px-1.5 py-0.5', item.risk === 'risky' ? 'bg-live/10 text-live' : 'bg-surface-2 text-muted')}>
            {item.risk === 'risky' ? '有风险' : '安全'}
          </span>
        )}
        <span className="text-dim">#{item.id} · {item.source === 'manual' ? '手动分诊' : item.source === 'ai-split' ? '自动分诊 · 拆出的待批准部分' : '自动分诊'} · {item.model || '—'}</span>
        {item.confidence != null && <span className="text-muted">置信度 {item.confidence}</span>}
        <span className="text-dim">{when(item.createdAt)}</span>
      </div>
      <p className="mt-2 break-words text-sm text-fg">{item.signatureText.split(' · ').slice(2).join(' · ') || item.signatureText}</p>
      {item.diagnosis && <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{item.diagnosis}</p>}
      {item.error && <p className="mt-2 text-xs text-live">{item.error}</p>}

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <p className="text-dim">临时修补</p>
          {item.actions.length ? (
            <ul className="mt-1 space-y-0.5">
              {item.actions.map((a) => (
                <li key={a.type} title={HOTFIX_ACTIONS[a.type]?.label}>· {describeAction(a)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted">没有对症的白名单动作，只记录诊断</p>
          )}
          {item.dropped.length > 0 && <p className="mt-1 text-dim">被白名单拦下：{item.dropped.join('；')}</p>}
        </div>
        <div>
          <p className="text-dim">作用范围</p>
          <p className="mt-1 flex flex-wrap gap-1">
            {item.scope.games.map((slug) => (
              <Link key={slug} to={`/games/${encodeURIComponent(slug)}`} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-brand-hover hover:underline">{slug}</Link>
            ))}
            {!item.scope.games.length && <span className="text-muted">—</span>}
          </p>
          <p className="mt-1 text-muted">
            {item.scope.browsers.length ? `浏览器：${item.scope.browsers.join('、')}　` : ''}
            {item.scope.os.length ? `系统：${item.scope.os.join('、')}　` : ''}
            {item.scope.cnOnly ? '仅大陆访客' : ''}
            {!item.scope.browsers.length && !item.scope.os.length && !item.scope.cnOnly ? '所有浏览器' : ''}
          </p>
        </div>
      </div>

      {(item.appliedAt || item.statusNote || item.playerImpact) && (
        <div className="mt-3 space-y-1 text-xs text-muted">
          {item.playerImpact && <p>对玩家：{item.playerImpact}</p>}
          {item.appliedAt && <p>生效 {when(item.appliedAt)} · {item.status === 'active' ? `到期 ${when(item.expiresAt)}` : `结束 ${when(item.closedAt)}`}</p>}
          {item.effect && (
            <p>
              触发时 {item.effect.visitsAtTrigger} 个访问失败；生效后同一故障 {item.effect.sameSignatureVisitsSince} 个访问
              {item.effect.failedVisitsWithHotfix != null ? `，带着这条修补仍失败 ${item.effect.failedVisitsWithHotfix} 个` : ''}
            </p>
          )}
          {item.statusNote && <p>{item.statusNote}</p>}
        </div>
      )}

      {item.permanentFix && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted hover:text-fg">AI 的固化建议</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-fg">{item.permanentFix}</pre>
        </details>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {(item.status === 'proposed' || item.status === 'expired' || item.status === 'revoked') && item.actions.length > 0 && (
          <button type="button" className={btnClass.primary} disabled={Boolean(busy)} onClick={() => void act('approve')}>
            {busy === 'approve' ? '…' : item.status === 'proposed' ? '批准生效' : '重新生效'}
          </button>
        )}
        {item.status === 'active' && (
          <button type="button" className={btnClass.secondary} disabled={Boolean(busy)} onClick={() => void act('extend', { hours: 24 })}>
            {busy === 'extend' ? '…' : '再延 24 小时'}
          </button>
        )}
        {(item.status === 'active' || item.status === 'proposed') && (
          <button type="button" className={btnClass.danger} disabled={Boolean(busy)} onClick={() => void act('revoke')}>
            {busy === 'revoke' ? '…' : '撤销'}
          </button>
        )}
        <button type="button" className={btnClass.secondary} disabled={Boolean(busy)} onClick={() => void copyReport()}>
          {busy === 'copy' ? '…' : '复制给 Claude'}
        </button>
        {item.status !== 'resolved' && item.status !== 'analyzing' && (
          <button type="button" className={btnClass.secondary} disabled={Boolean(busy)} onClick={() => void act('resolve')}>
            {busy === 'resolve' ? '…' : '标记已固化'}
          </button>
        )}
        <Link to={`/admin/diagnostics?q=${encodeURIComponent(item.signatureText.split(' · ').slice(2).join(' · ').slice(0, 60))}`} className={cx(btnClass.small, 'text-muted hover:text-fg')}>
          查看诊断
        </Link>
      </div>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </li>
  )
}

export function AdminAi() {
  const [status, setStatus] = useState<'' | HotfixStatus>('')
  const [items, setItems] = useState<HotfixItem[] | null>(null)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<AiConfig | null>(null)
  const onSaved = useCallback((c: AiConfig) => setConfig(c), [])

  const load = useCallback(() => {
    if (!apiEnabled()) return
    setError('')
    api.get<{ items: HotfixItem[] }>(`/api/admin/ai/hotfixes${status ? `?status=${status}` : ''}`, true)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(errorText(e)))
  }, [status])

  useEffect(() => {
    load()
  }, [load])

  const replace = (next: HotfixItem) => setItems((list) => list?.map((it) => (it.id === next.id ? next : it)) ?? null)
  const activeCount = items?.filter((it) => it.status === 'active').length ?? 0
  const proposedCount = items?.filter((it) => it.status === 'proposed').length ?? 0

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">AI 修补</h1>
        <p className="mt-1 text-sm text-muted">
          同一类加载失败 / 启动超时聚集时，MiniMax 读脱敏后的诊断包判断原因，从白名单里挑播放器已有的退路临时打开
          （换核心、改走主站、关引擎缓存、ROM 放内存、给玩家提示），让玩家先玩得上；每一条都记在下面，
          「复制给 Claude」把经过和现场交给人做永久修复。AI 不能改代码，修补到期自动失效，没起作用会自动撤销。
        </p>
      </div>

      <ConfigPanel onSaved={onSaved} />

      <Card
        title="修补记录"
        extra={<button type="button" className={btnClass.secondary} onClick={load}>刷新</button>}
      >
        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id || 'all'}
              type="button"
              onClick={() => setStatus(f.id)}
              className={cx(btnClass.small, status === f.id ? 'bg-brand/15 text-brand-hover' : 'text-muted hover:text-fg')}
            >
              {f.label}
            </button>
          ))}
          {items && !status && (
            <span className="ml-auto text-xs text-muted">生效中 {activeCount} 条 · 待批准 {proposedCount} 条</span>
          )}
        </div>
        {config && !config.enabled && (
          <p className="mt-3 text-xs text-muted">
            自动分诊没有开启。也可以去 <Link to="/admin/diagnostics" className="text-brand-hover hover:underline">错误诊断</Link> 对某一组点「AI 分诊」。
          </p>
        )}
      </Card>

      {error && <p className="rounded-lg bg-live/10 px-3 py-2 text-sm text-live">{error}</p>}
      {items === null && !error && <p className="text-sm text-muted">正在读取…</p>}
      <ul className="space-y-3">
        {items?.map((item) => <HotfixCard key={item.id} item={item} onChange={replace} />)}
      </ul>
      {items && !items.length && (
        <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted">还没有修补记录。</p>
      )}
    </div>
  )
}
