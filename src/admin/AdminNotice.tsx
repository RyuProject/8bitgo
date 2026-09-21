import { useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '@/services/api'
import { Card, Field, btnClass, inputClass } from './ui'
import { NoticeBar } from '@/components/home/NoticeBar'
import { useAdminData } from './AdminLayout'
import {
  NOTICE_TEXT_MAX,
  sanitizeNotice,
  visibleNotice,
  type NoticeLevel,
  type StoredSiteNotice,
} from '../../shared/site-notice.js'
import { cx } from '@/lib/format'

/**
 * 后台：首页公告条。
 *
 * ## 三种状态，两个颜色
 *
 *   关闭        —— 前台整条不画
 *   黄色（warn）—— 提示：站点近期有波动、某个功能正在测试
 *   红色（error）—— Sorry：站长自己动了什么，导致玩不了 / 进不来
 *
 * ## 预览用的是**前台那个组件本身**
 *
 * 不是照着画一个「差不多的」：文本清洗（折叠空白、按码点截断）和可见性判断都在
 * shared/site-notice.js 里，这里调 `visibleNotice()` 把结果喂给 `<NoticeBar>` ——
 * 后台看到的就是首页会渲染的那一份。手抄一份预览迟早会和前台分家，
 * 而这一条的文案是**出事时**才写的，那时候没人会去核对两边的差别。
 */
export function AdminNotice() {
  const { state } = useAdminData()
  const [loaded, setLoaded] = useState<StoredSiteNotice | null>(null)
  const [level, setLevel] = useState<NoticeLevel>('warn')
  const [text, setText] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    if (state !== 'db') return
    let alive = true
    void (async () => {
      try {
        const res = await api.get<{ notice: StoredSiteNotice }>('/api/admin/site-notice', true)
        if (!alive) return
        setLoaded(res.notice)
        setLevel(res.notice.level)
        setText(res.notice.text)
        setEnabled(res.notice.enabled)
        setError('')
      } catch (e) {
        if (!alive) return
        // 最常见的一种：代码先上线、迁移还没跑 —— 那时要说清楚，否则只会看到一句 500
        const missing = e instanceof ApiError && e.status >= 500
        setError(
          missing
            ? `${e.message} —— 如果是刚刚部署，先在服务器上跑一次 `
              + '`cd server && npm run migrate`（公告存在新表 site_settings 里）。'
            : e instanceof Error ? e.message : String(e),
        )
      }
    })()
    return () => {
      alive = false
    }
  }, [state])

  // 后台看到的就是前台会画的那一份（见文件头）
  const preview = useMemo(() => visibleNotice({ level, text, enabled }), [level, text, enabled])
  const tone: 'off' | NoticeLevel = enabled ? level : 'off'

  const pick = (next: 'off' | NoticeLevel) => {
    if (next === 'off') {
      setEnabled(false)
      return
    }
    // 从「关闭」切回来时保留上一次选的颜色：出事的场景里没人想再点第二次
    setLevel(next)
    setEnabled(true)
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const body = sanitizeNotice({ level, text, enabled })
      const res = await api.put<{ notice: StoredSiteNotice }>('/api/admin/site-notice', body, true)
      // 回包是**服务端实际存下来的那一份**：文本被折叠 / 截断过的话，界面上要跟着变，
      // 否则管理员以为存的是自己打的那一版，刷新一下才发现不是
      setLoaded(res.notice)
      setLevel(res.notice.level)
      setText(res.notice.text)
      setEnabled(res.notice.enabled)
      setToast(res.notice.enabled ? '已发布' : '已关闭')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const dirty = !loaded || loaded.level !== level || loaded.text !== text || loaded.enabled !== enabled

  return (
    <div className="space-y-4">
      <Card
        title="首页公告条"
        extra={
          <button type="button" onClick={() => void save()} disabled={busy || state !== 'db' || !dirty} className={btnClass.primary}>
            {busy ? '保存中…' : '保存'}
          </button>
        }
      >
        <p className="mb-4 text-xs text-muted">
          显示在首页<strong>搜索框与横幅之间</strong>。文案自己写，两种语气：
          <span className="mx-1 rounded border border-coin/50 bg-coin/15 px-1.5 py-0.5 text-fg">黄色 · 提示</span>
          （站点近期有波动、功能在测试）、
          <span className="mx-1 rounded border border-live/50 bg-live/12 px-1.5 py-0.5 text-fg">红色 · Sorry</span>
          （自己动了什么，导致玩不了 / 进不来）。
        </p>

        <Field label="语气" hint="「关闭」只影响显示，文案会留着 —— 下次开回来不用重打">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['off', '关闭'],
                ['warn', '黄色 · 提示'],
                ['error', '红色 · Sorry'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => pick(value)}
                aria-pressed={tone === value}
                className={cx(
                  'h-9 rounded-lg border px-3 text-sm transition',
                  tone === value ? 'border-brand bg-brand-soft font-semibold text-fg' : 'border-line bg-surface-2 text-muted hover:border-line-strong',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field
          className="mt-4"
          label="文案"
          hint={`最多 ${NOTICE_TEXT_MAX} 字；换行与连续空格会被折叠成一个空格（它只画一行，换行会把首页顶开）`}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={NOTICE_TEXT_MAX}
            rows={2}
            placeholder="例如：机房正在维护，部分游戏可能打不开，预计 30 分钟内恢复。"
            className={cx(inputClass, 'h-auto py-2 leading-relaxed')}
          />
          <span className="mt-1 block text-right text-[11px] text-dim tabular-nums">
            {Array.from(text).length}/{NOTICE_TEXT_MAX}
          </span>
        </Field>

        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-muted">预览（就是首页会渲染的那一条）</p>
          {preview ? (
            <NoticeBar notice={preview} />
          ) : (
            <p className="rounded-card border border-dashed border-line px-4 py-3 text-xs text-dim">
              当前不可见：关闭状态、或文案是空的。
            </p>
          )}
        </div>

        {error && <p className="mt-4 rounded-lg border border-live/40 bg-live/10 px-3 py-2 text-xs text-fg">{error}</p>}
        <p className="mt-4 text-[11px] text-dim">
          保存后服务端的页面缓存会立刻作废；如果站点前面挂了 CDN，首页 HTML 里那一条最多再晚 5 分钟。
        </p>
      </Card>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm text-bg shadow-lg">{toast}</div>
      )}
    </div>
  )
}
