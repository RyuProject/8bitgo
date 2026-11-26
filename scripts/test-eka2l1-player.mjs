#!/usr/bin/env node
/**
 * 游戏详情页塞班播放器（scripts/eka2l1-player.js + adapters/eka2l1.ts）的回归测试，不联网、不需要固件。
 *
 *   npm run test:eka2l1-player
 *
 * 守的是：游戏包类型识别、存档包格式与安全校验、「只存游戏改过的文件」的快照比较、键位映射，
 * 以及接线 —— 运行时登记、塞班平台走 eka2l1、详情页跨源隔离、play.html 的脚本顺序、操作说明与播放页键位一致。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { EKA2L1_SITE_SCRIPTS } from './lib/eka2l1-site-scripts.mjs'
import { INLINE_ISOLATED_PLATFORMS, isInlineIsolatedPlatform } from '../shared/inline-isolated-platforms.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const scriptFile = join(root, 'scripts', 'eka2l1-player.js')
vm.runInThisContext(readFileSync(scriptFile, 'utf8'), { filename: scriptFile })
const P = globalThis.EightBitGoSymbianPlayer
assert.ok(P, '播放器脚本没有导出 EightBitGoSymbianPlayer')

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

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✖ ${name}`)
    throw err
  }
}

function le32(...values) {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  values.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true))
  return out
}

function throwsCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'PlayerError', String(err))
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`)
    return true
  })
}

/** 只实现播放器用到的几个 Emscripten FS 方法 */
class FakeFS {
  constructor() { this.nodes = new Map([['/', { dir: true }]]); this.clock = 1000 }
  mk(path, data) {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (const part of parts.slice(0, -1)) { cur += '/' + part; if (!this.nodes.has(cur)) this.nodes.set(cur, { dir: true }) }
    this.nodes.set(path, { dir: false, data: Uint8Array.from(data), mtime: new Date(++this.clock) })
  }
  readdir(path) {
    const node = this.nodes.get(path)
    if (!node || !node.dir) throw new Error('ENOTDIR')
    const prefix = path === '/' ? '/' : path + '/'
    const names = new Set()
    for (const p of this.nodes.keys()) if (p !== path && p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0])
    return ['.', '..', ...names]
  }
  stat(path) {
    const node = this.nodes.get(path)
    if (!node) throw new Error('ENOENT')
    return node.dir ? { mode: 0o40000, size: 4096, mtime: new Date(0) } : { mode: 0o100000, size: node.data.length, mtime: node.mtime }
  }
  isDir(mode) { return (mode & 0o170000) === 0o40000 }
  readFile(path) { return this.nodes.get(path).data }
}

console.log('塞班详情页播放器')

test('游戏包类型：卡带 ZIP / 老 SIS / S60 第三版 SISX / 认不出', () => {
  assert.equal(P.detectGameKind(Uint8Array.from([0x50, 0x4B, 0x03, 0x04, 0, 0])), 'card')
  assert.equal(P.detectGameKind(le32(0x10201A7A, 0, 0, 0)), 'sisx')
  assert.equal(P.detectGameKind(le32(0x101F4A2C, 0x1000006D, 0x10000419, 0)), 'sis')
  assert.equal(P.detectGameKind(le32(1, 2, 3, 4)), 'unknown')
  assert.equal(P.detectGameKind(new Uint8Array(2)), 'unknown')
})

test('存档路径：只收 C / E 盘上的游戏文件，系统自己改写的位置不进存档', () => {
  for (const ok of ['c/System/Apps/6RAK/THESIMS.SAV', 'e/System/Apps/6rak/save.dat', 'c/Nokia/Games/x.sav', 'c/Data/Saved/a']) {
    assert.equal(P.isSaveCandidate(ok), true, ok)
  }
  for (const no of ['c/System/Temp/x', 'c/System/Mail/NEM-4/messaging.db', 'c/System/SharedData/101f8a5a.ini',
    'c/System/System.ini', 'c/sys/install/sisregistry/1/0.reg', 'c/private/1/x', 'z/system/x', 'd/x', 'c/System/Data/T9UDB0f.DAT', 'c/System/Data/sms_settings.dat']) {
    assert.equal(P.isSaveCandidate(no), false, no)
  }
  for (const bad of ['../x', 'c/../x', 'c//x', 'c\\x', '/c/x', 'z/x', 'c', 'c/a/./b', 'c/\u0001']) {
    assert.equal(P.isSafeRel(bad), false, bad)
  }
  assert.equal(P.isSafeRel('e/System/Apps/6rak/a.sav'), true)
})

