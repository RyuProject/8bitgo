/**
 * 「后台那一栏 DIP 开关」 → 「这个核心上到底该改哪一项、改成什么」，决策单独一处、纯函数。
 *
 * ## 为什么要有这一层
 *
 * 街机麻将类游戏在实机上是靠主板上那组拨码开关（DIP）决定**这一局按摇杆还是按麻将面板收键**
 * 的：核心/出厂的默认档是摇杆，于是麻将游戏进去以后方向键、碰吃杠全对不上 ——
 * 而屏幕上不会报任何错，玩家只会觉得「这游戏是坏的」。要拨的就是那一档。
 *
 * ## DIP 在引擎里的样子
 *
 * FBNeo 系核心把**每一项 DIP 都做成了一个核心选项**，键名形如
 * `fbneo-dipswitch-<驱动名>-<DIP 名>`：驱动名是 `BurnDrvGetTextA(DRV_NAME)`（= romset 名），
 * DIP 名里的空格 / `=` / `:` / `#` 统一换成下划线（见 libretro/FBNeo 的 libretro.cpp，
 * `create_variables_from_dipswitches`）。取值就是 DIP 上印的那些字（`Joystick` / `Mahjong`、
 * `Off` / `On` …），核心把这些选项注册在 `retro_load_game` 里，也就是**开局之后一定读得到**。
 *
 * ⚠️ 键名里带驱动名、DIP 组名又由每个驱动自己定，所以**没有任何办法在后台预先写死一份表**。
 * 这里只做两件事：
 *
 *   1. 后台写 `mahjong`（或 `麻将`）时，**从核心当场报上来的选项表里认**出「摇杆 / 麻将」那一项。
 *      判据是同一个选项的取值里**同时**有摇杆类词和麻将类词 —— 只认「Mahjong」会认错：
 *      有的游戏另有一项叫 `Tiles: Mahjong`（牌面图案换成麻将牌，和输入设备无关），
 *      那是另一个东西，拨错了玩家只会更糊涂。
 *   2. 后台写 `组名=值`（可以写好几条，逗号 / 分号 / 换行分隔）时按组名认，
 *      也接受写全的键（含 `dipswitch` 字样就当成完整键用）。
 *
 * ## 取值为什么一律回填核心报的原文
 *
 * 和 dualScreen.ts 里触控模式那条同一个道理：`changeSettingOption` 碰上认不出的取值是
 * **静默**的（往 allSettings 里塞一格，不报错也不生效）。所以取值只在核心报上来的那些
 * 字符串里挑：先原样、再忽略大小写、最后唯一前缀 —— 都挑不到就什么都不做，只留一条
 * 点名「有哪些档」的日志。**绝不猜**：猜错的那一档在这里是「玩家按什么都没反应」，
 * 比不做更糟。
 *
 * ## 只有 FBNeo 系核心有这条路
 *
 * mame2003 / mame2003_plus 没把 DIP 做成核心选项（那一路在核心内部处理），所以后台填了也
 * 不会生效。那时核心报出来的选项里一个 `dipswitch` 键都没有 —— 这里会返回一条点名这件事的
 * warning，而不是安静地什么都没干（「填了没反应」正是最难查的那种）。
 *
 * 回归：`npm run test:arcade-dip`。
 */
import { flatValues, type CoreOption } from './dualScreen'

/**
 * 哪些 key 是 DIP 开关。
 *
 * 三种写法都认：FBNeo 的 `fbneo-dipswitch-kov-Controls`、以及 mame 系的
 * `mame2003-plus_dip_switch_…` 那一类（现在还没有，但认出来不会有坏处 ——
 * 认出来之后下面的匹配规则仍然要过一遍取值）。
 */
const DIP_KEY = /dip[\s_-]?switch/i

/** 取值里出现这些词 = 麻将那一档 / 摇杆那一档 */
const MAHJONG_VALUE = /mahjong|麻将|麻雀/i
const JOYSTICK_VALUE = /joystick|joypad|摇杆/i

/** 后台那一栏写这个就是「自动找摇杆/麻将那一项并拨到麻将」 */
const MAHJONG_PRESET = /^(mahjong|麻将)$/i

