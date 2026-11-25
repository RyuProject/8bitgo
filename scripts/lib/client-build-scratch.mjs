import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function trackedPublicEntries(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'public'], { cwd: root })
  return output.toString().split('\0').filter(Boolean)
}

function isTrackedPublicEntry(name, tracked) {
  const publicPath = `public/${name}`
  return tracked.some(path => path === publicPath || path.startsWith(`${publicPath}/`))
}

function removeUntrackedBuildCopies(root, tracked) {
  const outputDir = join(root, 'dist/client')
  if (!existsSync(outputDir)) return

  for (const name of readdirSync(outputDir)) {
    if (!name.startsWith('__') || isTrackedPublicEntry(name, tracked)) continue
    rmSync(join(outputDir, name), { recursive: true, force: true })
  }
}

/**
 * Vite 会原样复制 public；Git ignore 规则不会阻止打包。
 * 构建期间暂移未跟踪的根级 `public/__*` 私人测试资料，并清掉失败构建留下的旧副本。
 */
export async function withLocalPublicScratchExcluded(root, build) {
  const publicDir = join(root, 'public')
  const tracked = trackedPublicEntries(root)
  const heldDir = mkdtempSync(join(root, '.build-client-scratch-'))
  const moved = []
  let result
  let buildError

  try {
    for (const name of readdirSync(publicDir)) {
      if (!name.startsWith('__') || isTrackedPublicEntry(name, tracked)) continue
      const source = join(publicDir, name)
      const destination = join(heldDir, name)
      renameSync(source, destination)
      moved.push({ source, destination })
    }

    if (moved.length) console.log(`构建时隔离 ${moved.length} 个未跟踪的 public/__ 本地测试文件或链接`)
    result = await build()
  } catch (error) {
    buildError = error
  }

  const restoreErrors = []
  for (const { source, destination } of moved.reverse()) {
    if (existsSync(source) || (() => { try { return lstatSync(source).isSymbolicLink() } catch { return false } })()) {
      restoreErrors.push(new Error(`恢复本地测试文件时目标已存在，原件保留在 ${destination}`))
      continue
    }
    try {
      renameSync(destination, source)
    } catch (error) {
      restoreErrors.push(new Error(`无法恢复本地测试文件 ${source}；原件保留在 ${destination}`, { cause: error }))
    }
  }

  try {
    removeUntrackedBuildCopies(root, tracked)
  } catch (error) {
    restoreErrors.push(new Error(`无法清理 dist/client 中未跟踪的 public/__ 副本`, { cause: error }))
  }

  if (restoreErrors.length === 0) rmSync(heldDir, { recursive: true, force: true })
  if (restoreErrors.length) throw new AggregateError([...(buildError ? [buildError] : []), ...restoreErrors], '隔离 public 本地测试文件时收尾失败')
  if (buildError) throw buildError
  return result
}
