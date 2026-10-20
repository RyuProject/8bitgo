/**
 * NDS 音频缓冲（毫秒）。
 *
 * EmulatorJS 把 RetroArch 的 `audio_latency` 写死为 64ms，而当前自托管的 melonDS 是
 * 单线程软件渲染：主线程只要被一帧较重的 3D、React / 聊天 UI 或浏览器 GC 卡过 64ms，
 * RWebAudio 的排期队列就会见底，后续音块断开，听感就是用户说的「一卡一卡」。
 *
 * 《宝可梦：白 2》这类 3D / 大卡带游戏在单线程软件渲染时，96ms 的窗口仍可能被
 * 解码、画面上传或浏览器 GC 的短任务抽干。普通 NDS 用 128ms，节奏游戏保留 96ms：
 * 它们更在意按键到声音的延迟，且目前没有同样的重场景证据。
 * 若机器连模拟本身都维持不了实时速度，增大缓冲不能凭空补算力。
 */
export const NDS_AUDIO_LATENCY_MS = 128
export const NDS_RHYTHM_AUDIO_LATENCY_MS = 96

const RHYTHM_GAMES = new Set([
  'rhythm-heaven',
  'rhythm-heaven-gold',
  'rhythm-tengoku-gold',
])

/** 只给明确的节奏游戏保留低延迟；存档档位后缀不应改变同一款游戏的音频配置。 */
export function ndsAudioLatencyMs(gameSlug?: string): number {
  // 播放器会给多语言即时存档加 ~nds- 后缀，音频策略仍应按原游戏而不是档位名判断。
  const slug = gameSlug?.split(':', 1)[0]?.split('~nds-', 1)[0]?.toLowerCase() ?? ''
  return RHYTHM_GAMES.has(slug) ? NDS_RHYTHM_AUDIO_LATENCY_MS : NDS_AUDIO_LATENCY_MS
}

/** 48kHz、双声道、Float32 下核心日志应该打印的缓冲字节数，便于现场核对。 */
export const NDS_AUDIO_BUFFER_BYTES_48K = NDS_AUDIO_LATENCY_MS / 1000 * 48_000 * 2 * 4
