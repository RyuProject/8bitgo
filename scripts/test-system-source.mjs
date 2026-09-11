#!/usr/bin/env node
/**
 * 系统镜像多源兜底的回归测试。跑：npm run test:system-source
 *
 * 站长 2026-09-11：「做一个兜底方案，确保每个用户至少是可以正确加载镜像的」。
 *
 * ⚠️ 这块的失败方式全是安静的：换错源 = 玩家拿到另一个 Windows（能开机、游戏跑不起来）；
 * 取消时还往下试 = 玩家换了游戏还在后台下 40MB；不验下载结果 = 把一页 HTML 错误页
 * 喂进 js-dos，报出来的错和真正的原因隔着十万八千里。所以每条都要钉。
 */
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import {
  looksLikeSystemBundle,
  loadSystemBytes,
  systemCacheUrl,
  systemSourcesFor,
} from '../src/emulator/systemSource.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/* ---------------- 造一个最小的 zip ---------------- */

function crc32(buf) {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 造一个 zip。names 里每项 [文件名, 内容] */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let off = 0
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'latin1')
    const data = Buffer.from(text, 'utf8')
    const body = deflateRawSync(data)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lh, nameBuf, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(off, 42)
    centrals.push(ch, nameBuf)
    off += 30 + nameBuf.length + body.length
  }
  const l = Buffer.concat(locals)
  const c = Buffer.concat(centrals)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10)
  e.writeUInt32LE(c.length, 12); e.writeUInt32LE(l.length, 16)
  const all = Buffer.concat([l, c, e])
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

const GOOD = makeZip([['.jsdos/dosbox.conf', '[autoexec]\n'], ['disk.qcow2', 'x'.repeat(200)]])
const NO_CONF = makeZip([['readme.txt', 'hi']])

/* ---------------- 假 fetch ---------------- */

function fakeFetch(routes) {
  return async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const r = routes[url]
    if (!r) throw new TypeError('Failed to fetch')
    // before 用来模拟「下载途中玩家取消」：先让外部 signal 真的 abort，再抛
    if (r.before) r.before()
    if (r.throw) throw r.throw
    if (r.hang) {
      // 永远不 resolve，直到被 abort —— 用来验失速探测
      return await new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      })
    }
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status ?? 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? r.type ?? 'application/octet-stream' : null) },
      body: null,
      arrayBuffer: async () => r.body,
    }
  }
}

const PRIMARY = 'https://assets.8bitgo.com/systems/dos/system-win95-v1.jsdos'
const OFFICIAL = 'https://br.cdn.dos.zone/js-dos/system/system-win95-v1.jsdos'

console.log('一、镜像表')

await check('已登记的路径有备用源，而且主源永远排第一', () => {
  const s = systemSourcesFor(PRIMARY)
  assert.equal(s.length, 2)
  assert.equal(s[0].url, PRIMARY, '主源不是第一个 —— 备用源不是「更快的源」，顺序不能倒')
  assert.equal(s[1].url, OFFICIAL)
})

await check('⚠️⚠️ 我们自己改出来的 VGA 镜像绝不能回落到官方那份', () => {
  /*
    system-win311-vga-v1 是把官方 win311 的 SYSTEM.INI 显示驱动换成标准 VGA 之后的产物。
    登记成官方那份的镜像 = 主源一抖就把 800x600 真彩的系统发下去，
    Zeek 这类 16 色游戏又变回空白窗口，而且不报任何错。
  */
  const s = systemSourcesFor('https://assets.8bitgo.com/systems/dos/system-win311-vga-v1.jsdos')
  assert.equal(s.length, 1, '给它配了备用源 —— 那不是同一个系统')
  assert.ok(!s.some((x) => x.url.includes('dos.zone')), '回落到了官方源')
})

