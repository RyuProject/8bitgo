/** ROM 证据足够强时才给街机选核心；不完整、歧义或未知包必须留给默认值/管理员判断。 */
export type ArcadeCoreId = 'fbneo' | 'mame-current'

export interface ArcadeCoreRecommendation {
  core: ArcadeCoreId
  confidence: 'exact-board-signature' | 'complete-romset' | 'fbneo-romdata'
  reason: string
}

/**
 * 让识别策略保持纯函数，避免上传表单、播放器和回归测试各自复制一套猜测规则。
 * MAME 专属硬件的精确指纹优先；完整 FBNeo set 或可由 RomData 明确加载的改版包才选 FBNeo。
 */
export function detectArcadeCore(evidence: {
  exactMameBoard?: boolean
  indexedFbneoSet?: boolean
  supportedFbneoRomData?: boolean
}): ArcadeCoreRecommendation | null {
  if (evidence.exactMameBoard) {
    return {
      core: 'mame-current',
      confidence: 'exact-board-signature',
      reason: 'ROM CRC 精确命中 MAME 专属街机板卡指纹',
    }
  }
  if (evidence.supportedFbneoRomData) {
    return {
      core: 'fbneo',
      confidence: 'fbneo-romdata',
      reason: '该改版包有可用的 FBNeo RomData 加载方案',
    }
  }
  if (evidence.indexedFbneoSet) {
    return {
      core: 'fbneo',
      confidence: 'complete-romset',
      reason: 'ZIP 成员 CRC 完整命中 FBNeo 支持的 romset',
    }
  }
  return null
}
