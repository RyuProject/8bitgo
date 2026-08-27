#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
前端的观众模式（直播第一步）。幂等。

    python3 patches/spectator-client.py [项目路径]

做两件事：
  1. 适配器支持 role='spectator' —— 观众的按键不往房主那边发
  2. services/netplay.ts 加上「切换角色」和观众相关的类型
"""
import sys, os

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')


def patch(rel, edits, marker):
    p = os.path.join(ROOT, rel)
    s = open(p, encoding='utf-8').read()
    if marker in s:
        print('skip ', rel)
        return
    for old, new in edits:
        assert old in s, f'[{rel}] 找不到锚点：{old[:70]!r}'
        s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('patch', rel)


# ---------- 适配器：观众不发输入 ----------
patch('src/emulator/adapters/emulatorjs.ts', [
    ("""  /** host = 开新房间；join = 加入 roomId 指定的房间 */
  mode: 'host' | 'join'""",
     """  /** host = 开新房间；join = 加入 roomId 指定的房间 */
  mode: 'host' | 'join'
  /**
   * 以什么身份加入：
   *   player    占一个手柄位，能操作（默认）
   *   spectator 只看不操作 —— 这就是「直播观众」
   *
   * 观众这一侧我们会把 netplay 的输入转发函数换成空实现，
   * 所以他按键盘不会影响房主那边的游戏。手柄位的分配在服务端，见 server/src/netplay.js。
   */
  role?: 'player' | 'spectator'"""),

    # 进房后，观众把输入通道掐掉
    ("""    try {
      if (netplay.mode === 'join' && netplay.roomId) {
        np.joinRoom(netplay.roomId, netplay.roomName, netplay.maxPlayers, netplay.password || null)
      } else {
        np.openRoom(netplay.roomName, netplay.maxPlayers, netplay.password || '')
      }""",
     """    // 观众：把 netplay 的输入转发换成空实现。
    // EmulatorJS 的调用链是 键盘 → GameManager.simulateInput → netplay.simulateInput → 发给房主，
    // 把最后这一环换掉，观众按什么都传不出去（画面和声音照常收）。
    if (netplay.role === 'spectator') {
      try {
        np.simulateInput = () => {}
      } catch {
        /* 换不掉也不致命，服务端那边本来就不给观众手柄位 */
      }
    }

    try {
      if (netplay.mode === 'join' && netplay.roomId) {
        np.joinRoom(netplay.roomId, netplay.roomName, netplay.maxPlayers, netplay.password || null)
      } else {
        np.openRoom(netplay.roomName, netplay.maxPlayers, netplay.password || '')
      }"""),

    # 类型声明补上 simulateInput
    ("""  leaveRoom?: () => void""",
     """  leaveRoom?: () => void
  /** 把访客的按键转发给房主；观众这一侧会被换成空实现 */
  simulateInput?: (player: number, index: number, value: number) => void"""),
], marker="role?: 'player' | 'spectator'")


# ---------- services/netplay.ts：角色切换 + 观众计数 ----------
patch('src/services/netplay.ts', [
    ("""export interface NetplayRoom {""",
     """export type RoomRole = 'player' | 'spectator'

export interface NetplayRoom {"""),

    ("""  players: number
  max: number""",
     """  players: number
  max: number
  /** 只看不玩的人数（直播观众） */
  spectators?: number
  maxSpectators?: number"""),

    ("""  members: Array<{ nickname: string; host: boolean }>""",
     """  members: Array<{ nickname: string; host: boolean; role?: RoomRole }>"""),
], marker='RoomRole')

# 追加角色切换函数
p = os.path.join(ROOT, 'src/services/netplay.ts')
s = open(p, encoding='utf-8').read()
if 'export async function setRoomRole' not in s:
    s += '''
/**
 * 切换自己在房间里的身份：上场当玩家，或退下来只看。
 * 用房间令牌鉴权（和上传存档同一套），改不了别人的。
 */
export async function setRoomRole(roomId: string, token: string, role: RoomRole): Promise<boolean> {
  if (!token) return false
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netplay-token': token },
      body: JSON.stringify({ role }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 房间里在看的人数（老服务端没有这个字段时返回 0） */
export function viewersOf(room: NetplayRoom): number {
  return room.spectators ?? 0
}
'''
    open(p, 'w', encoding='utf-8').write(s)
    print('patch src/services/netplay.ts（角色切换）')
else:
    print('skip  src/services/netplay.ts（角色切换）')

print('\n完成。')
