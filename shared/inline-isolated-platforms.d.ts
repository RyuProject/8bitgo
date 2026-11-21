export type InlineIsolatedPlatformId = 'psp' | 'symbian'

export declare const INLINE_ISOLATED_PLATFORMS: readonly InlineIsolatedPlatformId[]

export function isInlineIsolatedPlatform(id: string | null | undefined): id is InlineIsolatedPlatformId
