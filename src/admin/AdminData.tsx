import { useRef, useState } from 'react'
import { STORAGE_KEY, exportGamesJson, hasLocalChanges, hydrateGames, importGamesJson, resetGames, useAllGames } from '@/services/store'
import { POSTS_KEY, hydratePosts, postsStore, useAllPosts } from '@/services/posts'
import { USERS_KEY, usersStore } from '@/services/auth'
import { api, apiEnabled, apiLabel, getAdminApiToken, setAdminApiToken } from '@/services/api'
import { games as builtinGames } from '@/data/games'
import { posts as builtinPosts } from '@/data/posts'
import { Card, btnClass, inputClass } from './ui'
import { cx } from '@/lib/format'

/** 数据库 / API 连接状态与初始化 */
function DbApiCard() {
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
      // 写完立刻把库里的数据重新拉一遍，界面马上就能看到
      await Promise.all([hydrateGames(true), hydratePosts(true)])
      setMsg({ ok: true, text: `已写入 ${r.games} 款游戏、${r.posts} 篇文章。` })
    } catch (e) {
      setMsg({ ok: false, text: '导入失败：' + (e instanceof Error ? e.message : '') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="数据库 / API">
      <p className="text-sm text-muted">
        后端地址（VITE_API_URL）：{url ? <code className="text-fg">{url}</code> : <span className="text-dim">未配置——当前用浏览器本地存储</span>}
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
            <p className="mb-1 text-xs text-muted">后台写操作需要。填与后端 .env 里一致的 ADMIN_TOKEN；或者直接用管理员账号登录也行。</p>
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
  const all = useAllGames()
  const posts = useAllPosts()
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const local = hasLocalChanges()

  const download = () => downloadJson(exportGamesJson(), '8bitgo-games')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportGamesJson())
      setMsg({ ok: true, text: '已复制到剪贴板' })
    } catch {
      setMsg({ ok: false, text: '复制失败，请使用下载' })
    }
  }

  const doImport = async (json: string) => {
    try {
      if (connected) {
        // 连了后端就必须写库：只改内存的话刷新一下就没了
        const parsed: unknown = JSON.parse(json)
        if (!Array.isArray(parsed)) throw new Error('JSON 格式不正确：需要一个游戏对象数组')
        const r = await api.post<{ games: number }>('/api/admin/import', { games: parsed }, true)
        await hydrateGames(true)
        setMsg({ ok: true, text: `已写入数据库：${r.games} 款游戏` })
      } else {
        const n = importGamesJson(json)
        setMsg({ ok: true, text: `导入成功：${n} 款游戏` })
      }
      setText('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '导入失败' })
    }
  }

  const onFile = async (file?: File) => {
    if (!file) return
    await doImport(await file.text())
    if (fileRef.current) fileRef.current.value = ''
  }

  const reset = () => {
    if (!window.confirm('确定重置？后台所做的全部修改将被清除，恢复为代码里的内置数据。')) return
    resetGames()
    setMsg({ ok: true, text: '已恢复为内置数据' })
  }

  let bytes = 0
  try {
    bytes = new Blob([localStorage.getItem(STORAGE_KEY) ?? '']).size
  } catch {
    /* ignore */
  }

  return (
    <div className="space-y-4">
      <DbApiCard />
      <div>
        <h1 className="text-xl font-bold">数据</h1>
        {connected ? (
          <p className="mt-1 text-sm text-muted">
            已连接后端，<strong className="text-fg">一切以数据库为准</strong>：后台看到的、前台展示的都是 <code className="text-fg">games</code> /{' '}
            <code className="text-fg">posts</code> 表里的内容。项目内置的 <code className="text-fg">src/data/games.ts</code> 只在没配{' '}
            <code className="text-fg">VITE_API_URL</code> 时才会用到。
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            后台的修改保存在当前浏览器的 localStorage（键：<code className="text-fg">{STORAGE_KEY}</code>），换浏览器或清除站点数据后会丢失。
            想长期保存请导出 JSON，替换到 <code className="text-fg">src/data/games.ts</code>。
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="当前状态">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">数据来源</dt>
              <dd className={cx('font-medium', connected ? 'text-brand-hover' : local ? 'text-coin' : 'text-fg')}>
                {connected ? '数据库（MySQL）' : local ? '本地修改版' : '内置数据（src/data/games.ts）'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">游戏数量</dt>
              <dd>
                {all.length} 款（{all.filter((g) => g.hidden).length} 款已下架）
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">占用空间</dt>
              <dd>{local ? `${(bytes / 1024).toFixed(1)} KB` : '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btnClass.primary} onClick={download}>
              ⬇ 下载 JSON
            </button>
            <button type="button" className={btnClass.secondary} onClick={copy}>
              复制 JSON
            </button>
            <button type="button" className={btnClass.danger} onClick={reset} disabled={!local}>
              重置为内置数据
            </button>
          </div>
        </Card>

        <Card title="导入 JSON">
          <p className="mb-2 text-xs text-muted">
            粘贴一个游戏数组（与导出格式一致），或选择 .json 文件。
            {connected ? '已连接数据库：会按 slug 写入 / 覆盖数据库中的对应条目。' : '导入会整体替换当前列表。'}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='[{"slug":"...","title":"...","platform":"nes","genres":["action"], ...}]'
            className={cx(inputClass, 'h-40 resize-y py-2 font-mono text-xs')}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnClass.primary} disabled={!text.trim()} onClick={() => void doImport(text)}>
              导入粘贴内容
            </button>
            <button type="button" className={btnClass.secondary} onClick={() => fileRef.current?.click()}>
              选择 .json 文件
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
        </Card>
      </div>

      <Card title="文章与用户数据">
        <p className="mb-3 text-xs text-muted">
          文章保存在 <code className="text-fg">{POSTS_KEY}</code>，用户保存在 <code className="text-fg">{USERS_KEY}</code>（含密码哈希，导出后请妥善保管）。
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnClass.secondary} onClick={() => downloadJson(postsStore.exportJson(), '8bitgo-posts')}>
            ⬇ 下载文章 JSON（{posts.length} 篇）
          </button>
          <button
            type="button"
            className={btnClass.danger}
            disabled={!postsStore.hasLocalChanges()}
            onClick={() => {
              if (window.confirm('确定把文章重置为内置内容？后台写的文章会被清除。')) {
                postsStore.reset()
                setMsg({ ok: true, text: '文章已重置' })
              }
            }}
          >
            重置文章
          </button>
          <button type="button" className={btnClass.secondary} onClick={() => downloadJson(usersStore.exportJson(), '8bitgo-users')}>
            ⬇ 下载用户 JSON（{usersStore.load().length} 位）
          </button>
          <button
            type="button"
            className={btnClass.danger}
            disabled={!usersStore.hasLocalChanges()}
            onClick={() => {
              if (window.confirm('确定清空全部用户？所有账号、收藏与 G 币都会删除，且会退出当前登录。')) {
                usersStore.reset()
                try {
                  localStorage.removeItem('8bitgo.session')
                } catch {
                  /* ignore */
                }
                setMsg({ ok: true, text: '用户数据已清空' })
              }
            }}
          >
            清空用户
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
