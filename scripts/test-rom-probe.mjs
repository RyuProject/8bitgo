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
let methods = []
globalThis.fetch = async (_url, init = {}) => {
  calls++
  methods.push(init.method ?? 'GET')
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
  methods = []
}

const { probeRomUrl, probeRom, clearRomProbeCache, conventionalKeys, romCandidates, playbackRomCandidates, romProbeExpected, dosExecutableForRom, dosStartupCommandsForRom, versionedRomUrl, romKeysOf, unbindKeyPatch, shouldTryRomCandidateAfterUncertain, nextRomCandidateKey, slugFromKey, romUrlForKey, coverThumbKey } = await import(
  fileURLToPath(new URL('../src/services/roms.ts', import.meta.url))
)
// 红宝石封面是外链：没有 -96 缩略图时必须回原图，不能把空 key 拼成资源域名根目录。
const externalCover = 'https://mms1.baidu.com/example.jpg'
assert.equal(coverThumbKey(externalCover), '')
assert.equal(romUrlForKey(coverThumbKey(externalCover), 'https://assets.8bitgo.com'), '')
assert.equal(romUrlForKey(externalCover, 'https://assets.8bitgo.com'), externalCover)
const { ROM_LANGS } = await import(fileURLToPath(new URL('../src/config/languages.ts', import.meta.url)))
const { romCacheKey } = await import(fileURLToPath(new URL('../src/emulator/romCache.ts', import.meta.url)))
const { isolatedEmbedFor } = await import(fileURLToPath(new URL('../shared/isolated-embeds.js', import.meta.url)))
const { gameRowToApi, dosExecutableOf, dosStartupCommandsOf, relationsInPatch, romRelationRows } = await import(fileURLToPath(new URL('../server/src/mappers.js', import.meta.url)))
// ts-loader 为了让 ROM 探测测试保持轻量，会把平台表换成空桩；补齐流式光盘真正用到的格式。
const { platformMap: testPlatformMap } = await import('@/data/platforms')
testPlatformMap.ps2 = { romExtensions: ['.iso', '.chd', '.cso', '.zso', '.isz', '.bin', '.elf'] }
testPlatformMap.gamecube = { romExtensions: ['.iso', '.gcm', '.rvz', '.ciso', '.gcz', '.dol', '.elf'] }
testPlatformMap.wii = { romExtensions: ['.iso', '.rvz', '.ciso', '.gcz', '.wbfs', '.wad', '.dol', '.elf'] }

let url = 0
const next = () => `https://assets.example.com/roms/nes/game-${++url}.zip`

/* ---------- PS2 约定地址：ISO 直接给 Play!，不能让历史 ZIP 抢先 ---------- */
{
  const keys = conventionalKeys({ platform: 'ps2', slug: 'demo' })
  assert.equal(keys[0], 'roms/ps2/demo.iso', 'PS2 默认先探裸 ISO')
  assert.ok(keys.some((key) => key.endsWith('.chd')), 'PS2 也保留 Play! 支持的压缩光盘格式')
  assert.ok(!keys.some((key) => key.endsWith('.zip')), 'PS2 不能把外层 ZIP 当成光盘镜像')
}

/* ---------- Dolphin 约定地址：同样必须是可随机读取的裸容器 ---------- */
for (const platform of ['gamecube', 'wii']) {
  const keys = conventionalKeys({ platform, slug: 'demo' })
  assert.ok(keys[0].endsWith('.iso'), `${platform} 默认先探 ISO`)
  assert.ok(keys.some((key) => key.endsWith('.rvz')), `${platform} 应探 Dolphin 的 RVZ 容器`)
  assert.ok(!keys.some((key) => key.endsWith('.zip') || key.endsWith('.8bg')), `${platform} 不能探外层 ZIP / 8BG`)
  const candidates = playbackRomCandidates({ platform, rom: `roms/${platform}/demo.rvz` }, 'zh-Hans')
  assert.deepEqual(candidates.map((candidate) => candidate.key), [`roms/${platform}/demo.rvz`], `${platform} 绑定地址不能派生 8BG`)
}

