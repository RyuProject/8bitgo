import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'scripts/prepare-sockdrive.mjs')
const root = mkdtempSync(join(tmpdir(), '8bitgo-sockdrive-prepare-'))
const bin = join(root, 'bin')
const workDir = join(root, 'work')
const source = join(root, 'source.zip')
const extractionMarker = join(root, '7z-extracted')
mkdirSync(bin)
mkdirSync(workDir)
writeFileSync(source, 'mock ZIP; the mocked 7z command supplies its listing and files')

function command(name, body) {
  const path = join(bin, name)
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(path, 0o755)
}

command('7z', `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
const entries = JSON.parse(process.env.MOCK_ARCHIVE_ENTRIES || '[]')
if (args[0] === 'l') {
  console.log('Archive listing')
  console.log('----------')
  for (const entry of entries) {
    console.log('Path = ' + entry.path)
    console.log('Size = ' + entry.size)
  }
  process.exit(0)
}
const destination = args.find((value) => value.startsWith('-o'))?.slice(2)
if (process.env.MOCK_7Z_EXTRACT_MARKER) writeFileSync(process.env.MOCK_7Z_EXTRACT_MARKER, 'yes')
for (const entry of entries) {
  const path = join(destination, ...entry.path.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(entry.size, 0x41))
}
`)

command('virt-make-fs', `
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
const image = args.at(-1)
mkdirSync(dirname(image), { recursive: true })
writeFileSync(image, 'mock qcow2')
`)

command('qemu-img', `
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
console.log(JSON.stringify({ format: 'qcow2', 'virtual-size': 252370944 }))
`)

command('sockdrive-cli', `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] !== 'sockify') throw new Error('expected sockify')
const output = join(args[3], 'disk')
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'sockdrive.metaj'), JSON.stringify({ range_count: 1, preload_ranges: [0] }))
`)

const runPrepare = ({ version, executable, entries, extraArgs = [] }) => {
  const result = spawnSync(process.execPath, [
    script,
    '--source', source,
    '--slug', 'testgame',
    '--version', version,
    '--exe', executable,
    '--work-dir', workDir,
    '--cli', join(bin, 'sockdrive-cli'),
    '--encoding', 'identity',
    '--defer-validation',
    ...extraArgs,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
      MOCK_ARCHIVE_ENTRIES: JSON.stringify(entries),
      MOCK_7Z_EXTRACT_MARKER: extractionMarker,
    },
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`prepare-sockdrive exited ${result.status}`)
    error.outputText = `${result.stdout || ''}\n${result.stderr || ''}`
    throw error
  }
  return result.stdout
}

try {
  const nested = [{ path: 'Age of Empires II/EMPIRES2.EXE', size: 4 }]
  const output = runPrepare({ version: 'v1', executable: 'EMPIRES2.exe', entries: nested })
  const manifest = JSON.parse(readFileSync(join(workDir, 'testgame-v1', 'release.json'), 'utf8'))
  assert.equal(manifest.requestedExecutable, 'EMPIRES2.exe')
  assert.equal(manifest.executable, 'Age of Empires II/EMPIRES2.EXE')
  assert.match(output, /唯一定位启动程序：Age of Empires II\/EMPIRES2\.EXE/)

  const duplicateEntries = [
    { path: 'Age II/EMPIRES2.EXE', size: 4 },
    { path: 'Old Install/EMPIRES2.EXE', size: 4 },
  ]
  rmSync(extractionMarker, { force: true })
  assert.throws(
    () => runPrepare({ version: 'v2', executable: 'EMPIRES2.exe', entries: duplicateEntries }),
    (error) => /多个同名启动程序/.test(error.outputText) && /Age II\/EMPIRES2\.EXE/.test(error.outputText) &&
      /Old Install\/EMPIRES2\.EXE/.test(error.outputText) && !/制作 FAT32\/QCOW2/.test(error.outputText),
    '多个同名程序必须在创建磁盘前停止并列出路径',
  )
  assert.equal(existsSync(extractionMarker), false, '启动路径歧义要在解开大型 ZIP 前停止')

  rmSync(extractionMarker, { force: true })
  runPrepare({
    version: 'v3',
    executable: 'EMPIRES2.exe',
    entries: nested,
    extraArgs: ['--dos83-exe'],
  })
  assert.fail('纯 DOS 不能使用含长目录名的启动路径')
} catch (error) {
  if (!/纯 DOS 流式盘要求启动路径符合 8\.3 格式/.test(error.outputText || '')) throw error
  assert.doesNotMatch(error.outputText, /制作 FAT32\/QCOW2/)
  assert.equal(existsSync(extractionMarker), false, '纯 DOS 路径错误应在解包 ZIP 前停止')
  console.log('Sockdrive 制作器测试通过：嵌套入口唯一解析、歧义拒绝、纯 DOS 8.3 前置校验')
} finally {
  rmSync(root, { recursive: true, force: true })
}
