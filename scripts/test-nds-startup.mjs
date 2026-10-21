/** melonDS DS 浏览器启动环境回归：防止再次掉进 RetroArch 的 No Items。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NDS_CORE_OPTIONS_PATH,
  NDS_SYSTEM_DIRECTORY,
  NDS_WFC_MAC_PATH,
  configureNdsCoreOptions,
  configureNdsSystemDirectory,
  installNdsCoreOptionsGuard,
} from '../src/emulator/ndsStartup.ts'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error.message}`)
  }
}

check('system_directory 从根目录改成真实子目录，重复执行幂等', () => {
  const before = 'savefile_directory = "/data/saves"\nsystem_directory = "/"\naudio_latency = 64\n'
  const once = configureNdsSystemDirectory(before)
  assert.equal(once, `savefile_directory = "/data/saves"\nsystem_directory = "${NDS_SYSTEM_DIRECTORY}"\naudio_latency = 64\n`)
  assert.equal(configureNdsSystemDirectory(once), once)
})

check('首次启动写 builtin BIOS、禁用 4GB 虚拟 SD 和布局 OSD', () => {
  assert.equal(
    configureNdsCoreOptions(''),
    'melonds_sysfile_mode = "builtin"\nmelonds_homebrew_sdcard = "disabled"\nmelonds_show_current_layout = "disabled"\n',
  )
})

check('已有玩家的 BIOS 选择保留，但旧的布局 OSD 配置强制关闭', () => {
  const before = '# player choice\nmelonds_sysfile_mode = "native"\nmelonds_show_current_layout = "enabled"\n'
  const after = configureNdsCoreOptions(before)
  assert.match(after, /melonds_sysfile_mode = "native"/)
  assert.match(after, /melonds_homebrew_sdcard = "disabled"/)
  assert.match(after, /melonds_show_current_layout = "disabled"/)
  assert.doesNotMatch(after, /melonds_show_current_layout = "enabled"/)
  assert.equal(configureNdsCoreOptions(after), after)
})

check('布局 OSD 重复配置只留一条 disabled，不能让最后一条 enabled 翻盘', () => {
  const after = configureNdsCoreOptions('melonds_show_current_layout = "enabled"\nmelonds_show_current_layout = "enabled"\n')
  assert.equal((after.match(/melonds_show_current_layout/g) ?? []).length, 1)
  assert.match(after, /melonds_show_current_layout = "disabled"/)
})

check('WFC 内置固件使用独立 MAC，重复写入幂等且不改玩家自定义地址', () => {
  const mac = '00:09:bf:12:34:56'
  const initial = configureNdsCoreOptions('', mac)
  assert.match(initial, /melonds_mac_address_mode = "00:09:BF:12:34:56"/)
  assert.equal(configureNdsCoreOptions(initial, mac), initial)
  const firmwareDefault = configureNdsCoreOptions('melonds_mac_address_mode = "firmware"\n', mac)
  assert.match(firmwareDefault, /melonds_mac_address_mode = "00:09:BF:12:34:56"/)
  // 站点旧版托管的 00:08:BF 不算玩家自定义：换代后必须换成新地址
  const legacy = configureNdsCoreOptions('melonds_mac_address_mode = "00:08:BF:AA:BB:CC"\n', mac)
  assert.match(legacy, /melonds_mac_address_mode = "00:09:BF:12:34:56"/)
  const custom = configureNdsCoreOptions('melonds_mac_address_mode = "00:1f:32:aa:bb:cc"\n', mac)
  assert.match(custom, /melonds_mac_address_mode = "00:1f:32:aa:bb:cc"/)
  assert.doesNotMatch(custom, /melonds_mac_address_mode = "00:09:BF:12:34:56"/)
  const native = configureNdsCoreOptions('melonds_sysfile_mode = "native"\n', mac)
  assert.doesNotMatch(native, /melonds_mac_address_mode/)
  assert.doesNotMatch(configureNdsCoreOptions('', 'malformed'), /melonds_mac_address_mode/)
  assert.doesNotMatch(configureNdsCoreOptions('', '00:08:bf:12:34:56'), /melonds_mac_address_mode/)
})

check('引擎最终覆盖 .opt 后，WFC 独立 MAC 仍生效', () => {
  const files = new Map()
  const fs = {
    readFile: (path) => new TextEncoder().encode(files.get(path) ?? ''),
    writeFile: (path, data) => files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data)),
  }
  const callbacks = { setupCoreSettingFile(path) { fs.writeFile(path, 'melonds_mac_address_mode = "firmware"\n') } }
  assert.equal(installNdsCoreOptionsGuard(callbacks, fs, undefined, '00:09:bf:12:34:56'), true)
  callbacks.setupCoreSettingFile(NDS_CORE_OPTIONS_PATH)
  assert.match(files.get(NDS_CORE_OPTIONS_PATH), /melonds_mac_address_mode = "00:09:BF:12:34:56"/)
})

check('致命时序：引擎在 callMain 内覆盖 .opt 后，守卫必须再做最后一次校正', () => {
  const files = new Map()
  const fs = {
    readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`)
      return new TextEncoder().encode(files.get(path))
    },
    writeFile(path, data) {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
  }
  let engineRan = false
  let applied = false
  const callbacks = {
    setupCoreSettingFile(path) {
      engineRan = true
      // 这就是引擎真实时序：它在 callMain 内把 startGame 前写好的内容覆盖掉。
      fs.writeFile(path, 'melonds_sysfile_mode = "native"\nmelonds_show_current_layout = "enabled"\n')
    },
  }
  assert.equal(installNdsCoreOptionsGuard(callbacks, fs, (ok) => { applied = ok }), true)
  callbacks.setupCoreSettingFile(NDS_CORE_OPTIONS_PATH)
  const final = new TextDecoder().decode(fs.readFile(NDS_CORE_OPTIONS_PATH))
  assert.equal(engineRan, true, '玩家设置的原回调必须先执行')
  assert.equal(applied, true, '最终回读必须确认安全项真的在位')
  assert.match(final, /melonds_sysfile_mode = "native"/, '玩家选的 native BIOS 不能被默认值覆盖')
  assert.match(final, /melonds_homebrew_sdcard = "disabled"/, '缺失的 4GB 虚拟 SD 安全默认值必须补上')
  assert.match(final, /melonds_show_current_layout = "disabled"/, '引擎写回的 enabled 必须被校正')
  assert.doesNotMatch(final, /melonds_show_current_layout = "enabled"/)
})

check('最终写入守卫只处理 melonDS DS 路径，且重复安装不套娃', () => {
  let calls = 0
  const files = new Map([['/other/core.opt', 'untouched\n']])
  const fs = {
    readFile: (path) => new TextEncoder().encode(files.get(path) ?? ''),
    writeFile: (path, data) => files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data)),
  }
  const callbacks = { setupCoreSettingFile() { calls++ } }
  assert.equal(installNdsCoreOptionsGuard(callbacks, fs), true)
  assert.equal(installNdsCoreOptionsGuard(callbacks, fs), true)
  callbacks.setupCoreSettingFile('/other/core.opt')
  assert.equal(calls, 1)
  assert.equal(files.get('/other/core.opt'), 'untouched\n')
})

check('适配器在 callMain 前建目录、写 cfg 与核心选项，并接入统一 beforeStart 链', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(NDS_CORE_OPTIONS_PATH.includes('melonDS DS.opt'))
  assert.match(code, /ensureParentDir\(fs, `\$\{NDS_SYSTEM_DIRECTORY\}\/\.keep`\)/)
  assert.match(code, /configureNdsSystemDirectory\(cfgBefore\)/)
  assert.match(code, /configureNdsCoreOptions\(optBefore, wfcMacForCore\)/)
  assert.match(code, /const wfcMacForCore = core === 'melondsds' && ndsWfcTask \? ndsWfcMacAddress\(\) : null/)
  assert.match(code, /fs\.writeFile\(NDS_WFC_MAC_PATH, wfcMacForCore\.toUpperCase\(\)\)/)
  assert.equal(NDS_WFC_MAC_PATH, `${NDS_SYSTEM_DIRECTORY}/8bitgo-wfc-mac.txt`)
  assert.match(code, /optCheck\.includes\('melonds_show_current_layout = "disabled"'\)/)
  assert.match(code, /installNdsCoreOptionsGuard\(gm\?\.Module\?\.callbacks, fs/)
  assert.match(code, /selectNdsArchiveRom\?\.\(emu\)/)
  assert.match(code, /assertNdsRomBlob\(blob\)/)
  assert.match(code, /configureNdsStartup\?\.\(emu\)/)
  assert.match(code, /resumeKey:\s*options\.resumeAcrossRefresh\s*\?\s*cacheKey\s*:\s*undefined/)
  assert.match(code, /resumeAcrossRefresh:\s*true/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
