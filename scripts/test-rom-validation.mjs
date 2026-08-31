/** ROM 双层校验的纯函数回归测试：重点覆盖“开头正确、末尾被截断”这种线上真实故障。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { assertJarBuffer } from '../server/src/jar-validation.js'

function arrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** 测试只需 stored ZIP；CRC 不参与结构校验，写 0 即可。 */
function zip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, body] of files) {
    const n = Buffer.from(name)
    const data = Buffer.from(body)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(n.length, 26)
    local.push(header, n, data)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, n)
    offset += header.length + n.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-rom-validation-'))
try {
  const outfile = path.join(temp, 'validators.mjs')
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/romValidation.ts'",
        "export { assertValidZip, listZipEntries, extractZipEntry } from './src/lib/unzip.ts'",
        "export { makeJsdosBundle } from './src/lib/jsdosBundle.ts'",
        "export { buildWindowsGuestConfig } from './src/lib/windowsGuest.ts'",
        "export { normalizeDosboxConfigOverride, mergeDosboxConfigOverride } from './shared/dosbox-config.js'",
        "export { createOverallRatio, fetchWithProgress, windowsGuestStartupBudgetMs } from './src/emulator/loadProgress.ts'",
        "export { shouldCaptureMouse } from './src/emulator/mouseCapture.ts'",
        "export { isWindowsGraphicsMode, scheduleWindowsLaunch, windowsLaunchDelayMs } from './src/emulator/windowsLaunch.ts'",
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'rom-validation-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  const {
    assertValidZip,
    assertNesRom,
    assertSwf,
    assertJar,
    prepareNdsRom,
    makeJsdosBundle,
    listZipEntries,
    extractZipEntry,
    buildWindowsGuestConfig,
    normalizeDosboxConfigOverride,
    mergeDosboxConfigOverride,
    createOverallRatio,
    fetchWithProgress,
    shouldCaptureMouse,
    isWindowsGraphicsMode,
    scheduleWindowsLaunch,
    windowsLaunchDelayMs,
    windowsGuestStartupBudgetMs,
  } = await import(
    `${pathToFileURL(outfile).href}?${Date.now()}`
  )

  const nes = Buffer.alloc(16)
  nes.set(Buffer.from([0x4e, 0x45, 0x53, 0x1a]))
  assert.doesNotThrow(() => assertNesRom(arrayBuffer(nes)))
  assert.throws(() => assertNesRom(arrayBuffer(Buffer.from('<html>not a rom'))), /网页|NES ROM/)
  const shortNes = Buffer.from(nes)
  shortNes[4] = 1
  assert.throws(() => assertNesRom(arrayBuffer(shortNes)), /不完整/)

  const complete = zip([['game.nes', nes]])
  assert.equal(assertValidZip(arrayBuffer(complete)).length, 1)
  const truncated = complete.subarray(0, complete.length - 10)
  assert.throws(() => assertValidZip(arrayBuffer(truncated)), /损坏|不完整/)

  const swf = Buffer.alloc(8)
  swf.write('FWS', 0, 'ascii')
  swf.writeUInt32LE(8, 4)
  assert.doesNotThrow(() => assertSwf(arrayBuffer(swf)))
  swf.writeUInt32LE(20, 4)
  assert.throws(() => assertSwf(arrayBuffer(swf)), /不完整/)

  const nds = Buffer.alloc(0x200)
  nds.set([0x24, 0xff, 0xae, 0x51], 0xc0)
  const ndsZip = zip([['folder/game.nds', nds]])
  const prepared = await prepareNdsRom(arrayBuffer(ndsZip), 'wrapper.zip')
  assert.equal(prepared.name, 'folder/game.nds')
  assert.equal(prepared.data.byteLength, nds.length)
  const shortNds = Buffer.from(nds)
  shortNds.writeUInt32LE(0x200, 0x20)
  shortNds.writeUInt32LE(1, 0x2c)
  await assert.rejects(() => prepareNdsRom(arrayBuffer(shortNds), 'short.nds'), /不完整/)

  const jar = zip([
    ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\nMIDlet-1: Game,,Main\n')],
    ['Main.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
  ])
  assert.equal(assertJar(arrayBuffer(jar)).length, 2)
  assert.equal(assertJarBuffer(jar).length, 2)
  const noManifest = zip([['Main.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe])]])
  assert.throws(() => assertJar(arrayBuffer(noManifest)), /MANIFEST/)
  assert.throws(() => assertJarBuffer(noManifest), /MANIFEST/)

  await assert.rejects(() => makeJsdosBundle('broken.zip', arrayBuffer(truncated)), /损坏|不完整/)
  await assert.rejects(() => makeJsdosBundle('data.zip', arrayBuffer(zip([['README.TXT', 'x']]))), /没有可运行/)
  const dos = await makeJsdosBundle('game.zip', arrayBuffer(zip([['GAME.EXE', Buffer.from('MZ')]])))
  assert.equal(dos.executable, 'GAME.EXE')

  // 高级配置只允许硬件 / 性能段；启动命令和鼠标捕获策略不能借 INI 覆盖绕过去。
  assert.equal(normalizeDosboxConfigOverride('  [gus]\r\ngus=false  '), '[gus]\ngus=false')
  assert.throws(() => normalizeDosboxConfigOverride('[autoexec]\nformat c:'), /不允许编辑/)
  assert.throws(() => normalizeDosboxConfigOverride('[sdl]\nautolock=true'), /统一管理/)
  assert.throws(() => normalizeDosboxConfigOverride('[gus]\ngus=false\n[gus]\ngus=true'), /重复出现/)
  const mergedConfig = mergeDosboxConfigOverride('[cpu]\ncycles=auto\n\n[gus]\ngus=true\n', '[cpu]\ncycles=20000\n\n[gus]\ngus=false')
  assert.match(mergedConfig, /\[cpu\]\ncycles=20000/)
  assert.match(mergedConfig, /\[gus\]\ngus=false/)

  // 共享系统镜像：覆盖在站点补完游戏盘与 boot 后应用，受保护的 autoexec 仍完整存在。
  const guestConfig = buildWindowsGuestConfig(
    '[dosbox]\nmemsize=64\n\n[autoexec]\nimgmount c system.img\nboot c:\n',
    '[gus]\ngus=false',
  )
  assert.match(guestConfig.dosboxConf, /mount d GAME -freesize 16/)
  assert.match(guestConfig.dosboxConf, /boot c: -convertfat/)
  assert.match(guestConfig.dosboxConf, /\[gus\]\ngus=false/)

  // 旧式完整 .jsdos 也要替换包内配置；不能只让共享系统模式生效。
  const legacyBytes = arrayBuffer(zip([
    ['.jsdos/dosbox.conf', Buffer.from('[gus]\ngus=true\n\n[autoexec]\nmount c .\nc:\nGAME.EXE\n')],
    ['GAME.EXE', Buffer.from('MZ')],
  ]))
  const customized = await makeJsdosBundle('legacy.jsdos', legacyBytes, undefined, '[gus]\ngus=false')
  assert.equal(customized.passthrough, false)
  const customizedBytes = await customized.blob.arrayBuffer()
  const configEntry = listZipEntries(customizedBytes).find((entry) => entry.name === '.jsdos/dosbox.conf')
  assert.ok(configEntry)
  const customizedConfig = new TextDecoder().decode(await extractZipEntry(customizedBytes, configEntry))
  assert.match(customizedConfig, /\[gus\]\ngus=false/)
  assert.match(customizedConfig, /\[autoexec\]\nmount c \./)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '3' } })
  await assert.rejects(() => fetchWithProgress('https://example.test/short.rom'), /下载不完整/)
  globalThis.fetch = originalFetch

  const overall = createOverallRatio()
  assert.equal(overall({ phase: 'engine', ratio: 0.5 }), 0.1)
  assert.equal(overall({ phase: 'assets', ratio: 1 }), 0.4)
  assert.ok(Math.abs(overall({ phase: 'rom', ratio: 0.5 }) - 0.6) < Number.EPSILON)
  // starting=1 只表示开始启动，80% 之后必须留给超时计时和真正的 onReady。
  assert.equal(overall({ phase: 'starting', ratio: 1 }), 0.8)
  // 并行请求的旧阶段晚到时，总进度不能倒退。
  assert.equal(overall({ phase: 'assets', ratio: 0.1 }), 0.8)
  // Windows 客体不能再沿用旧的“开机等待 + 45 秒”；慢设备挂 qcow2 本身就可能超过一分钟。
  assert.equal(windowsGuestStartupBudgetMs(24), 264_000)
  assert.equal(windowsGuestStartupBudgetMs(2), 245_000)
  assert.equal(windowsGuestStartupBudgetMs(999), 360_000)

  // 只有 DOS 射击游戏使用相对鼠标；其他类别和其他平台都不能误锁定指针。
  assert.equal(shouldCaptureMouse('dos', ['action', 'shooter']), true)
  assert.equal(shouldCaptureMouse('dos', ['strategy']), false)
  assert.equal(shouldCaptureMouse('dos'), false)
  assert.equal(shouldCaptureMouse('nes', ['shooter']), false)

  // ci-ready 时的 720×400 仍是 DOSBox 文本画面，不能从这里开始自启动倒计时。
  assert.equal(isWindowsGraphicsMode(720, 400), false)
  assert.equal(isWindowsGraphicsMode(640, 480), true)
  assert.equal(isWindowsGraphicsMode(800, 600), true)
  assert.equal(windowsLaunchDelayMs(2), 5_000)
  assert.equal(windowsLaunchDelayMs(999), 120_000)

  // 自启动必须等 Windows 报告图形模式；这条回归测试专门防止以后又退回 ci-ready 一到就计时。
  const originalWindow = globalThis.window
  const scheduled = []
  let frameSizeConsumer
  globalThis.window = {
    setTimeout(fn, ms) {
      scheduled.push({ fn, ms, cleared: false })
      return scheduled.length
    },
    clearTimeout(id) {
      if (scheduled[id - 1]) scheduled[id - 1].cleared = true
    },
  }
  const cancelLaunch = scheduleWindowsLaunch(
    {
      sendKeyEvent() {},
      events: () => ({ onFrameSize: (consumer) => { frameSizeConsumer = consumer } }),
    },
    'D:\\8BITGO\\RUN.BAT',
    24,
    () => false,
    () => {},
  )
  assert.deepEqual(scheduled.map(({ ms }) => ms), [90_000])
  frameSizeConsumer(720, 400)
  assert.deepEqual(scheduled.map(({ ms }) => ms), [90_000])
  frameSizeConsumer(640, 480)
  assert.deepEqual(scheduled.map(({ ms }) => ms), [90_000, 24_000])
  cancelLaunch()
  assert.ok(scheduled.every(({ cleared }) => cleared))

  // Windows 3.x 没有开始菜单：必须走 Program Manager 的 Alt+F、R，不能再发 Ctrl+Esc。
  scheduled.length = 0
  const keyEvents = []
  frameSizeConsumer = undefined
  const cancelWin31Launch = scheduleWindowsLaunch(
    {
      sendKeyEvent(keyCode, pressed) { keyEvents.push([keyCode, pressed]) },
      events: () => ({ onFrameSize: (consumer) => { frameSizeConsumer = consumer } }),
    },
    'D:\\8BITGO\\RUN.BAT',
    5,
    () => false,
    () => {},
    '3x',
  )
  frameSizeConsumer(640, 480)
  const launchTimer = scheduled.find(({ ms }) => ms === 5_000)
  assert.ok(launchTimer)
  launchTimer.fn()
  assert.deepEqual(keyEvents, [
    [342, true],
    [70, true],
    [70, false],
    [342, false],
  ])
  cancelWin31Launch()
  globalThis.window = originalWindow

  console.log('ROM 校验测试通过：下载长度 / 分段进度 / Windows 自启动 / DOS 鼠标 / NES / ZIP 截断 / SWF / NDS / J2ME / DOS')
} finally {
  await rm(temp, { recursive: true, force: true })
}
