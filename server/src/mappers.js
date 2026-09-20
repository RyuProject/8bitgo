/**
 * 数据库行 <-> 前端对象 的转换（schema v2）。
 *
 * v2 把类型 / 标签 / ROM 拆成了关联表，所以一行 games 已经凑不出一个完整的 Game，
 * 必须把关联数据一起带上。对外接口刻意保持 v1 的 Game 形状不变 ——
 * 前端组件一行都不用改，变的只是数据怎么取。
 *
 * 关联数据一律**批量**装配（attachRelations）：一次列表查询只多打 3 条
 * WHERE game_id IN (...)，不会退化成每款游戏查三次的 N+1。
 */

import { normalizeDosboxConfigOverride } from '../../shared/dosbox-config.js'
import { normalizeDosStartupCommands } from '../../shared/dos-startup-commands.js'
import { isAdultByBirthDate } from '../../shared/age.js'
import { normalizeGamePlayers } from '../../shared/netplay-players.js'

/**
 * 数据库布尔列的唯一判断方式。
 *
 * mysql2 把 `tinyint(1)` 读成数字 `1`/`0`，所以**不能**用 routes 里那个 `truthy`
 * （只认 `'1'`/`'true'`，那是给 `req.query` 用的）—— 拿它判数据库值会恒为 false。
 * 这个坑真出过事故：`GET /games/:slug/access` 用 truthy 判 `adult`，永远回 false，
 * 前端据此把成人游戏的年龄门整个撤掉了。需要判库里布尔值的地方都从这里导入。
 */
export const dbFlag = (v) => v === 1 || v === true || v === '1'

const bool = dbFlag

/**
 * 把数据库 JSON 列读出来的「翻译缓存对象」规整一下再交给 API：
 *   - mysql2 默认把 JSON 列解成普通 JS 对象，但空 / null / 数组都被 mysql2 默默处理成 undefined，
 *     这三种一律视为「没翻译过」返回 undefined，让调用方当成字段不存在 —— 前端的 i18nData
 *     选择函数会用这种 undefined 来回退到基准文本。
 *   - 顺手过滤掉空字符串 / 全空白，让"被删过"的译文不挂在响应里。
 * - 形状：{ 'zh-Hant': '...', 'es': '...', ... } -> 同形状的去空版本或 undefined。
 */
export function readI18nMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** 入库时统一逗号和空格，否则同一家公司会在开发商统计里被拆成多个名字。 */
function developersText(value) {
  const seen = new Set()
  return String(value ?? '')
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false
      const key = name.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(', ')
}

