/**
 * 开放平台 · 类型与语言目录（只读参考）。
 *
 * 和 `open/platforms.js` 同一个定位：第三方客户端要画筛选器（「按类型」「按语言」），
 * 得先知道有哪些可选项，而不是把一份会变的枚举硬编码进固件。
 *
 * ## 两份来源的取舍
 *
 * - **语言**：直接复用 `shared/site-languages.js` 的 `SITE_LANGUAGES`（这是 .js，
 *   服务端能 import，不需要镜像）。
 * - **类型**：`shared/site-taxonomy.js` 只给 `GENRE_IDS`（id 名单），**展示名在
 *   `src/data/genres.ts`**（TS，服务端 import 不了）。所以 `OPEN_GENRES` 在这里镜像一份
 *   `id + name`。⚠️ 这份和 `GENRE_IDS`、以及 `genres.ts` 的 id 集合**必须一致**：
 *   `genres.ts` 增减一个类型（比如加 `simulation`），这里和 `GENRE_IDS` 都要同步，
 *   否则前端类型页正常、开放接口却列不出来的那种「半生效」最难查。
 */

import { GENRE_IDS } from '../../../shared/site-taxonomy.js'
import { SITE_LANGUAGES } from '../../../shared/site-languages.js'

/**
 * 类型 id → 展示名。键集合要和 `GENRE_IDS` 对得上。
 * 名称照搬 `src/data/genres.ts`，改了那里这里要一起改。
 */
const GENRE_LABELS = {
  action: '动作',
  fighting: '格斗',
  shooter: '射击',
  platformer: '平台跳跃',
  adventure: '冒险',
  rpg: '角色扮演',
  strategy: '策略',
  racing: '竞速',
  sports: '体育',
  music: '音乐',
  puzzle: '益智',
  card: '卡牌',
}

/** 对外的类型目录。name 找不到（类型下线但 id 还残留）时回退到 id 本身 */
export const OPEN_GENRES = Object.freeze(
  GENRE_IDS.map((id) => ({ id, name: GENRE_LABELS[id] ?? id })),
)

/** 对外的语言目录。直接映射 SITE_LANGUAGES，不镜像 */
export const OPEN_LANGUAGES = Object.freeze(
  SITE_LANGUAGES.map((l) => ({ code: l.code, label: l.label, english: l.english })),
)
