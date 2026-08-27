/**
 * 存档：一套接口，两种去处。
 *
 *   已登录  → 云端（服务器上的 saves 表）。**存档跟着账号走**，换电脑、换浏览器都还在。
 *   没登录  → 浏览器里（IndexedDB）。够用，但浏览器清理站点数据时会一起没掉，
 *             所以界面上要提示，并且随时可以导出成文件自己保管。
 *
 * 两种引擎的存档格式完全不同，用 runtime 分开存、互不覆盖：
 *   emulatorjs  内存快照 —— 精确到某一帧
 *   jsdos       DOS 文件系统的变更包 —— 玩家得先在游戏里存盘
 *
 * js-dos 的 fsChanges.pull/push/delete 三个钩子的签名正好和这里对得上，
 * 所以 DOS 那边是「玩家点存档 → 直接落到这里」，不需要中间层。
 */
import { apiBase, apiEnabled, getToken } from './api'
import { idbDelete, idbGet, idbPut } from '@/lib/idb'

/** 存档属于哪个引擎。格式不通用，所以必须分开存 */
export type SaveRuntime = 'emulatorjs' | 'jsdos' | 'cloudgame' | 'jsnes' | 'ruffle' | 'webretro' | 'j2me'

/** 存档存在哪儿 */
export type SaveWhere = 'cloud' | 'local'

export interface SaveMeta {
  runtime: SaveRuntime
  gameSlug: string
  slot: number
  size: number
  updatedAt: number
  where: SaveWhere
}

/** 后端配的上限是 4MB；这里先在前端拦一道，省得白传一趟 */
export const MAX_SAVE_BYTES = 4 * 1024 * 1024

/**
 * 能不能用云存档。
 * 两个条件缺一不可：配了后端 + 当前已登录 —— 云存档是跟着账号的，游客没有。
 */
export function cloudSavesEnabled(): boolean {
  return apiEnabled() && Boolean(getToken())
}

/**
 * 本地存档的 key。带上引擎名，免得同一个游戏的 DOS 变更包和内存快照互相覆盖。
 * 云端不用这个 —— 它按 (user_id, runtime, game_slug, slot) 做主键。
 */
function localKey(runtime: SaveRuntime, gameSlug: string, slot: number): string {
  return `${runtime}:${gameSlug}:${slot}`
}

function cloudUrl(runtime: SaveRuntime, gameSlug: string, slot: number, suffix = ''): string {
  return `${apiBase()}/api/saves/${runtime}/${encodeURIComponent(gameSlug)}${suffix}?slot=${slot}`
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * 读存档。登录了先问云端，云端没有或者连不上就退回浏览器里的那份。
 *
 * 「连不上就用本地」是有意的：网络抖一下不该让玩家看到「存档不见了」，
 * 本地那份至少是他自己这台机器上最后玩到的进度。
 */
export async function pullSave(
  runtime: SaveRuntime,
  gameSlug: string,
  slot = 0,
): Promise<{ data: Uint8Array; where: SaveWhere; updatedAt: number } | null> {
  if (cloudSavesEnabled()) {
    try {
      const res = await fetch(cloudUrl(runtime, gameSlug, slot), { headers: authHeaders(), cache: 'no-store' })
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.length > 0) {
          const stamp = Number(res.headers.get('x-save-updated-at') || 0)
          return { data: buf, where: 'cloud', updatedAt: stamp || Date.now() }
        }
      }
      // 404 = 云端确实没有这份存档，继续往下看本地
    } catch {
      /* 网络问题：退回本地 */
    }
  }
  const local = await idbGet(localKey(runtime, gameSlug, slot))
  return local ? { data: local.data, where: 'local', updatedAt: local.updatedAt } : null
}

/**
 * 写存档。
 *
 * **本地那份永远写**，云端在登录时额外写一份 —— 这样即使云端挂了、
 * 或者玩家中途退出登录，他这台机器上的进度也不会丢。
 */
export async function pushSave(
  runtime: SaveRuntime,
  gameSlug: string,
  data: Uint8Array,
  slot = 0,
): Promise<{ ok: boolean; where: SaveWhere | null; error?: string }> {
  if (data.length === 0) return { ok: false, where: null, error: 'empty' }
  if (data.length > MAX_SAVE_BYTES) return { ok: false, where: null, error: 'too-large' }

  const localOk = await idbPut(localKey(runtime, gameSlug, slot), data)

  if (cloudSavesEnabled()) {
    try {
      const res = await fetch(cloudUrl(runtime, gameSlug, slot), {
        method: 'PUT',
        headers: { ...authHeaders(), 'content-type': 'application/octet-stream' },
        // fetch 不收 Uint8Array 的类型声明，但运行时是可以的
        body: data as BodyInit,
      })
      if (res.ok) return { ok: true, where: 'cloud' }
      const msg = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined)
      // 云端拒了（超配额、太大）但本地写成功了：算部分成功，把原因带回去显示
      return { ok: localOk, where: localOk ? 'local' : null, error: msg }
    } catch {
      return { ok: localOk, where: localOk ? 'local' : null, error: 'network' }
    }
  }

  return { ok: localOk, where: localOk ? 'local' : null }
}

/** 删存档：两边都删 */
export async function deleteSave(runtime: SaveRuntime, gameSlug: string, slot = 0): Promise<void> {
  await idbDelete(localKey(runtime, gameSlug, slot))
  if (!cloudSavesEnabled()) return
  try {
    await fetch(cloudUrl(runtime, gameSlug, slot), { method: 'DELETE', headers: authHeaders() })
  } catch {
    /* 删不掉就算了，下次覆盖会顶掉 */
  }
}

/**
 * 有没有存档、是什么时候的。
 * 界面上要显示「云端有存档 · 3 分钟前」，为这个下载整份二进制太浪费，所以走 /meta。
 */
export async function saveInfo(
  runtime: SaveRuntime,
  gameSlug: string,
  slot = 0,
): Promise<{ where: SaveWhere; updatedAt: number; size: number } | null> {
  if (cloudSavesEnabled()) {
    try {
      const res = await fetch(cloudUrl(runtime, gameSlug, slot, '/meta'), {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (res.ok) {
        const j = (await res.json()) as { size: number; updatedAt: number }
        return { where: 'cloud', updatedAt: j.updatedAt, size: j.size }
      }
    } catch {
      /* 往下看本地 */
    }
  }
  const local = await idbGet(localKey(runtime, gameSlug, slot))
  return local ? { where: 'local', updatedAt: local.updatedAt, size: local.data.length } : null
}

/** 我的云存档清单（个人页要用；没登录时返回空） */
export async function listCloudSaves(): Promise<SaveMeta[]> {
  if (!cloudSavesEnabled()) return []
  try {
    const res = await fetch(`${apiBase()}/api/saves`, { headers: authHeaders(), cache: 'no-store' })
    if (!res.ok) return []
    const rows = (await res.json()) as Array<Omit<SaveMeta, 'where'>>
    return rows.map((r) => ({ ...r, where: 'cloud' as const }))
  } catch {
    return []
  }
}
