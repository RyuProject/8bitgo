/**
 * 虚拟文件系统写入辅助（src/emulator/fsWrite.ts）的回归测试。
 *
 *   npm run test:fs-write
 *
 * 为什么值得测：这段逻辑的失败是**完全静默**的。
 *
 *   1. `FS.writeFile` 不会创建中间目录（实测：父目录不存在时抛 ENOENT）。
 *      注入现在已经逐文件隔离失败，但漏建目录仍会让当前 BIOS 消失，
 *      回报与“后台没绑地址”几乎一样。
 *   2. 症状与「本来就没绑地址」一模一样：核心报缺文件，而文件看起来确实准备了。
 *
 * 2026-09-20 的真实事故：mame-current 的 BIOS 要写进 /roms（核心拿父目录当 system dir），
 * 而 /roms 是内容搬迁那一步才建的、注入却跑在它之前 —— 直链游戏那条路 /roms 根本不存在。
 */
import assert from 'node:assert/strict'
import { ensureParentDir } from '../src/emulator/fsWrite.ts'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 记下 mkdir 调用序列的假 FS；failOn 里的路径会抛（模拟 EEXIST） */
const fakeFs = (failOn = []) => {
  const calls = []
  return {
    calls,
    fs: {
      mkdir: (path) => {
        if (failOn.includes(path)) throw new Error('EEXIST')
        calls.push(path)
      },
    },
  }
}

console.log('\n虚拟文件系统写入辅助')

check('根目录下的文件不动 mkdir（/x.zip 的父目录已经是根）', () => {
  const { fs, calls } = fakeFs()
  ensureParentDir(fs, '/x.zip')
  assert.deepEqual(calls, [])
})

check('没有斜杠的路径不动 mkdir', () => {
  const { fs, calls } = fakeFs()
  ensureParentDir(fs, 'x.zip')
  assert.deepEqual(calls, [])
})

check('单级父目录照建（/roms/x.zip → /roms）—— 这次事故就是这一格', () => {
  const { fs, calls } = fakeFs()
  ensureParentDir(fs, '/roms/mxsqy102tw.zip')
  assert.deepEqual(calls, ['/roms'])
})

check('多级逐级建，且顺序是从上到下（Emscripten 的 mkdir 不是递归的）', () => {
  const { fs, calls } = fakeFs()
  ensureParentDir(fs, '/a/b/c/x.zip')
  assert.deepEqual(calls, ['/a', '/a/b', '/a/b/c'])
})

check('目录已存在（mkdir 抛 EEXIST）不往外抛', () => {
  const { fs, calls } = fakeFs(['/roms'])
  assert.doesNotThrow(() => ensureParentDir(fs, '/roms/x.zip'))
  assert.deepEqual(calls, [])
})

check('多级里中间某级已存在：剩下的照样建', () => {
  const { fs, calls } = fakeFs(['/a'])
  ensureParentDir(fs, '/a/b/c.zip')
  assert.deepEqual(calls, ['/a/b'])
})

check('FS 没有 mkdir（老实现）也不炸', () => {
  assert.doesNotThrow(() => ensureParentDir({}, '/roms/x.zip'))
})

check('重复的斜杠不会建出怪目录', () => {
  const { fs, calls } = fakeFs()
  ensureParentDir(fs, '//roms//x.zip')
  assert.deepEqual(calls, ['/roms'])
})

// MAME CHD：Blob 到写入时才物化，独占缓冲区交给 MEMFS（canOwn），写完立刻放掉引用
{
  const { writeFsInjections } = await import('../src/emulator/fsInjection.ts')
  const writes = []
  const fs = { mkdir() {}, writeFile(path, bytes, opts) { writes.push({ path, size: bytes.length, canOwn: Boolean(opts?.canOwn) }) } }
  const chd = { path: '/roms/taiko2/nm-002.chd', required: true, exclusive: true, bytes: Promise.resolve(new Blob([new Uint8Array(1234)])) }
  const bios = { path: '/roms/namcoc76.zip', bytes: Promise.resolve(new Uint8Array(16)) }
  const failures = await writeFsInjections(fs, [bios, chd], () => {})
  check('CHD 以 Blob 注入：写入时物化一次并交出所有权', () => {
    assert.deepEqual(failures, [])
    assert.deepEqual(writes, [
      { path: '/roms/namcoc76.zip', size: 16, canOwn: false },
      { path: '/roms/taiko2/nm-002.chd', size: 1234, canOwn: true },
    ])
  })
  check('独占注入写完后不再持有 160MB 字节', async () => {
    assert.equal(await chd.bytes, null)
  })
}

{
  const { combinedRomProgress } = await import('../src/emulator/romProgress.ts')
  if (combinedRomProgress) {
    const seen = []
    const of = combinedRomProgress((p) => seen.push(p), { rom: 0, 'chd:nm-002': 1000 })
    of('rom')({ phase: 'rom', loaded: 100, total: 100, ratio: 1 })
    check('ROM 先下完时合并进度不能满格（CHD 还在下）', () => {
      assert.equal(seen.at(-1).ratio, 100 / 1100)
    })
    of('chd:nm-002')({ phase: 'rom', loaded: 1000, total: 1000, ratio: 1 })
    check('两条流都完成才满格', () => assert.equal(seen.at(-1).ratio, 1))
  }
}

console.log(failed === 0 ? '\n虚拟文件系统写入辅助测试通过\n' : `\n虚拟文件系统写入辅助测试失败：${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
