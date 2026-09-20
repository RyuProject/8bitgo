/**
 * 封面缩略图（…-96.webp）的取图兜底 —— 用内存版 R2 mock 把 Worker 的 GET 真跑一遍。
 *
 *   node scripts/test-cover-thumb.mjs      （或 npm run test:cover-thumb）
 *
 * 为什么值得测：老封面上传时还没有「再压一张 96」这一步，缩略图 key 是取不到的。
 * 兜底写在 Worker 里（缺对象时用原图顶上），而 Worker 是**单独部署**的（wrangler deploy）——
 * 没兜底的表现不是报错，而是浏览器每张小图先吃一个 404、再发一次主图请求：
 * 一次看不出来，只是在弱网上更慢一点。这种退化最容易悄悄留在线上。
 */
import assert from 'node:assert/strict'
import worker from '../worker/src/index.js'

let failed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/** 最小的 R2 mock：只实现 GET / HEAD 用到的那几个成员 */
function makeEnv(objects) {
  const bucket = {
    async get(key) {
      const found = objects.get(key)
      return found ? { ...found } : null
    },
    async head(key) {
      const found = objects.get(key)
      return found ? { ...found } : null
    },
  }
  return { ROMS: bucket, ALLOWED_ORIGINS: '*' }
}

function objectOf(text, type = 'image/webp') {
  const bytes = new TextEncoder().encode(text)
  return {
    size: bytes.byteLength,
    httpEtag: '"e"',
    body: bytes,
    writeHttpMetadata(headers) {
      headers.set('Content-Type', type)
    },
  }
}

const get = (env, key) => worker.fetch(new Request(`https://roms.test/${key}`), env)
const bodyText = async (res) => new TextDecoder().decode(await res.arrayBuffer())

test('缩略图存在 -> 直接给缩略图（不碰原图）', async () => {
  const env = makeEnv(new Map([['covers/a-96.webp', objectOf('thumb')]]))
  const res = await get(env, 'covers/a-96.webp')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'image/webp')
  assert.equal(await bodyText(res), 'thumb')
})

test('老封面（无缩略图）-> 用原图顶上，而不是 404', async () => {
  const env = makeEnv(new Map([['covers/b.webp', objectOf('full')]]))
  const res = await get(env, 'covers/b-96.webp')
  assert.equal(res.status, 200, '兜底没生效，浏览器会先吃一个 404')
  assert.equal(await bodyText(res), 'full')
  assert.equal(res.headers.get('Content-Type'), 'image/webp')
  assert.match(res.headers.get('Cache-Control') ?? '', /max-age=/, '兜底响应也要带缓存头')
})

test('缩略图和原图都没有 -> 仍然 404', async () => {
  const env = makeEnv(new Map())
  const res = await get(env, 'covers/c-96.webp')
  assert.equal(res.status, 404)
})

test('非图片的 -96 key 不被兜底误伤（ROM 之类不生成缩略图）', async () => {
  const env = makeEnv(new Map([['roms/gba/x.zip', objectOf('rom', 'application/zip')]]))
  const res = await get(env, 'roms/gba/x-96.zip')
  assert.equal(res.status, 404, 'zip 不该被当成缩略图去回退')
})

test('普通 key 不受影响（原图照常可取）', async () => {
  const env = makeEnv(new Map([['covers/d.webp', objectOf('full')]]))
  const res = await get(env, 'covers/d.webp')
  assert.equal(res.status, 200)
  assert.equal(await bodyText(res), 'full')
})

for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error.message}`)
  }
}

if (failed) {
  console.log(`\n❌ ${failed} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\n✅ 封面缩略图兜底 ${cases.length} 项通过`)
}
