#!/usr/bin/env node
/**
 * 把 Play! 的 System 2x6 资源整理成 8BitGo 可识别的原始 ZIP。
 * Tekken 5.1 的 DVD 以外层 CHD 直接存储；若源盘是 GDDD 硬盘 CHD，会先用 chdman
 * 提取并重建 DVD CHD，同时核对逻辑 Data SHA1，避免把硬盘容器误交给光盘驱动。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const values = new Map()
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法：node scripts/create-play-arcade-bundle.mjs --id tekken51 --dongle tekken51.zip --disk te51-dvd0.chd --out tekken51-play.zip [--definition path.arcadedef] [--chdman /path/to/chdman]')
    process.exit(0)
  }
  if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数格式错误：${args[i]}`)
  values.set(args[i].slice(2), args[++i])
}

const id = values.get('id')
const dongleInput = resolve(values.get('dongle') ?? '')
const diskInput = resolve(values.get('disk') ?? '')
const output = resolve(values.get('out') ?? '')
if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !values.has('dongle') || !values.has('disk') || !values.has('out')) {
  throw new Error('必须提供 --id、--dongle、--disk 和 --out')
}
if (await stat(output).then(() => true, () => false)) throw new Error(`拒绝覆盖已有文件：${output}`)
const dongleStats = await stat(dongleInput)
if (!dongleStats.isFile() || dongleStats.size > 64 * 1024 * 1024) throw new Error('dongle ZIP 不存在或超过 64 MiB')
const diskStats = await stat(diskInput)
if (!diskStats.isFile() || diskStats.size > 768 * 1024 * 1024) throw new Error('源 CHD 不存在或超过 768 MiB')

const defaultDef = join(root, 'public', 'play', 'arcadedefs', `${id}.arcadedef`)
const definitionInput = resolve(values.get('definition') ?? defaultDef)
const chdman = values.get('chdman') ?? 'chdman'
const temp = await mkdtemp(join(tmpdir(), `8bitgo-play-${id}-`))
const tree = join(temp, 'bundle')
const outputDir = dirname(output)
await mkdir(outputDir, { recursive: true })

const run = (command, argv, options = {}) => execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
const chdInfo = (path) => run(chdman, ['info', '-i', path])
const dataSha1 = (text) => text.match(/^Data SHA1:\s*([a-f0-9]{40})/im)?.[1]?.toLowerCase()
const verify = (path) => run(chdman, ['verify', '-i', path])

try {
  const definition = JSON.parse(await readFile(definitionInput, 'utf8'))
  if (definition.id !== id || !['sys246', 'sys147'].includes(definition.driver)) throw new Error('arcadedef 的 id / driver 与参数不匹配')
  const media = definition.cdvd ?? definition.hdd
  if (!media?.name || !definition.dongle?.name) throw new Error('arcadedef 必须声明 cdvd/hdd 与 dongle')
  const inputInfo = chdInfo(diskInput)
  const tag = inputInfo.match(/Tag='([^']+)'/i)?.[1]
  let playableDisk = diskInput
  let generatedDisk = ''
  if (tag === 'GDDD') {
    if (!definition.cdvd) throw new Error('GDDD 是硬盘 CHD，但 arcadedef 没有 cdvd 目标；不能把盘型猜成光盘')
    const rawDisk = join(temp, `${id}-raw.iso`)
    generatedDisk = join(temp, media.name)
    console.log('源 CHD 是 GDDD 硬盘；正在提取扇区并重建为 Play! 支持的 DVD CHD…')
    run(chdman, ['verify', '-i', diskInput])
    run(chdman, ['extracthd', '-i', diskInput, '-o', rawDisk])
    run(chdman, ['createdvd', '-i', rawDisk, '-o', generatedDisk])
    const outputInfo = chdInfo(generatedDisk)
    if (!/Tag='DVD\s*'/i.test(outputInfo)) throw new Error('重建产物不是 DVD CHD')
    if (!dataSha1(inputInfo) || dataSha1(inputInfo) !== dataSha1(outputInfo)) throw new Error('原盘与 DVD CHD 的逻辑 Data SHA1 不同，已停止打包')
    run(chdman, ['verify', '-i', generatedDisk])
    playableDisk = generatedDisk
  } else if (tag !== 'DVD ') {
    throw new Error(`此打包脚本只接受 DVD CHD 或可转换为 DVD 的 GDDD；源盘 metadata=${tag ?? '未知'}`)
  } else {
    run(chdman, ['verify', '-i', diskInput])
  }

  const diskInfo = chdInfo(playableDisk)
  if (!/Tag='DVD\s*'/i.test(diskInfo)) throw new Error('游戏定义要求的 CDVD 文件不是 DVD CHD')
  const zipList = run('unzip', ['-Z1', dongleInput]).split(/\r?\n/).filter(Boolean)
  if (!zipList.includes(definition.dongle.name)) throw new Error(`dongle ZIP 内找不到 ${definition.dongle.name}`)

  const manifest = {
    format: '8bitgo-play-arcade-v1',
    id,
    definition: `arcadedefs/${id}.arcadedef`,
    dongleArchive: `arcaderoms/${id}.zip`,
    discs: [`arcaderoms/${id}/${basename(media.name)}`],
  }
  if (basename(media.name) !== media.name || !/\.(chd|iso|cue|cso|isz|mds)$/i.test(media.name)) throw new Error('arcadedef 镜像名不符合安全包路径约定')
  await mkdir(join(tree, 'arcadedefs'), { recursive: true })
  await mkdir(join(tree, 'arcaderoms', id), { recursive: true })
  await copyFile(definitionInput, join(tree, 'arcadedefs', `${id}.arcadedef`))
  await copyFile(dongleInput, join(tree, 'arcaderoms', `${id}.zip`))
  await copyFile(playableDisk, join(tree, 'arcaderoms', id, media.name))
  await writeFile(join(tree, '8bitgo-play-arcade.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  run('zip', ['-0', '-q', '-r', output, '8bitgo-play-arcade.json', 'arcadedefs', 'arcaderoms'], { cwd: tree })
  const zipCheck = run('unzip', ['-t', output])
  assert.match(zipCheck, /No errors detected/i)
  const outputStats = await stat(output)
  if (outputStats.size > 768 * 1024 * 1024) throw new Error('打包结果超过浏览器安全上限 768 MiB')
  console.log(`完成：${output}（${(outputStats.size / 1024 / 1024).toFixed(1)} MiB）`)
  if (generatedDisk) console.log(`DVD CHD 已核对逻辑 Data SHA1：${dataSha1(inputInfo)}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
