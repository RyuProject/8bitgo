/** 首页「特别鸣谢」友情链接的后台读写。 */
import { api, apiBase, apiEnabled } from './api'

export interface FriendLink {
  id: number
  name: string
  url: string
  /** 对象存储 key、站内路径或完整 URL；空串表示文字友链 */
  image: string
  sortOrder: number
  enabled: boolean
}

export type FriendLinkInput = Omit<FriendLink, 'id'>

/** 后台列表上的一条：多带两个方向的人数（见 server/src/friend-link-hits.js） */
export interface FriendLinkAdmin extends FriendLink {
  hits: {
    /** 出站：这条链接被点了，多少人 */
    out: number
    /** 入站：从对方站点过来了多少人 */
    in: number
  }
}

export interface FriendLinkAdminList {
  links: FriendLinkAdmin[]
  /** 上面两个数字统计的是最近多少天。界面必须把它显示出来，否则数字没有意义 */
  statsDays: number
}

const NO_HITS = { out: 0, in: 0 }

export async function fetchFriendLinks(): Promise<FriendLinkAdminList> {
  if (!apiEnabled()) return { links: [], statsDays: 0 }
  const result = await api.get<FriendLinkAdminList | FriendLink[]>('/api/friend-links', true)
  /*
    ⚠️ 两种形状都要认：这个接口 2026-09-11 从「一个数组」改成了 `{links, statsDays}`。
    前端和后端**不是同时部署的**（这个仓库踩过：前端是当天的、后端还是两天前的），
    只认新形状的话，后端没跟上的那段时间里整个友链后台是空的 —— 而且不报错。
  */
  if (Array.isArray(result)) return { links: result.map((l) => ({ ...l, hits: NO_HITS })), statsDays: 0 }
  const links = Array.isArray(result?.links) ? result.links : []
  return { links: links.map((l) => ({ ...l, hits: l.hits ?? NO_HITS })), statsDays: Number(result?.statsDays) || 0 }
}

export async function saveFriendLink(id: number | null, input: FriendLinkInput): Promise<FriendLink> {
  return id === null
    ? api.post<FriendLink>('/api/friend-links', input, true)
    : api.put<FriendLink>(`/api/friend-links/${id}`, input, true)
}

export async function deleteFriendLink(id: number): Promise<void> {
  await api.del(`/api/friend-links/${id}`, true)
}

/**
 * 上报一次出站点击（首页鸣谢位上的链接被点了）。
 *
 * ⚠️ 必须用 `navigator.sendBeacon`，不能用 fetch：点击的下一件事就是导航离开，
 * 浏览器会把还在飞的 fetch 直接掐掉 —— 那样统计到的只是「点了但没跳走」的那部分人，
 * 而且失败得毫无声息。sendBeacon 是专为这个场景设计的：交给浏览器，页面卸载了也会发出去。
 *
 * ⚠️ **绝不 await、绝不抛**。这是个统计动作，不能让它有任何机会挡住用户的跳转。
 * 浏览器不支持 sendBeacon（很老的 Safari）就干脆不报 —— 少一条数据，
 * 比为了一条数据去赌跳转时序划算。
 */
export function reportFriendLinkClick(id: number): void {
  if (!apiEnabled()) return
  try {
    navigator.sendBeacon?.(`${apiBase()}/api/friend-links/${id}/click`)
  } catch {
    /* 统计失败没有任何可见后果 */
  }
}
