/**
 * 玩家选的存档落点，以及它在浏览器里的记忆。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────
 * 1. **没有任何 import**，所以 node 侧能直接跑测试（`npm run test:save-target`）。
 *    services/saves.ts 拉着 api / auth / idb 一大串浏览器依赖，进不了 node。
 * 2. 「存到哪儿」是玩家的一个偏好，和「怎么存」是两件事，分开更好读。
 *
 * ── 为什么会有这个东西 ─────────────────────────────────────
 * 原来的行为是：`pushSave` 一律「写本地 + 只要登录了就顺手推云端」——
 * 也就是**登录用户的每一次存档都默认上云**，玩家从来没被问过。
 * 存档是他自己的东西，存在哪儿该由他说了算。
 */

/**
 *   local     只存在这个浏览器里（IndexedDB）
 *   cloud     跟着账号走，换设备还在；顺带在本地留一份当断网兜底
 *   download  存成文件下载走，站上什么都不留
 *
 * 'download' 不是「存到哪儿」而是「不存，给你」，所以它不进 pushSave，由界面直接处理。
 */
export type SaveTarget = 'local' | 'cloud' | 'download'

const TARGET_KEY = '8bitgo.save.target'

/**
 * 读玩家选过的落点。**没选过就是 null**，界面据此弹选择框。
 *
 * 故意不给默认值：给了默认值就等于替玩家做了决定，而这正是要改掉的行为。
 * 认不出来的值（老版本写的、被人手改的）一律当没选过 —— 绝不歪打正着变成云端。
 */
export function getSaveTarget(): SaveTarget | null {
  try {
    const v = localStorage.getItem(TARGET_KEY)
    return v === 'local' || v === 'cloud' || v === 'download' ? v : null
  } catch {
    return null // 无痕模式 / 禁了存储：每次都问，总比替他猜强
  }
}

/** 记住玩家的选择；传 null = 忘掉，下次重新问 */
export function setSaveTarget(target: SaveTarget | null): void {
  try {
    if (target) localStorage.setItem(TARGET_KEY, target)
    else localStorage.removeItem(TARGET_KEY)
  } catch {
    /* 存不下就算了，大不了每次问一次 */
  }
}
