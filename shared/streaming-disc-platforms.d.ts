export type StreamingDiscPlatformId = 'ps2' | 'gamecube' | 'wii'

export const STREAMING_DISC_PLATFORM_IDS: readonly StreamingDiscPlatformId[]

export function isStreamingDiscPlatform(id: string | undefined): id is StreamingDiscPlatformId
