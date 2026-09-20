/**
 * J2ME 临时 JAR 目录（TemporaryJarStore）与上游响应边界（bounded-response）。
 *
 * 这两块是审计报告 F04 / F05 的修复落点：
 *
 *   F04 · 配额检查与落盘之间有并发窗口
 *     以前是「同步扫一遍目录算总量 → await writeFile」。多个请求能同时看到同一个旧总量
 *     一起把目录写超配额；而且公开路径在写入完成前就出现了，失败时会留下半截文件。
 *     现在把「算配额、写临时文件、rename 提交」串行化，配额记账以字节为准（不是文件数）。
 *
 *   F05 · 上游响应没有大小 / 期限 / 并发边界
 *     以前 arrayBuffer 整包缓冲，不管上游声明多大、也不管客户端是否已经离开。
 *     现在逐块计量、预检 Content-Length 并复查实际字节，断连即取消，超时 504。
 *
 * 审计包里的对应用例（audit/tests/resources.test.mjs）混了本仓库尚未采纳的其它改动
 * （trusted-proxy / bounded-multipart / envNumber 抛异常那套语义），这里只保留这两块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, utimes, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { load } from './helpers/target.mjs'

const { readResponseBuffer } = await load('src/bounded-response.js')
const { TemporaryJarStore } = await load('src/temporary-jar-store.js')

/* ---------------- bounded-response（F05） ---------------- */

test('恰好等于上限的响应可以接受', async () => {
  assert.equal((await readResponseBuffer(new Response('12345'), 5)).toString(), '12345')
})

test('声明长度超限时在读数据之前就拒绝', async () => {
  let cancel = false
  const stream = new ReadableStream({ cancel() { cancel = true } })
  await assert.rejects(readResponseBuffer(new Response(stream, { headers: { 'Content-Length': '1000' } }), 10), {
    code: 'UPSTREAM_TOO_LARGE',
  })
  assert.ok(cancel, '拒绝时要带上游一起取消，别让连接挂着')
})

test('Content-Length 撒谎时按实际字节再查一遍', async () => {
  await assert.rejects(readResponseBuffer(new Response('123456', { headers: { 'Content-Length': '1' } }), 5), {
    code: 'UPSTREAM_TOO_LARGE',
  })
})

test('取消能打断卡住的数据流并释放 reader', async () => {
  let cancel = false
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ cancel() { cancel = true } }))
  const task = readResponseBuffer(response, 100, controller.signal)
  controller.abort(new Error('stop'))
  await assert.rejects(task, /stop/)
  assert.ok(cancel)
  assert.equal(response.body.locked, false)
})

test('没有正文的响应当作空内容', async () => {
  assert.equal((await readResponseBuffer(new Response(null), 10)).length, 0)
})

/* ---------------- TemporaryJarStore（F04） ---------------- */

async function tempStore(fn, { maxBytes = 500, ttlMs = 60000 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), '8bitgo-store-'))
  try {
    return await fn(new TemporaryJarStore({ directory, maxBytes, ttlMs }), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('20 个并发写入不会把 500 字节的目录写超配额', () =>
  tempStore(async (store, dir) => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.put(Buffer.alloc(50))))
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 10)
    assert.equal(store.total, 500)
    assert.equal((await readdir(dir)).length, 10)
  }))

test('发布出去的文件是完整内容，不残留暂存后缀', () =>
  tempStore(async (store, dir) => {
    const name = await store.put(Buffer.from('complete'))
    assert.equal((await readFile(path.join(dir, name))).toString(), 'complete')
    assert.deepEqual(await readdir(dir), [name])
  }))

test('内容相同的两次上传各自成文件，删一个不影响另一个', () =>
  tempStore(async (store, dir) => {
    const a = await store.put(Buffer.from('same'))
    const b = await store.put(Buffer.from('same'))
    assert.notEqual(a, b)
    await store.remove(a)
    assert.equal((await readFile(path.join(dir, b))).toString(), 'same')
    assert.equal(store.total, 4)
  }))

test('过期清扫同时算上已发布的 jar 和孤儿暂存文件', () =>
  tempStore(async (store, dir) => {
    const a = `tmp-${'a'.repeat(32)}.jar`
    const b = `tmp-${'b'.repeat(32)}.jar.part`
    for (const n of [a, b]) {
      await writeFile(path.join(dir, n), Buffer.alloc(20))
      await utimes(path.join(dir, n), new Date(1), new Date(1))
    }
    assert.equal(await store.sweep(), 2)
    assert.equal(store.total, 0)
  }))

test('不认识的文件保留，符号链接不会被当成托管 jar', () =>
  tempStore(async (store, dir) => {
    await writeFile(path.join(dir, 'keep.txt'), 'keep')
    const name = `tmp-${'c'.repeat(32)}.jar`
    await symlink(path.join(dir, 'keep.txt'), path.join(dir, name))
    await store.sweep()
    assert.equal(await store.touch(name), false)
    assert.equal((await readFile(path.join(dir, 'keep.txt'))).toString(), 'keep')
  }))

test('release / touch 拒绝路径穿越且不动文件系统', () =>
  tempStore(async (store) => {
    assert.equal(await store.remove('../secret'), false)
    assert.equal(await store.touch('../secret'), false)
  }))

test('一次超配额的失败不会毒化后续写入', () =>
  tempStore(async (store) => {
    await assert.rejects(store.put(Buffer.alloc(501)), { code: 'J2ME_QUOTA' })
    const name = await store.put(Buffer.alloc(100))
    await store.remove(name)
    assert.equal(store.total, 0)
  }))

test('keepalive 续期之后不会被下一轮清扫删掉', () =>
  tempStore(async (store, dir) => {
    const name = await store.put(Buffer.alloc(10))
    await utimes(path.join(dir, name), new Date(1), new Date(1))
    assert.equal(await store.touch(name), true)
    assert.equal(await store.sweep(), 0)
  }))