/** DATE / TIMESTAMP -> 'YYYY-MM-DD'；mysql2 对 DATE 列返回的是 Date 对象 */
export function dateOnly(v) {
  if (!v) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    // 用本地时区取年月日：DATE 列没有时区概念，toISOString() 会按 UTC 偏移，
    // 东八区存的 2026-08-27 会被读成 2026-08-26。
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/** TIMESTAMP -> 带时区的 ISO 8601，避免把无时区字符串交给搜索引擎猜。 */
export function dateTimeIso(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** 通用 ROM 在 game_roms 里用 lang = '*' 表示 */
export const GENERIC_ROM_LANG = '*'

/* ---------------- 游戏 ---------------- */

/**
 * 一行 games + 它的关联数据 -> 前端的 Game 对象。
 * rel 缺省时当作没有类型 / 标签 / ROM，不会抛错。
 */
/**
 * 首页精选位的排序号。
 *
 * 空串 / null / 0 / 负数 / 非数字一律当「不上首页」。
 * 特别是 0：后台输入框清空后某些浏览器会回 0 而不是空串，
 * 当成有效排序号的话这款游戏会莫名其妙钉在首页第一个。
 */
export function homeRankOf(v) {
  if (v == null || v === '') return null
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return null
  // SMALLINT UNSIGNED 上限；填个离谱的数不该让写入直接报错
  return Math.min(n, 65535)
}

/**
 * 模拟器核心名。
 *
 * 不做白名单：核心列表是前端配置（src/config/emulators.ts），后端跟着抄一份迟早会走偏，
 * 而且换引擎版本时新核心会先在前端加上。这里只做形状约束 —— 核心名在 libretro 生态里
 * 一般是小写字母 / 数字 / 下划线，但本项目自构建的「MAME 当前版」id 是 `mame-current`
 * （连字符，对应 public/emulatorjs/cores/mame-current-wasm.data），所以减号也放行。
 * 把别的字符挡掉就够了，不认识的名字交给引擎自己报错。
 */
export function coreOf(v) {
  if (v == null) return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  return /^[a-z0-9_-]{1,32}$/.test(s) ? s : null
}

/**
 * DOS 启动程序：zip 内相对路径（如 NFS/TNFS.EXE）。
 * 反斜杠统一成正斜杠（DOS 习惯写法照收），去掉开头的斜杠；
 * 拒绝空段 / . / .. 与控制字符 —— 这个值最终会拼进 dosbox.conf 的 autoexec，
 * 换行混进去等于让后台能注入任意 DOSBox 命令，必须在这里挡死。
 */
/**
 * DOS 游戏的**附加文件**：一行一个对象 key，加载时并进游戏目录（见 lib/jsdosBundle 的 mergeExtraFiles）。
 *
 * 用来装扩展包 / 补丁 / 额外配置这类「只要和本体躺在同一个目录里」的纯数据，
 * 免得为加一个几十 KB 的文件去重打一份十几 MB 的 ROM。
 *
 * ⚠️ 存的是**对象 key**，不是 URL —— 和 cover / rom / dos_system 一个路数，
 * 换资源域名时不用改数据。
 * ⚠️ 条数和长度都要卡住：这东西会进每个玩家的加载链路，
 * 填一百行等于让每个人开局先串行下一百个文件。
 */
const DOS_EXTRAS_MAX = 12
/** 落点（ZIP 里的相对路径）合法吗。空 = 用默认落点，不是错误 */
function extraPathOk(path) {
  if (path.length > 200) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return false
  if (path.endsWith('/')) return false
  return !path.split('/').some((seg) => !seg || seg === '.' || seg === '..')
}
export function dosExtrasOf(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split('\n')
  const out = []
  for (const raw of list) {
    let line = String(raw ?? '').trim()
    if (!line) continue
    /*
      一行的形状：`[?]对象key[|游戏里的路径]`（见 src/lib/dosExtras.ts）。
      行首的 `?` 是「玩家自己选要不要加载」，必须先剥掉再往下解析 —— 它不是 key 的一部分。
    */
    const optional = line.startsWith('?')
    if (optional) line = line.slice(1).trim()
    const bar = line.indexOf('|')
    const key = (bar < 0 ? line : line.slice(0, bar)).trim().replace(/^\/+/, '')
    const path = bar < 0 ? '' : line.slice(bar + 1).trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!key || key.length > 500) continue
    // 反斜杠和 .. 一律不收：这个值最终会变成 ZIP 里的路径
    if (key.includes('\\') || key.split('/').includes('..')) continue
    if (path && !extraPathOk(path)) continue
    // 同一个 key 落两个不同位置是合法的（同一份补丁丢进两个目录），所以整行去重
    const norm = (optional ? '?' : '') + (path ? `${key}|${path}` : key)
    if (!out.includes(norm)) out.push(norm)
    if (out.length >= DOS_EXTRAS_MAX) break
  }
  return out.length ? out.join('\n') : null
}

/**
 * 可选附加文件在开始界面上的名字（「隐秘行动」「黎明计划」…）。
 *
 * 只在有可选条目时才用得上：开关上写「加载「隐秘行动」（额外 498 MB）」比
 * 「加载附加文件」强得多 —— 玩家得知道那 500 MB 到底是什么才好决定要不要下。
 * 体积是前端现场 HEAD 测的，不存库：换一份文件就自动跟着变，没有对不上的风险。
 */
export function dosExtrasLabelOf(v) {
  if (v == null) return null
  const s = String(v).replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.slice(0, 60)
}

export function dosExecutableOf(v) {
  if (v == null) return null
  const s = String(v).trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s || s.length > 200) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) return null
  if (s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
  return s
}

/**
 * DOSBox 是默认核心，不必占一列值；只有 Windows 客体游戏需要明确保存 DOSBox-X。
 * 用白名单而不是照抄请求，避免拼错的核心名一路存进库、直到玩家点开才报错。
 */
export function dosBackendOf(v) {
  return v === 'dosboxX' ? 'dosboxX' : null
}

/**
 * 可复用的 Windows 客体系统镜像。
 *
 * 允许对象存储 key、站内绝对路径和 http(s) URL；只拦长度与控制字符。
 * 它最终会进入 fetch，换行等控制字符既没有合法用途，也会让日志与错误信息变得含混。
 */
export function dosSystemOf(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s || s.length > 500) return null
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(s) ? null : s
}

/**
 * 这款 DOS 游戏怎么存档，一句话（如「按 F2 存档、F3 读档」）。
 *
 * 它只被前端当纯文本渲染，不进 dosbox.conf、不拼 SQL，所以不必像 dos_executable 那样
 * 挑剔路径形状；只砍长度、去掉控制字符 —— 换行会把说明面板的排版撑乱，且没有任何合法用途。
 */
export function dosSaveHintOf(v) {
  if (v == null) return null
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x1f]/g, ' ').trim()
  if (!s) return null
  return s.slice(0, 120)
}

/**
 * Windows 3.x 的 Program Manager 与 Windows 9x 的开始菜单使用不同的“运行”快捷键。
 * 旧数据没有这列值时前端按 9x 处理；这里只接受后台下拉框会发送的两个代次。
 */
export function dosWindowsVersionOf(v) {
  return v === '3x' || v === '9x' ? v : null
}

/**
 * 客体 Windows 进入图形模式后的自启动等待秒数。5 秒以下可能打在仍未就绪的桌面服务上；
 * 120 秒以上只会让坏镜像把玩家长期困在遮罩后，所以把可配置范围收在这里。
 */
