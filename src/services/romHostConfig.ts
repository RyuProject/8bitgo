/**
 * ROM 资源域的构建期地址配置与纯地址换算。
 *
 * 只需要把镜像地址规范化的轻量模块（例如缓存键）不该为此加载线路测速、健康记分板与请求调度；
 * 这些运行时能力仍留在 romHosts.ts，地址规则则可独立复用。
 */
const trim = (value: string | undefined) => {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

export const ENV_ROM_BASE = trim(import.meta.env.VITE_ROM_BASE_URL)
export const ENV_ROM_MIRROR = trim(import.meta.env.VITE_ROM_MIRROR_URL)
export const ENV_ROM_DOWNLOAD = trim(import.meta.env.VITE_ROM_DOWNLOAD_URL)

/** 镜像或下载域地址换回主域写法；其它地址原样返回。 */
export function canonicalRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  if (!url || !base) return url
  if (mirror && base !== mirror && url.startsWith(`${mirror}/`)) return `${base}${url.slice(mirror.length)}`
  if (ENV_ROM_DOWNLOAD && base !== ENV_ROM_DOWNLOAD && url.startsWith(`${ENV_ROM_DOWNLOAD}/`)) {
    return `${base}${url.slice(ENV_ROM_DOWNLOAD.length)}`
  }
  return url
}
