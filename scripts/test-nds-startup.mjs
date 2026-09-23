/** melonDS DS 浏览器启动环境回归：防止再次掉进 RetroArch 的 No Items。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NDS_CORE_OPTIONS_PATH,
  NDS_SYSTEM_DIRECTORY,
  configureNdsCoreOptions,
  configureNdsSystemDirectory,
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

check('首次启动写 builtin BIOS + 禁用 4GB 虚拟 SD', () => {
  assert.equal(
    configureNdsCoreOptions(''),
    'melonds_sysfile_mode = "builtin"\nmelonds_homebrew_sdcard = "disabled"\n',
  )
})

check('已有玩家选择不覆盖，只补缺项', () => {
  const before = '# player choice\nmelonds_sysfile_mode = "native"\n'
  const after = configureNdsCoreOptions(before)
  assert.match(after, /melonds_sysfile_mode = "native"/)
  assert.match(after, /melonds_homebrew_sdcard = "disabled"/)
  assert.equal(configureNdsCoreOptions(after), after)
})

check('适配器在 callMain 前建目录、写 cfg 与核心选项，并接入统一 beforeStart 链', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(NDS_CORE_OPTIONS_PATH.includes('melonDS DS.opt'))
  assert.match(code, /ensureParentDir\(fs, `\$\{NDS_SYSTEM_DIRECTORY\}\/\.keep`\)/)
  assert.match(code, /configureNdsSystemDirectory\(cfgBefore\)/)
  assert.match(code, /configureNdsCoreOptions\(optBefore\)/)
  assert.match(code, /configureNdsStartup\?\.\(emu\)/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