export function dosLaunchDelayOf(v) {
  if (v == null || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.max(5, Math.min(120, n))
}

/**
 * DOSBox-X 覆盖配置必须和浏览器端使用同一套规则；否则 API 能存进去、播放器却拒绝运行。
 * 错误标成可公开的 400，只包含配置行号和规则，不会泄露数据库或服务器路径。
 */
export function dosboxConfigOf(v) {
  if (v == null) return null
  try {
    return normalizeDosboxConfigOverride(v) || null
  } catch (cause) {
    const error = new Error(cause instanceof Error ? cause.message : 'DOSBox-X 配置格式不正确')
    error.status = 400
    error.expose = true
    throw error
  }
}

/** 多行命令在保存时拒绝非法配置节，不能等玩家点击开始才发现无法运行。 */
export function dosStartupCommandsOf(v) {
  if (v == null) return null
  try {
    return normalizeDosStartupCommands(v) || null
  } catch (cause) {
    const error = new Error(cause instanceof Error ? cause.message : 'DOS 启动前命令无效')
    error.status = 400
    error.expose = true
    throw error
  }
}

/**
 * FBNeo RomData（.dat 文本）。
 *
 * 它不进 SQL、不进 shell，只会被写进模拟器的虚拟文件系统再由核心解析，
 * 所以这里不做逐行语法校验（那是 FBNeo 的活），只管三件事：
 *
 *   1. 统一换行、砍掉除 \t 之外的控制字符 —— dat 是按行 token 化解析的，
 *      \r 混进去会跟着并进最后一个 token（romset 名后面多个 \r 就找不到包了）。
 *   2. 长度上限。TEXT 列放得下 64KB，但一份 dat 撑死几十行，
 *      真填进来一个几十 KB 的东西多半是贴错了内容。
 *   3. **必须同时有 ZipName/RomName 和 DrvName/Parent**。缺任何一个，核心的
 *      RomDataGetDrvName() 拿不到驱动名，会安静地退回普通 romset 流程 ——
 *      表现是「后台明明填了，游戏还是 Romset is unknown」，非常难查。
 *      宁可在保存这一刻就 400 拒掉，把话说清楚。
 */
export function arcadeRomDataOf(v) {
  if (v == null) return null
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '').trim()
  if (!s) return null

  if (s.length > 32768) {
    const error = new Error('RomData 太长了（上限 32768 字符）—— 确认贴进来的是 .dat 而不是别的文件')
    error.status = 400
    error.expose = true
    throw error
  }

  // 只看行首关键字，大小写不敏感，和 FBNeo 的 _tcsicmp 一致
  const has = (words) =>
    s.split('\n').some((line) => {
      const head = line.trim().split(/[\s\t,%:|{}]+/)[0]?.toLowerCase() ?? ''
      return words.includes(head)
    })

  if (!has(['zipname', 'romname']) || !has(['drvname', 'parent'])) {
    const error = new Error(
      'RomData 必须同时写明 ZipName（包名，如 wofcn）和 DrvName（借用的驱动，如 wofj），否则核心会忽略整份 dat',
    )
    error.status = 400
    error.expose = true
    throw error
  }

  return s
}

/**
 * 街机游戏需要的 **BIOS 系统包名**（`neogeo` / `pgm` / `skns` / …）。
 *
 * ## 它和平台级 BIOS 是两件事，别混
 *
 * `platform_bios` 表按**平台**绑一份（arcade → neogeo.zip），那是因为「一个平台共用一份」
 * 在过去是对的。可街机这一个平台底下其实是好几套硬件：NeoGeo 要 neogeo.zip、
 * IGS 的 PGM 板子要 pgm.zip，而引擎的 `EJS_biosUrl` 只接受**一个**地址 ——
 * 于是不管配哪一份，另一类游戏必然起不来（报的都是 `missing files`，和 ROM 对不对无关）。
 *
 * 这一列存的**不是地址**，是**系统名**：内核要找的那个 set 名，也是压缩包该叫的名字
 * （FBNeo 按固定文件名找 BIOS：它要 pgm.zip，你给它 `bios/arcade.zip` 就是没有）。
 * 地址由后台按系统名绑（`platform_bios` 里 `bios:<系统名>` 那几行），换存储桶不用改数据。
 *
 * ## 为什么允许手工填
 *
 * 自动识别（src/lib/arcadeRomset.ts 的候选里带 bios）只认 FBNeo 驱动表里的包。
 * 汉化版、魔改版、以及驱动表里根本没有的板子识别不出来。这时候管理员知道答案，
 * 就得让他直接填 —— 填错了他自己看得见，比让玩家对着 `Romset is unknown` 强。
 *
 * 形状收紧到 `[a-z0-9_]`：FBNeo 的 set 名就是小写字母数字下划线（`ngp_ngp`、
 * `astro_astrocde`、`nmk004`），带别的字符一定拼不出核心要找的文件名，
 * 与其让它静默失效，不如在保存这一刻 400 掉。
 */
export function arcadeBiosOf(v) {
  if (v == null) return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z0-9_]{1,32}$/.test(s)) {
    return badGameField('BIOS 系统名只能是字母、数字和下划线（例如 neogeo、pgm），长度不超过 32')
  }
  return s
}

