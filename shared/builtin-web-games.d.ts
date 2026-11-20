export interface BuiltinWebGame {
  entry: string
  title: string
  isolated: boolean
  /** 需要离开站内播放器、从用户点击时直接打开的新标签页地址。 */
  externalLaunchUrl?: string
}

export const BUILTIN_WEB_GAMES: Readonly<Record<string, BuiltinWebGame>>
export function builtinWebGameFor(slug: string | undefined): BuiltinWebGame | undefined
