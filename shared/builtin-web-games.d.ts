export interface BuiltinWebGame {
  entry: string
  title: string
  isolated: boolean
}

export const BUILTIN_WEB_GAMES: Readonly<Record<string, BuiltinWebGame>>
export function builtinWebGameFor(slug: string | undefined): BuiltinWebGame | undefined
