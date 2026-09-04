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
import { idbDelete, idbGet, idbMark, idbPut } from '@/lib/idb'
// 落点偏好单独一个无依赖的模块，好在 node 侧直接测；这里透传出去，调用方不用多认一个文件
import { getSaveTarget, setSaveTarget, type SaveTarget } from './saveTarget'
export { getSaveTarget, setSaveTarget, type SaveTarget }

/** 存档属于哪个引擎。格式不通用，所以必须分开存 */
export type SaveRuntime = 'emulatorjs' | 'jsdos' | 'cloudgame' | 'jsnes' | 'ruffle' | 'webretro' | 'j2me'

/** 存档存在哪儿 */
export type SaveWhere = 'cloud' | 'local'

/**
 * 这一次实际该往哪儿存。
 *
 * 没选过、或者选了云端但现在没登录（退出登录 / 令牌过期）→ 回落到本地。
 * **绝不**反过来把没选过的人默认成云端。
 */
export function effectiveSaveTarget(): Exclude<SaveTarget, 'download'> {
  const picked = getSaveTarget()
  if (picked === 'cloud' && cloudSavesEnabled()) return 'cloud'
  return 'local'
}

/**
 * 合法的存档引擎名，和服务端 routes/saves.js 的 RUNTIMES 一字不差。
 *
 * ⚠️ RuntimeId 比这个宽：html5（第三方游戏页，自己管自己的存储）和 liveview
 * （看别人直播，压根没有自己的机器状态）都在 RuntimeId 里，但都不产生存档。
 * 所以从 RuntimeId 过来的值必须过 asSaveRuntime()，不能直接 as 断言 ——
 * 断言过去的结果是：看直播的人一进页面就发一个注定被服务端 400 掉的存档查询。
 */
const SAVE_RUNTIMES: ReadonlySet<string> = new Set([
  'emulatorjs',
  'jsdos',
  'cloudgame',
  'jsnes',
  'ruffle',
  'webretro',
  'j2me',
])

/** 把 RuntimeId 之类的字符串收窄成存档引擎名；不是存档引擎就返回 null */
export function asSaveRuntime(id: string | null | undefined): SaveRuntime | null {
  return id && SAVE_RUNTIMES.has(id) ? (id as SaveRuntime) : null
}

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

export interface PulledSave {
  data: Uint8Array
  where: SaveWhere
  updatedAt: number
  /** 这份是本地的、而且还没同步到云端 —— 界面上值得提一句 */
  pending?: boolean
}

/**
 * 读存档。
 *
 * 顺序很讲究，改之前先看这段：
 *
 *   1. 本地那份**带待同步标记**时，它赢。这份是玩家上次玩到的进度，
 *      而云端因为断网 / 超配额 / 令牌过期没收到，云端那份必然更旧。
 *      ⚠️ 以前这里是无条件先问云端 —— 结果是断网存过一次的玩家，
 *      下次进来读到的是旧的云存档，再存一次就把本地那份更新的也覆盖了，
 *      进度真的没了。这是这个文件里最贵的一个 bug，别把顺序改回去。
 *   2. 否则问云端。换台电脑、换个浏览器要能接着玩，就靠这一步。
 *   3. 云端没有（404）或者连不上，退回本地。网络抖一下不该让玩家看到「存档不见了」。
 *
 * 为什么用标记而不是比 updatedAt：本地时间戳来自玩家自己的机器，
 * 时钟差几小时的机器很常见，比出来的结果可能正好是反的。
 */
export async function pullSave(runtime: SaveRuntime, gameSlug: string, slot = 0): Promise<PulledSave | null> {
  const local = await idbGet(localKey(runtime, gameSlug, slot))

  if (local?.dirty) {
    return { data: local.data, where: 'local', updatedAt: local.updatedAt, pending: true }
  }

  /**
   * 明确选了「只存本地」的人，读档也要先读本地。
   *
   * ⚠️ 这一条是配合落点选择加的，不加会**静默丢进度**：选了本地之后存下来的那份
   * 不带 dirty 标记（它本来就没打算上云），于是下面那段会照旧去问云端，
   * 把一份**更旧的**云端存档读回来 —— 玩家明明刚存过，回来却退回了上次上云的进度。
   *
   * 没选过、或者选的是云端，仍然走「云端优先」：那才是换台电脑接着玩的前提。
   */
  if (getSaveTarget() === 'local' && local) {
    return { data: local.data, where: 'local', updatedAt: local.updatedAt }
  }

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

  return local ? { data: local.data, where: 'local', updatedAt: local.updatedAt } : null
}

/**
 * 只取云端那份，取不到就是取不到。
 *
 * 个人页的「我的云存档 → 下载」用这个：那个列表是从服务器拉的，
 * 点下载却给一份浏览器里的存档，等于把不同的东西贴上同一个标签。
 */
/**
 * 只取**这个浏览器里**的那份，取不到就是取不到。
 *
 * 和 pullSave 的分工：那个是「按玩家选的落点决定读哪儿」，给自动读档用；
 * 这个是玩家在存档面板里明确点了「本地存档 · 加载」—— 他要的就是本地那份，
 * 这时候再去问云端等于答非所问。
 */