test('存档包：往返一致；坏 magic、截断、尾巴多、越界路径、重名、超限一律拒绝', () => {
  const files = [
    { path: 'c/System/Apps/6RAK/THESIMS.SAV', data: Uint8Array.from([0x41, 0x53, 0x49, 0x45, 1, 2, 3]) },
    { path: 'e/System/Apps/6rak/options.dat', data: new Uint8Array(0) },
  ]
  const packed = P.encodeSaveArchive(files)
  const back = P.decodeSaveArchive(packed)
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((f) => f.path), files.map((f) => f.path))
  assert.deepEqual([...back[0].data], [...files[0].data])

  const badMagic = packed.slice(); badMagic[0] ^= 0xFF
  throwsCode(() => P.decodeSaveArchive(badMagic), 'save-corrupt')
  throwsCode(() => P.decodeSaveArchive(packed.subarray(0, packed.length - 1)), 'save-corrupt')
  throwsCode(() => P.decodeSaveArchive(Uint8Array.from([...packed, 0])), 'save-corrupt')
  throwsCode(() => P.decodeSaveArchive(P.encodeSaveArchive([{ path: 'z/evil', data: new Uint8Array(1) }])), 'save-corrupt')
  throwsCode(() => P.decodeSaveArchive(P.encodeSaveArchive([{ path: 'c/../x', data: new Uint8Array(1) }])), 'save-corrupt')
  throwsCode(() => P.decodeSaveArchive(P.encodeSaveArchive([
    { path: 'c/A/x.sav', data: new Uint8Array(1) }, { path: 'c/a/X.SAV', data: new Uint8Array(1) },
  ])), 'save-corrupt')
  throwsCode(() => P.encodeSaveArchive([{ path: 'c/big', data: new Uint8Array(2 * 1048576) }]), 'save-too-large')
})

await asyncTest('核心资源：短包自动重取，按 data 声明长度校验并限制最大体积', async () => {
  let calls = 0
  const result = await P.fetchCoreAsset(async () => {
    calls++
    return new Response(Uint8Array.from(calls === 1 ? [1, 2] : [1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream' },
    })
  }, 'https://8bitgo.test/eka2l1.data?v=test', {
    expectedBytes: 3, maxBytes: 8, idleTimeoutMs: 100, retries: 1,
  })
  assert.equal(calls, 2, 'data 短包应自动重试一次')
  assert.deepEqual([...result.bytes], [1, 2, 3])

  calls = 0
  await assert.rejects(P.fetchCoreAsset(async () => {
    calls++
    return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })
  }, 'https://8bitgo.test/eka2l1.wasm', { maxBytes: 2, idleTimeoutMs: 100, retries: 2 }), /超过声明大小/)
  assert.equal(calls, 1, '超过安全上限属于确定性错误，不应重复下载')
})

await asyncTest('核心资源：停流有空闲时限，重试期间不把调用方取消当网络故障', async () => {
  let calls = 0
  const result = await P.fetchCoreAsset(async () => {
    calls++
    if (calls === 1) return new Response(new ReadableStream({ start() {} }))
    return new Response(Uint8Array.from([4, 5]))
  }, 'https://8bitgo.test/eka2l1.data', { expectedBytes: 2, maxBytes: 8, idleTimeoutMs: 5, retries: 1 })
  assert.equal(calls, 2, '停流后应重下核心资源')
  assert.deepEqual([...result.bytes], [4, 5])

  const controller = new AbortController()
  controller.abort()
  calls = 0
  await assert.rejects(P.fetchCoreAsset(async () => { calls++; return new Response([1]) }, 'https://8bitgo.test/eka2l1.wasm', {
    maxBytes: 8, idleTimeoutMs: 5, retries: 2, signal: controller.signal,
  }), { name: 'AbortError' })
  assert.equal(calls, 0, '已取消的播放器不能继续发核心请求')
})

