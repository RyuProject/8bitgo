import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { gamesStore, useAllGames } from '@/services/store'
import {
  conventionalKeys,
  deleteRom,
  getRomConfig,
  isS3ApiUrl,
  listRomObjects,
  pingRomApi,
  platformFromKey,
  romUrlForKey,
  saveRomConfig,
  slugFromKey,
  subscribeRomConfig,
  type RomObject,
} from '@/services/roms'
import { platformMap } from '@/data/platforms'
import { cx } from '@/lib/format'
import { slugify } from './GameForm'
import { Card, Field, Stat, btnClass, inputClass } from './ui'

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 给一个对象 key 找最匹配的游戏：文件名 == slug / 标题 slug，同平台目录优先 */
function matchGame(key: string, games: Game[]): Game | undefined {
  const guess = slugFromKey(key)
  const folder = platformFromKey(key)
  const candidates = games.filter((g) => g.slug === guess || slugify(g.title) === guess || slugify(g.titleZh ?? '') === guess)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  return candidates.find((g) => g.platform === folder) ?? candidates[0]
}

const CORS_EXAMPLE = `[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://8bitgo.com", "https://www.8bitgo.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 86400
  }
]`

export function AdminRoms() {
  const games = useAllGames()
  const [cfg, setCfg] = useState(getRomConfig())
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [test, setTest] = useState<Array<{ ok: boolean; text: string }> | null>(null)
  const [testing, setTesting] = useState(false)
  const [objects, setObjects] = useState<RomObject[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showCors, setShowCors] = useState(false)

  useEffect(() => subscribeRomConfig(() => setCfg(getRomConfig())), [])

  const bound = games.filter((g) => g.rom)
  const byRom = useMemo(() => new Map(bound.map((g) => [g.rom!, g])), [bound])

  const flash = (t: string) => {
    setSavedMsg(t)
    window.setTimeout(() => setSavedMsg(null), 3000)
  }

  const save = () => {
    saveRomConfig(cfg)
    flash('已保存（地址与前缀存于 localStorage，口令存于 sessionStorage）')
  }

  const runTest = async () => {
    saveRomConfig(cfg)
    setTesting(true)
    const results: Array<{ ok: boolean; text: string }> = []
    const base = cfg.base.trim().replace(/\/+$/, '')
    const api = (cfg.api.trim() || base).replace(/\/+$/, '')

    if (!base) results.push({ ok: false, text: '公开根地址未填写' })
    else if (isS3ApiUrl(base)) results.push({ ok: false, text: '公开根地址填的是 S3 API（*.r2.cloudflarestorage.com），浏览器无法直接访问，请改成自定义域名或 Worker 地址' })
    else {
      const sample = bound[0]?.rom ?? (games[0] ? conventionalKeys(games[0])[0] : '')
      try {
        const r = await fetch(romUrlForKey(sample, base), { method: 'HEAD', cache: 'no-store' })
        if (r.ok) results.push({ ok: true, text: `公开读取正常：${sample} → ${r.status}` })
        else if (r.status === 404) results.push({ ok: true, text: `公开根地址可达（示例对象 ${sample} 不存在，返回 404，这很正常）` })
        else results.push({ ok: false, text: `公开根地址返回 ${r.status}` })
      } catch {
        results.push({ ok: false, text: `无法从浏览器访问公开根地址。最常见原因是桶没有配置 CORS，或自定义域名还在初始化。点下方「查看 CORS 配置示例」。` })
      }
    }

    if (!api) results.push({ ok: false, text: 'Worker 地址未填写：无法上传 / 列表，只能按约定路径读取' })
    else {
      try {
        const p = await pingRomApi(api)
        if (!p.isWorker) results.push({ ok: false, text: `Worker 地址不是本项目的 Worker（/ping 无响应或格式不对）。上传与列表功能不可用` })
        else if (!p.writable) results.push({ ok: false, text: 'Worker 在线，但尚未设置 ADMIN_TOKEN（npx wrangler secret put ADMIN_TOKEN），上传 / 列表会被拒绝' })
        else results.push({ ok: true, text: 'Worker 在线，已启用上传 / 删除 / 列表' })
      } catch {
        results.push({ ok: false, text: '无法连接 Worker 地址' })
      }
    }
    setTest(results)
    setTesting(false)
  }

  const loadList = async () => {
    saveRomConfig(cfg)
    setLoading(true)
    setListError(null)
    try {
      setObjects(await listRomObjects())
    } catch (err) {
      setListError(err instanceof Error ? err.message : '列表失败')
    } finally {
      setLoading(false)
    }
  }

  const bind = (slug: string, key: string | undefined) => gamesStore.update(slug, { rom: key })

  const autoMatch = () => {
    if (!objects) return
    let n = 0
    for (const o of objects) {
      if (byRom.has(o.key)) continue
      const g = matchGame(o.key, games)
      if (g && !g.rom) {
        bind(g.slug, o.key)
        n++
      }
    }
    flash(n ? `自动匹配并绑定了 ${n} 款游戏` : '没有可自动匹配的新文件')
  }

  const removeObject = async (o: RomObject) => {
    if (!window.confirm(`确定从 R2 删除 ${o.key}？此操作不可恢复。`)) return
    try {
      await deleteRom(o.key)
      setObjects((list) => list?.filter((x) => x.key !== o.key) ?? null)
      const g = byRom.get(o.key)
      if (g) bind(g.slug, undefined)
      flash('已删除')
    } catch (err) {
      setListError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const visibleObjects = useMemo(() => {
    if (!objects) return []
    const needle = filter.trim().toLowerCase()
    return objects.filter((o) => !needle || o.key.toLowerCase().includes(needle))
  }, [objects, filter])

  const totalSize = objects?.reduce((s, o) => s + o.size, 0) ?? 0

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">ROM 存储</h1>
        <p className="mt-1 text-sm text-muted">
          玩家从「公开根地址」读取 ROM；后台通过 Worker 上传、删除和列出文件。游戏绑定了 key 之后，详情页会直接显示「开始游戏」。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="已绑定 ROM 的游戏" value={bound.length} sub={`共 ${games.length} 款`} />
        <Stat label="公开根地址" value={cfg.base ? '已配置' : '未配置'} sub={cfg.base || '在下方填写'} />
        <Stat label="Worker" value={cfg.api ? '已配置' : '未配置'} sub={cfg.api || '上传 / 列表需要'} />
        <Stat label="桶内文件" value={objects ? objects.length : '—'} sub={objects ? formatBytes(totalSize) : '点击「列出文件」'} />
      </div>

      <Card title="连接配置">
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="公开根地址（R2 自定义域名 / r2.dev，玩家读取用）" hint="需在桶上配置 CORS 允许 GET、HEAD；末尾不带斜杠">
            <input className={inputClass} value={cfg.base} onChange={(e) => setCfg({ ...cfg, base: e.target.value })} placeholder="https://assets.8bitgo.com" />
          </Field>
          <Field label="Worker 地址（后台上传 / 删除 / 列表用）" hint="部署 worker/ 目录后得到，如 https://8bitgo-roms.xxx.workers.dev">
            <input className={inputClass} value={cfg.api} onChange={(e) => setCfg({ ...cfg, api: e.target.value })} placeholder="https://8bitgo-roms.your-name.workers.dev" />
          </Field>
          <Field label="key 前缀（桶内目录）" hint="对应 roms/gba、roms/nes…；上传与约定路径探测都会带上它">
            <input className={cx(inputClass, 'font-mono')} value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })} placeholder="roms" />
          </Field>
          <Field label="Worker 口令（ADMIN_TOKEN）" hint="存于 sessionStorage，关闭标签页后需重填">
            <input type="password" className={inputClass} value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} placeholder="wrangler secret put ADMIN_TOKEN" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btnClass.primary} onClick={save}>
            保存配置
          </button>
          <button type="button" className={btnClass.secondary} onClick={runTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className={btnClass.secondary} onClick={loadList} disabled={loading || !(cfg.api || cfg.base).trim()}>
            {loading ? '读取中…' : '列出文件'}
          </button>
          <button type="button" className={cx(btnClass.small, 'text-muted underline underline-offset-2 hover:text-fg')} onClick={() => setShowCors((v) => !v)}>
            {showCors ? '收起 CORS 示例' : '查看 CORS 配置示例'}
          </button>
          {savedMsg && <span className="text-xs text-online">{savedMsg}</span>}
        </div>
        {test && (
          <ul className="mt-3 space-y-1.5">
            {test.map((t, i) => (
              <li key={i} className={cx('rounded-lg px-3 py-2 text-sm', t.ok ? 'bg-online/15 text-online' : 'bg-live/15 text-red-300')}>
                {t.ok ? '✔' : '✖'} {t.text}
              </li>
            ))}
          </ul>
        )}
        {listError && <p className="mt-3 rounded-lg bg-live/15 px-3 py-2 text-sm text-red-300">{listError}</p>}
        {showCors && (
          <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <p className="mb-2 text-muted">Cloudflare 控制台 → R2 → 桶 → 设置 → CORS 策略，粘贴（把域名换成你的站点地址）：</p>
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-fg">{CORS_EXAMPLE}</pre>
          </div>
        )}
      </Card>

      {objects && (
        <Card
          title={`桶内文件（${objects.length}，前缀 ${cfg.prefix || '/'}）`}
          extra={
            <div className="flex items-center gap-2">
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选 key…" className={cx(inputClass, 'h-8 w-48 text-xs')} />
              <button type="button" className={cx(btnClass.small, 'bg-brand text-white hover:bg-brand-hover')} onClick={autoMatch}>
                自动匹配未绑定的
              </button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">文件</th>
                  <th className="pb-2 font-medium">大小</th>
                  <th className="pb-2 font-medium">绑定到</th>
                  <th className="pb-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibleObjects.map((o) => (
                  <ObjectRow key={o.key} object={o} games={games} boundGame={byRom.get(o.key)} suggestion={byRom.get(o.key) ? undefined : matchGame(o.key, games)} onBind={bind} onDelete={removeObject} />
                ))}
                {visibleObjects.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-muted">
                      {objects.length === 0 ? '这个前缀下没有文件' : '没有匹配的文件'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={`已绑定的游戏（${bound.length}）`} extra={<Link to="/admin/games" className="text-xs text-brand-hover hover:underline">去游戏编辑里上传 →</Link>}>
        {bound.length === 0 ? (
          <p className="text-sm text-muted">还没有游戏绑定 ROM。在「游戏」页打开某款游戏的编辑弹窗，用「上传到 R2」直接上传；或在这里列出文件后「自动匹配」。</p>
        ) : (
          <ul className="divide-y divide-line">
            {bound.map((g) => (
              <li key={g.slug} className="flex items-center gap-3 py-2 text-sm">
                <span aria-hidden>{g.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{g.titleZh ?? g.title}</span>
                  <span className="ml-2 text-xs text-muted">{platformMap[g.platform]?.shortName}</span>
                  <span className="block truncate font-mono text-xs text-dim">{g.rom}</span>
                </span>
                <a href={romUrlForKey(g.rom!)} target="_blank" rel="noreferrer" className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}>
                  打开
                </a>
                <button type="button" className={cx(btnClass.small, 'text-red-300 hover:bg-live/15')} onClick={() => bind(g.slug, undefined)}>
                  解绑
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="接入步骤">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>
            R2 桶开启自定义域名（如 <code className="text-fg">assets.8bitgo.com</code>）作为公开根地址，并在桶上配置 CORS（上方有示例）。
          </li>
          <li>
            部署 <code className="text-fg">worker/</code>（`cd worker && npx wrangler secret put ADMIN_TOKEN && npx wrangler deploy`），把得到的地址填到「Worker 地址」，口令填到「Worker 口令」。
          </li>
          <li>
            之后在「游戏」页的编辑弹窗里直接「上传到 R2」，文件会存到 <code className="text-fg">{cfg.prefix || ''}/&lt;platform&gt;/&lt;slug&gt;.&lt;后缀&gt;</code> 并自动绑定；已有文件用「列出文件 → 自动匹配」。
          </li>
        </ol>
      </Card>
    </div>
  )
}

function ObjectRow({
  object,
  games,
  boundGame,
  suggestion,
  onBind,
  onDelete,
}: {
  object: RomObject
  games: Game[]
  boundGame?: Game
  suggestion?: Game
  onBind: (slug: string, key: string | undefined) => void
  onDelete: (o: RomObject) => void
}) {
  const [selected, setSelected] = useState(suggestion?.slug ?? '')
  return (
    <tr className="hover:bg-black/[0.03]">
      <td className="py-2 pr-3 font-mono text-xs">{object.key}</td>
      <td className="py-2 pr-3 tabular-nums text-muted">{formatBytes(object.size)}</td>
      <td className="py-2 pr-3">
        {boundGame ? (
          <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">
            {boundGame.icon} {boundGame.titleZh ?? boundGame.title}
          </span>
        ) : (
          <select className={cx(inputClass, 'h-8 w-64 text-xs')} value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">{suggestion ? `— 建议：${suggestion.titleZh ?? suggestion.title} —` : '— 选择游戏 —'}</option>
            {games.map((g) => (
              <option key={g.slug} value={g.slug}>
                {platformMap[g.platform]?.shortName} · {g.titleZh ?? g.title}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="py-2 text-right">
        <div className="flex justify-end gap-1">
          {boundGame ? (
            <button type="button" className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')} onClick={() => onBind(boundGame.slug, undefined)}>
              解绑
            </button>
          ) : (
            <button
              type="button"
              className={cx(btnClass.small, 'text-brand-hover hover:bg-brand-soft')}
              disabled={!selected && !suggestion}
              onClick={() => onBind(selected || suggestion!.slug, object.key)}
            >
              绑定
            </button>
          )}
          <button type="button" className={cx(btnClass.small, 'text-red-300 hover:bg-live/15')} onClick={() => onDelete(object)}>
            删除文件
          </button>
        </div>
      </td>
    </tr>
  )
}
