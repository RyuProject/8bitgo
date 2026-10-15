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
 *   html5       接入存档桥的网页游戏自己的存档包（当前是 PvZ ZIP）
 *
 * js-dos 的 fsChanges.pull/push/delete 三个钩子的签名正好和这里对得上，
 * 所以 DOS 那边是「玩家点存档 → 直接落到这里」，不需要中间层。
 */
import { apiBase, apiEnabled, getToken, TOKEN_CHANGED_EVENT } from './api'
import { idbDelete, idbGet, idbKeys, idbMark, idbPut } from '@/lib/idb'
import {
  decodeSaveArchive,
  encodeSaveArchive,
  type SaveArchiveCoordinate,
  type SaveArchiveDetails,
} from '@/emulator/saveEnvelope'
// 落点偏好单独一个无依赖的模块，好在 node 侧直接测；这里透传出去，调用方不用多认一个文件
import { getSaveTarget, setSaveTarget, type SaveTarget } from './saveTarget'
export { getSaveTarget, setSaveTarget, type SaveTarget }

/** 存档属于哪个引擎。格式不通用，所以必须分开存 */
export type SaveRuntime = 'emulatorjs' | 'jsdos' | 'cloudgame' | 'jsnes' | 'ruffle' | 'webretro' | 'j2me' | 'html5' | 'ppsspp' | 'dolphin'

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
 * ⚠️ RuntimeId 比这个宽：play 还没有统一存档格式，liveview 看别人直播也没有自己的状态。
 * HTML5 虽然在白名单里，但只有页面主动接入存档桥才会上报能力；普通第三方页面不会触发写入。
 */
