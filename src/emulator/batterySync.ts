/**
 * 游戏内存档（电池存档 / SRAM，`.srm`）跟着账号走。
 *
 * 电池存档本身存在 IDBFS `/data/saves`（见 ejsSaveFs.ts），那是**按浏览器、按域名**的：
 * 8bitgo.com 和 cn.8bitgo.com 各一份，换电脑就没了。玩家在 RPG 里按的「保存」写的正是它，
 * 而本站的云存档原来只收即时存档（快照）。这里把 `.srm` 也放进 `/api/saves`：
 *
 *   runtime = emulatorjs，slot = 9（即时存档用 0），game_slug = 存档 slug（含语言变体），
 *   载荷 = `.srm` 原样字节，信封 format = `battery:<核心目录>/<文件名>`（开机前写回哪儿）。
 *
 * ── 时序 ─────────────────────────────────────────────────────
 *   开局：ROM 下载的同时拉云端那份；callMain 之前（核心读 .srm 之前）比较、必要时写进 FS。
 *   运行：适配器每次刷电池存档（30 秒一次、切后台、离页、拆播放器）后，内容变了就推一次。
 *
 * ── 谁赢 ─────────────────────────────────────────────────────
 * 不比时间戳（玩家机器的时钟不可信），比「上次同步时的内容指纹」（存 localStorage）：
 *   本地没变、云端变了 → 用云端（别的设备玩过）；
 *   本地变了、云端没变 → 用本地，随后推上去；
 *   两边都变了 → 用本地，云端那份在旁边留一个 `.cloud-<时间>.bak` 文件，不丢。
 * 推送全部是**带条件**的：以开局读到的 revision 为前提，期间另一台设备先写了，服务端回 409，
 * 这一局就停止推送，绝不静默覆盖。开局没读到云端（断网、超时、5xx）的一局**不推送**——
 * 那时不知道云端有什么，推上去可能盖掉更新的进度。
 */
import { diagLog } from '@/services/startupDiagnostics'
import { MAX_SAVE_BYTES, cloudSavesEnabled, fetchCloudSaveStrict, getSaveTarget, pushSave } from '@/services/saves'

/** 云端 emulatorjs 存档里留给电池存档的那一格（即时存档用 0） */
export const BATTERY_SAVE_SLOT = 9
const FORMAT_PREFIX = 'battery:'
const ROOT = '/data/saves'
const META_PREFIX = '8bitgo.battery-sync.v1:'
/** 开局最多等云端多久；等不到就本局只用本地、且不推送 */
export const BATTERY_PULL_TIMEOUT_MS = 6_000
const MAX_PUSH_FAILURES = 3

