/**
 * 后台 → 配置。**只读**的一页：这台机器上每一个环境变量是从 .env 来的，
 * 还是在用代码内置的默认值，外加一组体检。
 *
 * 它要回答的不是「我想改限流」，而是**「我到底配了什么、生效了没有」**。
 * 2026-09-13 之前这个问题只能 ssh 上去 cat 一遍 .env、再回源码里找默认值 ——
 * 而 SUBMIT_GAME_TO_EMAIL 就是这么漏掉的：服务端启动时一直在打警告，只是没人翻日志。
 *
 * ⚠️ 这一页刻意**没有任何输入框**。想让它可写之前，先读 server/src/config-manifest.js 的文件头。
 */
import { useCallback, useEffect, useState } from 'react'
import { cx } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import {
  fetchSiteConfig,
  type ConfigCheckLevel,
  type ConfigItem,
  type ConfigReport,
} from '@/services/siteConfig'
import { Card } from './ui'

const LEVEL: Record<ConfigCheckLevel, { label: string; cls: string }> = {
  danger: { label: '危险', cls: 'border-red-500/40 bg-red-500/10 text-red-200' },
  warn: { label: '注意', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-200' },
  info: { label: '提示', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-200' },
}

function uptimeText(sec: number) {
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`
  return `${Math.floor(sec / 86400)} 天`
}

function ValueCell({ item }: { item: ConfigItem }) {
  if (item.kind === 'secret') {
    if (item.source !== 'env') return <span className="text-dim">未设</span>
    return (
      <span className="text-muted">
        已配置 · {item.length} 字符
        {item.fingerprint ? (
          <>
            {' · '}
            {/* 指纹只能判「两台机器是不是同一个值」，判不出内容。见 config-report.js */}
            <code className="text-fg" title="HMAC 指纹：只能用来比对两处是否同值">
              {item.fingerprint}
            </code>
          </>
        ) : null}
      </span>
    )
  }
  if (item.source !== 'env') return <span className="text-dim">默认值</span>
  return <code className="break-all text-fg">{item.value}</code>
}

export function AdminConfig() {
  const [data, setData] = useState<ConfigReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /** 默认只看「.env 里真的写了的」—— 133 条全列出来反而看不见重点 */
  const [onlySet, setOnlySet] = useState(true)

  const reload = useCallback(() => {
    if (!apiEnabled()) return
    setLoading(true)
    setError('')
    fetchSiteConfig()
      .then(setData)
      .catch((e: unknown) => {
        setData(null)
        setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

  if (error) return <Card title="配置">加载失败：{error}</Card>
  if (!data) return <Card title="配置">{loading ? '读取中…' : '暂无数据'}</Card>

  return (
    <div className="space-y-4">
      <Card
        title="体检"
        extra={
          <button type="button" onClick={reload} className="text-xs text-muted hover:text-fg">
            {loading ? '刷新中…' : '刷新'}
          </button>
        }
      >
        {data.checks.length === 0 ? (
          <p className="text-sm text-muted">没有发现问题。</p>
        ) : (
          <ul className="space-y-2">
            {data.checks.map((c) => (
              <li key={c.id} className={cx('rounded-lg border px-3 py-2 text-sm', LEVEL[c.level].cls)}>
                <div className="font-semibold">
                  [{LEVEL[c.level].label}] {c.title}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed opacity-90">{c.detail}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-dim">
          进程已运行 {uptimeText(data.uptimeSec)}（Node {data.nodeVersion}）。
          {/* 「改完重启了吗」是看到告警时第一个要问的事，所以运行时长放在这儿 */}
          改完 .env 需要重启进程才生效 —— 运行时长比你改动的时间还长，说明还没重启。
          配置指纹 <code className="text-muted">{data.digest}</code>（两台机器同值才相同；不含任何密钥内容）。
        </p>
      </Card>

      <Card
        title={`环境变量（${data.counts.set} 项来自 .env，${data.counts.default} 项用默认值）`}
        extra={
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={onlySet}
              onChange={(e) => setOnlySet(e.target.checked)}
              className="accent-current"
            />
            只看 .env 里配了的
          </label>
        }
      >
        <p className="mb-3 text-xs text-dim">
          这一页是只读的。要改值就改服务器上的 <code className="text-muted">server/.env</code> 再重启 —— 
          做成能在这里改会制造两份真相（库里一份、.env 里一份），而密钥更是绝不能进数据库。
        </p>
        <div className="space-y-4">
          {data.groups.map(({ group, items }) => {
            const rows = onlySet ? items.filter((i) => i.source === 'env') : items
            if (!rows.length) return null
            return (
              <section key={group}>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">{group}</h3>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full min-w-[540px] text-[12px]">
                    <tbody>
                      {rows.map((item) => (
                        <tr key={item.name} className="border-b border-line/60 last:border-0 align-top">
                          <td className="w-[230px] px-2 py-1.5">
                            <code className={cx('break-all', item.source === 'env' ? 'text-fg' : 'text-dim')}>
                              {item.name}
                            </code>
                            {item.kind === 'secret' ? (
                              <span className="ml-1 text-[10px] text-amber-300/80">密钥</span>
                            ) : null}
                            <div className="text-[10px] text-dim">{item.file}</div>
                          </td>
                          <td className="px-2 py-1.5">
                            <ValueCell item={item} />
                            {item.note ? <div className="mt-0.5 text-[11px] text-dim">{item.note}</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
