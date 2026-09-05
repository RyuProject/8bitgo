import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * 应用壳状态：
 *  - collapsed  桌面端侧边栏是否折叠为图标栏（持久化到 localStorage）
 *  - mobileOpen 移动端抽屉是否打开
 *  - immersive  沉浸模式：隐藏侧边栏与顶栏，只保留内容（游戏运行时使用）
 */
export interface ShellState {
  /**
   * 外面到底有没有 ShellProvider。
   *
   * 嵌入页（/embed/:slug）是**故意**挂在 <Layout> 外面的，那儿 useShell() 拿到的是下面这份
   * defaultState —— setImmersive 是个空函数、immersive 永远 false。不给个标记的话，
   * 组件没法区分「玩家现在没开沉浸」和「这个页面压根开不了沉浸」，于是会画出一颗
   * 点了什么都不发生的按钮（播放器的「◧ 沉浸模式」在嵌入页里一直是这样）。
   */
  available: boolean
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  toggleCollapsed: () => void
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
  immersive: boolean
  setImmersive: (v: boolean) => void
  toggleImmersive: () => void
}

const STORAGE_KEY = '8bitgo.sidebar.collapsed'

const noop = () => {}
const defaultState: ShellState = {
  available: false,
  collapsed: false,
  setCollapsed: noop,
  toggleCollapsed: noop,
  mobileOpen: false,
  setMobileOpen: noop,
  immersive: false,
  setImmersive: noop,
  toggleImmersive: noop,
}

const ShellContext = createContext<ShellState>(defaultState)

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v)
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
    } catch {
      /* 忽略：隐私模式等情况下不可用 */
    }
  }, [])

  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed])
  const toggleImmersive = useCallback(() => setImmersive((v) => !v), [])

  // 沉浸模式下按 Esc 退出
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileOpen])

  const value = useMemo<ShellState>(
    () => ({
      available: true,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      mobileOpen,
      setMobileOpen,
      immersive,
      setImmersive,
      toggleImmersive,
    }),
    [collapsed, setCollapsed, toggleCollapsed, mobileOpen, immersive, toggleImmersive],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell(): ShellState {
  return useContext(ShellContext)
}
