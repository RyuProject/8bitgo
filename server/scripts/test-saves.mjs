/**
 * 云存档接口的回归测试。
 *
 *   cd server && node scripts/test-saves.mjs
 *
 * 需要数据库（存档就是存在库里的）。连不上就整组跳过并正常退出 ——
 * 这样在没配数据库的机器上跑测试套件不会误报失败。
 *
 * 覆盖：必须登录 / 存取删 / 覆盖同一格 / 引擎之间互不覆盖 / 存档位隔离 /
 * 参数校验 / 超大存档被拒 / 只能看到自己的存档。
 *
 * 测试会建两个临时用户，跑完删掉（saves 有 ON DELETE CASCADE，存档跟着一起没）。
 */
import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ping, query } from '../src/db.js'
import { signToken } from '../src/auth.js'
import { savesRouter, MAX_SAVE_BYTES } from '../src/routes/saves.js'

// ping() 连不上时是**抛异常**而不是返回 false，所以这里必须包一层
const dbUp = await ping().catch(() => false)
if (!dbUp) {
  console.log('⏭  连不上数据库，跳过云存档测试（配好 server/.env 的 DB_* 再跑）')
  process.exit(0)
}

let failed = 0
const ok = (name, cond) => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
const section = (title) => console.log(`\n── ${title} ──`)

const app = express()
app.use('/api/saves', savesRouter)
// 和线上一样兜一层错误处理，否则 500 会变成挂起的连接
// 和 src/index.js 的兜底处理保持一致 —— 测试里要是自己写一套，
// 测的就不是线上真正会发生的事
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: '文件过大' })
  }
  const status = Number(err?.status || err?.statusCode || 0)
  if (status >= 400 && status < 500) return res.status(status).json({ error: '请求格式不正确' })
  console.error('   ↳ 服务端错误：', err.message)
  res.status(500).json({ error: 'server error' })
})
const http = createServer(app)
await new Promise((r) => http.listen(9941, r))
const API = 'http://127.0.0.1:9941'

/** 建个临时用户，返回它的 id 和 token */
async function makeUser(tag) {
  const id = `test-${tag}-${randomUUID().slice(0, 8)}`
  await query(
    'INSERT INTO users (id, email, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, `${id}@test.local`, `测试${tag}`, 'x', new Date().toISOString().slice(0, 10)],
  )
  return { id, token: signToken(id) }
}

const alice = await makeUser('a')
const bob = await makeUser('b')

const url = (runtime, slug, slot = 0, suffix = '') =>
  `${API}/api/saves/${runtime}/${encodeURIComponent(slug)}${suffix}?slot=${slot}`
const auth = (u) => ({ Authorization: `Bearer ${u.token}` })

const put = (u, runtime, slug, bytes, slot = 0) =>
  fetch(url(runtime, slug, slot), {
    method: 'PUT',
    headers: { ...auth(u), 'content-type': 'application/octet-stream' },
    body: bytes,
  })
const get = (u, runtime, slug, slot = 0) => fetch(url(runtime, slug, slot), { headers: auth(u) })
const del = (u, runtime, slug, slot = 0) => fetch(url(runtime, slug, slot), { method: 'DELETE', headers: auth(u) })

const bytes = (s) => new Uint8Array(Buffer.from(s))
const textOf = async (res) => Buffer.from(await res.arrayBuffer()).toString()