/** `组名=值` 一条的形状。组名和值都不许含分隔符（逗号 / 分号 / 换行 / 等号），各限 32 字符 */
const DIP_ASSIGN = /^[^=,;\n]{1,32}=[^=,;\n]{1,32}$/
/** 预设关键字：自动认「摇杆 / 麻将」那一项并拨到麻将 */
const DIP_PRESET = /^(mahjong|麻将)$/i
/** 最多几条。和前端 dipPlan 的 MAX_INTENTS 对齐 */
const DIP_MAX_PARTS = 4

/**
 * 街机 DIP 开关（麻将类游戏要拨的那一档）。写法与语义见 src/emulator/dipPlan.ts。
 *
 * 和 arcadeBiosOf 一样是**形状校验**，只是这里没有「必须是某个集合里的值」这回事 ——
 * 组名和取值都由核心定（键名里还带驱动名），服务端无从查表。能查的只有两件事：
 *
 *   1. 别把分隔符写进去 —— `a=1, b=2` 是两条，`a=1; b=2` 也是；一条里再出现逗号会切歪；
 *   2. 别写成一整段别的东西 —— 这一栏最终会被塞进核心的选项写入调用，
 *      长度和条数都要有个头。
 *
 * ⚠️ **不要 toLowerCase**：这一栏允许写完整的核心选项键
 * （`fbneo-dipswitch-kov-Controls=Mahjong`），而键名是大小写敏感的 ——
 * 小写化之后就再也匹配不上，症状是「后台填了、跑起来没反应」。
 * 只把每条两端的空白收干净、统一用 `, ` 连接，存进去的就是人可以再读一遍的样子。
 */
export function arcadeDipOf(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (s.length > 200) return badGameField('DIP 开关最多 200 个字符')
  const parts = s.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean)
  if (!parts.length) return null
  if (parts.length > DIP_MAX_PARTS) {
    return badGameField(`DIP 开关最多 ${DIP_MAX_PARTS} 条（多条用逗号分隔）`)
  }
  for (const part of parts) {
    if (DIP_PRESET.test(part) || DIP_ASSIGN.test(part)) continue
    return badGameField(
      `DIP 开关「${part}」看不懂：只能写 mahjong（自动找摇杆 / 麻将那一项），` +
        '或者「组名=值」，例如 Controls=Mahjong',
    )
  }
  return parts.join(', ')
}

const FLASH_BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'])
const FLASH_NAMED_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape', 'ShiftLeft', 'ControlLeft',
])

const badGameField = (message) => {
  const error = new Error(message)
  error.status = 400
  error.expose = true
  throw error
}

function flashControlsObject(v, strict = true) {
  if (v == null || v === '') return null
  let raw = v
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return strict ? badGameField('Flash 键位不是合法 JSON') : null }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return strict ? badGameField('Flash 键位必须是包含 p1 的对象') : null
  }

  const out = {}
  for (const player of ['p1', 'p2']) {
    const pad = raw[player]
    if (pad == null) continue
    if (!pad || typeof pad !== 'object' || Array.isArray(pad)) {
      return strict ? badGameField(`Flash ${player} 键位必须是对象`) : null
    }
    const clean = {}
    const used = new Set()
    for (const [button, key] of Object.entries(pad)) {
      if (!FLASH_BUTTONS.has(button)) {
        if (strict) badGameField(`Flash 键位含未知按钮：${button}`)
        continue
      }
      const name = typeof key === 'string' ? key.trim() : ''
      if (!FLASH_NAMED_KEYS.has(name) && !/^Key[A-Z]$/.test(name) && !/^Digit[0-9]$/.test(name)) {
        if (strict) badGameField(`Flash ${button} 的键名无效：${String(key)}`)
        continue
      }
      if (used.has(name)) {
        if (strict) badGameField(`Flash ${player} 的多个按钮重复使用 ${name}`)
        continue
      }
      used.add(name)
      clean[button] = name
    }
    if (Object.keys(clean).length) out[player] = clean
  }
  if (!out.p1) return strict ? badGameField('Flash 键位至少要给 p1 配一个按钮') : null
  return out
}

/** JSON 列入库时显式序列化，避免不同 mysql2 配置把普通对象写成 [object Object]。 */
export function flashControlsOf(v) {
  const controls = flashControlsObject(v, true)
  return controls ? JSON.stringify(controls) : null
}

export function arcadeButtonsOf(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (n === 2 || n === 4 || n === 6) return n
  return badGameField('街机动作键数量只能是 2、4 或 6')
}

