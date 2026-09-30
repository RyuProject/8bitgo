#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareExistingPvzge, PVZGE_INDEX_HTML } from './lib/pvzge-index.mjs'

const root = mkdtempSync(join(tmpdir(), '8bitgo-pvzge-'))
const missing = join(root, 'missing')
const installed = join(root, 'installed')

try {
  assert.equal(prepareExistingPvzge(missing), 'missing', '未安装时必须跳过')
  assert.equal(existsSync(missing), false, '跳过时不能制造残缺的 PvZ2 目录')

  // 测试目录由 mkdtemp 提供；单独建子目录只为模拟跨 git pull 留下的旧运行时。
  mkdirSync(installed)
  writeFileSync(
    join(installed, 'index.html'),
    '<script src="https://www.googletagmanager.com/gtag/js"></script><script data-cf-settings="rocket-loader"></script>',
  )

  assert.equal(prepareExistingPvzge(installed), 'repaired', '旧入口必须被修复')
  const repaired = readFileSync(join(installed, 'index.html'), 'utf8')
  assert.equal(repaired, PVZGE_INDEX_HTML)
  assert.match(repaired, /<base href="\/web\/PvZ2\/">/)
  assert.doesNotMatch(repaired, /googletagmanager|rocket-loader|cf-settings/)
  assert.equal(prepareExistingPvzge(installed), 'unchanged', '重复执行必须幂等')

  console.log('✔ PvZ2 构建前入口修复测试通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
