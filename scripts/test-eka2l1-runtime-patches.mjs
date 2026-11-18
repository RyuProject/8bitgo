#!/usr/bin/env node
/**
 * EKA2L1 补丁表的回归测试：applyReplacePatch 的命中规则，以及 2026-11-19 修的「核心启动即报 reading 'IDBFS'」。
 *
 *   npm run test:eka2l1-patches
 *
 * 那次的根因：本站用 emcc 7 构建，胶水里没有 FS.filesystems、也没导出 IDBFS，上游 boot.js 却照旧
 * mod.FS.mount(mod.FS.filesystems.IDBFS, …)。修法是 idbfs-current-emscripten（boot.js）+ idbfs-module-export（胶水）。
 * 仓库里还留着出事的那版运行时 vce3dcea2a438，拿它当「修之前」的样本；它被清理后这几项自动跳过。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EKA2L1_ALL_PATCHES, EKA2L1_GLUE_PATCHES, EKA2L1_PATCHES,
  applyReplacePatch, eka2l1PublishedPagePath,
} from './lib/eka2l1-patches.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✖ ${name}`)
    throw err
  }
}

const sample = { id: 'sample', file: 'x.js', replace: [['a = 1;', 'a = 2; // $& $1']] }

console.log('EKA2L1 补丁表')

test('applyReplacePatch：恰好一次才替换，已在位跳过，替换文本按字面写入', () => {
  assert.equal(applyReplacePatch('x; a = 1; y', sample), 'x; a = 2; // $& $1 y')
  assert.equal(applyReplacePatch('a = 2; // $& $1', sample), 'a = 2; // $& $1', '已打过的不能再打一次')
  assert.throws(() => applyReplacePatch('nothing here', sample), /命中 0 次/)
  assert.throws(() => applyReplacePatch('a = 1; a = 1;', sample), /命中 2 次/)
})

test('补丁表：id 不重复，页面补丁能映射到发布路径，胶水补丁指向 eka2l1.js', () => {
  const ids = EKA2L1_ALL_PATCHES.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(eka2l1PublishedPagePath('src/emu/web/pages/js/boot.js'), 'js/boot.js')
  assert.equal(eka2l1PublishedPagePath('src/emu/cpu/src/x.cpp'), '')
  assert.ok(EKA2L1_PATCHES.some((p) => p.id === 'idbfs-current-emscripten' && p.file === 'src/emu/web/pages/js/boot.js'))
  assert.deepEqual(EKA2L1_GLUE_PATCHES.map((p) => p.file), ['eka2l1.js'])
})

const broken = join(root, 'public', 'eka2l1', 'vce3dcea2a438')
if (existsSync(join(broken, 'js', 'boot.js')) && existsSync(join(broken, 'eka2l1.js'))) {
  test('出事那版 boot.js：补丁后不再从 FS.filesystems 取 IDBFS，缺省版本 / 存储名与胶水一致', () => {
    const before = readFileSync(join(broken, 'js', 'boot.js'), 'utf8')
    assert.ok(before.includes('mod.FS.mount(mod.FS.filesystems.IDBFS'), '样本应当是修之前的版本')
    const patch = EKA2L1_PATCHES.find((p) => p.id === 'idbfs-current-emscripten')
    const after = applyReplacePatch(before, patch)
    assert.ok(!after.includes('mod.FS.filesystems.IDBFS, {}'))
    assert.ok(!/IDBFS\.DB_STORE_NAME\)/.test(after), '存储名不能再直接用可能为 undefined 的属性')
    assert.ok(after.includes('function idbfsOf(mod)'))
    assert.ok(after.includes('IDBFS.DB_VERSION || 21'))
    assert.ok(after.includes("IDBFS.DB_STORE_NAME || 'FILE_DATA'"))
    assert.equal(applyReplacePatch(after, patch), after, '重复打必须不变')
  })

  test('出事那版胶水：确实没有 FS.filesystems，补丁后导出 Module.IDBFS 且只导出一次', () => {
    const before = readFileSync(join(broken, 'eka2l1.js'), 'utf8')
    assert.ok(!before.includes('filesystems'), '样本胶水里本来就没有 FS.filesystems（这是事故的根因）')
    assert.ok(/IDBFS_DB_VERSION=21/.test(before) && /IDBFS_DB_STORE_NAME="FILE_DATA"/.test(before),
      '胶水把版本 / 存储名做成了模块常量，boot.js 的缺省值必须与之相同')
    const [patch] = EKA2L1_GLUE_PATCHES
    const after = applyReplacePatch(before, patch)
    assert.equal(after.split('Module["IDBFS"]=IDBFS').length - 1, 1)
    assert.equal(applyReplacePatch(after, patch), after)
  })
} else {
  console.log('  · 仓库里已没有 vce3dcea2a438，跳过「修之前」样本测试')
}

const constants = readFileSync(join(root, 'src', 'emulator', 'eka2l1Runtime.ts'), 'utf8')
const buildId = /EKA2L1_BUILD_ID = '([0-9a-f]{12})'/.exec(constants)?.[1]
if (buildId) {
  test(`当前运行时 v${buildId}：boot.js 与胶水都已修好`, () => {
    const dir = join(root, 'public', 'eka2l1', `v${buildId}`)
    const boot = readFileSync(join(dir, 'js', 'boot.js'), 'utf8')
    assert.ok(boot.includes('function idbfsOf(mod)') && !boot.includes('mod.FS.mount(mod.FS.filesystems.IDBFS'))
    assert.ok(readFileSync(join(dir, 'eka2l1.js'), 'utf8').includes('Module["IDBFS"]=IDBFS'))
    const manifest = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'))
    assert.deepEqual(manifest.patches, EKA2L1_ALL_PATCHES.map((p) => p.id))
  })
}

console.log(`✓ EKA2L1 补丁表 ${passed} 项通过`)