export function gameRowToApi(r, rel = {}) {
  const g = {
    slug: r.slug,
    title: r.title,
    platform: r.platform,
    genres: rel.genres ?? [],
    year: Number(r.year) || 0,
    developer: r.developer || '',
    plays: Number(r.plays) || 0,
    players: normalizeGamePlayers(r.players),
    multiplayer: bool(r.multiplayer),
    coinReward: Number(r.coin_reward) || 0,
    icon: r.icon || '🎮',
    description: r.description || '',
    // 后台没填上线日期时用真实入库时间兜底，不用人工编日期
    addedAt: dateOnly(r.added_at) || dateOnly(r.created_at),
    updatedAt: dateTimeIso(r.updated_at),
    bodyControl: bool(r.body_control),
    adult: bool(r.adult),
    hidden: bool(r.hidden),
    /**
     * 评分。games 上那三列是 game_ratings 的聚合缓存（见 ratings-repo.js）。
     * 平均分按权重算：SUM(score*weight) / SUM(weight)，登录票 1.0、匿名票 0.5。
     * 一票都没有时给 0 —— 前端据此判断「还没人评过」，不画星星，
     * 也**不能**输出到 schema.org 的 aggregateRating（0 分会被 Google 判为虚假富媒体摘要）。
     */
    rating: Number(r.rating_weight) > 0
      ? Math.round((Number(r.rating_sum) / Number(r.rating_weight)) * 10) / 10
      : 0,
    ratingCount: Number(r.rating_count) || 0,
  }
  // 不上首页的游戏干脆不带这个字段，前台拿到的形状和以前一样
  if (r.home_rank != null) g.homeRank = Number(r.home_rank)
  // 没覆盖核心的游戏同样不带这个字段，前台自己回落到平台默认
  if (r.core) g.core = r.core
  // 只有 DOS 游戏会填；不带字段 = 前端启发式自己猜
  if (r.dos_executable) g.dosExecutable = r.dos_executable
  if (r.dos_backend === 'dosboxX') g.dosBackend = 'dosboxX'
  if (r.dos_system) g.dosSystem = r.dos_system
  // 附加文件：库里是一行一个 key 的文本，接口上给数组，前端直接 map 成 URL
  if (r.dos_extras) {
    const extras = String(r.dos_extras).split('\n').map((x) => x.trim()).filter(Boolean)
    if (extras.length) g.dosExtras = extras
  }
  if (r.dos_extras_label) g.dosExtrasLabel = r.dos_extras_label
  if (r.dos_extras_label_en) g.dosExtrasLabelEn = r.dos_extras_label_en
  if (r.dos_windows_version === '3x' || r.dos_windows_version === '9x') g.dosWindowsVersion = r.dos_windows_version
  if (r.dos_launch_delay != null) g.dosLaunchDelay = Number(r.dos_launch_delay)
  if (r.dosbox_config_override) g.dosboxConfig = r.dosbox_config_override
  if (r.dos_save_hint) g.dosSaveHint = r.dos_save_hint
  if (r.arcade_romdata) g.arcadeRomData = r.arcade_romdata
  // 这款游戏要哪个 BIOS 系统包（neogeo / pgm）。没填就不带这个字段，
  // 播放器据此回落到「平台级 BIOS 那一份」——也就是加这个字段之前的行为。
  if (r.arcade_bios) g.arcadeBios = r.arcade_bios
  // DIP 开关（麻将类游戏要拨的那一档）。没填就不带这个字段 —— 播放器那边留空 = 完全不干预
  if (r.arcade_dip) g.arcadeDip = r.arcade_dip
  const flashControls = flashControlsObject(r.flash_controls, false)
  if (flashControls) g.flashControls = flashControls
  const arcadeButtons = arcadeButtonsOf(r.arcade_buttons)
  if (arcadeButtons) g.arcadeButtons = arcadeButtons
  if (r.title_zh) g.titleZh = r.title_zh
  // 中文译名的繁体版（只可能有 zh-Hant 一个键）。没生成过就不挂这个字段，
  // 前端的 gameTitle() 会自然回退到 titleZh，繁体读者看到简体 —— 那是 2026-09-07
  // 之前的状态，也是 GSC 把 /zh-Hant/* 判成重复页的原因。
  g.titleI18n = readI18nMap(r.title_i18n)
  // 没写英文简介的游戏不带这个字段，前台自己回落到基准简介
  if (r.description_en) g.descriptionEn = r.description_en
  // 按需缓存的其它语种译文。形状：{ zh-Hant: '...', es: '...', ... }。
  // 没翻译过则不挂这个字段，前端的 gameDescription() 会自然回退到 descriptionEn / description。
  g.descriptionI18n = readI18nMap(r.description_i18n)
  if (r.cover) g.cover = r.cover
  if (r.video) g.video = r.video

  const roms = rel.roms ?? {}
  // 通用 ROM 对外仍然叫 rom，按语言的仍然叫 roms —— 保持 v1 的对外形状
  if (roms[GENERIC_ROM_LANG]) g.rom = roms[GENERIC_ROM_LANG]
  const byLang = { ...roms }
  delete byLang[GENERIC_ROM_LANG]
  if (Object.keys(byLang).length) g.roms = byLang
  // 启动文件跟语言槽走；通用 ROM 继续用 games.dos_executable，旧数据无需迁移内容。
  if (rel.dosExecutables && Object.keys(rel.dosExecutables).length) g.dosExecutables = rel.dosExecutables
  if (rel.dosStartupCommands && Object.keys(rel.dosStartupCommands).length) g.dosStartupCommands = rel.dosStartupCommands
  // 备用地址必须保留语言归属；成功切源后 DOS 入口、存档与语言选择仍按原槽处理。
  if (rel.romBackups && Object.keys(rel.romBackups).length) g.romBackups = rel.romBackups

  const tags = rel.tags ?? []
  if (tags.length) g.tags = tags
  return g
}