try {
  /* ================= 一、必须登录 ================= */
  section('云存档必须登录')
  ok('没有 token 取不到', (await fetch(url('emulatorjs', 'contra'))).status === 401)
  ok('没有 token 存不了', (await fetch(url('emulatorjs', 'contra'), { method: 'PUT', body: bytes('x') })).status === 401)
  ok('假 token 也不行', (await fetch(url('emulatorjs', 'contra'), { headers: { Authorization: 'Bearer nope' } })).status === 401)

  /* ================= 二、存取删 ================= */
  section('存取删')
  ok('没存过时是 404', (await get(alice, 'emulatorjs', 'contra')).status === 404)
  ok('存进去了', (await put(alice, 'emulatorjs', 'contra', bytes('第一关'))).ok)
  ok('原样取回来', (await textOf(await get(alice, 'emulatorjs', 'contra'))) === '第一关')

  ok('覆盖同一格', (await put(alice, 'emulatorjs', 'contra', bytes('第三关'))).ok)
  ok('取到的是新的', (await textOf(await get(alice, 'emulatorjs', 'contra'))) === '第三关')

  const meta = await (await fetch(url('emulatorjs', 'contra', 0, '/meta'), { headers: auth(alice) })).json()
  ok('meta 给出体积和时间', meta.size === Buffer.from('第三关').length && meta.updatedAt > 0)

  /* ================= 三、互不覆盖 ================= */
  section('不同引擎 / 存档位 / 用户之间互不覆盖')
  await put(alice, 'jsdos', 'contra', bytes('DOS 的变更包'))
  ok('同名游戏、不同引擎各存各的', (await textOf(await get(alice, 'emulatorjs', 'contra'))) === '第三关')
  ok('DOS 那份也在', (await textOf(await get(alice, 'jsdos', 'contra'))) === 'DOS 的变更包')

  await put(alice, 'emulatorjs', 'contra', bytes('二号位'), 1)
  ok('存档位隔离', (await textOf(await get(alice, 'emulatorjs', 'contra', 0))) === '第三关')
  ok('二号位是自己的内容', (await textOf(await get(alice, 'emulatorjs', 'contra', 1))) === '二号位')

  ok('看不到别人的存档', (await get(bob, 'emulatorjs', 'contra')).status === 404)
  await put(bob, 'emulatorjs', 'contra', bytes('鲍勃的进度'))
  ok('各存各的，不串档', (await textOf(await get(alice, 'emulatorjs', 'contra'))) === '第三关')

  /* ================= 四、清单 ================= */
  section('存档清单')
  const list = await (await fetch(`${API}/api/saves`, { headers: auth(alice) })).json()
  ok('清单只列自己的', Array.isArray(list) && list.length === 3)
  ok('清单不带存档内容', list.every((r) => !('data' in r)) && list.every((r) => r.size > 0))
  ok('按更新时间倒序', list.every((r, i) => i === 0 || list[i - 1].updatedAt >= r.updatedAt))

  /* ================= 五、参数校验 ================= */
  section('参数校验')
  ok('未知引擎被拒', (await put(alice, 'nintendo64', 'contra', bytes('x'))).status === 400)
  ok('带斜杠的标识进不来', (await fetch(`${API}/api/saves/emulatorjs/a%2Fb`, { headers: auth(alice) })).status === 400)
  ok('存档位越界被拒', (await put(alice, 'emulatorjs', 'contra', bytes('x'), 99)).status === 400)
  ok('空存档被拒', (await put(alice, 'emulatorjs', 'contra', new Uint8Array(0))).status === 400)
  ok('超大存档被拒', (await put(alice, 'emulatorjs', 'big', new Uint8Array(MAX_SAVE_BYTES + 1024))).status === 413)
  ok('本地文件的 local: 标识可以用', (await put(alice, 'jsdos', 'local:doom.zip', bytes('本地'))).ok)
  // 玩家自己传的 ROM 很可能是中文文件名，不能因为「不是 ASCII」就存不了
  ok('中文文件名也能存', (await put(alice, 'jsdos', 'local:超级马里奥.zip', bytes('中文'))).ok)
  ok('中文文件名能取回来', (await textOf(await get(alice, 'jsdos', 'local:超级马里奥.zip'))) === '中文')
  ok('编码坏掉的标识按 400 处理，不是 500', (await fetch(`${API}/api/saves/jsdos/%zz`, { headers: auth(alice) })).status === 400)
  // 路由参数 Express 已经解过码，服务端不能再解一次 —— 否则名字里带 % 的文件会被解坏
  ok('名字里带 % 的文件能存', (await put(alice, 'jsdos', 'local:100%.zip', bytes('百分号'))).ok)
  ok('名字里带 % 的文件能取回来', (await textOf(await get(alice, 'jsdos', 'local:100%.zip'))) === '百分号')

  /* ================= 六、删除 ================= */
  section('删除')
  ok('删掉了', (await del(alice, 'emulatorjs', 'contra')).ok)
  ok('删完就取不到了', (await get(alice, 'emulatorjs', 'contra')).status === 404)
  ok('只删指定的那一格', (await get(alice, 'emulatorjs', 'contra', 1)).status === 200)
  ok('删不存在的也不报错', (await del(alice, 'emulatorjs', '从来没存过')).ok)
} finally {
  // 用户一删，saves 靠外键级联跟着清干净
  await query('DELETE FROM users WHERE id IN (?, ?)', [alice.id, bob.id])
  http.close()
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
