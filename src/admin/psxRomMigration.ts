/**
 * 旧 PS1 `.chd.8bg` 的一次性迁移准备。
 *
 * PS1 按需读盘要求 R2 对象本身是 CHD；8BG 容器要完整下载后才能交给现有 AES 解包器，
 * 所以管理员需要先取回原容器，再复用普通上传流程解包并发布裸 CHD。这里固定源对象版本、
 * 校验完整下载长度，避免迁移过程中对象被覆盖或源站返回不完整内容。
 */

export interface LegacyPsxPackProbe {
  url: string
  size?: number
}

export interface LegacyPsxPackMigrationDependencies {
  urlForKey(key: string): string
  probe(url: string): Promise<LegacyPsxPackProbe>
  download(url: string, size: number, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<Blob>
}

const MAX_PSX_CHD_PACK_BYTES = 1024 * 1024 * 1024 + 2 * 1024 * 1024

export function isLegacyPsxPackKey(value: string): boolean {
  const key = value.trim()
  return Boolean(key) && !/^https?:/i.test(key) && !key.startsWith('/') && /\.chd\.8bg$/i.test(key)
}

function hasStrongObjectVersion(url: string): boolean {
  try {
    const version = new URL(url).searchParams.get('romv') ?? ''
    return /^[a-f\d]{32}(?:-\d+)?$/i.test(version)
  } catch {
    return false
  }
}

export async function downloadLegacyPsxPackForMigration(
  key: string,
  dependencies: LegacyPsxPackMigrationDependencies,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const sourceKey = key.trim()
  if (!isLegacyPsxPackKey(sourceKey)) throw new Error('当前绑定不是可迁移的本地 PS1 CHD 8BG 对象')

  const sourceUrl = dependencies.urlForKey(sourceKey)
  if (!sourceUrl) throw new Error('无法生成旧 PS1 镜像的公开地址')
  const source = await dependencies.probe(sourceUrl)
  if (!hasStrongObjectVersion(source.url) || !Number.isSafeInteger(source.size) || (source.size ?? 0) <= 0 ||
      source.size! > MAX_PSX_CHD_PACK_BYTES) {
    throw new Error('无法确认旧 PS1 镜像强版本或大小；未开始下载')
  }

  const blob = await dependencies.download(source.url, source.size!, onProgress, signal)
  if (blob.size !== source.size) {
    throw new Error(`旧 PS1 镜像下载不完整：收到 ${blob.size} 字节，预期 ${source.size} 字节`)
  }
  return new File([blob], sourceKey.split('/').pop()!, { type: 'application/x-8bitgo-rom' })
}
