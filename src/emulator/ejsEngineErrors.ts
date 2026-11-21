/**
 * EmulatorJS 引擎报错原文的归一化与归因（纯函数，`npm run test:ejs-failure-reasons` 覆盖）。
 *
 * 为什么单独一个文件：适配器里的 FATAL / CONTENT 表全是英文整句，而引擎界面按 EJS_language 本地化 ——
 * `.ejs_error_text` 里拿到的是「启动游戏失败」「ゲームの開始に失敗しました」。同一个根因在英文界面算
 * 内容错误（可换 ROM），在中文界面却掉进 'runtime'，两种玩家拿到的恢复策略不一样（2026-11-14 大陆
 * 《拳皇 97》诊断包 #2591：「引擎报错：启动游戏失败」）。先把这些已知译文换回英文原句再判。
 */

/**
 * 引擎 localization/*.json 里会出现在 `.ejs_error_text` 的几句（只收我们分类会用到的）。
 * 译文取自 public/emulatorjs/localization/ 当前版本；引擎升级改了译文，最坏也只是退回旧行为（按 runtime）。
 */
const LOCALIZED_ENGINE_PHRASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Failed to start game', [
    '启动游戏失败',
    'ゲームの開始に失敗しました',
    'Error al iniciar el juego',
    'Échec au démarrage du jeu',
    'Das Spiel konnte nicht gestartet werden',
    'Avvio del gioco fallito',
  ]],
  ['Outdated graphics driver', ['显卡驱动已过时', 'Controlador de gráficos obsoleto', 'Pilote graphique obsolète']],
  ['Network Error', ['网络错误']],
]

/** 把已知的本地化引擎报错换回英文原句；不认识的原样返回。只用于分类，展示给玩家的仍是原文。 */
export function normalizeEngineText(text: string): string {
  let out = text
  for (const [english, variants] of LOCALIZED_ENGINE_PHRASES) {
    for (const variant of variants) {
      if (out.includes(variant)) out = out.split(variant).join(english)
    }
  }
  return out
}

export interface CoreDownloadFailureCause {
  /** 下载器自己给的失败原因（`Download failed: …` 后面那段），截短后附在玩家看到的报错里，诊断包摘要也能留住 */
  detail: string
  /**
   * 核心包体**已经在流**、随后 20 秒没有新字节（下载器的失速中止），之后 XHR 兜底也没救回来。
   * 这说明线路通、只是慢 / 断续：大陆访客此时退回同源（Cloudflare 洛杉矶）实测只有几 KB/s，
   * 而续传助手已把收到的整 MiB 分片存进 IndexedDB，留在原线路重试能接着下。
   */
  bodyStalled: boolean
  /** 服务器给了 HTTP 错误状态（或 XHR 兜底拿到截断 / 错误页）：这条线路本身有问题，可以换线路 */
  httpError: boolean
}

/**
 * 「Error downloading core (xxx-wasm.data)」只说失败了，不说为什么。真正的原因在它前面几行：
 *   - `[EJS Download] 20 秒没有新数据，中止：…`（包体失速，patch-emulatorjs 第十节）
 *   - `Download failed in onComplete: Download failed: Error: XHR fallback stalled after AbortError…`
 *   - `Download failed in onComplete: Download failed: Error: HTTP 502`
 * lines 是错误探针最近的若干行（含 `[warn]` / `[error]` 前缀）。
 */
export function coreDownloadFailureCause(lines: readonly string[]): CoreDownloadFailureCause {
  // 只看最后一次核心下载的那一段：上一局 / 上一次失败留下的行不能串进来
  let from = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\[EJS Core\] Downloading core:/i.test(lines[i])) {
      from = i
      break
    }
  }
  const recent = lines.slice(from)
  const failedLine = [...recent].reverse().find((line) => /Download failed in onComplete:/i.test(line)) ?? ''
  const detail = failedLine
    .replace(/^.*?Download failed in onComplete:\s*/i, '')
    .replace(/^Download failed:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  const bodyStalled = recent.some((line) => /20 秒没有新数据/.test(line) && !/XHR 20 秒/.test(line)) ||
    /XHR fallback (?:stalled|network error) after AbortError/i.test(detail)
  const httpError = /\bHTTP [45]\d\d\b/.test(detail) || /XHR fallback (?:incomplete|invalid partial) response/i.test(detail) ||
    /Core range recovery failed/i.test(detail)
  return { detail, bodyStalled: bodyStalled && !httpError, httpError }
}