export async function pullLocalSave(
  runtime: SaveRuntime,
  gameSlug: string,
  slot = 0,
): Promise<{ data: Uint8Array; updatedAt: number } | null> {
  const local = await idbGet(localKey(runtime, gameSlug, slot))
  return local?.data?.length ? { data: local.data, updatedAt: local.updatedAt } : null
}

export async function fetchCloudSave(
  runtime: SaveRuntime,
  gameSlug: string,
  slot = 0,
): Promise<{ data: Uint8Array; updatedAt: number } | null> {
  if (!cloudSavesEnabled()) return null
  const res = await fetch(cloudUrl(runtime, gameSlug, slot), { headers: authHeaders(), cache: 'no-store' })
  if (!res.ok) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.length) return null
  return { data: buf, updatedAt: Number(res.headers.get('x-save-updated-at') || 0) || Date.now() }
}

export interface PushedSave {
  ok: boolean
  where: SaveWhere | null
  error?: string
  /**
   * 玩家是登录状态、本该进云端，但云端这一路失败了（超配额、令牌过期、断网）。
   * 界面必须把这件事说出来 —— 光说「已存在这个浏览器里」，
   * 一个已登录的玩家会以为存档跟着账号走，其实并没有。
   */
  cloudFailed?: boolean
}

/**
 * 写存档。
 *
 * **本地那份永远先写**，云端在登录时额外写一份 —— 这样即使云端挂了、
 * 或者玩家中途退出登录，他这台机器上的进度也不会丢。
 *
 * 待同步标记的落定顺序是刻意的：先按「待同步」写进本地，云端确认成功之后才清掉。
 * 反过来（先乐观地标成已同步、失败再改回来）的话，PUT 飞在半空中时玩家关掉标签页，
 * 本地就留下一份「以为已经上云」的记录，下次读档会去读更旧的云端那份。
 */
export async function pushSave(
  runtime: SaveRuntime,
  gameSlug: string,
  data: Uint8Array,
  slot = 0,
  /**
   * 存到哪儿。不传就按玩家选过的来（`effectiveSaveTarget`）——
   * **没选过就是本地**，不再像以前那样「只要登录了就默认上云」。
   * DOS 那条自动固化的路（adapters/jsdos.ts）没有界面可问，走的就是这个默认。
   */
  target: Exclude<SaveTarget, 'download'> = effectiveSaveTarget(),
): Promise<PushedSave> {
  if (data.length === 0) return { ok: false, where: null, error: 'empty' }
  if (data.length > MAX_SAVE_BYTES) return { ok: false, where: null, error: 'too-large' }

  const key = localKey(runtime, gameSlug, slot)
  // 选了云端但此刻没登录（退出 / 令牌过期）就只能落本地，界面会照实说
  const toCloud = target === 'cloud' && cloudSavesEnabled()
  /**
   * 「待同步」只给**真打算上云**的那一份。
   * 游客、以及明确选了「只存本地」的玩家都不算 —— 他们没打算往云端存，
   * 云端那份（别的设备存的）该正常接管，不该被这份本地存档挡住。
   */
  const localOk = await idbPut(key, data, Date.now(), toCloud)

  if (!toCloud) return { ok: localOk, where: localOk ? 'local' : null }

  try {
    const res = await fetch(cloudUrl(runtime, gameSlug, slot), {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/octet-stream' },
      // fetch 不收 Uint8Array 的类型声明，但运行时是可以的
      body: data as BodyInit,
    })
    if (res.ok) {
      await idbMark(key, false)
      return { ok: true, where: 'cloud' }
    }
    const msg = await res
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => undefined)
    // 云端拒了（超配额、太大、令牌过期）但本地写成功了：算部分成功。
    // 本地那份保持「待同步」，读档时就会优先用它。
    return {
      ok: localOk,
      where: localOk ? 'local' : null,
      error: msg || `HTTP ${res.status}`,
      cloudFailed: true,
    }
  } catch {
    return { ok: localOk, where: localOk ? 'local' : null, error: 'network', cloudFailed: true }
  }
}

/** 删存档：两边都删。游戏里「清空存档」用这个 —— 玩家的意思是这份进度不要了 */
export async function deleteSave(runtime: SaveRuntime, gameSlug: string, slot = 0): Promise<void> {
  await idbDelete(localKey(runtime, gameSlug, slot))
  await deleteCloudSave(runtime, gameSlug, slot)
}

/**
 * 只删云端那份，浏览器里的不动。
 *
 * 个人页「我的云存档 → 删除」用这个。那个确认框写的是「浏览器里的那份不受影响」，
 * 以前调的却是两边都删的 deleteSave —— 说一套做一套，而且删掉的是玩家
 * 在这台机器上唯一的进度备份。
 */
export async function deleteCloudSave(runtime: SaveRuntime, gameSlug: string, slot = 0): Promise<void> {
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
): Promise<{ where: SaveWhere; updatedAt: number; size: number; pending?: boolean } | null> {
  // 优先级和 pullSave 完全一致 —— 否则按钮上写「云端 · 3 分钟前」，
  // 点下去读到的却是本地那份，玩家会以为读错了档
  const local = await idbGet(localKey(runtime, gameSlug, slot))
  if (local?.dirty) {
    return { where: 'local', updatedAt: local.updatedAt, size: local.data.length, pending: true }
  }

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
