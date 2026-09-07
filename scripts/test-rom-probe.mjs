/**
 * ROM 探测缓存的回归测试。
 *
 * 盯的是这个坑：`probeRomUrl` 以前把**所有**失败都永久缓存，包括超时和 5xx。
 * 于是一次网络抖动就能让一款 ROM 好端端躺在 R2 上的游戏，在整个单页应用会话里
 * 一直显示「游戏没有当前语言版本 / 选择 ROM 开始游戏」—— 切来切去都没用，
 * 只有整页刷新才恢复。区分「服务器说没有」和「这次没问出来」是这里的全部重点。
 *
 * 跑：cd .. && npm run test:rom-probe
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/* ---- 浏览器环境的最小桩：模块里用的是 window.setTimeout ---- */
globalThis.window = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) }

/** 按脚本排好的响应依次回，并记下发了几次请求 */
let plan = []
let calls = 0
globalThis.fetch = async () => {
  calls++
  const step = plan.shift()
  if (!step) throw new Error('fetch 次数超出脚本预期')
  if (step.throw) throw new Error(step.throw)
  return {
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (k) => step.headers?.[k.toLowerCase()] ?? null },
  }
}
const script = (...steps) => {
  plan = steps
  calls = 0
}

const { probeRomUrl, probeRom, clearRomProbeCache, romCandidates, romProbeExpected } = await import(
  fileURLToPath(new URL('../src/services/roms.ts', import.meta.url))
)
const { ROM_LANGS } = await import(fileURLToPath(new URL('../src/config/languages.ts', import.meta.url)))

let url = 0
const next = () => `https://assets.example.com/roms/nes/game-${++url}.zip`

/* ---------- 1. 服务器明确说没有 → 缓存，不重复问 ---------- */
{
  const u = next()
  script({ status: 404 })
  assert.equal(await probeRomUrl(u), '', '404 就是没有')
  assert.equal(await probeRomUrl(u), '', '再问一次仍然是没有')
  assert.equal(calls, 1, '确定性的「没有」要缓存，不该重复发请求')
}

/* ---------- 2. 没问出来 → 不缓存，下次真的会重新问 ---------- */
{
  const u = next()
  script({ status: 503 }, { status: 503 })
  assert.equal(await probeRomUrl(u), '')
  assert.equal(calls, 2, '没问出结论时当场重试一次')

  // 关键：这一次必须真的重新发请求，而不是复读上面那个失败
  script({ status: 200, headers: { etag: '"abc"' } })
  const again = await probeRomUrl(u)
  assert.ok(again.includes('romv=abc'), '网络恢复后要能探到，而不是被上一轮的失败钉死')
  assert.equal(calls, 1)
}

/* ---------- 3. 抖一下就好 → 内部重试直接救回来 ---------- */
{
  const u = next()
  script({ throw: '模拟断网' }, { status: 200, headers: { etag: 'W/"v2"' } })
  const got = await probeRomUrl(u)
  assert.ok(got.includes('romv=v2'), '第一次连不上、第二次成功，应当返回可播放地址')
  assert.equal(calls, 2)
}

/* ---------- 4. 超时（abort）也算「没问出来」 ---------- */
{
  const u = next()
  script({ throw: 'The operation was aborted' }, { throw: 'The operation was aborted' })
  assert.equal(await probeRomUrl(u), '')
  script({ status: 200, headers: { etag: '"late"' } })
  assert.ok((await probeRomUrl(u)).includes('romv=late'), '超时过的地址下次必须重新探')
}