await check('⚠️ 没登记的镜像不猜备用源', () => {
  /*
    官方那边 system-win95-v2.jsdos 是「Windows 95 (DT)」，和 v1 不是同一个系统。
    按文件名猜的话，我们哪天自己传一个叫 v2 的文件，兜底就会把另一个 Windows 发给玩家 ——
    能开机、游戏未必跑得起来，而且没有任何报错。宁可漏配，不能猜。
  */
  for (const u of [
    'https://assets.8bitgo.com/systems/dos/system-win95-v2.jsdos',
    'https://assets.8bitgo.com/systems/dos/system-win95-v1-deflate.jsdos',
    'https://assets.8bitgo.com/roms/dos/whatever.zip',
  ]) {
    assert.equal(systemSourcesFor(u).length, 1, u + ' 不该有备用源')
  }
})

await check('主源本身就是官方地址时不重复排一遍', () => {
  assert.equal(systemSourcesFor(OFFICIAL).length, 1)
})

console.log('二、下载结果要当场验')

await check('合法 bundle 认得出来', () => {
  assert.equal(looksLikeSystemBundle(GOOD), true)
})

await check('⚠️ HTML 错误页 / 垃圾 / 缺 dosbox.conf 一律不认', () => {
  const html = new TextEncoder().encode('<!doctype html><h1>404</h1>').buffer
  assert.equal(looksLikeSystemBundle(html), false, 'HTML 被当成镜像了')
  assert.equal(looksLikeSystemBundle(new ArrayBuffer(0)), false, '空文件被当成镜像了')
  assert.equal(looksLikeSystemBundle(NO_CONF), false, '缺 .jsdos/dosbox.conf 的 zip 被当成镜像了')
})

console.log('三、换源的时机')

const origFetch = globalThis.fetch
const src = [{ url: PRIMARY, label: '主源' }, { url: OFFICIAL, label: 'js-dos 官方源' }]

await check('主源 500 → 自动换到备用源', async () => {
  globalThis.fetch = fakeFetch({ [PRIMARY]: { status: 500 }, [OFFICIAL]: { body: GOOD } })
  const r = await loadSystemBytes(src)
  assert.equal(r.usedFallback, true)
  assert.equal(r.url, OFFICIAL)
})

await check('主源返回网页 → 换源（字节数是「有」的，不验就会喂进 js-dos）', async () => {
  const html = new TextEncoder().encode('<!doctype html>').buffer
  globalThis.fetch = fakeFetch({ [PRIMARY]: { body: html, type: 'text/html' }, [OFFICIAL]: { body: GOOD } })
  const r = await loadSystemBytes(src)
  assert.equal(r.usedFallback, true)
})

await check('⚠️ 主源下了个不是镜像的 zip → 也要换源', async () => {
  globalThis.fetch = fakeFetch({ [PRIMARY]: { body: NO_CONF }, [OFFICIAL]: { body: GOOD } })
  const r = await loadSystemBytes(src)
  assert.equal(r.usedFallback, true, '只看 HTTP 状态码的话，这一份会被当成好的')
})

await check('主源好的时候不碰备用源', async () => {
  let officialHit = 0
  globalThis.fetch = fakeFetch({
    [PRIMARY]: { body: GOOD },
    get [OFFICIAL]() { officialHit++; return { body: GOOD } },
  })
  const r = await loadSystemBytes(src)
  assert.equal(r.usedFallback, false)
  assert.equal(officialHit, 0, '主源成功了还去打备用源')
})

