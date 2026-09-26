import { ROM_LANGS, type RomLang } from '@/config/languages'

/**
 * PSP 即时状态和 ROM 二进制严格绑定；地区版 / 汉化版之间通常不能互读。
 * 只给确实有多语言 ROM 的 PSP 游戏加后缀，避免把历史上只有一张盘的存档无谓迁走。
 */
const PSP_SAVE_LANG_MARKER = '~psp-'

export function pspVariantSaveSlug(gameSlug: string, romLang: RomLang | undefined, romLangCount: number): string {
  if (!romLang || romLangCount < 2 || gameSlug.startsWith('local:')) return gameSlug
  return `${gameSlug}${PSP_SAVE_LANG_MARKER}${romLang}`
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