await asyncTest('核心预热：同一个播放页只启动一次 EKA2L1.boot', async () => {
  let bootCalls = 0
  let memoryWrapperReady = false
  let dataBytes = null
  let wasmBytes = null
  let mountCalls = 0
  let redraws = 0
  const requestedCoreUrls = []
  const canvas = { width: 176, height: 208, style: {}, focus() {} }
  const fakeDocument = { hidden: false, getElementById: () => canvas, addEventListener() {} }
  let context
  const fakeRoot = {
    document: fakeDocument,
    location: { href: 'https://8bitgo.test/eka2l1/vtest/play.html', origin: 'https://8bitgo.test' },
    EKA2L1_ASSET_SIZES: { wasm: 4, data: 3 },
    innerWidth: 176,
    innerHeight: 208,
    addEventListener() {},
    createEKA2L1Module(options) {
      memoryWrapperReady = Boolean(options.getPreloadedPackage)
      assert.equal(requestedCoreUrls.length, 2, 'wasm 与 data 必须在核心工厂调用前并行发起')
      const packageBytes = options.getPreloadedPackage('https://8bitgo.test/eka2l1/vtest/eka2l1.data?v=test', 3)
      assert.equal(Object.prototype.toString.call(packageBytes), '[object ArrayBuffer]', 'Emscripten 预加载回调必须同步给出 ArrayBuffer')
      dataBytes = [...new Uint8Array(packageBytes)]
      return context.fetch('https://8bitgo.test/eka2l1.wasm?v=test').then(async (response) => {
        assert.equal(response.headers.get('content-type'), 'application/wasm')
        wasmBytes = [...new Uint8Array(await response.arrayBuffer())]
        return { FS: {
        mount() { mountCalls++ },
        writeFile() {},
        unlink() {},
        readdir() { return ['.', '..'] },
        stat() { throw new Error('ENOENT') },
        isDir() { return false },
        } }
      })
    },
    EKA2L1: {
      environmentProblem: () => null,
      boot() {
        bootCalls++
        assert.equal(context.createEKA2L1Module.__8bitgoMemory, true, '必须先切换本局 MEMFS，再启动核心')
        return context.createEKA2L1Module({
          locateFile: (path) => `https://8bitgo.test/eka2l1/vtest/${path}?v=test`,
        }).then((module) => {
          context.EKA2L1.module = module
          return module
        })
      },
      applyPerfPrefs() {},
      initDevice() { return 0 },
      appList() { return [{ uid: 0x1234, name: 'Test game', sys: false }] },
      redrawCount() { return redraws },
      launchApp() { redraws++; return 0 },
      setPaused() {},
      setVolume() {},
      sendKey() {},
      lastAppExit() { return null },
    },
    MutationObserver: class { observe() {} },
  }
  context = vm.createContext({
    ...fakeRoot,
    document: fakeDocument,
    MutationObserver: fakeRoot.MutationObserver,
    Blob, TextEncoder, TextDecoder, URL, Headers, Response, AbortController, DOMException,
    setTimeout, clearTimeout, console, performance,
  })
  const nativeFetch = async (url) => {
    requestedCoreUrls.push(String(url))
    const isData = String(url).endsWith('.data?v=test')
    return new Response(
      Uint8Array.from(isData ? [1, 2, 3] : [0, 97, 115, 109]),
      { headers: { 'content-type': isData ? 'application/octet-stream' : 'application/wasm' } },
    )
  }
  context.fetch = nativeFetch
  vm.runInContext(readFileSync(scriptFile, 'utf8'), context, { filename: scriptFile })
  context.EightBitGoNgageCard = {
    async installCard() { return { plan: { appUid: 0x1234, title: 'Test game' } } },
  }
  const player = context.EightBitGoSymbianPlayer
  const first = player.prepare()
  const second = player.prepare()
  assert.equal(first, second, '并发 prepare 必须共享同一个核心启动 Promise')
  await first
  assert.equal(bootCalls, 1)
  assert.equal(memoryWrapperReady, true, '核心工厂必须使用弱网资源保护器')
  assert.deepEqual(dataBytes, [1, 2, 3])
  assert.deepEqual(wasmBytes, [0, 97, 115, 109])
  assert.equal(mountCalls, 0, '播放页不得挂载 /eka2l1 的持久 IDBFS')
  assert.equal(context.fetch, nativeFetch, '核心初始化后必须恢复页面原始 fetch')
  const consumed = []
  const startOptions = {
    firmware: new ArrayBuffer(4),
    game: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
    gameName: 'Test game',
    onAssetConsumed: (asset) => consumed.push(asset),
  }
  const started = await player.start(startOptions)
  assert.equal(started.uid, 0x1234)
  assert.deepEqual(consumed, ['game', 'firmware'])
  assert.equal(startOptions.game.byteLength, 0, '卡带装入虚拟盘后释放原始 ROM 缓冲')
  assert.equal(startOptions.firmware.byteLength, 0, '设备激活后释放原始固件缓冲')
})