await check('⚠️⚠️ 下载途中玩家取消 → 立刻出去，绝不试下一个源', async () => {
  /*
    取消不是失败。不分清楚的话，玩家换个游戏 / 关掉页面，后台还会接着去把
    另一个几十 MB 的源下完 —— 流量和 CPU 全白烧，而且没有任何人看得见。

    ⚠️ 这里必须模拟**下载途中**取消（before 里 abort 再抛），不能在调用前就 abort：
    那样循环开头那道 `signal?.aborted` 闸会先拦下，catch 里真正要守的那条分支
    一次都走不到 —— 第一版就是这么写的，变异检查没变红才发现。
  */
  let officialHit = 0
  const ctl = new AbortController()
  globalThis.fetch = fakeFetch({
    [PRIMARY]: {
      before: () => ctl.abort(),
      throw: new DOMException('玩家切走了', 'AbortError'),
    },
    get [OFFICIAL]() { officialHit++; return { body: GOOD } },
  })
  /*
    ⚠️ 断言要落在**抛出去的是哪个错误**上，不能只看「有没有去打第二个源」——
    循环开头那道 signal?.aborted 闸本来就会拦住第二个源，所以只看 officialHit
    的话，catch 里那条分支删掉也不会红（第一版就是这样，变异检查没红才发现）。
    区别在于：catch 那条把**原始的**取消原因原样抛出去，闸那条只会合成一个笼统的。
    调用方（jsdos.ts 的 onError）要靠这个区分「玩家自己走了」和别的失败。
  */
  await assert.rejects(
    () => loadSystemBytes(src, undefined, ctl.signal),
    (e) => {
      assert.equal(e.name, 'AbortError')
      assert.equal(e.message, '玩家切走了', '原始的取消原因被吞掉、换成合成的了')
      return true
    },
  )
  assert.equal(officialHit, 0, '取消之后还去试备用源')
})

await check('全都取不到时，报错里要点名每个源和原因', async () => {
  globalThis.fetch = fakeFetch({ [PRIMARY]: { status: 503 }, [OFFICIAL]: { status: 404 } })
  await assert.rejects(
    () => loadSystemBytes(src),
    (e) => {
      assert.match(e.message, /主源/, '没点名主源')
      assert.match(e.message, /js-dos 官方源/, '没点名备用源')
      assert.match(e.message, /503/)
      assert.match(e.message, /404/)
      return true
    },
  )
})

console.log('三点五、缓存：那 20 MB 不该每次都重下一遍')

/*
  背景：系统镜像 21,498,320 字节，占一次冷启动全部下载量的 71%。
  而 romCacheKey 要求地址带 `?romv=<etag>`，romUrlForKey 又不加 —— 所以在 09-11 之前
  这份镜像**一次都没被缓存过**，每个玩家每次进任何 Windows 游戏都重下 20 MB。
  现在先 HEAD 一趟拿 ETag 把 key 拼出来，再走 romCache。
*/

await check('拿到 ETag → 拼成带 romv 的地址（这样 romCacheKey 才认）', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'HEAD', '探 ETag 必须用 HEAD，不能把整个镜像拉下来')
    assert.equal(init?.cache, 'no-store', '自己吃缓存就永远读不到新的 ETag')
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"abc123"' : null) } }
  }
  assert.equal(await systemCacheUrl(PRIMARY), `${PRIMARY}?romv=abc123`)
})

await check('弱 ETag 的 W/ 前缀和引号要剥掉', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'W/"xyz"' } })
  assert.equal(await systemCacheUrl(PRIMARY), `${PRIMARY}?romv=xyz`)
})

await check('⚠️⚠️ 读不到 ETag 时用 Last-Modified 兜底', async () => {
  /*
    ETag **不在 CORS 响应头安全列表里**。系统镜像在资源域名上（跨域），服务器不额外发
    `Access-Control-Expose-Headers: ETag` 的话 headers.get('etag') 就是 null ——
    于是拼不出 romv、缓存一个字节都不生效，而且没有任何报错。
    Last-Modified 在安全列表里，任何跨域配置下都读得到。
  */
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'last-modified' ? 'Tue, 01 Apr 2025 12:27:00 GMT' : null) },
  })
  const url = await systemCacheUrl(PRIMARY)
  assert.match(url, /[?&]romv=/, '⭐ 只认 ETag 的话，跨域没暴露这个头就等于整套缓存白写')
  assert.ok(url.startsWith(PRIMARY), '兜底也要挂在原地址上')
})

await check('⚠️ ETag 优先于 Last-Modified', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"e1"' : 'Tue, 01 Apr 2025 12:27:00 GMT') },
  })
  assert.equal(await systemCacheUrl(PRIMARY), `${PRIMARY}?romv=e1`)
})

await check('⚠️ 两个版本头都没有 → 返回空串（明确「这次不缓存」）', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null } })
  const url = await systemCacheUrl(PRIMARY)
  assert.equal(url, '', '没有版本号却返回了地址，上层会拿它当 key —— 那等于把「过期镜像复活」的坑又挖回来')
})

