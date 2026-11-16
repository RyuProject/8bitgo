import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(repo, 'node_modules/un7z-opfs')
const defaultTarget = resolve(repo, 'public/web/gta-vc/vendor/un7z-opfs')
const files = [
  'License.txt',
  'README.md',
  'index.d.ts',
  'package.json',
  'dist/7zz.js',
  'dist/7zz.wasm',
  'patches/7zz-emcc.patch',
  'src-glue/opfs_fs.js',
  'worker/opfs-extractor.js',
]

export function copyGtaVc7zRuntime(targetRoot = defaultTarget) {
  if (!existsSync(packageRoot)) {
    throw new Error('缺少 un7z-opfs；请先运行 npm install')
  }

  const metadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  if (metadata.version !== '1.0.2') {
    throw new Error(`un7z-opfs 版本变化（当前 ${metadata.version}），请审核后更新固定版本与清单`)
  }

  mkdirSync(targetRoot, { recursive: true })
  for (const file of files) {
    const source = resolve(packageRoot, file)
    if (!existsSync(source)) throw new Error(`un7z-opfs 缺少发布文件：${file}`)
    cpSync(source, resolve(targetRoot, file), { recursive: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyGtaVc7zRuntime()
  console.log('已准备 GTA VC 浏览器端 7z 解码器')
}
