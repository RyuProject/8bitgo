/**
 * 街机核心的能力边界。
 *
 * 「都是街机核心」不等于「功能可以混用」：RomData 是 FBNeo 自己的扩展，
 * mame2003 / mame2003_plus 虽然也能跑街机，却不会读取同目录的 FBNeo `.dat`。
 * 以前把三者放进同一个“FBNeo 系”集合，后台一旦给 MAME 游戏填了 RomData，
 * 页面会看似完成注入、核心却仍然报 Romset is unknown，排查方向完全错误。
 */

/** 当前发布的核心里，只有 fbneo 的 wasm 确实包含 RomData / ZipName / DrvName 实现。 */
export function supportsFbneoRomData(core: string | undefined): boolean {
  return core === 'fbneo'
}

/**
 * 有 RomData 就必须交给 FBNeo。
 *
 * 这不是性能偏好，而是格式约束：把 `.dat` 交给 MAME 只会被忽略。自动纠正比让一款
 * 已经有完整加载方案的改版游戏因为后台核心选错而必定开局失败更安全。
 */
export function arcadeCoreForRomData(core: string, romData: string | undefined): string {
  return romData?.trim() ? 'fbneo' : core
}
