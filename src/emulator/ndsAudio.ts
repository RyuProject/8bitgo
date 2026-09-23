/**
 * NDS 音频缓冲（毫秒）。
 *
 * EmulatorJS 把 RetroArch 的 `audio_latency` 写死为 64ms，而当前自托管的 melonDS 是
 * 单线程软件渲染：主线程只要被一帧较重的 3D、React / 聊天 UI 或浏览器 GC 卡过 64ms，
 * RWebAudio 的排期队列就会见底，后续音块断开，听感就是用户说的「一卡一卡」。
 *
 * 这里取 96 而不是 MAME 的 128：NDS 约 60fps，96ms 已接近六帧的抗抖窗口；
 * 《节奏天国》又对输入到声音的延迟非常敏感，只增加 32ms 是稳定性和节拍手感之间的折中。
 * 若机器连模拟本身都维持不了实时速度，增大缓冲不能凭空补算力——那是换新核心才解决得了的。
 */
export const NDS_AUDIO_LATENCY_MS = 96

/** 48kHz、双声道、Float32 下核心日志应该打印的缓冲字节数，便于现场核对。 */
export const NDS_AUDIO_BUFFER_BYTES_48K = NDS_AUDIO_LATENCY_MS / 1000 * 48_000 * 2 * 4
