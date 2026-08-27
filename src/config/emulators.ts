/**
 * 「哪种格式用哪个引擎」的配置表 —— 想换引擎改这里就够了。
 *
 * 解析顺序（见 src/emulator/registry.ts）：
 *   1. 扩展名在下面的覆盖表里 → 直接用指定引擎
 *   2. 否则在「支持该扩展名」的引擎里挑 priority 最高的
 *   3. 再否则退回平台自己配置的引擎（src/data/platforms.ts 的 runtime 字段）
 *
 * 覆盖表只在该引擎 available() 为真时生效，否则自动往下走，不会把页面卡死。
 */
import type { RuntimeId } from '@/emulator/types'

export const EXT_RUNTIME_OVERRIDES: Record<string, RuntimeId> = {
  // NES 交给轻量的 jsnes（纯 JS，启动快、包小）
  // 想换回 EmulatorJS 的 RetroArch 核心（更精准、支持金手指与更多 mapper），把这行删掉即可
  nes: 'jsnes',

  // Flash
  swf: 'ruffle',

  // Java 手机游戏：需要自托管 J2ME 运行时，没配置时会自动跳过
  jar: 'j2me',
  jad: 'j2me',

  // NDS：webretro 的 melonDS 核心，比 EmulatorJS 用的 desmume 分支稳。
  // 需要自托管（npm run webretro + VITE_WEBRETRO_PATH），没部署时 available() 为 false，
  // 这张表会自动跳过，NDS 回落到 EmulatorJS。
  nds: 'webretro',
  srl: 'webretro',

  // DOS：js-dos（DOSBox 浏览器移植）比 EmulatorJS 的 dosbox_pure 核心启动快、兼容性好。
  // .zip / .exe / .com 没写在这里 —— 那几个扩展名别的平台也在用，
  // 靠 jsdos 的 supports(dos) + priority 去争，不能一刀切。
  jsdos: 'jsdos',
}
