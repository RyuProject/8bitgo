import { useCallback, useEffect, useRef, useState } from 'react'
import type { Game, Post } from '@/types'
import { fetchAdminGames } from '@/services/store'
import { fetchAllPosts } from '@/services/posts'
import { api, apiEnabled, apiLabel, getAdminApiToken, setAdminApiToken } from '@/services/api'
import { games as builtinGames } from '@/data/games'
import { posts as builtinPosts } from '@/data/posts'
import { Card, btnClass, inputClass } from './ui'
import { cx } from '@/lib/format'

/** 后端列表接口一页最多给 100 条，导出时要按这个上限翻页 */
const EXPORT_PAGE_SIZE = 100

/**
 * 把整库游戏翻完。
 *
 * v1 的「导出 JSON」是把前端 store 里的数组直接 stringify —— 那份数组本来就是全库。
 * v2 后台只按页取数，所以导出得自己一页页翻，直到 totalPages。串行翻页是有意的：
 * 几十页并发打过去，后端连接池会被这一个按钮吃满。
 */
async function fetchAllGames(onProgress?: (loaded: number, total: number) => void): Promise<Game[]> {
  const items: Game[] = []
  let page = 1
  let totalPages = 1
  do {
    const r = await fetchAdminGames({ page, pageSize: EXPORT_PAGE_SIZE })
    items.push(...r.items)
    totalPages = r.totalPages
    onProgress?.(items.length, r.total)
    page++
  } while (page <= totalPages)
  return items
}

const toJson = (value: unknown) => JSON.stringify(value, null, 2)

