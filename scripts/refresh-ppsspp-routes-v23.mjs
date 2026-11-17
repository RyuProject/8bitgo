#!/usr/bin/env node
/** v23 在 v22 的基础上为远程光盘 Range 读取增加主站 / 镜像线路回退。 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replacePspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/ppsspp/v0dbfaca/v22')
const targetDir = resolve(root, 'public/ppsspp/v0dbfaca/v23')
const rangeSource = readFileSync(resolve(root, 'vendor/ppsspp/range-read-ahead.js'), 'utf8')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = resolve(from, entry.name)
    const target = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
  }
}

if (!existsSync(sourceDir)) throw new Error('缺少 PPSSPP v22 基线')
const baseline = JSON.parse(readFileSync(resolve(sourceDir, 'runtime.json'), 'utf8'))
for (const [name, expected] of Object.entries(baseline.artifacts)) {
  if (hash(readFileSync(resolve(sourceDir, name))) !== expected.sha256) throw new Error(`v22 ${name} 哈希不符`)
}
if (existsSync(targetDir)) throw new Error('v23 目录已存在；不可覆盖不可变运行时')

const temporary = mkdtempSync(resolve(root, 'public/ppsspp/v0dbfaca/.v23-build-'))
const working = resolve(temporary, 'v23')
try {
  copyDir(sourceDir, working)
  const scriptPath = resolve(working, 'PPSSPPSDL.js')
  writeFileSync(scriptPath, replacePspRangeReadAhead(readFileSync(scriptPath, 'utf8'), rangeSource))

  const hostPath = resolve(working, 'host.js')
  const host = readFileSync(hostPath, 'utf8')
  const anchor = '    const profile = performanceProfile()\n'
  if (host.split(anchor).length !== 2) throw new Error('无法唯一定位 PPSSPP 远程盘初始化位置')
  const routeSetup = [
    '    if (!isLocal) {',
    '      // 核心的同步 Range XHR 也使用同一组已验证线路；主站中途断流时可在核心线程里切到镜像。',
    '      const rangeUrls = [gamePath, ...(Array.isArray(remote.alternateUrls) ? remote.alternateUrls : [])]',
    '      window.__8bitgoPspRangeUrls = [...new Set(rangeUrls.filter((url) => /^https?:\\/\\//i.test(String(url))))]',
    '    }',
    anchor.trimEnd(),
    '',
  ].join('\n')
  writeFileSync(hostPath, host.replace(anchor, routeSetup))

  const sourcePath = resolve(working, 'SOURCE.txt')
  writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replaceAll('v22', 'v23'))
  const manifest = {
    ...baseline,
    runtimeGeneration: 'v23',
    rangeAlternateRouteProfile: 'probe-and-sync-failover-v1',
  }
  for (const name of ['PPSSPPSDL.js', 'host.js', 'SOURCE.txt']) {
    const path = resolve(working, name)
    manifest.artifacts[name] = { bytes: statSync(path).size, sha256: hash(readFileSync(path)) }
  }
  writeFileSync(resolve(working, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(working, targetDir)
  console.log('✔ PPSSPP v23：远程盘 Range 探测与运行时读取均可切换备用线路')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
