export type IsolatedRuntimePlatformId = 'psp' | 'ps2' | 'gamecube' | 'wii'

export const ISOLATED_RUNTIME_PLATFORM_IDS: readonly IsolatedRuntimePlatformId[]

export function isIsolatedRuntimePlatform(id: string | undefined): id is IsolatedRuntimePlatformId

export function isolatedRuntimeRoute(pathname: string):
  | Readonly<{ platform: IsolatedRuntimePlatformId; slug: string }>
  | undefined