const SAVE_RUNTIMES: ReadonlySet<string> = new Set([
  'emulatorjs',
  'jsdos',
  'cloudgame',
  'jsnes',
  'ruffle',
  'webretro',
  'j2me',
  'html5',
  'ppsspp',
  'dolphin',
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
  revision?: string
}

/** 后端配的上限是 4MB；这里先在前端拦一道，省得白传一趟 */
export const MAX_SAVE_BYTES = 4 * 1024 * 1024
/** PSP 的即时状态包含整台掌机内存，浏览器本地允许更大；云端仍守 4MB 的账号配额。 */
export const MAX_LOCAL_PSP_SAVE_BYTES = 96 * 1024 * 1024
/** Sockdrive 保存的是改过的磁盘扇区，大型 Windows 游戏可能超过普通 DOS 的 4MB。 */
export const MAX_LOCAL_JSDOS_SAVE_BYTES = 64 * 1024 * 1024
/** Dolphin 会把整台 GC / Wii 的内存与设备状态写进去；本地要容得下，云端仍守 4MB。 */
export const MAX_LOCAL_DOLPHIN_SAVE_BYTES = 256 * 1024 * 1024

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

function parseLocalKey(key: string): SaveArchiveCoordinate | null {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  const runtime = asSaveRuntime(key.slice(0, first))
  const slot = Number(key.slice(last + 1))
  if (!runtime || !Number.isInteger(slot) || slot < 0 || slot > 9) return null
  return { runtime, gameSlug: key.slice(first + 1, last), slot }
}

function cloudUrl(runtime: SaveRuntime, gameSlug: string, slot: number, suffix = ''): string {
  return `${apiBase()}/api/saves/${runtime}/${encodeURIComponent(gameSlug)}${suffix}?slot=${slot}`
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * JWT 的 uid 只拿来给浏览器本地的待同步档分账号，不当鉴权依据；真正身份仍由服务端验签。
 * 这里宁可解析失败后停掉自动补传，也不能猜错账号，把上一位用户的进度传给下一位。
 */
function currentCloudOwner(): string | null {
  const token = getToken()
  const payload = token.split('.')[1]
  if (!payload || typeof atob !== 'function') return null
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const uid = (JSON.parse(atob(padded)) as { uid?: unknown }).uid
    return typeof uid === 'string' && uid ? uid : null
  } catch {
    return null
  }
}

/** 云端待同步档只对原账号可见；普通“只存本地”的档仍然属于这台浏览器。 */
function localVisibleToCurrentAccount(entry: Awaited<ReturnType<typeof idbGet>>): boolean {
  if (!entry) return false
  if (!entry.dirty || !entry.cloudOwner) return true
  return entry.cloudOwner === currentCloudOwner()
}

const NO_CLOUD_REVISION = 'none'
const LEGACY_CLOUD_REVISION = 'legacy'
const cloudRevisions = new Map<string, string>()

function headerOf(res: Response, name: string): string {
  try {
    return res.headers?.get(name)?.trim() || ''
  } catch {
    return ''
  }
}

function rememberCloudRevision(key: string, revision: string | null | undefined): string {
  const next = revision?.trim() || LEGACY_CLOUD_REVISION
  cloudRevisions.set(key, next)
  return next
}

/** 第一次写某格前只取元信息；之后靠服务端乐观锁判“这期间是否被另一台设备改过”。 */
async function ensureCloudRevision(
  key: string,
  runtime: SaveRuntime,
  gameSlug: string,
  slot: number,
  hint?: string,
): Promise<string> {
  const known = cloudRevisions.get(key) || hint
  if (known) {
    cloudRevisions.set(key, known)
    return known
  }
  const res = await fetch(cloudUrl(runtime, gameSlug, slot, '/meta'), {
    headers: authHeaders(),
    cache: 'no-store',
  })
  if (res.status === 204 || res.status === 404) {
    cloudRevisions.set(key, NO_CLOUD_REVISION)
    return NO_CLOUD_REVISION
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const meta = await res.json().catch(() => ({})) as { revision?: string }
  return rememberCloudRevision(key, meta.revision || headerOf(res, 'x-save-revision'))
}

async function decodeCloudResponse(
  res: Response,
  coordinate: SaveArchiveCoordinate,
): Promise<{ data: Uint8Array; archive: Uint8Array; updatedAt: number; revision: string }> {
  const archive = new Uint8Array(await res.arrayBuffer())
  const decoded = await decodeSaveArchive(archive, coordinate)
  const key = localKey(coordinate.runtime as SaveRuntime, coordinate.gameSlug, coordinate.slot)
  const revision = rememberCloudRevision(key, headerOf(res, 'x-save-revision'))
  const stamp = Number(headerOf(res, 'x-save-updated-at') || 0)
  return { data: decoded.payload, archive, updatedAt: stamp || Date.now(), revision }
}

export interface PulledSave {
  data: Uint8Array
  where: SaveWhere
  updatedAt: number
  /** 云端响应的原始容器；个人页下载要保留文件头，模拟器加载只使用 data。 */
  archive?: Uint8Array
  revision?: string
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
  const visibleLocal = localVisibleToCurrentAccount(local) ? local : null

  if (visibleLocal?.dirty) {
    return { data: visibleLocal.data, where: 'local', updatedAt: visibleLocal.updatedAt, pending: true }
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
  if (getSaveTarget() === 'local' && visibleLocal) {
    return { data: visibleLocal.data, where: 'local', updatedAt: visibleLocal.updatedAt }
  }

  if (cloudSavesEnabled()) {
    try {
      const res = await fetch(cloudUrl(runtime, gameSlug, slot), { headers: authHeaders(), cache: 'no-store' })
      if (res.ok) {
        const got = await decodeCloudResponse(res, { runtime, gameSlug, slot })
        if (got.data.length > 0) {
          return { ...got, where: 'cloud' }
        }
      }
      // 404 = 云端确实没有这份存档，继续往下看本地
    } catch {
      /* 网络问题：退回本地 */
    }
  }

  return visibleLocal
    ? { data: visibleLocal.data, where: 'local', updatedAt: visibleLocal.updatedAt }
    : null
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
  return localVisibleToCurrentAccount(local) && local?.data?.length
    ? { data: local.data, updatedAt: local.updatedAt }
    : null
}

export async function fetchCloudSave(
  runtime: SaveRuntime,
  gameSlug: string,
  slot = 0,
): Promise<{ data: Uint8Array; archive: Uint8Array; updatedAt: number; revision: string } | null> {
  if (!cloudSavesEnabled()) return null
  const res = await fetch(cloudUrl(runtime, gameSlug, slot), { headers: authHeaders(), cache: 'no-store' })
  if (!res.ok) return null
  const got = await decodeCloudResponse(res, { runtime, gameSlug, slot })
  return got.data.length ? got : null
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
/**
 * 同一个存档位的写入**排队**，不并发。
 *
 * ⚠️ 为什么必须排队，而不是只靠 idbMark 的版本守卫：
 * 守卫能防住「清错标记」，防不住**两个 PUT 到达服务器的顺序反过来**。
 * 服务端是 last-writer-wins（saves.js 的 REPLACE），HTTP/2 多路复用和代理重试
 * 都可能让后发的先到 —— 那样云端最终留下的是更旧的那一份，而且没有任何迹象。
 * 排成一条链之后，「先按的先落地」这件事就由客户端保证了。
 *
 * 链尾会自己从 Map 里摘掉，所以这个 Map 不会随游戏数无界增长。
 */
const pushChains = new Map<string, Promise<void>>()
let revisionSequence = 0
let pendingSyncTimer: number | null = null
let pendingSyncRunning: Promise<PendingSaveSyncResult> | null = null
let pendingSyncDelayMs = 5_000
const MAX_PENDING_SYNC_DELAY_MS = 5 * 60_000

/**
 * 一次本地写入的身份。updatedAt 给人看，revision 才用来判“是不是我上传的那一份”。
 * randomUUID 覆盖正常浏览器；后面的序号 + 随机数是给老 WebView 的兜底。
 */
function newSaveRevision(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* 老 WebView 访问 crypto 也可能抛，退回下面的进程内唯一值 */
  }
  revisionSequence = (revisionSequence + 1) >>> 0
  return `${Date.now().toString(36)}-${revisionSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

function serializePush<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = pushChains.get(key) ?? Promise.resolve()
  // 前一个失败也要继续排下一个 —— 用同一个 run 接住两条分支
  const result = prev.then(run, run)
  const tail = result.then(
    () => {},
    () => {},
  )
  pushChains.set(key, tail)
  void tail.then(() => {
    if (pushChains.get(key) === tail) pushChains.delete(key)
  })
  return result
}

export interface PendingSaveSyncResult {
  attempted: number
  synced: number
  /** 冲突、超限或账号配额需要玩家处理，后台不再盲目重试。 */
  blocked: number
  failed: number
}

/**
 * 把浏览器里标成“待上云”的存档补传。
 *
 * 重试沿用第一次写入生成的 revision，不能每次都换一个：若服务器已经写成功、只是响应在路上丢了，
 * 同一个 revision 才能让服务端把补传认成幂等成功，而不是误判成另一台设备的冲突。
 */
export async function retryPendingSaves(): Promise<PendingSaveSyncResult> {
  if (pendingSyncRunning) return pendingSyncRunning
  const owner = currentCloudOwner()
  if (!cloudSavesEnabled() || !owner) return { attempted: 0, synced: 0, blocked: 0, failed: 0 }

  pendingSyncRunning = (async () => {
    const result: PendingSaveSyncResult = { attempted: 0, synced: 0, blocked: 0, failed: 0 }
    for (const key of await idbKeys()) {
      const coordinate = parseLocalKey(key)
      if (!coordinate) continue
      const first = await idbGet(key)
      if (!first?.dirty) continue
      if (first.cloudOwner !== owner) {
        // 没有 owner 的是升级前遗留档：继续保留在本地，等玩家手动保存一次再绑定当前账号。
        result.blocked++
        continue
      }
      if (first.syncBlocked) {
        result.blocked++
        continue
      }

      result.attempted++
      const pushed = await serializePush(key, async () => {
        let entry = await idbGet(key)
        if (!entry?.dirty || entry.syncBlocked || entry.cloudOwner !== owner) return null

        // 升级前留下的 dirty 记录没有 revision；只补一次，并把它落盘供后续网络重试复用。
        const revision = entry.revision || newSaveRevision()
        if (!entry.revision) {
          const kept = await idbPut(key, entry.data, entry.updatedAt, true, revision, {
            cloudRevision: entry.cloudRevision,
            cloudOwner: entry.cloudOwner,
            saveMetadata: entry.saveMetadata,
          })
          if (!kept) return { ok: false, where: null, error: 'local', cloudFailed: true } satisfies PushedSave
          entry = { ...entry, revision }
        }
        return uploadCloudEntry(
          key,
          coordinate,
          entry.data,
          entry.updatedAt,
          revision,
          entry.saveMetadata,
          entry.cloudRevision,
        )
      })

      if (!pushed) continue
      if (pushed.where === 'cloud' && !pushed.cloudFailed) result.synced++
      else {
        const current = await idbGet(key)
        if (current?.syncBlocked) result.blocked++
        else result.failed++
      }
    }
    return result
  })()

  try {
    const result = await pendingSyncRunning
    if (result.failed === 0) pendingSyncDelayMs = 5_000
    else pendingSyncDelayMs = Math.min(MAX_PENDING_SYNC_DELAY_MS, pendingSyncDelayMs * 2)
    return result
  } finally {
    pendingSyncRunning = null
  }
}

/** 同一轮失败只挂一个退避计时器，避免每个存档各自形成重试风暴。 */
function schedulePendingSaveSync(delayMs = pendingSyncDelayMs): void {
  if (typeof window === 'undefined' || pendingSyncTimer !== null || !cloudSavesEnabled()) return
  pendingSyncTimer = window.setTimeout(() => {
    pendingSyncTimer = null
    void retryPendingSaves().then((result) => {
      if (result.failed > 0) schedulePendingSaveSync()
    })
  }, Math.max(0, delayMs))
}

/**
 * 应用级自动补传：联网、重新登录、切回页面时都试一次。
 * 返回清理函数，React 开发模式重复挂载也不会留下两套监听器和计时器。
 */
export function installSaveAutoSync(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const wake = () => schedulePendingSaveSync(0)
  const tokenChanged = () => {
    // revision 属于账号；换账号后沿用旧账号缓存只会制造假冲突。
    cloudRevisions.clear()
    wake()
  }
  const visible = () => {
    if (document.visibilityState === 'visible') wake()
  }
  const storageChanged = (event: StorageEvent) => {
    if (event.key === '8bitgo.token') tokenChanged()
    else wake()
  }
  window.addEventListener('online', wake)
  window.addEventListener('storage', storageChanged)
  window.addEventListener(TOKEN_CHANGED_EVENT, tokenChanged)
  document.addEventListener('visibilitychange', visible)
  wake()
  return () => {
    window.removeEventListener('online', wake)
    window.removeEventListener('storage', storageChanged)
    window.removeEventListener(TOKEN_CHANGED_EVENT, tokenChanged)
    document.removeEventListener('visibilitychange', visible)
    if (pendingSyncTimer !== null) window.clearTimeout(pendingSyncTimer)
    pendingSyncTimer = null
  }
}

function metadataForStorage(details: SaveArchiveDetails | undefined): Record<string, string> | undefined {
  if (!details) return undefined
  const entries = Object.entries(details).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]))
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function uploadCloudEntry(
  key: string,
  coordinate: SaveArchiveCoordinate,
  data: Uint8Array,
  stamp: number,
  revision: string,
  metadata: SaveArchiveDetails | undefined,
  parentHint?: string,
): Promise<PushedSave> {
  const runtime = coordinate.runtime as SaveRuntime
  try {
    const parent = await ensureCloudRevision(key, runtime, coordinate.gameSlug, coordinate.slot, parentHint)
    const archive = await encodeSaveArchive(data, coordinate, metadata, stamp)
    if (archive.length > MAX_SAVE_BYTES) {
      await idbMark(key, true, stamp, revision, { cloudRevision: parent, syncBlocked: 'too-large' })
      return { ok: true, where: 'local', error: 'too-large', cloudFailed: true }
    }

    const res = await fetch(cloudUrl(runtime, coordinate.gameSlug, coordinate.slot), {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        'content-type': 'application/octet-stream',
        'x-save-revision': revision,
        'x-save-parent-revision': parent,
      },
      body: archive as BodyInit,
    })
    const response = await res.json().catch(() => ({})) as {
      code?: string
      error?: string
      revision?: string
      currentRevision?: string
    }
    if (res.ok) {
      const cloudRevision = rememberCloudRevision(
        key,
        response.revision || headerOf(res, 'x-save-revision') || revision,
      )
      // 只清「我自己推上去的那一份」的标记，别人的不动。
      await idbMark(key, false, stamp, revision, { cloudRevision, syncBlocked: undefined })
      return { ok: true, where: 'cloud' }
    }

    if (res.status === 409 && response.code === 'save_conflict') {
      const current = rememberCloudRevision(key, response.currentRevision || parent)
      await idbMark(key, true, stamp, revision, { cloudRevision: current, syncBlocked: 'conflict' })
      return { ok: true, where: 'local', error: response.error || 'conflict', cloudFailed: true }
    }

    const blocked = res.status === 413
      ? 'too-large'
      : res.status === 409
        ? 'quota'
        : undefined
    if (blocked) await idbMark(key, true, stamp, revision, { cloudRevision: parent, syncBlocked: blocked })
    else schedulePendingSaveSync()
    return {
      ok: true,
      where: 'local',
      error: response.error || `HTTP ${res.status}`,
      cloudFailed: true,
    }
  } catch {
    schedulePendingSaveSync()
    return { ok: true, where: 'local', error: 'network', cloudFailed: true }
  }
}

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
  metadata?: SaveArchiveDetails,
): Promise<PushedSave> {
  if (data.length === 0) return { ok: false, where: null, error: 'empty' }
  const localLimit = runtime === 'dolphin'
    ? MAX_LOCAL_DOLPHIN_SAVE_BYTES
    : runtime === 'ppsspp'
      ? MAX_LOCAL_PSP_SAVE_BYTES
      : runtime === 'jsdos'
        ? MAX_LOCAL_JSDOS_SAVE_BYTES
        : MAX_SAVE_BYTES
  if (data.length > localLimit) return { ok: false, where: null, error: 'too-large' }

  const key = localKey(runtime, gameSlug, slot)
  return serializePush(key, () => pushOne(key, runtime, gameSlug, data, slot, target, metadata))
}

async function pushOne(
  key: string,
  runtime: SaveRuntime,
  gameSlug: string,
  data: Uint8Array,
  slot: number,
  target: Exclude<SaveTarget, 'download'>,
  metadata?: SaveArchiveDetails,
): Promise<PushedSave> {
  // 选了云端但此刻没登录（退出 / 令牌过期）就只能落本地，界面会照实说
  const toCloud = target === 'cloud' && cloudSavesEnabled()
  /**
   * 「待同步」只给**真打算上云**的那一份。
   * 游客、以及明确选了「只存本地」的玩家都不算 —— 他们没打算往云端存，
   * 云端那份（别的设备存的）该正常接管，不该被这份本地存档挡住。
   *
   * ⚠️⚠️ 但「想上云、这次没上成」**也算**。2026-09-11 审出来的丢进度路径：
   *   1. 玩家选了云端（`8bitgo.save.target = 'cloud'` 落进 localStorage），云端存着第 3 关；
   *   2. 某次打开站点时 /api/auth/me 抖了一下 —— hydrateAuth 对**任何**异常都
   *      `setToken(null)`，玩家被静默登出，而那个 localStorage 的落点选择**不会**被清；
   *   3. 他接着玩到第 8 关存档：`toCloud` 为假 → 落本地、不打标记（界面照实说「存在这个浏览器里」，
   *      没骗人）；
   *   4. 重新登录再进游戏，DOS 那条路开机**自动**调 pullSave：`local.dirty` 是 false，
   *      而 `getSaveTarget()` 仍然是 'cloud' → 下面那道「只存本地」的保护也不成立 →
   *      去读云端那份第 3 关盖上来。两小时白玩，全程零提示。
   * 所以这里要问的不是「这次上没上成」，而是「他想不想上」。
   */
  const wantedCloud = getSaveTarget() === 'cloud'
  // 时间戳给界面显示；revision 才是凭证 —— 两个标签页可能在同一毫秒各存一次。
  const stamp = Date.now()
  const revision = newSaveRevision()
  const previous = await idbGet(key)
  const cloudOwner = wantedCloud ? currentCloudOwner() ?? undefined : undefined
  const cloudRevision = cloudRevisions.get(key) || (
    previous && previous.cloudOwner === cloudOwner ? previous.cloudRevision : undefined
  )
  const localOk = await idbPut(key, data, stamp, toCloud || wantedCloud, revision, {
    cloudRevision,
    cloudOwner,
    saveMetadata: metadataForStorage(metadata),
  })

  if (!toCloud) {
    if (wantedCloud) schedulePendingSaveSync()
    return { ok: localOk, where: localOk ? 'local' : null }
  }
  if (!localOk) return { ok: false, where: null, error: 'local' }
  return uploadCloudEntry(
    key,
    { runtime, gameSlug, slot },
    data,
    stamp,
    revision,
    metadata,
    cloudRevision,
  )
}

/** 删存档：两边都删。游戏里「清空存档」用这个 —— 玩家的意思是这份进度不要了 */
export async function deleteSave(runtime: SaveRuntime, gameSlug: string, slot = 0): Promise<void> {
  const key = localKey(runtime, gameSlug, slot)
  await idbDelete(key)
  cloudRevisions.delete(key)
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
    cloudRevisions.set(localKey(runtime, gameSlug, slot), NO_CLOUD_REVISION)
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
  const visibleLocal = localVisibleToCurrentAccount(local) ? local : null
  if (visibleLocal?.dirty) {
    return { where: 'local', updatedAt: visibleLocal.updatedAt, size: visibleLocal.data.length, pending: true }
  }

  // 和 pullSave 的显式本地优先保持一致。否则按钮写“云端”，点下去却按玩家选择读本地。
  if (getSaveTarget() === 'local' && visibleLocal) {
    return { where: 'local', updatedAt: visibleLocal.updatedAt, size: visibleLocal.data.length }
  }

  if (cloudSavesEnabled()) {
    try {
      const res = await fetch(cloudUrl(runtime, gameSlug, slot, '/meta'), {
        headers: authHeaders(),
        cache: 'no-store',
      })
      // 204 = 云端明确说「这一格没有存档」（不是错误，所以服务端不回 404 了）。
      // 必须先判它再 json()：204 没有响应体，解析会抛，落进下面那个 catch 之后
      // 看起来和「请求失败」一模一样 —— 真出问题时反而查不出来
      if (res.status !== 204 && res.ok) {
        const j = (await res.json()) as { size: number; updatedAt: number; revision?: string }
        rememberCloudRevision(localKey(runtime, gameSlug, slot), j.revision || headerOf(res, 'x-save-revision'))
        return { where: 'cloud', updatedAt: j.updatedAt, size: j.size }
      }
    } catch {
      /* 往下看本地 */
    }
  }

  return visibleLocal
    ? { where: 'local', updatedAt: visibleLocal.updatedAt, size: visibleLocal.data.length }
    : null
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
