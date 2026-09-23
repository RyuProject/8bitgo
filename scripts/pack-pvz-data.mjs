#!/usr/bin/env node

/*
  把 2000+ 个 reanim 散文件打成一个可流式解包的 gzip。

  直接请求散文件会产生两千多次 HTTP/IndexedDB 操作；普通 ZIP 又需要 JSZip 先把整包和全部
  解压结果同时放进内存。这里使用「小 JSON 索引 + 连续文件数据 + gzip」：浏览器边解压边写
  WASM FS，冷启动只请求一个约 50MB 的包，峰值也只多出当前文件。

  用法：
    npm run pvz:pack -- --reanim <reanim目录> --cn-main <中文main.pak> --en-main <英文main.pak>
*/
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const repo = resolve(import.meta.dirname, '..')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const reanimArg = arg('reanim')
const cnMainArg = arg('cn-main')
const enMainArg = arg('en-main')
const reanimDir = resolve(reanimArg || '.')
const cnMain = resolve(cnMainArg || '.')
const enMain = resolve(enMainArg || '.')
const outputDir = resolve(arg('out') || join(repo, '.pvz-data'))
if (!reanimArg || !cnMainArg || !enMainArg || !existsSync(reanimDir) || !statSync(reanimDir).isDirectory() ||
    !existsSync(cnMain) || !statSync(cnMain).isFile() || !existsSync(enMain) || !statSync(enMain).isFile()) {
  console.error('用法：npm run pvz:pack -- --reanim <reanim目录> --cn-main <中文main.pak> --en-main <英文main.pak>')
  process.exit(2)
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const files = []
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store' || name.startsWith('._')) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full)
    else {
      const rel = relative(dirname(reanimDir), full).split(sep).join('/')
      if (rel.split('/').some((part) => part === '.' || part === '..' || !part)) throw new Error(`不安全路径：${rel}`)
      files.push({ path: rel, size: stat.size, full })
    }
  }
}
walk(reanimDir)
if (files.length < 2000) throw new Error(`reanim 文件异常少：${files.length}`)
const unpackedBytes = files.reduce((sum, file) => sum + file.size, 0)
const header = Buffer.from(JSON.stringify({
  format: '8bitgo.pvz.gzip-pack.v1',
  fileCount: files.length,
  unpackedBytes,
  files: files.map(({ path, size }) => ({ path, size })),
}))
if (header.length > 4 * 1024 * 1024) throw new Error('索引超过 4MB，拒绝生成')
const magic = Buffer.from('8BPVZ1\n', 'ascii')
const length = Buffer.alloc(4)
length.writeUInt32LE(header.length)

await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }))
const temporary = join(outputDir, 'reanim.tmp.pvzpack.gz')
const output = createWriteStream(temporary)
const gzip = createGzip({ level: 9 })
gzip.pipe(output)
async function write(chunk) {
  if (!gzip.write(chunk)) await once(gzip, 'drain')
}
await write(magic)
await write(length)
await write(header)
for (const file of files) {
  for await (const chunk of createReadStream(file.full)) await write(chunk)
}
gzip.end()
await finished(output)

const packedBytes = statSync(temporary).size
const packedSha256 = sha256File(temporary)
const fileName = `reanim-${packedSha256.slice(0, 16)}.pvzpack.gz`
const finalFile = join(outputDir, fileName)
renameSync(temporary, finalFile)

const publicRoot = join(repo, 'public/web/PvZ')
const propertyNames = readdirSync(join(publicRoot, 'properties')).filter((name) => {
  const file = join(publicRoot, 'properties', name)
  return statSync(file).isFile() && name !== '.DS_Store'
}).sort()
const properties = propertyNames.map((name) => {
  const file = join(publicRoot, 'properties', name)
  return { r2: `properties/${name}`, fs: `properties/${name}`, size: statSync(file).size, sha256: sha256File(file) }
})
const bundle = {
  r2: `packs/${fileName}`,
  fs: '@bundle/reanim',
  format: '8bitgo.pvz.gzip-pack.v1',
  size: packedBytes,
  sha256: packedSha256,
  fileCount: files.length,
  unpackedBytes,
}
function manifest(mainFile, r2) {
  return {
    format: '8bitgo.pvz.manifest.v2',
    files: [
      { r2, fs: 'main.pak', size: statSync(mainFile).size, sha256: sha256File(mainFile) },
      ...properties,
    ],
    bundles: [bundle],
  }
}
writeFileSync(join(publicRoot, 'cn/pvz-manifest.json'), JSON.stringify(manifest(cnMain, 'main.pak'), null, 2) + '\n')
writeFileSync(join(publicRoot, 'en/pvz-manifest.json'), JSON.stringify(manifest(enMain, 'en-main.pak'), null, 2) + '\n')
writeFileSync(join(publicRoot, 'pvz-pack.json'), JSON.stringify({ ...bundle, localFile: `.pvz-data/${fileName}` }, null, 2) + '\n')

console.log(`PvZ 流式包已生成：${finalFile}`)
console.log(`  文件：${files.length} 个；解包 ${(unpackedBytes / 1048576).toFixed(1)} MB；压缩 ${(packedBytes / 1048576).toFixed(1)} MB`)
console.log(`  SHA-256：${packedSha256}`)
console.log(`  R2 key：PvZ/properties/${bundle.r2}`)
