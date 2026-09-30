#!/usr/bin/env node

/**
 * 构建前修复已安装的 PvZ2 入口。
 *
 * public/web/PvZ2 整体被忽略，生产机上的旧目录不会随 git pull 更新；因此旧 index.html
 * 可能缺 base 或残留 Cloudflare / GA 注入。这里只修 Git 能定义的入口，不联网，也不碰
 * 722MB 资产。目录尚未安装时保持缺失，让普通构建继续沿用 check-pvzge 的跳过语义。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareExistingPvzge } from './lib/pvzge-index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public/web/PvZ2')
const result = prepareExistingPvzge(out)

if (result === 'missing') {
  console.log(`PvZ2 入口准备跳过：未找到 ${out}/index.html（先跑 npm run pvzge:fetch）`)
} else if (result === 'repaired') {
  console.log('✔ 已修复 PvZ2 index.html（base 正确、无 Cloudflare/GA 注入）')
} else {
  console.log('✔ PvZ2 index.html 已是当前模板')
}