test('快照比较：只挑出开局后新建或改过的游戏文件（含开局时写回的存档）', () => {
  const fs = new FakeFS()
  const D = '/eka2l1/drives'
  fs.mk(`${D}/e/system/apps/6rak/thesims.dat`, [1, 2, 3])
  fs.mk(`${D}/c/System/SharedData/101f8a5a.ini`, [1])
  fs.mk(`${D}/c/System/Apps/6RAK/old.sav`, [9])
  const baseline = P.snapshotDrives(fs, D)
  assert.ok(baseline.has('e/system/apps/6rak/thesims.dat'))
  // 开局写回的存档、游戏新写的存档、系统改写的 ini
  fs.mk(`${D}/c/System/Apps/6RAK/THESIMS.SAV`, [0x41, 0x53])
  fs.mk(`${D}/c/System/Apps/6RAK/old.sav`, [9, 9])
  fs.mk(`${D}/c/System/SharedData/101f8a5a.ini`, [2, 2])
  const changed = P.changedSaveFiles(baseline, P.snapshotDrives(fs, D))
  assert.deepEqual(changed, ['c/System/Apps/6RAK/THESIMS.SAV', 'c/System/Apps/6RAK/old.sav'])
})

test('键位：方向 / OK / 软键 / 数字；带修饰键不接管；手柄 a=5、b=7', () => {
  const key = (code, extra = {}) => P.scanFor({ code, ctrlKey: false, metaKey: false, altKey: false, ...extra })
  assert.equal(key('ArrowUp'), P.SCAN.UP)
  assert.equal(key('Enter'), P.SCAN.OK)
  assert.equal(key('Space'), P.SCAN.OK)
  assert.equal(key('KeyQ'), P.SCAN.LSK)
  assert.equal(key('F2'), P.SCAN.RSK)
  assert.equal(key('Digit5'), 0x35)
  assert.equal(key('Numpad7'), 0x37)
  assert.equal(key('KeyX'), P.SCAN.STAR)
  assert.equal(key('Backspace'), P.SCAN.CLEAR)
  assert.equal(key('KeyR'), 0, '没映射的键要交还给页面')
  assert.equal(key('KeyQ', { ctrlKey: true }), 0, '浏览器快捷键不能被吞掉')
  assert.equal(P.PAD.a, 0x35)
  assert.equal(P.PAD.b, 0x37)
  assert.equal(P.PAD.select, P.SCAN.LSK)
  assert.equal(P.PAD.start, P.SCAN.OK)
})

