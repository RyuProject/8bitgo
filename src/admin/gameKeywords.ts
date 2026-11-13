const STOP_WORDS_BY_LANGUAGE: Record<string, Set<string>> = {
  en: new Set(`
    a an the and or but if so because as of at by for from in into on onto to with without through across over under between
    is are was were be been being have has had do does did can could may might must shall should will would
    this that these those it its they them their he she we you your our i who which what when where while than then
    also very more most some any all each other another such both either neither not no nor only own same too just
    about after before during until classic version series sequel title release released experience journey story world
    worlds level levels stage stages game games player players play playing
  `.trim().split(/\s+/)),
  es: new Set(`
    a al algo algunas algunos ante antes como con contra cual cuando de del desde donde el ella ellas ellos en entre era es esa ese eso
    esta este esto estos fue ha hacia hasta la las le les lo los más menos mi mis muy no nos o otra para pero por que se sin sobre su sus
    también te tiene un una uno unos y ya juego juegos jugador jugadores jugar jugando clásico clásicos versión serie mundo mundos
  `.trim().split(/\s+/)),
  fr: new Set(`
    a au aux avec ce ces cette comme dans de des du elle elles en entre est et eux il ils je la le les leur lui ma mais me même mes moi
    mon ne nos notre nous on ou par pas pour que qui sa sans se ses son sur ta te tes toi ton tu un une vos votre vous après avant
    jeu jeux joueur joueurs jouer classique version série monde mondes
  `.trim().split(/\s+/)),
  it: new Set(`
    a al alla alle anche che chi ci con da dal dalla dalle dei del della delle di dove e ed era essere fa fra gli ha hai hanno il in
    io la le lei lo loro lui ma mi ne nei nel nella no noi o per più quale quando questo se si sono su sul sulla tra tu un una uno
    gioco giochi giocatore giocatori giocare classico versione serie mondo mondi
  `.trim().split(/\s+/)),
  de: new Set(`
    aber als am an auch auf aus bei bin bis bist da das dass dein deine dem den der des die dies diese doch dort du durch ein eine einem
    einen einer eines er es für ganz hat haben hier ich ihr ihre im in ist ja kein keine mit nach nicht noch nun oder sein seine sich sie
    sind so über um und uns unser unter vom von vor war waren was was wenn wer wie wir zu zum zur zwischen
    spiel spiele spieler spielen klassisch version serie welt welten
  `.trim().split(/\s+/)),
  ja: new Set(`
    あそこ あなた あの ある いる うち および から これ ここ こと さ する そして その それ ため だ だっ です では でも と どこ ない ながら
    など なに に は へ ほか また まで も もの より れる を ん し て いる
    ゲーム プレイヤー プレイ シリーズ 作品 本作 世界 物語 体験 対応 バージョン
  `.trim().split(/\s+/)),
  zh: new Set(`
    的 了 和 是 在 与 及 等 也 可以 通过 进行 体验 成为 这个 这些 那些 该作 本作 游戏 游戏中 玩家 游玩 玩耍
    经典 版本 系列 世界 故事 内容 作品 角色 一款 一个 一种 这个 以及 并且 同时 其中 还有 后来 开始
    驾驶 操控 穿越 击败 展开 进入 使用 探索 带来 让你 让玩家
  `.trim().split(/\s+/)),
  ko: new Set(`
    그리고 그러나 그래서 또한 이것은 그것은 이 이가 을 를 에 에서 와 과 도 으로 로 하는 있다 없다 한다 된다
    게임 플레이어 플레이 시리즈 작품 세계 이야기 버전 클래식
  `.trim().split(/\s+/)),
}

const SHORT_KEYWORDS = new Set(['2d', '3d', 'fps', 'rpg', 'jrpg', 'mmorpg', 'vr', 'gba', 'nes', 'ps1', 'ps2'])
// 直接列码位范围，避免 legacy 构建的 Unicode 属性表拒绝 Script=Han，导致整站生产构建失败。
const CJK_SCRIPT = /[\u1100-\u11FF\u2E80-\u2FFF\u3005\u3007\u3021-\u3029\u3038-\u303B\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF65-\uFF9F\u{20000}-\u{323AF}]/u
const CJK_RUN = /^[\u1100-\u11FF\u2E80-\u2FFF\u3005\u3007\u3021-\u3029\u3038-\u303B\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF65-\uFF9F\u{20000}-\u{323AF}]+$/u

type KeywordDescriptions = Readonly<Record<string, string | undefined>>

type RankedKeyword = {
  value: string
  score: number
  firstSeen: number
}

function normalizeLanguage(language: string): { locale: string; base: string } {
  const normalized = language.trim().replace(/_/g, '-') || 'en'
  const parts = normalized.split('-')
  return { locale: normalized, base: parts[0].toLowerCase() }
}

function usefulToken(raw: string, stopWords: Set<string>): string | null {
  const token = raw.normalize('NFKC').toLocaleLowerCase().replace(/^[-'.]+|[-'.]+$/g, '')
  if (!token || stopWords.has(token) || /^\d+$/.test(token)) return null
  const eastAsian = CJK_SCRIPT.test(token)
  const length = [...token].length
  if (length < (eastAsian ? 2 : 3) && !SHORT_KEYWORDS.has(token)) return null
  if (token.length > 60) return null
  return token
}