/** 一条 `组名=值` 的长度上限。挡住手滑贴进来一整段东西 */
const MAX_PART = 32
/** 最多认几条。多到没意义，还容易把警告日志撑大 */
const MAX_INTENTS = 4

/** 核心自报的一项 DIP 开关 */
export interface DipOption {
  key: string
  /** 核心报的取值原文（挑值只在里面挑） */
  values: string[]
  /** 核心报的当前值（没报就是空） */
  current: string
  /** 核心报的出厂默认（没报就是空） */
  fallback: string
}

/** 要应用的一次改动 */
export interface DipChange {
  key: string
  /** 取值原文，直接可以交给 changeSettingOption */
  value: string
  /** 一句给日志看的说明（含组名和人话） */
  why: string
}

export interface DipPlan {
  changes: DipChange[]
  /** 要写进控制台的一句话（没有就是 null）。**不是给玩家看的**，见下面的措辞 */
  warning: string | null
}

/** 后台那一栏解析出来的一条意图 */
export interface DipIntent {
  kind: 'mahjong' | 'explicit'
  /** explicit 才有：组名（或完整键） */
  name: string
  /** explicit 才有：取值 */
  value: string
}

/**
 * 核心报的选项表里，哪些是 DIP 开关。
 *
 * 取值少于两个的直接跳过：只有一个档的拨码开关没有意义，引擎自己的设置菜单也是这么判的
 * （`values.length <= 1` 不画那一行）。
 */
export function findDipOptions(options: unknown): DipOption[] {
  const list = Array.isArray(options)
    ? options
    : Array.isArray((options as { options?: unknown } | null)?.options)
      ? ((options as { options: unknown[] }).options)
      : null
  if (!list) return []
  const out: DipOption[] = []
  for (const raw of list) {
    const opt = (raw ?? {}) as CoreOption
    const key = typeof opt.key === 'string' ? opt.key : ''
    if (!key || !DIP_KEY.test(key)) continue
    const values = flatValues(opt.values)
    if (values.length < 2) continue
    out.push({
      key,
      values,
      current: typeof opt.current === 'string' ? opt.current : '',
      fallback: typeof opt.default === 'string' ? opt.default : '',
    })
  }
  return out
}

/** 键名最后一段（`fbneo-dipswitch-kov-Controls` → `Controls`），后台那一栏写的就是它 */
export function dipNameOf(key: string): string {
  const i = key.lastIndexOf('-')
  return i >= 0 ? key.slice(i + 1) : key
}

/** 组名归一化：空格→下划线、忽略大小写（和核心把 DIP 名洗成键名的规则对齐） */
const normName = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_')

/** 后台那一栏写的东西 → 一组意图。解析不了的整条丢掉，但**留一条 warning 指出来** */
export function parseArcadeDip(raw: string | undefined): { intents: DipIntent[]; warning: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { intents: [], warning: null }

  const intents: DipIntent[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  for (const token of text.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean)) {
    if (intents.length >= MAX_INTENTS) {
      bad.push(token)
      continue
    }
    if (MAHJONG_PRESET.test(token)) {
      if (seen.has('mahjong')) continue
      seen.add('mahjong')
      intents.push({ kind: 'mahjong', name: '', value: '' })
      continue
    }
    const eq = token.indexOf('=')
    if (eq <= 0) {
      bad.push(token)
      continue
    }
    const name = token.slice(0, eq).trim()
    const value = token.slice(eq + 1).trim()
    if (!name || !value || name.length > MAX_PART || value.length > MAX_PART) {
      bad.push(token)
      continue
    }
    const id = `${normName(name)}=${value.toLowerCase()}`
    if (seen.has(id)) continue
    seen.add(id)
    intents.push({ kind: 'explicit', name, value })
  }

  const warning = bad.length
    ? `DIP 开关里这几条看不懂、已跳过：${bad.join('、')}。` +
      `只能写 mahjong（自动找摇杆/麻将那一项），或者「组名=值」（例如 Controls=Mahjong），多条用逗号分隔。`
    : null
  return { intents, warning }
}