await check('⚠️ HEAD 失败 / 断网 / CORS 不暴露 ETag → 返回空串，照常走网络', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, headers: { get: () => null } })
  assert.equal(await systemCacheUrl(PRIMARY), '')
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  assert.equal(await systemCacheUrl(PRIMARY), '', '探测抛异常必须被吞掉 —— 缓存只是加速，不能让人玩不了游戏')
})

await check('⚠️ 已经取消了就别再探', async () => {
  let called = 0
  globalThis.fetch = async () => { called++; return { ok: true, status: 200, headers: { get: () => null } } }
  const ctl = new AbortController()
  ctl.abort()
  assert.equal(await systemCacheUrl(PRIMARY, ctl.signal), '')
  assert.equal(called, 0, '已取消还去打了一次 HEAD')
})

await check('⚠️ node / 无痕 / SSR（没有 IndexedDB）下连探都不探', async () => {
  // 没有本地缓存时这趟往返的结果没人用得上，白给每次加载加一个 RTT
  let heads = 0
  globalThis.fetch = fakeFetch({ [PRIMARY]: { body: GOOD } })
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'HEAD') heads++
    return inner(url, init)
  }
  assert.equal(typeof indexedDB, 'undefined', '这条用例的前提是 node 里没有 indexedDB')
  const got = await loadSystemBytes(systemSourcesFor(PRIMARY))
  assert.equal(got.fromCache, false)
  assert.equal(heads, 0, '没有缓存可用却还是探了一趟')
})

console.log('三点六、缓存那几条不变量（源码守卫）')

/*
  下面几条的共同点：**错了都不会报错**，只会让玩家某一天打不开游戏、而且清缓存前不会自愈。
  行为测试要在 node 里造 IndexedDB 才跑得动，代价远大于收益，所以钉在源码上。
*/
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SRC = strip(readFileSync(new URL('../src/emulator/systemSource.ts', import.meta.url), 'utf8'))
const JSDOS = strip(readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8'))

await check('⚠️ 只有主源那一份写缓存', () => {
  assert.match(
    SRC,
    /if \(key && i === 0\) void romCachePut\(/,
    '备用源的内容按主源的 key 存进去 = 把一个可能不同的 Windows 永久钉在玩家本地，主源好了也换不回来',
  )
})

await check('⚠️ 缓存命中要先验是不是合法镜像，坏的要删掉再走网络', () => {
  const at = SRC.indexOf('romCacheGet(')
  assert.ok(at > 0, '没有读缓存')
  const body = SRC.slice(at, at + 700)
  assert.match(body, /looksLikeSystemBundle\(hit\)/, '命中直接就用了 —— 历史上写坏的那条会让这台浏览器永远起不来')
  assert.match(body, /romCacheDelete\(key\)/, '坏的那条不删，每次都撞上它')
})

await check('⚠️⚠️ jsdos.ts 改名前必须复制（否则改过名的镜像会被存进缓存）', () => {
  /*
    hideJsdosConfigForLayer 是原地改字节的，而 romCachePut 是不 await 的后台写，
    两者指着同一块 ArrayBuffer。不复制的话存进去的就是改过名的那份，
    下次命中找不到 .jsdos/dosbox.conf，客体永远起不来，清缓存前不会自愈。
    这一行 09-11 上午因为「反正没缓存」被删过一次，下午加了缓存必须补回来。
  */
  assert.match(
    JSDOS,
    /hideJsdosConfigForLayer\(\s*loadedSystem\.fromCache \? loadedSystem\.data : loadedSystem\.data\.slice\(0\)/,
    '走网络的那份没复制就交给原地改名的函数了',
  )
})

globalThis.fetch = origFetch

console.log('四、接线')

await check('⚠️ jsdos 适配器真的用上了多源加载', async () => {
  const { readFileSync } = await import('node:fs')
  const src2 = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.match(src2, /loadSystemBytes\(\s*\n?\s*systemSourcesFor\(options\.dosSystemUrl\)/, '系统镜像还在走单源的 loadGameBytes')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