function fallbackTokens(text: string): string[] {
  const parts = text.match(/[\u1100-\u11FF\u2E80-\u2FFF\u3005\u3007\u3021-\u3029\u3038-\u303B\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF65-\uFF9F\u{20000}-\u{323AF}]+|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? []
  return parts.flatMap((part) => {
    if (!CJK_RUN.test(part)) return [part]
    // 没有 Intl.Segmenter 的旧浏览器按二/三字片段退化，宁可少给几个候选也不把整句当关键词。
    const points = [...part]
    const ngrams: string[] = []
    for (let size = 2; size <= Math.min(3, points.length); size += 1) {
      for (let i = 0; i + size <= points.length; i += 1) ngrams.push(points.slice(i, i + size).join(''))
    }
    return ngrams
  })
}

function tokenize(text: string, locale: string): string[] {
  const clean = text
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[`*_#~|]/gu, ' ')
  try {
    if (typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
      return [...segmenter.segment(clean)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment)
    }
  } catch {
    // 非常旧的引擎或不受支持的自定义语言码走 Unicode 分词回退。
  }
  return fallbackTokens(clean)
}

function rankDescription(text: string, language: string, limit: number, includePhrases: boolean): RankedKeyword[] {
  const { locale, base } = normalizeLanguage(language)
  const stopWords = STOP_WORDS_BY_LANGUAGE[locale.toLowerCase()] ?? STOP_WORDS_BY_LANGUAGE[base] ?? STOP_WORDS_BY_LANGUAGE.en
  // 保留停用词所在的位置：若先过滤，"战机 穿越 宇宙" 会被错误拼成“战机宇宙”，
  // 英文也会把不相邻的词拼成看似真实的搜索词。短语只从原文中真正相邻的有效词生成。
  const tokens = tokenize(text, locale).map((token) => usefulToken(token, stopWords))
  const counts = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let position = 0
  const add = (keyword: string, weight = 1) => {
    counts.set(keyword, (counts.get(keyword) ?? 0) + weight)
    if (!firstSeen.has(keyword)) firstSeen.set(keyword, position)
    position += 1
  }

  tokens.forEach((token) => {
    if (token) add(token)
  })
  if (includePhrases) {
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const left = tokens[i]
      const right = tokens[i + 1]
      if (!left || !right) continue
      if (CJK_SCRIPT.test(left) !== CJK_SCRIPT.test(right)) continue
      const phrase = CJK_SCRIPT.test(left) ? `${left}${right}` : `${left} ${right}`
      // 单次出现的词组权重低于主题词，重复出现的词组则能自然进入前列。
      if ([...phrase].length <= 48) add(phrase, 0.75)
    }
  }

  return [...counts.keys()]
    .sort((a, b) => (counts.get(b)! - counts.get(a)!) || (firstSeen.get(a)! - firstSeen.get(b)!) || a.localeCompare(b))
    .slice(0, limit)
    .map((value) => ({ value, score: counts.get(value)!, firstSeen: firstSeen.get(value)! }))
}

/**
 * 保留旧的英文提取入口，供历史工具与测试使用；后台表单改用下面的多语言版本。
 */
export function extractGameKeywords(description: string, limit = 8): string[] {
  const normalizedLimit = Math.max(0, Math.min(20, Math.floor(limit)))
  if (!normalizedLimit) return []
  return rankDescription(description, 'en', normalizedLimit, false).map(({ value }) => value)
}

/**
 * 从实际存在的各语言简介提取可读关键词与短语。每种语言独立计分并轮流取词，
 * 避免英文文案更长或重复更多时把中文、日文等词全部挤掉；结果仍是后台现有的共享标签。
 */
export function extractGameKeywordsFromDescriptions(descriptions: KeywordDescriptions, limit = 24): string[] {
  const normalizedLimit = Math.max(0, Math.min(32, Math.floor(limit)))
  if (!normalizedLimit) return []

  const entries = Object.entries(descriptions ?? {})
    .map(([language, text]) => ({ language, text: String(text ?? '').trim() }))
    .filter(({ text }) => Boolean(text))
    .sort((a, b) => {
      const priority = (language: string) => language === 'zh-Hans' ? 0 : language === 'en' ? 1 : 2
      return priority(a.language) - priority(b.language) || a.language.localeCompare(b.language)
    })
  if (!entries.length) return []

  const perLanguageLimit = Math.min(4, normalizedLimit)
  const candidates = entries.map(({ language, text }) => rankDescription(text, language, perLanguageLimit, true))
  const output: string[] = []
  const seen = new Set<string>()
  for (let rank = 0; output.length < normalizedLimit; rank += 1) {
    let foundAtRank = false
    for (const languageCandidates of candidates) {
      const candidate = languageCandidates[rank]?.value
      if (!candidate) continue
      foundAtRank = true
      const key = candidate.normalize('NFKC').toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      output.push(candidate)
      if (output.length >= normalizedLimit) break
    }
    if (!foundAtRank) break
  }
  return output
}