/** API 游戏对象 -> games 表的字段字典（不含关联表） */
export function gameApiToRow(g) {
  return {
    slug: String(g.slug),
    title: String(g.title ?? ''),
    title_zh: g.titleZh ?? null,
    platform: String(g.platform ?? ''),
    year: Number(g.year) || 0,
    developer: developersText(g.developer),
    players: normalizeGamePlayers(g.players),
    multiplayer: g.multiplayer ? 1 : 0,
    coin_reward: Number(g.coinReward) || 0,
    icon: String(g.icon ?? '🎮'),
    cover: g.cover || null,
    video: g.video || null,
    description: String(g.description ?? ''),
    description_en: g.descriptionEn ? String(g.descriptionEn) : null,
    body_control: g.bodyControl ? 1 : 0,
    adult: g.adult ? 1 : 0,
    hidden: g.hidden ? 1 : 0,
    // 空字符串要写成 NULL，否则 DATE 列会存成 '0000-00-00'
    added_at: g.addedAt ? String(g.addedAt).slice(0, 10) : null,
    home_rank: homeRankOf(g.homeRank),
    core: coreOf(g.core),
    dos_executable: dosExecutableOf(g.dosExecutable),
    dos_backend: dosBackendOf(g.dosBackend),
    dos_system: dosSystemOf(g.dosSystem),
    dos_extras: dosExtrasOf(g.dosExtras),
    dos_extras_label: dosExtrasLabelOf(g.dosExtrasLabel),
    dos_extras_label_en: dosExtrasLabelOf(g.dosExtrasLabelEn),
    dos_windows_version: dosWindowsVersionOf(g.dosWindowsVersion),
    dos_launch_delay: dosLaunchDelayOf(g.dosLaunchDelay),
    dosbox_config_override: dosboxConfigOf(g.dosboxConfig),
    dos_save_hint: dosSaveHintOf(g.dosSaveHint),
    arcade_romdata: arcadeRomDataOf(g.arcadeRomData),
    arcade_bios: arcadeBiosOf(g.arcadeBios),
    arcade_dip: arcadeDipOf(g.arcadeDip),
    arcade_buttons: arcadeButtonsOf(g.arcadeButtons),
    flash_controls: flashControlsOf(g.flashControls),
  }
}

/**
 * PATCH 用：只把请求里**确实带了**的字段翻成数据库列。
 * plays 不在这里 —— 它由游玩计数接口自增，不接受整体覆盖。
 */
const FIELD_TO_COLUMN = {
  title: ['title', (v) => String(v ?? '')],
  titleZh: ['title_zh', (v) => (v == null || v === '' ? null : String(v))],
  platform: ['platform', (v) => String(v ?? '')],
  year: ['year', (v) => Number(v) || 0],
  developer: ['developer', developersText],
  players: ['players', normalizeGamePlayers],
  multiplayer: ['multiplayer', (v) => (v ? 1 : 0)],
  coinReward: ['coin_reward', (v) => Number(v) || 0],
  icon: ['icon', (v) => String(v ?? '🎮')],
  cover: ['cover', (v) => (v == null || v === '' ? null : String(v))],
  video: ['video', (v) => (v == null || v === '' ? null : String(v))],
  description: ['description', (v) => String(v ?? '')],
  descriptionEn: ['description_en', (v) => (v == null || v === '' ? null : String(v))],
  bodyControl: ['body_control', (v) => (v ? 1 : 0)],
  adult: ['adult', (v) => (v ? 1 : 0)],
  hidden: ['hidden', (v) => (v ? 1 : 0)],
  addedAt: ['added_at', (v) => (v ? String(v).slice(0, 10) : null)],
  homeRank: ['home_rank', homeRankOf],
  core: ['core', coreOf],
  dosExecutable: ['dos_executable', dosExecutableOf],
  dosBackend: ['dos_backend', dosBackendOf],
  dosSystem: ['dos_system', dosSystemOf],
  dosExtras: ['dos_extras', dosExtrasOf],
  dosExtrasLabel: ['dos_extras_label', dosExtrasLabelOf],
  dosExtrasLabelEn: ['dos_extras_label_en', dosExtrasLabelOf],
  dosWindowsVersion: ['dos_windows_version', dosWindowsVersionOf],
  dosLaunchDelay: ['dos_launch_delay', dosLaunchDelayOf],
  dosboxConfig: ['dosbox_config_override', dosboxConfigOf],
  dosSaveHint: ['dos_save_hint', dosSaveHintOf],
  arcadeRomData: ['arcade_romdata', arcadeRomDataOf],
  arcadeBios: ['arcade_bios', arcadeBiosOf],
  arcadeDip: ['arcade_dip', arcadeDipOf],
  arcadeButtons: ['arcade_buttons', arcadeButtonsOf],
  flashControls: ['flash_controls', flashControlsOf],
}

export function gameApiToPartialRow(patch) {
  const row = {}
  if (!patch || typeof patch !== 'object') return row
  for (const [field, [column, cast]] of Object.entries(FIELD_TO_COLUMN)) {
    // 用 hasOwnProperty 而不是取值真假：{ hidden: false } 是「上架」，
    // { cover: null } 是「清空封面」，两者都必须写进去
    if (Object.prototype.hasOwnProperty.call(patch, field)) row[column] = cast(patch[field])
  }
  return row
}