/** 在核心报的取值里找后台写的那个。挑不到返回空串（**不猜**） */
export function matchDipValue(values: readonly string[], want: string): string {
  const raw = String(want || '').trim()
  if (!raw) return ''
  const exact = values.find((v) => v === raw)
  if (exact) return exact
  const ci = values.find((v) => v.trim().toLowerCase() === raw.toLowerCase())
  if (ci) return ci
  // 唯一前缀才认：`Mahjong` 命中 `Mahjong panel` 是可以的，
  // 命中两项就说明我们不知道他要哪一档，宁可不动
  const partial = values.filter((v) => v.trim().toLowerCase().startsWith(raw.toLowerCase()))
  return partial.length === 1 ? partial[0] : ''
}

/** 把核心报出来的 DIP 摊成一句人话，给「认不出来」的警告用 */
function describeDipOptions(found: readonly DipOption[]): string {
  if (!found.length) return '（这个核心一个 DIP 都没报出来）'
  return found.map((o) => `${dipNameOf(o.key)} = ${o.values.join(' | ')}`).join('；')
}

/** 「摇杆 / 麻将」那一项：取值里同时有摇杆类词和麻将类词 */
function findMahjongOption(found: readonly DipOption[]): { opt: DipOption; value: string } | null {
  for (const opt of found) {
    const mj = opt.values.find((v) => MAHJONG_VALUE.test(v))
    if (!mj) continue
    if (!opt.values.some((v) => JOYSTICK_VALUE.test(v))) continue
    return { opt, value: mj }
  }
  return null
}

/**
 * 后台那一栏 + 核心报的选项表 → 要应用哪几处改动。
 *
 * 认不出来的情况一律在 `warning` 里说明白，并把核心报出来的 DIP 列出来 ——
 * 管理员照着那句就能把后台那一栏改对，不用去翻核心源码。
 */
export function planDipChanges(raw: string | undefined, options: unknown): DipPlan {
  const { intents, warning } = parseArcadeDip(raw)
  if (!intents.length) return { changes: [], warning }

  const found = findDipOptions(options)
  if (!found.length) {
    return {
      changes: [],
      warning:
        '这款游戏跑的核心没报出任何 DIP 选项（只有 FBNeo 系核心把 DIP 做成了核心选项），' +
        `后台配的 DIP「${String(raw ?? '').trim()}」不会生效。` +
        '要拨麻将模式的游戏得用 fbneo / fbalpha2012 这类核心。',
    }
  }

  const changes: DipChange[] = []
  const problems: string[] = []

  for (const intent of intents) {
    if (intent.kind === 'mahjong') {
      const hit = findMahjongOption(found)
      if (!hit) {
        problems.push(
          `没找到「摇杆 / 麻将」那一项（取值里要同时有摇杆和麻将两档），麻将模式没生效。` +
            `核心报出来的 DIP 是：${describeDipOptions(found)}。` +
            '可以在后台那一栏写明「组名=值」，例如 Controls=Mahjong',
        )
        continue
      }
      changes.push({
        key: hit.opt.key,
        value: hit.value,
        why: `麻将模式（${dipNameOf(hit.opt.key)} = ${hit.value}；核心默认 ${hit.opt.current || hit.opt.fallback || '未知'}）`,
      })
      continue
    }

    const want = normName(intent.name)
    // 写全的键优先（含 dipswitch 字样就说明他要指定完整键），否则按最后一段组名认
    const byFullKey = DIP_KEY.test(intent.name)
      ? found.find((o) => o.key.toLowerCase() === intent.name.toLowerCase())
      : undefined
    const opt = byFullKey ?? found.find((o) => normName(dipNameOf(o.key)) === want)
    if (!opt) {
      problems.push(
        `后台写的 DIP「${intent.name}」在这一局的核心里不存在。` +
          `核心报出来的 DIP 是：${describeDipOptions(found)}`,
      )
      continue
    }
    const value = matchDipValue(opt.values, intent.value)
    if (!value) {
      problems.push(
        `DIP「${dipNameOf(opt.key)}」没有「${intent.value}」这一档，只有：${opt.values.join(' | ')}`,
      )
      continue
    }
    changes.push({ key: opt.key, value, why: `${dipNameOf(opt.key)} = ${value}` })
  }

  return {
    changes,
    warning: problems.length ? problems.join(' ／ ') : warning,
  }
}