/** 数据库 / API 连接状态与初始化 */
function DbApiCard({ onSeeded }: { onSeeded: () => void }) {
  const enabled = apiEnabled()
  const url = enabled ? apiLabel() : ''
  const [token, setTok] = useState(getAdminApiToken())
  const [health, setHealth] = useState<string>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const test = async () => {
    setHealth('检测中…')
    try {
      const r = await api.get<{ db?: boolean }>('/api/health')
      setHealth(r.db ? '✅ 已连接，数据库正常' : '⚠️ 服务在线，但数据库连接异常')
    } catch (e) {
      setHealth('❌ 连不上后端：' + (e instanceof Error ? e.message : ''))
    }
  }

  const saveToken = () => {
    setAdminApiToken(token.trim() || null)
    setMsg({ ok: true, text: token.trim() ? '已保存管理员口令' : '已清除管理员口令' })
  }

  const seed = async () => {
    if (!window.confirm(`把项目内置的 ${builtinGames.length} 款游戏、${builtinPosts.length} 篇文章写入数据库？已存在的同名条目会被覆盖。`)) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.post<{ games: number; posts: number }>('/api/admin/import', { games: builtinGames, posts: builtinPosts }, true)
      setMsg({ ok: true, text: `已写入 ${r.games} 款游戏、${r.posts} 篇文章。` })
      // 写完让本页的统计重新去数一遍，否则上面还显示导入前的数字
      onSeeded()
    } catch (e) {
      setMsg({ ok: false, text: '导入失败：' + (e instanceof Error ? e.message : '') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="数据库 / API">
      <p className="text-sm text-muted">
        后端地址（VITE_API_URL）：{url ? <code className="text-fg">{url}</code> : <span className="text-dim">未配置——后台读不到也写不了任何数据</span>}
      </p>
      {enabled ? (
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnClass.secondary} onClick={test}>
              测试连接
            </button>
            {health && <span className="text-sm text-muted">{health}</span>}
          </div>

          <div>
            <label className="text-sm font-medium">管理员 API 口令（ADMIN_TOKEN）</label>
            <p className="mb-1 text-xs text-muted">后台读写都需要。填与后端 .env 里一致的 ADMIN_TOKEN；或者直接用管理员账号登录也行。</p>
            <div className="flex flex-wrap gap-2">
              <input
                type="password"
                className={cx(inputClass, 'max-w-xs flex-1')}
                value={token}
                onChange={(e) => setTok(e.target.value)}
                placeholder="与后端 .env 的 ADMIN_TOKEN 相同"
              />
              <button type="button" className={btnClass.secondary} onClick={saveToken}>
                保存
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">初始化数据库</label>
            <p className="mb-1 text-xs text-muted">首次使用时，把项目内置的游戏 / 文章一次性写入数据库。</p>
            <button type="button" className={btnClass.primary} onClick={seed} disabled={busy}>
              {busy ? '写入中…' : '导入内置数据到数据库'}
            </button>
          </div>

          {msg && <p className={cx('text-sm', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">
          想接数据库：部署 <code className="text-fg">server/</code> 后端，并在前端 <code className="text-fg">.env</code> 里设 <code className="text-fg">VITE_API_URL</code> 为你的站点地址，重新构建即可。详见 <code className="text-fg">server/README.md</code>。
        </p>
      )}
    </Card>
  )
}

function downloadJson(json: string, name: string) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function AdminData() {
  const connected = apiEnabled()
  const [total, setTotal] = useState<number | null>(null)
  const [posts, setPosts] = useState<Post[] | null>(null)
  const [statError, setStatError] = useState('')
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * 这一页只需要「有多少」，不需要把内容全拉下来：
   * 游戏用 pageSize=1 的分页结果里的 total，文章本来就一次给全。
   */
  const loadStats = useCallback(() => {
    if (!apiEnabled()) return
    setStatError('')
    void Promise.all([fetchAdminGames({ pageSize: 1 }), fetchAllPosts()])
      .then(([g, p]) => {
        setTotal(g.total)
        setPosts(p)
      })
      .catch((e: unknown) => {
        setTotal(null)
        setPosts(null)
        setStatError(e instanceof Error ? e.message : '读取失败')
      })
  }, [])

  useEffect(loadStats, [loadStats])

  /** 导出：翻完所有页再交给调用方，中途在按钮旁边报进度 */
  const collect = async (): Promise<string> => {
    setMsg(null)
    setBusy(true)
    try {
      const games = await fetchAllGames((loaded, all) => setMsg({ ok: true, text: `正在导出：${loaded} / ${all} 款…` }))
      return toJson(games)
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    try {
      const json = await collect()
      downloadJson(json, '8bitgo-games')
      setMsg({ ok: true, text: '已导出为 JSON 文件' })
    } catch (err) {
      setMsg({ ok: false, text: '导出失败：' + (err instanceof Error ? err.message : '') })
    }
  }

  const copy = async () => {
    try {
      const json = await collect()
      await navigator.clipboard.writeText(json)
      setMsg({ ok: true, text: '已复制到剪贴板' })
    } catch (err) {
      setMsg({ ok: false, text: (err instanceof Error ? err.message : '复制失败') + '（可改用下载）' })
    }
  }

  const downloadPosts = async () => {
    try {
      const list = await fetchAllPosts()
      downloadJson(toJson(list), '8bitgo-posts')
      setMsg({ ok: true, text: `已导出 ${list.length} 篇文章（含草稿）` })
    } catch (err) {
      setMsg({ ok: false, text: '导出失败：' + (err instanceof Error ? err.message : '') })
    }
  }

  const doImport = async (json: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const parsed: unknown = JSON.parse(json)
      if (!Array.isArray(parsed)) throw new Error('JSON 格式不正确：需要一个游戏对象数组')
      const r = await api.post<{ games: number }>('/api/admin/import', { games: parsed }, true)
      setMsg({ ok: true, text: `已写入数据库：${r.games} 款游戏` })
      setText('')
      loadStats()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file?: File) => {
    if (!file) return
    await doImport(await file.text())
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="space-y-4">
      <DbApiCard onSeeded={loadStats} />
      <div>
        <h1 className="text-xl font-bold">数据</h1>
        {connected ? (
          <p className="mt-1 text-sm text-muted">
            <strong className="text-fg">一切以数据库为准</strong>：后台看到的、前台展示的都是 <code className="text-fg">games</code> /{' '}
            <code className="text-fg">posts</code> 表里的内容。项目内置的 <code className="text-fg">src/data/games.ts</code> 现在只是一份「初始数据」，
            用上面的「导入内置数据到数据库」写进库以后就不再参与展示。
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            未配置后端（<code className="text-fg">VITE_API_URL</code>）。后台的读写全部走后端，没有后端时这一页什么也导不出、导不进 ——
            请先部署 <code className="text-fg">server/</code> 并在前端 <code className="text-fg">.env</code> 里配好地址。
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="当前状态">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">数据来源</dt>
              <dd className={cx('font-medium', connected ? 'text-brand-hover' : 'text-dim')}>{connected ? '数据库（MySQL）' : '未配置后端'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">游戏总数</dt>
              <dd>{total === null ? '—' : `${total} 款（含已下架）`}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">文章</dt>
              <dd>{posts === null ? '—' : `${posts.length} 篇（${posts.filter((p) => !p.published).length} 篇草稿）`}</dd>
            </div>
          </dl>
          {statError && <p className="mt-2 text-xs text-live">读不到统计：{statError}</p>}
          <p className="mt-4 text-xs text-muted">导出会把整库按每页 {EXPORT_PAGE_SIZE} 条翻完，游戏多时需要几秒。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnClass.primary} onClick={() => void download()} disabled={!connected || busy}>
              ⬇ 下载 JSON
            </button>
            <button type="button" className={btnClass.secondary} onClick={() => void copy()} disabled={!connected || busy}>
              复制 JSON
            </button>
          </div>
        </Card>

        <Card title="导入 JSON">
          <p className="mb-2 text-xs text-muted">
            粘贴一个游戏数组（与导出格式一致），或选择 .json 文件。会按 slug 写入 / 覆盖数据库中的对应条目，不在文件里的游戏不受影响。
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='[{"slug":"...","title":"...","platform":"nes","genres":["action"], ...}]'
            className={cx(inputClass, 'h-40 resize-y py-2 font-mono text-xs')}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnClass.primary} disabled={!connected || busy || !text.trim()} onClick={() => void doImport(text)}>
              导入粘贴内容
            </button>
            <button type="button" className={btnClass.secondary} disabled={!connected || busy} onClick={() => fileRef.current?.click()}>
              选择 .json 文件
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
        </Card>
      </div>

      <Card title="文章与用户数据">
        {/*
          v1 这里挂着一排读写 localStorage 的按钮（重置文章、下载 / 清空用户）。
          v2 这些数据只存在于数据库里，那些按钮要么导出一份空表、要么点完提示「已清空」
          而库里一条没少 —— 全部删掉，只留一个真的从库里导出的文章备份。
        */}
        <p className="mb-3 text-xs text-muted">
          文章与用户都存在数据库里。整站备份请直接 <code className="text-fg">mysqldump</code>；用户数据含邮箱与密码哈希，后台不提供导出。
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnClass.secondary} onClick={() => void downloadPosts()} disabled={!connected}>
            ⬇ 下载文章 JSON{posts ? `（${posts.length} 篇）` : ''}
          </button>
        </div>
      </Card>

      {msg && (
        <p role="status" className={cx('rounded-lg px-3 py-2 text-sm', msg.ok ? 'bg-online/15 text-online' : 'bg-live/10 text-live')}>
          {msg.text}
        </p>
      )}
    </div>
  )
}