/** 内容指纹：FNV-1a 32 位 + 长度，只用来判断「变没变」 */
export function batteryHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${bytes.length}`
}

export type BatteryDecision = 'none' | 'in-sync' | 'use-cloud' | 'keep-local' | 'conflict'

export function decideBatterySync(local: Uint8Array | null, cloud: Uint8Array | null, lastHash: string | undefined): BatteryDecision {
  if (!cloud) return local ? 'keep-local' : 'none'
  if (!local) return 'use-cloud'
  const l = batteryHash(local)
  const c = batteryHash(cloud)
  if (l === c) return 'in-sync'
  if (lastHash && l === lastHash) return 'use-cloud'
  if (lastHash && c === lastHash) return 'keep-local'
  return 'conflict'
}

/** `battery:mGBA/x.srm` → `mGBA/x.srm`。只接受 /data/saves 底下、不越级的相对路径 */
export function batteryRelPath(format: string | undefined): string | null {
  if (!format?.startsWith(FORMAT_PREFIX)) return null
  const rel = format.slice(FORMAT_PREFIX.length)
  if (!rel || rel.length > 150 || rel.startsWith('/') || rel.includes('\\')) return null
  const parts = rel.split('/')
  if (parts.length > 3 || parts.some((p) => !p || p === '.' || p === '..')) return null
  return rel
}

/** 核心给的存档路径 → 相对 /data/saves 的部分；不在那底下的返回 null */
export function batteryRelOf(path: string | undefined | null): string | null {
  if (!path?.startsWith(`${ROOT}/`)) return null
  return batteryRelPath(`${FORMAT_PREFIX}${path.slice(ROOT.length + 1)}`)
}

export interface BatteryFs {
  analyzePath(path: string): { exists: boolean }
  readFile(path: string): Uint8Array
  writeFile(path: string, data: Uint8Array): void
  mkdir(path: string): void
}

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function safeStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export interface BatterySyncDeps {
  enabled: () => boolean
  fetch: typeof fetchCloudSaveStrict
  push: typeof pushSave
  storage: KeyValueStore | null
  now: () => number
  timeoutMs: number
  log: (msg: string) => void
}

const defaultDeps = (): BatterySyncDeps => ({
  // 明确选了「只存本地」的玩家不上云；没选过、选了云端的已登录玩家都同步
  enabled: () => cloudSavesEnabled() && getSaveTarget() !== 'local',
  fetch: fetchCloudSaveStrict,
  push: pushSave,
  storage: safeStorage(),
  now: () => Date.now(),
  timeoutMs: BATTERY_PULL_TIMEOUT_MS,
  log: (msg) => {
    console.info(`[battery-sync] ${msg}`)
    diagLog('adapter', 'info', `电池存档同步：${msg}`)
  },
})

export interface BatterySync {
  /** callMain 之前调用：等云端那份，按规则写进 FS。永不抛错 */
  apply(fs: BatteryFs): Promise<BatteryDecision | 'off' | 'pull-failed'>
  /** 核心刷完电池存档后调用：内容变了就推上去。永不抛错 */
  push(fs: BatteryFs, savePath: string | null | undefined, core?: string): Promise<'skipped' | 'unchanged' | 'pushed' | 'failed' | 'stopped'>
  /** 拆播放器时调用：停止后续推送 */
  stop(): void
}

export function createBatterySync(saveSlug: string, partial: Partial<BatterySyncDeps> = {}): BatterySync {
  const deps = { ...defaultDeps(), ...partial }
  const metaKey = `${META_PREFIX}${saveSlug}`
  const readLast = (): string | undefined => {
    try {
      return deps.storage?.getItem(metaKey) || undefined
    } catch {
      return undefined
    }
  }
  const writeLast = (hash: string) => {
    try {
      deps.storage?.setItem(metaKey, hash)
    } catch {
      /* 存不下就下次多推一次，不影响正确性 */
    }
  }

  const on = deps.enabled()
  /** 只有开局确实读到了云端（含「云端没有」）才允许推送 */
  let ready = false
  let stopped = false
  let lastHash = readLast()
  let chain: Promise<unknown> = Promise.resolve()
  let failures = 0

  const pulled: Promise<{ ok: true; got: Awaited<ReturnType<typeof fetchCloudSaveStrict>> } | { ok: false }> = on
    ? (() => {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        return Promise.race([
          deps.fetch('emulatorjs', saveSlug, BATTERY_SAVE_SLOT, ctrl?.signal).then((got) => ({ ok: true as const, got })),
          new Promise<{ ok: false }>((resolve) => {
            timer = setTimeout(() => {
              ctrl?.abort()
              resolve({ ok: false })
            }, deps.timeoutMs)
          }),
        ])
          .catch(() => ({ ok: false as const }))
          .finally(() => clearTimeout(timer))
      })()
    : Promise.resolve({ ok: false as const })

  return {
    async apply(fs) {
      if (!on) return 'off'
      const result = await pulled
      if (!result.ok) {
        deps.log('没读到云端的游戏内存档，本局只用本地、不上传')
        return 'pull-failed'
      }
      try {
        const cloud = result.got
        const rel = batteryRelPath(cloud?.format)
        if (cloud && !rel) {
          // 格式认不出来：当作云端没有可用的那份，但仍不推送，免得盖掉一份我们看不懂的数据
          deps.log('云端游戏内存档格式不认识，本局不同步')
          return 'pull-failed'
        }
        const path = rel ? `${ROOT}/${rel}` : null
        const local = path && fs.analyzePath(path).exists ? fs.readFile(path) : null
        const decision = decideBatterySync(local, cloud?.data ?? null, lastHash)
        if (decision === 'use-cloud' && path && cloud) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir !== ROOT) {
            try {
              fs.mkdir(dir)
            } catch {
              /* 已存在 */
            }
          }
          fs.writeFile(path, cloud.data)
          lastHash = batteryHash(cloud.data)
          writeLast(lastHash)
          deps.log(`已用云端的游戏内存档（${rel}）`)
        } else if (decision === 'in-sync' && cloud) {
          lastHash = batteryHash(cloud.data)
          writeLast(lastHash)
        } else if (decision === 'conflict' && path && cloud) {
          // 两边都变了：留本地（这台设备上刚玩的），云端那份放旁边，不丢
          fs.writeFile(`${path}.cloud-${deps.now()}.bak`, cloud.data)
          deps.log(`本地与云端的游戏内存档都改过，保留本地，云端那份另存为 ${rel}.cloud-*.bak`)
        }
        if (decision !== 'use-cloud' && decision !== 'conflict') deps.log(`开局决定：${decision}`)
        ready = true
        return decision
      } catch (e) {
        deps.log(`应用云端游戏内存档失败：${e instanceof Error ? e.message : String(e)}`)
        return 'pull-failed'
      }
    },

    push(fs, savePath, core) {
      const run = async () => {
        if (!on || !ready || stopped) return stopped ? 'stopped' : 'skipped'
        if (!deps.enabled()) return 'skipped'
        const rel = batteryRelOf(savePath)
        if (!rel || !savePath) return 'skipped'
        let data: Uint8Array
        try {
          if (!fs.analyzePath(savePath).exists) return 'skipped'
          data = fs.readFile(savePath).slice()
        } catch {
          return 'skipped'
        }
        if (!data.length || data.length > MAX_SAVE_BYTES) return 'skipped'
        const hash = batteryHash(data)
        if (hash === lastHash) return 'unchanged'
        const r = await deps.push('emulatorjs', saveSlug, data, BATTERY_SAVE_SLOT, 'cloud', { format: `${FORMAT_PREFIX}${rel}`, core })
        if (r.where === 'cloud') {
          lastHash = hash
          writeLast(hash)
          failures = 0
          return 'pushed'
        }
        /*
          409（另一台设备在这局期间写过）、超配额、断网都走到这里。前两种重试也不会成功，
          断网下次刷存档时自然再试；连续失败几次就停手，别每 30 秒打一次注定失败的请求。
          下次开局会按规则重新比较。
        */
        if (++failures >= MAX_PUSH_FAILURES) {
          ready = false
          deps.log(`游戏内存档连续 ${failures} 次没传上云端（${r.error ?? '未知原因'}），本局停止上传`)
        }
        return 'failed'
      }
      const next = chain.then(run, run)
      chain = next.catch(() => {})
      return next.catch(() => 'failed' as const)
    },

    stop() {
      stopped = true
    },
  }
}