/** 请求体里带了关联字段吗（决定 PATCH 要不要动关联表） */
export function relationsInPatch(patch) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch ?? {}, k)
  return { genres: has('genres'), tags: has('tags'), roms: has('rom') || has('roms') || has('romBackups') || has('dosExecutables') || has('dosStartupCommands') }
}

/** 把 API 对象里的 rom / roms 归一成 { lang: key } 的形式（通用 ROM 用 '*'） */
export function romsOf(g) {
  const out = {}
  if (g?.rom) out[GENERIC_ROM_LANG] = String(g.rom).trim()
  for (const [lang, key] of Object.entries(g?.roms ?? {})) {
    if (typeof key === 'string' && key.trim()) out[lang] = key.trim()
  }
  return out
}

/** 关联表重写时，同 key 的旧入口可沿用；换包后旧入口必须作废。 */
export function romRelationRows(game, previous = [], partial = false) {
  const hasRomKeys = Object.prototype.hasOwnProperty.call(game, 'rom') || Object.prototype.hasOwnProperty.call(game, 'roms')
  const hasEntries = Object.prototype.hasOwnProperty.call(game, 'dosExecutables')
  const hasCommands = Object.prototype.hasOwnProperty.call(game, 'dosStartupCommands')
  const hasBackups = Object.prototype.hasOwnProperty.call(game, 'romBackups')
  const oldByLang = new Map(previous.map((row) => [row.lang, row]))
  const roms = hasRomKeys || !partial ? Object.entries(romsOf(game)) : previous.map((row) => [row.lang, row.object_key])
  return roms.map(([lang, key]) => ({
    lang,
    key,
    backupKey: lang === GENERIC_ROM_LANG ? null : hasBackups
      ? (() => {
          const backup = typeof game.romBackups?.[lang] === 'string' ? game.romBackups[lang].trim() : ''
          // 不能截断 URL：签名参数或 ZIP fragment 少一个字符都会变成另一条坏地址。
          // eslint-disable-next-line no-control-regex
          return backup && backup !== key && backup.length <= 500 && !/[\x00-\x1f]/.test(backup) ? backup : null
        })()
      : oldByLang.get(lang)?.object_key === key ? oldByLang.get(lang)?.backup_key ?? null : null,
    dosExecutable: lang === GENERIC_ROM_LANG ? null : hasEntries
      ? dosExecutableOf(game.dosExecutables?.[lang])
      : oldByLang.get(lang)?.object_key === key ? oldByLang.get(lang)?.dos_executable ?? null : null,
    dosStartupCommands: lang === GENERIC_ROM_LANG ? null : hasCommands
      ? dosStartupCommandsOf(game.dosStartupCommands?.[lang])
      : oldByLang.get(lang)?.object_key === key ? oldByLang.get(lang)?.dos_startup_commands ?? null : null,
  }))
}

/* ---------------- 博客 ---------------- */

export function postRowToApi(r, rel = {}) {
  return {
    slug: r.slug,
    title: r.title,
    // 标题的各语言译文。**含 en** —— 文章没有英文基准列（不像 game 有 title 当原名），
    // 所以英文界面也得靠这里，没有则回退到中文标题（见 i18nData.postTitle）。
    titleI18n: readI18nMap(r.title_i18n),
    excerpt: r.excerpt || '',
    content: r.content || '',
    icon: r.icon || '📝',
    tags: rel.tags ?? [],
    author: r.author || '',
    date: dateOnly(r.date) || dateOnly(r.created_at),
    updatedAt: dateTimeIso(r.updated_at),
    published: bool(r.published),
    // 按需翻译缓存（站点八种语言里 zh-Hans 看原文，en / es / fr / it / de / ja 看 i18n[lang]）。
    // post 没有英文基准列（不像 game 有 description_en），所以 en 也走 i18n[en]；
    // 没翻过则前端退回 excerpt / content 本身（见 i18nData.postExcerpt / postContent）。
    // 读取时的去空逻辑和 game.descriptionI18n 完全一致 —— 把空对象、null 等价过滤掉。
    excerptI18n: readI18nMap(r.excerpt_i18n),
    contentI18n: readI18nMap(r.content_i18n),
  }
}

export function postApiToRow(p) {
  return {
    slug: String(p.slug),
    title: String(p.title ?? ''),
    excerpt: String(p.excerpt ?? ''),
    content: String(p.content ?? ''),
    icon: String(p.icon ?? '📝'),
    author: String(p.author ?? ''),
    date: p.date ? String(p.date).slice(0, 10) : null,
    published: p.published ? 1 : 0,
  }
}

/* ---------------- 用户 ---------------- */