/* ---------- 内置 Web 游戏：不依赖 ROM 根地址，也不该对自己的同源入口发 R2 HEAD ---------- */
for (const [slug, entry] of [['diablo', '/web/diablo'], ['terraria', '/web/terraria']]) {
  const game = { platform: 'html5', slug }
  assert.deepEqual(conventionalKeys(game), [entry], `${slug} 应自动识别为站内 Web 游戏`)
  assert.equal(romProbeExpected(game, 'zh-Hans'), true, `${slug} 没配 VITE_ROM_BASE_URL 也应可播放`)
}
assert.equal(isolatedEmbedFor('terraria')?.embed, '/web/terraria', 'Terraria 必须走隔离薄壳，SharedArrayBuffer 才可用')
assert.equal(isolatedEmbedFor('diablo'), undefined, 'Diablo 不需要 COOP/COEP，保持普通详情页即可')

/* ---------- 8BG 约定地址：新容器优先，旧对象继续回退 ---------- */
{
  const keys = conventionalKeys({ platform: 'nes', slug: 'demo' })
  assert.equal(keys[0], 'roms/nes/demo.zip.8bg', '未绑定游戏先探新的 8BG 容器')
  assert.ok(keys.includes('roms/nes/demo.zip'), '旧 ROM 约定地址必须继续保留')
  assert.equal(slugFromKey('roms/nes/super-mario-bros.nes.8bg'), 'super-mario-bros', '自动匹配要剥掉容器和 ROM 两层扩展名')
}