/* ---------- 5. 200 但回的是 HTML → 确定性的假阳性，要缓存 ---------- */
{
  const u = next()
  script({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  assert.equal(await probeRomUrl(u), '', '落到 SSR 兜底路由的 HTML 不算 ROM')
  assert.equal(await probeRomUrl(u), '')
  assert.equal(calls, 1, '这是确定的结论，不用反复问')
}

/* ---------- 6. 手动清缓存 → 刚传上去的 ROM 不用刷新整页就能被认出来 ---------- */
{
  const u = next()
  script({ status: 404 })
  assert.equal(await probeRomUrl(u), '')
  clearRomProbeCache([u])
  script({ status: 200, headers: { etag: '"just-uploaded"' } })
  assert.ok((await probeRomUrl(u)).includes('romv=just-uploaded'), '清掉缓存后应重新探测')
}

/* ---------- 7. 没有 ETag 就不加 romv，避免把地址弄脏 ---------- */
{
  const u = next()
  script({ status: 200 })
  assert.equal(await probeRomUrl(u), u, '拿不到 ETag 时原样返回')
}

/* ---------- 8. certain 要如实报上来 ---------- */
/*
  播放器的自动重试就是看这一位：certain === false 才排下一轮退避重试，
  确定性的「没有」一次都不重试（见 services/roms.ts 的 useRomUrl）。
  probeRomUrl 把它丢掉了，所以这里直接验 probeRom。
*/
{
  const u = next()
  script({ status: 404 })
  assert.deepEqual(
    await probeRom(u),
    { url: '', certain: true, reason: 'http', status: 404 },
    '404 是确定的「没有」，并把原因如实带上（诊断用）',
  )
}
{
  const u = next()
  script({ status: 503 }, { status: 503 })
  const outcome = await probeRom(u)
  assert.equal(outcome.url, '')
  assert.equal(outcome.certain, false, '5xx 是「没问出来」，播放器要靠这一位决定自动重试')
}
{
  const u = next()
  script({ throw: '模拟断网' }, { throw: '模拟断网' })
  const netOutcome = await probeRom(u)
  assert.equal(netOutcome.certain, false, '连不上同样是「没问出来」')
  assert.equal(netOutcome.reason, 'network', 'fetch 抛异常且没超时 → network（CORS / 被插件拦也走这里）')
}
{
  const u = next()
  script({ status: 200, headers: { etag: '"ok"' } })
  const outcome = await probeRom(u)
  assert.equal(outcome.certain, true)
  assert.ok(outcome.url.includes('romv=ok'))
}

/* ---------- 9. 语言回退链必须覆盖**全部** ROM_LANGS ---------- */
/*
  踩过的坑：这条链原本是手写的五项 [requested, 'en', 'ja', 'zh-Hans', 'zh-Hant']，
  而 ROM_LANGS 有八项 —— fr / de / es / it 永远不会被当作回退。
  后果是一款只传了西语版的游戏（超级玛丽兄弟的 es 槽就是这么来的），
  在非西语站点下报「游戏没有当前语言版本」，而那个 ROM 就躺在 R2 上。
  下面第一条是逐个语言槽的普查：以后往 ROM_LANGS 里加语言却忘了管回退链，这里会红。
*/
{
  for (const slot of ROM_LANGS) {
    const game = { roms: { [slot]: `roms/nes/only-${slot}.nes` } }
    const got = romCandidates(game, 'zh-Hans')
    assert.equal(got.length, 1, `只有 ${slot} 一个槽时应该仍能回退到它，实际拿到 ${got.length} 个候选`)
    assert.equal(got[0].key, `roms/nes/only-${slot}.nes`)
    assert.equal(got[0].lang, slot)
  }
}
{
  // 站点语言的槽排最前，然后才是 en / ja / 中文，其余语言垫后
  const game = {
    roms: {
      'zh-Hans': 'roms/nes/g.zh.nes',
      en: 'roms/nes/g.en.nes',
      ja: 'roms/nes/g.ja.nes',
      es: 'roms/nes/g.es.nes',
    },
  }
  assert.deepEqual(
    romCandidates(game, 'zh-Hans').map((c) => c.lang),
    ['zh-Hans', 'en', 'ja', 'es'],
    '当前语言优先，其次 en / ja，其余语言垫后',
  )
  // 玩家在工具栏里手动选的语言优先级最高，但后面的回退要留着
  assert.deepEqual(
    romCandidates(game, 'zh-Hans', 'es').map((c) => c.lang),
    ['es', 'en', 'ja', 'zh-Hans'],
    'prefer 排第一，回退链仍在（所选槽的对象可能已经被删了）',
  )
}
{
  // 同一个对象绑到多个槽时只探一次，别浪费 HEAD
  const game = { roms: { en: 'roms/nes/same.nes', ja: 'roms/nes/same.nes', es: 'roms/nes/same.nes' } }
  assert.equal(romCandidates(game, 'en').length, 1, '同一个 key 只保留第一次出现')
}
{
  // 旧数据的无语言 rom 垫在最后，且不与语言槽重复
  const withGeneric = { rom: 'roms/nes/legacy.nes', roms: { en: 'roms/nes/g.en.nes' } }
  assert.deepEqual(
    romCandidates(withGeneric, 'fr').map((c) => c.key),
    ['roms/nes/g.en.nes', 'roms/nes/legacy.nes'],
    '通用 rom 是最后的回退',
  )
  const dup = { rom: 'roms/nes/g.en.nes', roms: { en: 'roms/nes/g.en.nes' } }
  assert.equal(romCandidates(dup, 'en').length, 1, '通用 rom 和语言槽指向同一个对象时不重复')
}

/* ---------- romProbeExpected：首帧要不要先按「正在确认」渲染 ---------- */
/*
  为什么值一组断言：这个返回值决定 useRomUrl 的**初始态**，也就是服务端渲染出来的
  那一帧。它以前只看 effectiveRomKey（后台显式绑定的语言槽），于是靠约定 key
  探测的游戏——绝大多数——首帧落到 idle，主按钮先写「选择本地 ROM」，
  effect 一跑变「正在准备在线版本…」，探完再变「开始游戏」：三段文案。

  另一半同样重要：这个判断必须在 SSR 和水合时算出同一个值，所以它只看构建时的
  VITE_ROM_BASE_URL，**不看 localStorage 覆盖**。下面最后一条锁的就是这点。
*/
{
  const bound = { slug: 'contra', platform: 'nes', roms: { en: 'roms/nes/contra.en.nes' } }
  const unbound = { slug: 'contra', platform: 'nes' }
  const external = { slug: 'x', platform: 'html5', rom: 'https://example.com/x/index.html' }
  const rooted = { slug: 'y', platform: 'html5', rom: '/games/y/index.html' }

  const saved = globalThis.__viteEnv

  // 根地址没配 = 没接云端 ROM：不该空转一帧「正在确认」
  globalThis.__viteEnv = {}
  assert.equal(romProbeExpected(bound, 'en'), false, '没配根地址时，连显式绑定也探不了')
  assert.equal(romProbeExpected(unbound, 'en'), false, '没配根地址时，约定 key 更探不了')
  // 但自带完整地址的 key 不依赖根地址
  assert.equal(romProbeExpected(external, 'en'), true, '外链 key 不需要根地址')
  assert.equal(romProbeExpected(rooted, 'en'), true, '站内绝对路径 key 不需要根地址')

  globalThis.__viteEnv = { VITE_ROM_BASE_URL: 'https://assets.example.com' }
  assert.equal(romProbeExpected(bound, 'en'), true, '有绑定、有根地址：首帧就该是「正在确认」')
  assert.equal(
    romProbeExpected(unbound, 'en'),
    true,
    '这条是这次修的正主：没有绑定记录、靠约定 key 探的游戏，首帧也必须是「正在确认」，' +
      '否则按钮会先谎报「选择本地 ROM」再改口',
  )
  assert.equal(romProbeExpected(undefined, 'en'), false, '没有游戏对象时不探')

  // localStorage 覆盖不参与判断：SSR 那一侧看不到它，参与了就是 hydration mismatch
  globalThis.__viteEnv = {}
  globalThis.localStorage = { getItem: (k) => (k === '8bitgo.rom.base' ? 'https://mine.example.com' : null) }
  assert.equal(
    romProbeExpected(unbound, 'en'),
    false,
    'localStorage 里的根地址覆盖只存在于管理员自己的浏览器；初始态不能看它，否则服务端和客户端算出两个值',
  )
  delete globalThis.localStorage

  globalThis.__viteEnv = saved
}

console.log('✅ ROM 探测测试通过：确定没有 / 没问出来（自动重试的依据）/ 手动清缓存 / 语言回退链覆盖全部 ROM_LANGS / 首帧探测判定')
