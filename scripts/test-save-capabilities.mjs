/**
 * 跨运行时存档能力的总闸测试。
 *
 * 单个适配器的测试只能证明“引擎能吐出一份状态”；这里钉的是它能否一路穿过
 * 工具栏坐标、前端白名单、后端白名单与体积策略。漏任意一层，玩家看到的都是同一个症状：
 * 按钮能点，但存档不在、读不回，或只能下载不能归档。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

globalThis.__viteEnv = { VITE_API_URL: 'https://api.test' }
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const {
  asSaveRuntime,
  MAX_LOCAL_DOLPHIN_SAVE_BYTES,
  MAX_LOCAL_PSP_SAVE_BYTES,
  MAX_SAVE_BYTES,
} = await import('../src/services/saves.ts')
const { dolphinVersionSaveSlug, parseDolphinVersionSaveSlug } = await import('../src/emulator/dolphinSave.ts')
const {
  emulatorVariantSaveSlug,
  ndsVariantSaveSlug,
  parseEmulatorVariantSaveSlug,
  pspVariantSaveSlug,
} = await import('../src/emulator/romLanguage.ts')

let passed = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed++
  console.log(`✅ ${message}`)
}

console.log('── Dolphin 统一存档链 ──')
ok(asSaveRuntime('dolphin') === 'dolphin', '前端白名单收 Dolphin')
ok(MAX_LOCAL_DOLPHIN_SAVE_BYTES > MAX_LOCAL_PSP_SAVE_BYTES, 'GC / Wii 大状态的本地上限高于 PSP')
ok(MAX_LOCAL_DOLPHIN_SAVE_BYTES > MAX_SAVE_BYTES, '大状态先保在浏览器，不被 4MB 云配额一起挡掉')

const keyed = dolphinVersionSaveSlug('super-mario-galaxy', '7e38409')
const parsed = parseDolphinVersionSaveSlug(keyed)
ok(parsed.gameSlug === 'super-mario-galaxy' && parsed.version === '7e38409', 'Dolphin 归档键带核心构建且可还原标题')
const longA = dolphinVersionSaveSlug(`${'x'.repeat(160)}a`, '7e38409')
const longB = dolphinVersionSaveSlug(`${'x'.repeat(160)}b`, '7e38409')
ok(longA.length <= 160 && parseDolphinVersionSaveSlug(longA).version === '7e38409', '极端长 slug 仍保留核心构建且不越过 160 字符')
ok(longA !== longB, '相同长前缀的两个本地 ROM 仍按指纹隔离')

console.log('\n── 多语言快照隔离 ──')
const romLangs = ['zh-Hans', 'en']
ok(
  emulatorVariantSaveSlug('contra', 'zh-Hans', romLangs) === 'contra',
  '默认语言继续使用历史 archive key，不迁走既有进度',
)
const englishEmulatorKey = emulatorVariantSaveSlug('contra', 'en', romLangs)
ok(englishEmulatorKey === 'contra~rom-en', '其它语言的 EmulatorJS / jsnes 快照使用独立 key')
ok(
  parseEmulatorVariantSaveSlug(englishEmulatorKey).gameSlug === 'contra'
    && parseEmulatorVariantSaveSlug(englishEmulatorKey).romLang === 'en',
  '通用语言变体存档仍能链接回原游戏',
)
const versionedWindowsGuestKey = `${englishEmulatorKey}:wg:0123456789abcdef`
ok(
  parseEmulatorVariantSaveSlug(versionedWindowsGuestKey).gameSlug === 'contra'
    && parseEmulatorVariantSaveSlug(versionedWindowsGuestKey).romLang === 'en',
  '整包 Windows 版本隔离键仍能剥离指纹并链接到正确语言游戏',
)
ok(
  parseEmulatorVariantSaveSlug('local:AoE.zip:wg:0123456789abcdef').gameSlug === 'local:AoE.zip',
  '本地 Windows ROM 的版本化存档仍显示为本地游戏',
)
ok(
  ndsVariantSaveSlug('pokemon-black', 'en', romLangs).endsWith('~nds-en')
    && pspVariantSaveSlug('djmax', 'en', 2).endsWith('~psp-en'),
  'NDS / PSP 既有的专用隔离规则保持不变',
)
const longVariant = emulatorVariantSaveSlug(`${'long-rom-'.repeat(24)}a`, 'en', romLangs)
ok(longVariant.length <= 160 && longVariant.endsWith('~rom-en'), '极端长 slug 的语言变体也不会被服务端拒绝')
const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
ok(
  /runtime\.id === 'emulatorjs' \|\| runtime\.id === 'jsnes' \|\| runtime\.id === 'jsdos' \|\| runtime\.id === 'dolphin'/.test(player),
  'DOS / Sockdrive 与 Dolphin 也复用语言隔离，不能只保护掌机快照',
)

console.log('\n── 工具栏归档坐标与远程存档边界 ──')
const tools = readFileSync(new URL('../src/emulator/EmulatorTools.tsx', import.meta.url), 'utf8')
ok(
  /pushSave\([\s\S]*?saveRuntime,[\s\S]*?archiveGameKey,[\s\S]*?bytes,[\s\S]*?archiveSlot,[\s\S]*?target,[\s\S]*?handle\.saveMetadata/.test(tools),
  '保存使用运行时声明的 archive key + slot',
)
ok(/encodeSaveArchive\(/.test(tools) && /decodeSaveArchive\(/.test(tools), '文件导出与导入走通用存档校验容器')
ok(
  /fetchCloudSave\(saveRuntime, archiveGameKey, archiveSlot\)/.test(tools) &&
    /pullLocalSave\(saveRuntime, archiveGameKey, archiveSlot\)/.test(tools),
  '云端与本地读取使用同一组 archive key + slot',
)
ok(/saveModal && !remoteOnly/.test(tools), '远程云游戏不再打开本地/文件三选一面板')
ok(/!handle\.loadState \|\| saveBusyRef\.current/.test(tools), '没有读档 API 时不会假报“读取成功”')
ok(/assertImportFileSize\(file\)/.test(tools) && /localSaveByteLimit\(saveRuntime\)/.test(tools), '导入异常大文件会在读取前按运行时上限拦住')

console.log(`\n全部通过 ✅  共 ${passed} 项`)