/** 用户行 -> 对外公开信息（不含密码）。favorites / recents 单独查后传入 */
export function userRowToPublic(r, favorites = [], recent = []) {
  // 老库还没跑 migrate 时这一列读出来是 undefined，当「没填」处理，读接口不该因此报错
  const birthDate = r.birth_date ? dateOnly(r.birth_date) : null
  return {
    id: r.id,
    email: r.email,
    nickname: r.nickname,
    avatar: r.avatar || '🕹️',
    coins: Number(r.coins),
    role: r.role,
    status: r.status,
    createdAt: dateOnly(r.created_at),
    /**
     * 出生日期与「现在能不能玩成人内容」。
     * 这两个字段只走本人（/api/auth/me、/api/me/*）和后台（/api/users）的接口 ——
     * 评论区那套 commentRowToApi 不经过这里，不会把别人的出生日期发到公开页面。
     * adultVerified 每次现算（shared/age.js）：未满 18 的账号到生日当天自然变 true。
     */
    birthDate,
    adultVerified: isAdultByBirthDate(birthDate),
    /**
     * 只回「有没有密码」，不回哈希。
     * 前端要靠它决定改密码时是否需要先问旧密码：验证码登录的账号从来没设过密码，
     * 逼他填一个填不出来的「当前密码」等于这个功能不可用。
     * 哈希本身是能离线爆破的，没有任何理由发到浏览器。
     */
    hasPassword: Boolean(r.password_hash),
    favorites,
    recent,
  }
}

/* ---------------- 评论 ---------------- */

/**
 * 一条评论 -> 对外结构。
 *
 * 三件事必须由这一层统一决定，不能让各个接口自己拼：
 *
 * 1. **被隐藏 / 被删除的评论不回正文**。前台只需要知道「这里曾经有一条评论」，
 *    好让引用它的回复不至于指向虚空；把原文照发出去，等于隐藏了个没隐藏。
 *    后台要看原文，走 admin: true。
 * 2. **不回邮箱**。评论区是公开的，userRowToPublic 那套是给后台和本人用的。
 * 3. `country` 统一大写、非法值归成 'XX'，前端只管拿两个字母去查国旗。
 *
 * @param r          game_comments 一行，外加 join 出来的 nickname / avatar / game_slug
 * @param admin      true = 后台视角，无论隐藏与否都给原文
 */
export function commentRowToApi(r, { admin = false } = {}) {
  const hidden = dbFlag(r.hidden)
  const deleted = Boolean(r.deleted_at)
  // 前台看不到内容的两种情形。注意别写成 `hidden || deleted ? '' : content` 之后
  // 又在别处判空——调用方要能区分「没内容」和「有内容但不给你看」，所以额外回状态位。
  const readable = admin || (!hidden && !deleted)
  return {
    id: String(r.id),
    // 后台列表才有：这条评论挂在哪款游戏 / 哪篇文章下（前台按宿主直接查，不需要回带）
    gameSlug: r.game_slug ?? undefined,
    gameTitle: r.game_title ?? undefined,
    postSlug: r.post_slug ?? undefined,
    postTitle: r.post_title ?? undefined,
    content: readable ? String(r.content ?? '') : '',
    country: countryOf(r.country),
    hidden,
    deleted,
    editedAt: dateTimeIso(r.edited_at) || undefined,
    createdAt: dateTimeIso(r.created_at),
    /**
     * 作者给这款游戏打的分（1~5）。**不是评论的一部分**，是 join 出来的当前评分 ——
     * 所以他改了分，历史评论上的星星会跟着变。这是有意的：星星表达的是
     * 「这个人怎么看这款游戏」，而人的看法只有一个当下值，冻结在每条评论上
     * 反而会出现同一个人的两条评论挂着两个不同分数。没评过分就不带这个字段。
     */
    score: r.rating_score != null ? Number(r.rating_score) : undefined,
    author: {
      id: r.user_id,
      nickname: r.nickname ?? '',
      avatar: r.avatar || '🕹️',
      // 只把「需要让别人认出来」的角色带出去；普通玩家 / 脏数据就不发这一格
      role: r.role === 'admin' || r.role === 'volunteer' ? r.role : undefined,
      // 后台要靠邮箱认人（昵称能改、能重名），前台一律不给
      email: admin ? (r.email ?? '') : undefined,
    },
    /**
     * 引用的那条评论。平铺列表 + 引用卡片的形态（见 GameComments.tsx）：
     * 只带一层，不做树 —— 卡片里要的就是「回复谁、说了什么」这一句。
     * 父评论已被隐藏或删除时 content 为空、deleted 为 true，前台显示占位文案。
     */
    quote: r.parent_id
      ? {
          id: String(r.parent_id),
          nickname: r.parent_nickname ?? '',
          avatar: r.parent_avatar || '🕹️',
          role: r.parent_role === 'admin' || r.parent_role === 'volunteer' ? r.parent_role : undefined,
          content:
            dbFlag(r.parent_hidden) || r.parent_deleted_at ? '' : String(r.parent_content ?? ''),
          deleted: dbFlag(r.parent_hidden) || Boolean(r.parent_deleted_at),
        }
      : undefined,
  }
}

/** ISO 3166-1 alpha-2，大写；认不出来的一律 'XX'（前端显示成「未知地区」） */
export function countryOf(v) {
  const code = String(v ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : 'XX'
}

/* ---------------- SQL 小工具 ---------------- */

/** INSERT ... ON DUPLICATE KEY UPDATE，覆盖除唯一键外的所有列 */
export function buildUpsert(table, row, pk) {
  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(', ')
  const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
  return { sql, values: cols.map((c) => row[c]) }
}
