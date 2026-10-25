import { ROM_LANGS, type RomLang } from '@/config/languages'

/**
 * PSP 即时状态和 ROM 二进制严格绑定；地区版 / 汉化版之间通常不能互读。
 * 只给确实有多语言 ROM 的 PSP 游戏加后缀，避免把历史上只有一张盘的存档无谓迁走。
 */
const PSP_SAVE_LANG_MARKER = '~psp-'
const NDS_SAVE_LANG_MARKER = '~nds-'
const EMULATOR_SAVE_LANG_MARKER = '~rom-'
const NDS_COMPAT_SAVE_SUFFIX = ':melonds-compat'
const MAX_SAVE_SLUG_LENGTH = 160

/**
 * 服务端把 game_slug 限为 160 个字符。语言变体不能因为一份很长的本地 ROM 名而让
 * 云端写入直接 400；同时不能只截断前缀，否则同前缀的两份本地 ROM 会重新撞在一起。
 */
function appendSaveVariant(gameSlug: string, marker: string, romLang: RomLang): string {
  const suffix = `${marker}${romLang}`
  if (gameSlug.length + suffix.length <= MAX_SAVE_SLUG_LENGTH) return `${gameSlug}${suffix}`
  let hash = 0x811c9dc5
  for (let i = 0; i < gameSlug.length; i++) {
    hash ^= gameSlug.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const fingerprint = `~${(hash >>> 0).toString(36)}`
  return `${gameSlug.slice(0, Math.max(1, MAX_SAVE_SLUG_LENGTH - suffix.length - fingerprint.length))}${fingerprint}${suffix}`
}

export function pspVariantSaveSlug(gameSlug: string, romLang: RomLang | undefined, romLangCount: number): string {
  if (!romLang || romLangCount < 2 || gameSlug.startsWith('local:')) return gameSlug
  return appendSaveVariant(gameSlug, PSP_SAVE_LANG_MARKER, romLang)
}

/** 个人页展示多语言 PSP 存档时，要拿基础 slug 查游戏并链接回正确详情页。 */
export function parsePspVariantSaveSlug(value: string): { gameSlug: string; romLang?: RomLang } {
  // 本地文件名完全由玩家决定；即使恰好以标记结尾，也不是本站生成的语言变体键。
  if (value.startsWith('local:')) return { gameSlug: value }
  const markerAt = value.lastIndexOf(PSP_SAVE_LANG_MARKER)
  if (markerAt <= 0) return { gameSlug: value }
  const romLang = value.slice(markerAt + PSP_SAVE_LANG_MARKER.length)
  if (!(ROM_LANGS as readonly string[]).includes(romLang)) return { gameSlug: value }
  return { gameSlug: value.slice(0, markerAt), romLang: romLang as RomLang }
}

/**
 * NDS 即时快照和具体 ROM 二进制绑定。第一种语言沿用旧键，避免把已有进度整个搬走；
 * 其它语言独立归档，不能把中文版快照直接喂给英文版。语言列表按 ROM_LANGS 固定排序。
 */
export function ndsVariantSaveSlug(gameSlug: string, romLang: RomLang | undefined, romLangs: readonly RomLang[]): string {
  if (!romLang || romLangs.length < 2 || romLang === romLangs[0] || gameSlug.startsWith('local:')) return gameSlug
  return appendSaveVariant(gameSlug, NDS_SAVE_LANG_MARKER, romLang)
}

/** 个人页要能从 NDS 语言档和兼容核心档位回到原游戏，而不是链接到不存在的变体 slug。 */
export function parseNdsVariantSaveSlug(value: string): { gameSlug: string; romLang?: RomLang } {
  if (value.startsWith('local:')) return { gameSlug: value }
  const base = value.endsWith(NDS_COMPAT_SAVE_SUFFIX)
    ? value.slice(0, -NDS_COMPAT_SAVE_SUFFIX.length)
    : value
  const markerAt = base.lastIndexOf(NDS_SAVE_LANG_MARKER)
  if (markerAt <= 0) return { gameSlug: base }
  const romLang = base.slice(markerAt + NDS_SAVE_LANG_MARKER.length)
  if (!(ROM_LANGS as readonly string[]).includes(romLang)) return { gameSlug: base }
  return { gameSlug: base.slice(0, markerAt), romLang: romLang as RomLang }
}

/**
 * 即时快照是 ROM 二进制的一部分：即使核心相同，换语言版后读回旧快照也可能覆盖
 * RAM、存储卡或区域配置。NDS/PSP 已有专用规则；其它 EmulatorJS / jsnes 平台沿用
 * “第一语言保留历史键、其它语言隔离”的规则，避免升级时让既有默认语言进度消失。
 */
export function emulatorVariantSaveSlug(
  gameSlug: string,
  romLang: RomLang | undefined,
  romLangs: readonly RomLang[],
): string {
  if (!romLang || romLangs.length < 2 || romLang === romLangs[0] || gameSlug.startsWith('local:')) return gameSlug
  return appendSaveVariant(gameSlug, EMULATOR_SAVE_LANG_MARKER, romLang)
}

/** 个人页展示通用 EmulatorJS / jsnes 语言档时，仍要能返回游戏详情页。 */
export function parseEmulatorVariantSaveSlug(value: string): { gameSlug: string; romLang?: RomLang } {
  // 整包 Windows 游戏盘在语言 / 核心变体键后追加包指纹；个人页先剥掉它才能链接回游戏详情。
  const base = value.replace(/:wg:[0-9a-f]{16}$/i, '')
  if (base.startsWith('local:')) return { gameSlug: base }
  const markerAt = base.lastIndexOf(EMULATOR_SAVE_LANG_MARKER)
  if (markerAt <= 0) return { gameSlug: base }
  const romLang = base.slice(markerAt + EMULATOR_SAVE_LANG_MARKER.length)
  if (!(ROM_LANGS as readonly string[]).includes(romLang)) return { gameSlug: base }
  return { gameSlug: base.slice(0, markerAt), romLang: romLang as RomLang }
}

/**
 * 连点语言选择时，已经拆掉旧会话就继续把“重开”意图交给最后一次选择。
 * 空闲页第一次选语言则只换地址，不擅自替玩家开机。
 */
export function nextRomLanguageRestart(
  pending: RomLang | null,
  hasSession: boolean,
  next: RomLang,
): RomLang | null {
  return hasSession || pending ? next : null
}

/**
 * 必须等“玩家最后一次选择、父层正在解析的选择、实际探到的 ROM”三者一致再重开。
 * 少任何一层，旧请求或跨语言回退都可能把错误的镜像启动起来。
 */
export function canResumeRomLanguageSwitch({
  pending,
  selected,
  resolved,
  romUrl,
  checking,
}: {
  pending: RomLang | null
  selected: RomLang | null | undefined
  resolved: RomLang | undefined
  romUrl: string | undefined
  checking: boolean | undefined
}): boolean {
  return Boolean(pending && pending === selected && pending === resolved && romUrl && !checking)
}