test('操作说明表与播放页键位一致', () => {
  const emulator = read('src/lib/emulator.ts')
  const block = emulator.slice(emulator.indexOf("if (runtimeId === 'eka2l1')"))
  assert.ok(block.length > 0, 'src/lib/emulator.ts 缺少塞班的操作说明')
  const section = block.slice(0, block.indexOf('touch:'))
  for (const [label, codes] of [['Q / F1', ['KeyQ', 'F1']], ['E / F2', ['KeyE', 'F2']], ['X / C', ['KeyX', 'KeyC']], ['Enter / Space', ['Enter', 'Space']]]) {
    assert.ok(section.includes(`'${label}'`), `操作说明缺少 ${label}`)
    for (const code of codes) assert.ok(P.KEYBOARD[code], `播放页没有映射 ${code}`)
  }
})

test('接线：运行时登记、塞班平台走 eka2l1、详情页跨源隔离、play.html 脚本顺序', () => {
  assert.ok(read('src/emulator/types.ts').includes("'eka2l1'"), 'RuntimeId 缺少 eka2l1')
  assert.ok(/eka2l1: \(\) => import\('\.\/adapters\/eka2l1'\)/.test(read('src/emulator/runtimes.ts')))
  assert.ok(/eka2l1: eka2l1Meta/.test(read('src/emulator/runtimeMeta.ts')))
  const platforms = read('src/data/platforms.ts')
  const symbian = platforms.slice(platforms.indexOf("id: 'symbian'"))
  assert.ok(/runtime: 'eka2l1'/.test(symbian.slice(0, 600)), '塞班平台没有走 eka2l1')
  assert.ok(/'\.zip'/.test(symbian.slice(0, 600)), '塞班平台不收卡带转储 .zip')
  assert.ok(INLINE_ISOLATED_PLATFORMS.includes('symbian') && isInlineIsolatedPlatform('psp') && !isInlineIsolatedPlatform('nes'))
  assert.ok(read('server/src/ssr.js').includes('isInlineIsolatedPlatform(data.game?.platform)'), 'SSR 没有按共享名单给详情页发隔离头')
  assert.ok(read('src/pages/GameDetailPage.tsx').includes('isInlineIsolatedPlatform(game?.platform)'), '详情页没有按共享名单整页刷新')
  const pageEntry = EKA2L1_SITE_SCRIPTS.find((s) => s.published === 'play.html')
  const playerEntry = EKA2L1_SITE_SCRIPTS.find((s) => s.published === 'js/8bitgo-player.js')
  assert.ok(pageEntry && pageEntry.inject === false && playerEntry && playerEntry.inject === false)
  const html = read('scripts/eka2l1-player.html')
  let last = -1
  for (const needle of ['src="eka2l1.js"', 'src="js/boot.js"', 'src="js/8bitgo-ngage-card.js"', 'src="js/8bitgo-player.js"']) {
    const at = html.indexOf(needle)
    assert.ok(at > last, `play.html 没有按顺序加载 ${needle}`)
    last = at
  }
  const constants = read('src/emulator/eka2l1Runtime.ts')
  const adapter = read('src/emulator/adapters/eka2l1.ts')
  assert.ok(adapter.includes('const preparedPlayer = frameReady.then'), '核心没有在 ROM / 固件到齐前开始预热')
  assert.ok(adapter.includes('Promise.all([preparedPlayer, firmwareLoad, gameLoad, seeded])'), '核心、固件与 ROM 没有并行等待')
  assert.ok(adapter.includes('probeRom(biosUrl, 4_000, false, { signal: aborter.signal, retry: false })'), '平台固件没有按 ETag 版本化以复用安全缓存')
  assert.ok(adapter.includes('api?.cancelBoot()'), '失败路径没有取消核心下载并释放线程')
  const buildId = /EKA2L1_BUILD_ID = '([0-9a-f]{12})'/.exec(constants)?.[1]
  if (buildId) {
    const dir = join(root, 'public', 'eka2l1', `v${buildId}`)
    assert.equal(readFileSync(join(dir, 'play.html'), 'utf8'), html, '发布目录里的 play.html 与仓库不一致，需运行 npm run eka2l1:repackage')
    assert.equal(readFileSync(join(dir, 'js/8bitgo-player.js'), 'utf8'), readFileSync(scriptFile, 'utf8'))
  }
})

console.log(`✓ 塞班详情页播放器 ${passed} 项通过`)
