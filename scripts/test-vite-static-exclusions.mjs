#!/usr/bin/env node
/** 守住 Vite 大型静态目录的排除边界，避免把可变运行时误改成构建期软链。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HUGE_STATIC_DIRS, VERSIONED_RUNTIME_DIRS } from './lib/vite-static-exclusions.mjs'
import { CACHE, staticCacheHeaders } from '../server/src/cache.js'

const root = resolve(import.meta.dirname, '..')
const publicDir = join(root, 'public')
const expectedVersioned = ['dolphin', 'eka2l1', 'ppsspp']

assert.deepEqual([...VERSIONED_RUNTIME_DIRS].sort(), expectedVersioned)
for (const directory of VERSIONED_RUNTIME_DIRS) {
  const target = join(publicDir, directory)
  if (!existsSync(target)) continue // 精简构建环境可以不带该模拟器资源
  assert.ok(statSync(target).isDirectory(), `${directory} 必须是静态目录`)

  const children = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(children.length > 0, `${directory} 没有版本目录，不能假设 URL 不变`)
  assert.ok(children.every((name) => /^v[\w.-]+$/.test(name)), `${directory} 含非版本化顶层目录：${children.join(', ')}`)

  const headers = new Map()
  staticCacheHeaders({ setHeader: (name, value) => headers.set(name, value) }, join(root, 'dist/client', directory, children[0], 'runtime.js'))
  assert.equal(headers.get('Cache-Control'), CACHE.engineVersioned, `${directory} 的软链路径必须继续命中版本化缓存策略`)
}

assert.deepEqual(new Set(HUGE_STATIC_DIRS).size, HUGE_STATIC_DIRS.length, '暂存清单不能重复')
for (const mutable of ['emulatorjs', 'web/PvZ2', 'web/cs15', 'web/cs16']) {
  assert.ok(!HUGE_STATIC_DIRS.includes(mutable), `${mutable} 是可变入口或含可变入口，必须保留 dist 快照`)
}
for (const snapshot of ['jsdos', 'ruffle']) {
  assert.ok(!HUGE_STATIC_DIRS.includes(snapshot), `${snapshot} 的当前构建可能覆盖同版本 URL，必须保留 dist 快照`)
}

const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8')
assert.match(viteConfig, /import \{ HUGE_STATIC_DIRS \} from '\.\/scripts\/lib\/vite-static-exclusions\.mjs'/)
assert.match(viteConfig, /const HUGE_STATIC = HUGE_STATIC_DIRS/)

// EKA2L1 的版本目录在 public/ 与 dist/client/ 间软链；页面壳需短缓存，pthread 资源需隔离头。
for (const [file, expectedCache] of [
  ['/dist/client/eka2l1/v0123456789ab/index.html', CACHE.engine],
  ['/dist/client/eka2l1/v0123456789ab/eka2l1.wasm', CACHE.engineVersioned],
]) {
  const headers = new Map()
  staticCacheHeaders({ setHeader: (name, value) => headers.set(name, value) }, file)
  assert.equal(headers.get('Cache-Control'), expectedCache, `${file} 缓存策略错误`)
  assert.equal(headers.get('Cross-Origin-Opener-Policy'), 'same-origin', `${file} 缺 COOP`)
  assert.equal(headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', `${file} 缺 COEP`)
  assert.equal(headers.get('Cross-Origin-Resource-Policy'), 'same-origin', `${file} 缺 CORP`)
}
{
  const headers = new Map()
  staticCacheHeaders({ setHeader: (name, value) => headers.set(name, value) }, '/dist/client/eka2l1/v0123456789ab/run.html')
  assert.equal(headers.get('X-Robots-Tag'), 'noindex, nofollow', '模拟器运行页不应成为搜索落地页')
}
console.log(`✅ Vite 只软链不可变版本化静态运行时：${VERSIONED_RUNTIME_DIRS.join('、')}`)
console.log('✅ EmulatorJS、js-dos、Ruffle 与含可变入口的网页游戏仍保留 dist 快照')