/* ---------- 外站 ZIP：fragment 选内层文件，ETag 也只进 fragment，不污染签名 URL ---------- */
{
  const u = 'https://files.example.com/archive.zip?token=signed#rom=folder%2Fgame.nes'
  const versioned = versionedRomUrl(u, '"etag-1"')
  assert.equal(versioned, `${u}&romv=etag-1`)
  assert.equal(romCacheKey(u), '', '无内容版本时不能缓存外站文件')
  assert.equal(romCacheKey(`${u}&v=1`), `${u}&v=1`, '管理员手工版本可作为缓存键')
  assert.equal(romCacheKey(versioned), versioned, 'ETag 版本可作为缓存键')
  script({ status: 405 }, { status: 206, headers: { etag: '"etag-2"' } })
  assert.equal(await probeRomUrl(u), `${u}&romv=etag-2`)
  assert.deepEqual(methods, ['HEAD', 'GET'], 'HEAD 不可用时只用 GET Range 探一下')
}

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
  // 同语言备用必须紧跟主地址；只有两者都失败才允许跨语言回退。
  const game = {
    roms: {
      'zh-Hans': 'https://primary.example.com/game.zip',
      en: 'roms/nes/game.en.zip',
    },
    romBackups: { 'zh-Hans': 'roms/nes/game.zh-Hans.zip' },
  }
  assert.deepEqual(
    romCandidates(game, 'zh-Hans').map(({ key, lang, backup }) => ({ key, lang, backup: Boolean(backup) })),
    [
      { key: 'https://primary.example.com/game.zip', lang: 'zh-Hans', backup: false },
      { key: 'roms/nes/game.zh-Hans.zip', lang: 'zh-Hans', backup: true },
      { key: 'roms/nes/game.en.zip', lang: 'en', backup: false },
    ],
    '同语言备用排在其它语言之前',
  )
  const candidates = romCandidates(game, 'zh-Hans')
  assert.equal(shouldTryRomCandidateAfterUncertain(candidates[0], candidates[1]), true, '主地址超时后仍尝试同语言备用')
  assert.equal(shouldTryRomCandidateAfterUncertain(candidates[1], candidates[2]), false, '备用也无法确认时停止，不把本机断网误判成跨语言缺失')
  const playback = playbackRomCandidates({ platform: 'nes', ...game }, 'zh-Hans')
  assert.deepEqual(
    playback.slice(0, 4).map(({ key, derivedPacked, backup }) => ({ key, derivedPacked: Boolean(derivedPacked), backup: Boolean(backup) })),
    [
      { key: 'https://primary.example.com/game.zip', derivedPacked: false, backup: false },
      { key: 'roms/nes/game.zh-Hans.zip.8bg', derivedPacked: true, backup: true },
      { key: 'roms/nes/game.zh-Hans.zip', derivedPacked: false, backup: true },
      { key: 'roms/nes/game.en.zip.8bg', derivedPacked: true, backup: false },
    ],
    '对象 key 自动先探旁边的 .8bg；完整外链保持原样，旧对象紧跟着兜底',
  )
  assert.equal(shouldTryRomCandidateAfterUncertain(playback[1], playback[2]), true, '派生 .8bg 超时也必须尝试原对象')
  assert.equal(
    nextRomCandidateKey(candidates.map((candidate) => candidate.key), candidates[0].key, new Set()),
    candidates[1].key,
    '主包真实加载失败后要切同语言备用，不能因为 HEAD 曾成功就反复打开主包',
  )
  assert.equal(
    nextRomCandidateKey(candidates.map((candidate) => candidate.key), candidates[0].key, new Set([candidates[1].key])),
    candidates[2].key,
    '备用也失败后继续往后走，且不能重新选择已经失败的 key',
  )
  assert.deepEqual(romKeysOf(game), [
    'https://primary.example.com/game.zip',
    'roms/nes/game.en.zip',
    'roms/nes/game.zh-Hans.zip',
  ], 'ROM 存储页也要把备用对象算作绑定')
  assert.deepEqual(
    unbindKeyPatch(game, 'roms/nes/game.zh-Hans.zip'),
    { romBackups: undefined },
    '从 ROM 存储页解绑备用对象时要清掉备用字段',
  )
}
{
  // 同一 ZIP 的 URL 一样，但所选语言槽必须保留，启动文件由它决定。
  const game = {
    roms: { en: 'roms/dos/shared.zip', 'zh-Hans': 'roms/dos/shared.zip' },
    dosExecutable: 'START.BAT',
    dosExecutables: { en: 'EN/RUN.BAT', 'zh-Hans': 'CN/RUN.BAT' },
    dosStartupCommands: { 'zh-Hans': 'imgmount d "./CD/HEROES2_fixed.cue" -t cdrom' },
  }
  const english = romCandidates(game, 'en')[0]
  const chinese = romCandidates(game, 'zh-Hans')[0]
  assert.equal(english.key, chinese.key)
  assert.equal(dosExecutableForRom(game, english), 'EN/RUN.BAT')
  assert.equal(dosExecutableForRom(game, chinese), 'CN/RUN.BAT')
  assert.equal(dosStartupCommandsForRom(game, chinese), game.dosStartupCommands['zh-Hans'], '共用 ZIP 的中文槽独自挂载光盘')
  assert.equal(dosStartupCommandsForRom(game, english), undefined, '免 CD 英文槽不会继承中文挂盘命令')
  assert.equal(dosExecutableForRom(game, { lang: 'ja' }), 'START.BAT', '未配置的语言使用原有默认入口')
  assert.equal(dosExecutableForRom(game, {}), 'START.BAT', '旧版通用 ROM 沿用默认入口')
  const fromApi = gameRowToApi(
    { slug: 'shared', title: 'Shared DOS', platform: 'dos', dos_executable: 'START.BAT' },
    { roms: game.roms, dosExecutables: game.dosExecutables, dosStartupCommands: game.dosStartupCommands },
  )
  assert.deepEqual(fromApi.dosExecutables, game.dosExecutables, 'API 把各语言入口送回后台编辑表单')
  assert.deepEqual(fromApi.dosStartupCommands, game.dosStartupCommands, 'API 把各语言命令送回后台编辑表单')
  assert.equal(dosExecutableForRom(fromApi, chinese), 'CN/RUN.BAT')
  assert.equal(dosExecutableOf('CN\\RUN.BAT'), 'CN/RUN.BAT', '后端将 DOS 反斜杠规整为 ZIP 相对路径')
  assert.equal(dosExecutableOf('../RUN.BAT'), null, '不能把相对路径穿出 ZIP')
  assert.equal(relationsInPatch({ dosExecutables: { en: 'EN/RUN.BAT' } }).roms, true, '只更新入口时也要写 ROM 关联表')
  assert.equal(relationsInPatch({ dosStartupCommands: { 'zh-Hans': game.dosStartupCommands['zh-Hans'] } }).roms, true, '只更新挂盘命令时也要写 ROM 关联表')
  assert.equal(relationsInPatch({ romBackups: { en: 'roms/dos/shared-backup.zip' } }).roms, true, '只更新备用地址时也要写 ROM 关联表')
  const previous = [{ lang: 'en', object_key: 'roms/dos/shared.zip', dos_executable: 'EN/RUN.BAT', dos_startup_commands: 'imgmount d "./CD/OLD.cue" -t cdrom' }]
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/shared.zip' } }, previous, true)[0].dosExecutable, 'EN/RUN.BAT', '只改 ROM 绑定且 key 不变时保留入口')
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/new.zip' } }, previous, true)[0].dosExecutable, null, '换 ZIP 后旧入口不能沿用')
  assert.equal(romRelationRows({ dosExecutables: { en: 'EN/NEW.BAT' } }, previous, true)[0].dosExecutable, 'EN/NEW.BAT', '只改入口时保留 ROM key')
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/shared.zip' } }, previous)[0].dosExecutable, 'EN/RUN.BAT', '旧后台整体保存相同 ROM 时不抹掉入口')
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/shared.zip' }, dosExecutables: {} }, previous)[0].dosExecutable, null, '新后台明确清空入口时可删除旧值')
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/shared.zip' } }, previous)[0].dosStartupCommands, previous[0].dos_startup_commands, '旧后台整体保存同一 ZIP 时保留挂盘命令')
  assert.equal(romRelationRows({ roms: { en: 'roms/dos/new.zip' } }, previous)[0].dosStartupCommands, null, '换 ZIP 后不能继承旧光盘镜像路径')
  assert.equal(romRelationRows({ dosStartupCommands: {} }, previous, true)[0].dosStartupCommands, null, '清空最后一个语言命令时可删除旧值')
  assert.equal(dosStartupCommandsOf('imgmount d "./CD/DISC.cue" -t cdrom\r\n'), 'imgmount d "./CD/DISC.cue" -t cdrom', '后端规整多行挂盘命令')
  assert.throws(() => dosStartupCommandsOf('[autoexec]\nmount c .'), /不能填写/, '命令不能注入 DOSBox 配置节')
  assert.throws(
    () => dosStartupCommandsOf('imgmount d "D:\\Games\\homm2_cn\\CD\\HEROES2_fixed.cue" -t cdrom'),
    /ZIP 内的相对路径/,
    '后台不能保存站长电脑上的绝对路径，浏览器里的 DOSBox-X 看不见它',
  )
  assert.equal(
    dosStartupCommandsOf('imgmount d "CD\\HEROES2_fixed.cue" -t cdrom'),
    'imgmount d "CD\\HEROES2_fixed.cue" -t cdrom',
    'ZIP 内的 DOS 风格相对路径仍然合法',
  )
  assert.throws(
    () => dosStartupCommandsOf('imgmount d "https://files.example.com/HEROES2.cue" -t cdrom'),
    /ZIP 内的相对路径/,
    'CUE 不能绕过游戏 ZIP 读取外部 URL',
  )
}
{
  const previous = [{
    lang: 'en',
    object_key: 'https://primary.example.com/game.zip',
    backup_key: 'roms/nes/game.en.zip',
    dos_executable: null,
  }]
  assert.equal(
    romRelationRows({ roms: { en: previous[0].object_key } }, previous)[0].backupKey,
    previous[0].backup_key,
    '旧后台保存相同主地址时不能抹掉备用地址',
  )
  assert.equal(
    romRelationRows({ romBackups: { en: 'roms/nes/new-backup.zip' } }, previous, true)[0].backupKey,
    'roms/nes/new-backup.zip',
    '只改备用地址时保留主地址',
  )
  assert.equal(
    romRelationRows({ romBackups: {} }, previous, true)[0].backupKey,
    null,
    '显式空对象可清除最后一个备用地址',
  )
  assert.equal(
    romRelationRows({ roms: { en: 'roms/nes/different.zip' } }, previous)[0].backupKey,
    null,
    '换主文件时旧备用地址也要作废，避免语言包错配',
  )
  const api = gameRowToApi(
    { slug: 'backup', title: 'Backup', platform: 'nes' },
    { roms: { en: previous[0].object_key }, romBackups: { en: previous[0].backup_key } },
  )
  assert.deepEqual(api.romBackups, { en: previous[0].backup_key }, 'API 把备用地址送回播放器和后台')
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
