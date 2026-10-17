#!/usr/bin/env node

/**
 * 把“大型 Windows 游戏的普通 ZIP / 文件目录”制作成本站可直接发布的静态 Sockdrive。
 *
 * 这项工作依赖 guestfs / qemu 和官方 sockdrive CLI，必须在 Linux 制作机的后台任务或离线命令里
 * 执行，不能放进 Express 请求生命周期。StarCraft 约 1.5GB，一次转换会持续占用 CPU、磁盘与
 * 文件描述符；持久队列把它限制为单并发，并用最终元数据区分半成品与可绑定版本。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersionedSockdriveDirectory } from '../shared/sockdrive-url.js'
import {
  archiveEntriesFrom7z,
  ensureBaselinePreloadProfile,
  selectSockdriveDiskTemplate,
  shellQuote,
  SOCKDRIVE_DISK_TEMPLATES,
  SOCKDRIVE_FILESYSTEM_OVERHEAD_BYTES,
} from './lib/sockdrive-pipeline.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : ''
}
const flag = (name) => argv.includes(`--${name}`)
const source = resolve(arg('source') || '')
const slug = (arg('slug') || '').toLowerCase()
const version = (arg('version') || '').toLowerCase()
const executable = (arg('exe') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const workRoot = resolve(arg('work-dir') || '')
const cli = resolve(arg('cli') || process.env.SOCKDRIVE_CLI || '')
const encoding = (arg('encoding') || 'br').toLowerCase()
const publicBase = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
const freeSpace = arg('free-space') || '128M'
const publish = flag('publish')
const bind = flag('bind')
const bucket = arg('bucket')
const apiBase = arg('api-base') || 'https://8bitgo.com'

const usage = () => {
  console.error(
    '用法：npm run sockdrive:prepare -- --source <原始ZIP或目录> --slug starcraft --version v1 ' +
      '--exe StarCraft/Brood.exe --work-dir </data/builds> --cli </opt/sockdrive/cli> ' +
      '[--encoding br|gzip|identity] [--free-space 128M] ' +
      '[--publish --bucket <R2桶名> [--bind --api-base https://8bitgo.com]]',
  )
  process.exit(2)
}

if (!arg('source') || !slug || !version || !executable || !arg('work-dir') || !arg('cli') && !process.env.SOCKDRIVE_CLI) usage()
if (!existsSync(source)) throw new Error(`源文件不存在：${source}`)
if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error('--slug 只能用小写字母、数字和连字符')
if (!/^v[1-9]\d*$/.test(version) && !/^[a-f0-9]{8,64}$/.test(version)) {
  throw new Error('--version 必须是 v1 / v2 这类版本，或 8～64 位内容哈希')
}
// eslint-disable-next-line no-control-regex -- Windows 启动路径不能把控制字符带进 DOSBox 配置。
if (!/^[^:<>"|?*\x00-\x1f]+\.exe$/i.test(executable) || executable.split('/').some((part) => !part || part === '.' || part === '..')) {
  throw new Error('--exe 必须是游戏盘内安全的 .exe 相对路径')
}
if (!['br', 'gzip', 'identity'].includes(encoding)) throw new Error('--encoding 只能是 br、gzip 或 identity')
if (!/^[1-9]\d*(?:[KMG])$/i.test(freeSpace)) throw new Error('--free-space 请写成 256M 这类正数容量')
if (!existsSync(cli) || !statSync(cli).isFile()) throw new Error(`找不到官方 sockdrive CLI：${cli}`)
if (bind && !publish) throw new Error('--bind 只能和 --publish 一起使用；单独绑定请运行 npm run sockdrive:bind')
if (publish && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket)) throw new Error('--publish 时必须提供合法的 --bucket')

const prefix = `sockdrives/${slug}-${version}`
if (!isVersionedSockdriveDirectory(prefix)) throw new Error(`生成的版本目录不合法：${prefix}`)
const publicRoot = `${publicBase}/${prefix}`
const buildRoot = join(workRoot, `${slug}-${version}`)
if (existsSync(buildRoot)) {
  throw new Error(`工作目录已经存在：${buildRoot}。为避免把两次转换混在一起，请换版本或空工作目录`)
}
mkdirSync(buildRoot, { recursive: true })

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...options })
  if (result.error) throw new Error(`无法运行 ${command}：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`)
}
const capture = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  } catch (error) {
    const detail = error?.stderr?.toString().trim()
    throw new Error(`${command} 执行失败${detail ? `：${detail}` : ''}`)
  }
}
const requireTool = (command, versionArgs = ['--version']) => {
  try {
    spawnSync(command, versionArgs, { stdio: 'ignore' })
  } catch (error) {
    throw new Error(`缺少制作工具 ${command}：${error instanceof Error ? error.message : String(error)}`)
  }
  const probe = spawnSync(command, versionArgs, { stdio: 'ignore' })
  if (probe.error?.code === 'ENOENT') throw new Error(`缺少制作工具 ${command}`)
}

requireTool('virt-make-fs')
requireTool('qemu-img')
requireTool('7z')
if (encoding === 'br') requireTool('brotli', ['--help'])

let filesRoot = source
if (statSync(source).isFile()) {
  if (/\.8bg$/i.test(source)) {
    throw new Error('请使用加密打包前的原始 ZIP；R2 上的 .8bg 不能拿来制作磁盘')
  }
  if (!/\.zip$/i.test(source)) throw new Error('--source 文件只支持原始 .zip；也可以直接传已解压目录')
  const listing = capture('7z', ['l', '-slt', '--', source])
  // 2GB 是当前官方 CLI 的最大模板；在解包前利用 7z 声明大小止损，避免 ZIP 炸弹耗尽工作盘。
  const requested = selectSockdriveDiskTemplate(0, freeSpace)
  const largestTemplate = SOCKDRIVE_DISK_TEMPLATES.at(-1)
  const maxDeclaredBytes = largestTemplate.bytes - requested.requestedFreeBytes - SOCKDRIVE_FILESYSTEM_OVERHEAD_BYTES
  archiveEntriesFrom7z(listing, maxDeclaredBytes)
  filesRoot = join(buildRoot, 'files')
  mkdirSync(filesRoot)
  run('7z', ['x', '-y', `-o${filesRoot}`, '--', source])
}

const sourceReal = realpathSync(filesRoot)
let fileCount = 0
let totalBytes = 0
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error(`源目录含符号链接，拒绝写进游戏盘：${relative(filesRoot, path)}`)
    if (info.isDirectory()) walk(path)
    else if (info.isFile()) {
      fileCount++
      totalBytes += info.size
      if (info.size > 0xffff_ffff) throw new Error(`FAT32 不支持超过 4GB 的单文件：${relative(filesRoot, path)}`)
      const actual = realpathSync(path)
      if (actual !== sourceReal && !actual.startsWith(`${sourceReal}${sep}`)) {
        throw new Error(`源文件逃逸出工作目录：${relative(filesRoot, path)}`)
      }
    } else throw new Error(`源目录含普通文件以外的条目：${relative(filesRoot, path)}`)
  }
}
walk(filesRoot)
if (!fileCount) throw new Error('源目录没有文件')
const diskTemplate = selectSockdriveDiskTemplate(totalBytes, freeSpace)

const findCaseInsensitive = (root, wanted) => {
  let current = root
  for (const part of wanted.split('/')) {
    const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase())
    if (!actual) return null
    current = join(current, actual)
  }
  return current
}
const exePath = findCaseInsensitive(filesRoot, executable)
if (!exePath || !statSync(exePath).isFile()) throw new Error(`源文件里找不到启动程序：${executable}`)

console.log(`✔ 源文件检查通过：${fileCount} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`)
const bundleRoot = join(buildRoot, 'bundle')
const configRoot = join(bundleRoot, '.jsdos')
mkdirSync(configRoot, { recursive: true })
const imageName = `${slug}.qcow2`
const imagePath = join(bundleRoot, imageName)
writeFileSync(join(configRoot, 'dosbox.conf'), [
  '[dosbox]',
  'memsize=64',
  '',
  '[autoexec]',
  `imgmount 3 ${imageName}`,
  '',
].join('\n'))

console.log(`制作 ${diskTemplate.label}/QCOW2 游戏盘（额外可写空间至少 ${freeSpace}）…`)
run('virt-make-fs', [
  '--format=qcow2',
  '--type=vfat',
  '--partition=mbr',
  `--size=${diskTemplate.bytes}`,
  '--label=8BITGO',
  '--',
  filesRoot,
  imagePath,
])
const imageInfo = JSON.parse(capture('qemu-img', ['info', '--output=json', imagePath]))
if (imageInfo.format !== 'qcow2' || imageInfo['virtual-size'] !== diskTemplate.bytes) {
  throw new Error(`生成的 QCOW2 格式或虚拟容量不正确：应为 ${diskTemplate.bytes} 字节`)
}

const convertedRoot = join(buildRoot, 'converted')
mkdirSync(convertedRoot)
const sockifiedBundle = join(buildRoot, `${slug}-${version}-sockdrive.jsdos`)
const compressionFlag = encoding === 'br' ? '-b' : encoding === 'gzip' ? '-g' : null
console.log('调用官方 sockify 生成静态分块…')
run(cli, [
  'sockify',
  bundleRoot,
  `${slug}-`,
  convertedRoot,
  publicRoot,
  sockifiedBundle,
  ...(compressionFlag ? [compressionFlag] : []),
])

const metadataDirs = []
const findMetadata = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (info.isDirectory()) findMetadata(path)
    else if (name === 'sockdrive.metaj') metadataDirs.push(dirname(path))
  }
}
findMetadata(convertedRoot)
if (metadataDirs.length !== 1) {
  throw new Error(`期望生成 1 块游戏盘，实际找到 ${metadataDirs.length} 份 sockdrive.metaj`)
}
const publishDir = join(buildRoot, 'publish')
renameSync(metadataDirs[0], publishDir)
const baseline = ensureBaselinePreloadProfile(publishDir, encoding)
if (baseline.created) console.log(`✔ 已生成基础热点清单：${baseline.ranges.length} 个范围`)

run(process.execPath, [
  join(repoRoot, 'scripts/upload-sockdrive-r2.mjs'),
  '--src', publishDir,
  '--prefix', prefix,
  '--encoding', encoding,
  '--dry-run',
])

const manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  slug,
  version,
  executable,
  source: source,
  sourceFiles: fileCount,
  sourceBytes: totalBytes,
  diskTemplate: diskTemplate.id,
  requestedFreeBytes: diskTemplate.requestedFreeBytes,
  qcowVirtualBytes: imageInfo['virtual-size'],
  encoding,
  prefix,
  publicRoot,
  publishDir,
}
writeFileSync(join(buildRoot, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)

if (publish) {
  run(process.execPath, [
    join(repoRoot, 'scripts/upload-sockdrive-r2.mjs'),
    '--src', publishDir,
    '--bucket', bucket,
    '--prefix', prefix,
    '--encoding', encoding,
    '--public-base', publicBase,
  ])
  if (bind) {
    run(process.execPath, [
      join(repoRoot, 'scripts/bind-sockdrive-game.mjs'),
      '--slug', slug,
      '--prefix', prefix,
      '--public-base', publicBase,
      '--api-base', apiBase,
    ], { env: process.env })
  }
}

console.log(`✔ Sockdrive 制作完成：${publishDir}`)
if (!publish) {
  console.log('下一步上传：')
  console.log(
    `npm run sockdrive:upload -- --src ${shellQuote(publishDir)} --bucket <R2桶名> ` +
      `--prefix ${shellQuote(prefix)} --encoding ${encoding}`,
  )
  console.log('上传成功后绑定：')
  console.log('先用隐藏输入设置并导出 EIGHTBITGO_ADMIN_JWT（不要把令牌明文写进命令历史），再运行：')
  console.log(`npm run sockdrive:bind -- --slug ${slug} --prefix ${prefix}`)
}
