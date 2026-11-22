import { decodeNesScore, type NesScoreEncoding, type NesScoreProfile } from './nesScore'

export interface NesRamTraceAnalysisLabel {
  score: string
  sampleIndex: number
}

export interface NesRamTraceAnalysisSample {
  ramHex: string
}

export interface NesRamTraceCandidate {
  byteOffsets: number[]
  encoding: NesScoreEncoding
  matchedLabels: number
  totalLabels: number
  matchMode: 'display-exact' | 'numeric-equivalent' | 'partial'
  decodedScores: Array<string | null>
  rawBytesByLabel: string[]
}

export interface NesRamTraceAnalysis {
  status: 'scanned' | 'insufficient-labels' | 'invalid-labels'
  distinctScores: number
  labelsUsed: number
  exactCandidateCount: number
  exactCandidatesTruncated: boolean
  candidates: NesRamTraceCandidate[]
}

const TRACE_SHA256 = '0'.repeat(64)
const MAX_REPORTED_CANDIDATES = 24

function parseRamHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[\da-f]*$/i.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function numericScore(value: string): string | null {
  const digits = value.trim().replace(/[\s,._]/g, '')
  if (!/^\d+$/.test(digits)) return null
  try {
    return BigInt(digits).toString(10)
  } catch {
    return null
  }
}

function rawBytesFor(ram: Uint8Array, offsets: readonly number[]): string {
  return offsets.map((offset) => ram[offset].toString(16).padStart(2, '0')).join(' ')
}

function makeProfile(byteOffsets: number[], encoding: NesScoreEncoding): NesScoreProfile {
  return {
    gameSlug: 'trace-analysis',
    romSha256: TRACE_SHA256,
    version: 'temporary trace candidate',
    byteOffsets,
    encoding,
  }
}

/**
 * 只用玩家明确标记的分数做候选预筛；原始 RAM 时间序列仍须由分析者检查，不能把命中当成证明。
 * 搜索连续字节窗口，覆盖本站支持的解码方式，并按完整命中优先输出最多 24 项。
 */
export function analyzeNesRamTrace(
  labels: readonly NesRamTraceAnalysisLabel[],
  samples: readonly NesRamTraceAnalysisSample[],
): NesRamTraceAnalysis {
  const validLabels = labels.flatMap((label) => {
    if (!Number.isInteger(label.sampleIndex) || label.sampleIndex < 0 || label.sampleIndex >= samples.length) return []
    const score = numericScore(label.score)
    const ram = parseRamHex(samples[label.sampleIndex].ramHex)
    if (score === null || !ram?.length) return []
    return [{ score, ram }]
  })
  const distinctScores = new Set(validLabels.map((label) => label.score)).size
  if (validLabels.length !== labels.length || validLabels.length < 2) {
    return { status: 'invalid-labels', distinctScores, labelsUsed: validLabels.length, exactCandidateCount: 0, exactCandidatesTruncated: false, candidates: [] }
  }
  if (distinctScores < 2) {
    return { status: 'insufficient-labels', distinctScores, labelsUsed: validLabels.length, exactCandidateCount: 0, exactCandidatesTruncated: false, candidates: [] }
  }

  const ramLength = validLabels[0].ram.length
  if (validLabels.some((label) => label.ram.length !== ramLength)) {
    return { status: 'invalid-labels', distinctScores, labelsUsed: validLabels.length, exactCandidateCount: 0, exactCandidatesTruncated: false, candidates: [] }
  }

  const scored: NesRamTraceCandidate[] = []
  const evaluate = (byteOffsets: number[], encoding: NesScoreEncoding) => {
    const profile = makeProfile(byteOffsets, encoding)
    const decodedScores = validLabels.map(({ ram }) => decodeNesScore(ram, profile))
    const matchModes = decodedScores.map((decoded, index) => {
      if (decoded === null) return 'partial'
      const expected = labels[index].score.trim()
      if (decoded === expected) return 'display-exact'
      return numericScore(decoded) === validLabels[index].score ? 'numeric-equivalent' : 'partial'
    })
    const matchedLabels = matchModes.filter((mode) => mode !== 'partial').length
    if (!matchedLabels) return
    const hasPartial = matchModes.some((mode) => mode === 'partial')
    const matchMode = hasPartial
      ? 'partial'
      : matchModes.every((mode) => mode === 'display-exact')
        ? 'display-exact'
        : 'numeric-equivalent'
    scored.push({
      byteOffsets,
      encoding,
      matchedLabels,
      totalLabels: validLabels.length,
      matchMode,
      decodedScores,
      rawBytesByLabel: validLabels.map(({ ram }) => rawBytesFor(ram, byteOffsets)),
    })
  }

  const maxRamBytes = Math.min(ramLength, 8)
  for (let start = 0; start < ramLength; start += 1) {
    for (let width = 1; width <= maxRamBytes && start + width <= ramLength; width += 1) {
      const byteOffsets = Array.from({ length: width }, (_, index) => start + index)
      for (const byteOrder of ['little', 'big'] as const) {
        evaluate(byteOffsets, { kind: 'binary', byteOrder })
        for (const nibbleOrder of ['high-first', 'low-first'] as const) {
          evaluate(byteOffsets, { kind: 'packed-bcd', byteOrder, nibbleOrder })
        }
        evaluate(byteOffsets, { kind: 'decimal-digits', byteOrder })
      }
      evaluate(byteOffsets, { kind: 'ascii-decimal' })
    }
  }

  scored.sort((a, b) => {
    const exactA = a.matchedLabels === a.totalLabels ? 1 : 0
    const exactB = b.matchedLabels === b.totalLabels ? 1 : 0
    const displayExactA = a.matchMode === 'display-exact' ? 1 : 0
    const displayExactB = b.matchMode === 'display-exact' ? 1 : 0
    return exactB - exactA || displayExactB - displayExactA || b.matchedLabels - a.matchedLabels || a.byteOffsets.length - b.byteOffsets.length || a.byteOffsets[0] - b.byteOffsets[0]
  })
  const exactCandidateCount = scored.filter((candidate) => candidate.matchedLabels === candidate.totalLabels).length
  return {
    status: 'scanned',
    distinctScores,
    labelsUsed: validLabels.length,
    exactCandidateCount,
    exactCandidatesTruncated: exactCandidateCount > MAX_REPORTED_CANDIDATES,
    candidates: scored.slice(0, MAX_REPORTED_CANDIDATES),
  }
}
