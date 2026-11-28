/**
 * DOS 7.1 系统盘的轻量地址规则。
 *
 * 游戏详情页渲染 Sockdrive 启动参数时只需要拼这个地址；若从 systemSource 导入，
 * 会把 ROM 缓存与多源下载实现也拉进页面。把纯地址规则单独放置，等到真正预热或开局再加载下载代码。
 */
export const DOS71_SYSTEM_FILE = 'system-dos7.1-v1.jsdos'

export function isDos71SystemUrl(value: string): boolean {
  try {
    return new URL(value, typeof window === 'undefined' ? 'https://x/' : window.location.href).pathname
      .split('/')
      .pop() === DOS71_SYSTEM_FILE
  } catch {
    return false
  }
}

/** 默认优先走资源域；开发环境没配公开根地址时退回同源白名单代理。 */
export function defaultDos71SystemUrl(): string {
  const env = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env
  const base = String(env?.VITE_ROM_BASE_URL || '').trim().replace(/\/+$/, '')
  return base ? `${base}/systems/dos/${DOS71_SYSTEM_FILE}` : `/system-images/${DOS71_SYSTEM_FILE}`
}
