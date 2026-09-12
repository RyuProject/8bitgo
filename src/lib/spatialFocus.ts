/**
 * 方向键焦点导航（电视遥控器 / 车机旋钮用）。
 *
 * ## 为什么不能用浏览器自带的 Tab 顺序
 *
 * Tab 是**一维**的：它按 DOM 顺序一格一格走。而电视上人拿着遥控器按的是「右」——
 * 他想去的是屏幕上**右边那一张**，不是 DOM 里的下一个。一排 20 张磁贴的游戏墙，
 * 想跳到下一排得按 20 次 Tab；这正是「网页在电视上没法用」的主要来源。
 *
 * 所以这里自己算：给一堆矩形和当前焦点，按方向挑出**屏幕上**该去的那一个。
 *
 * ## 挑法（先读完再改，每一条都是踩出来的）
 *
 *   1. **只看真的在那个方向的**。判据是候选的近边越过了当前项的近边，
 *      而不是「中心点在那一侧」—— 用中心点的话，一张很宽的磁贴（横跨半屏）
 *      会因为中心偏左而被判成「在左边」，按右键跳不过去。
 *
 *   2. **横向优先给「同一排」的**。同一排 = 在垂直方向上有重叠。
 *      不这么分档的话，按右键会斜着跳到下一排某张离得更近的磁贴上 ——
 *      人看到的是焦点莫名其妙掉了一行，这是最常见的投诉。
 *
 *   3. 同一档里比**主轴距离**，主轴一样再比**错位量**，还一样比 id。
 *      最后那条不是洁癖：没有它的话，两张完全对称的候选谁赢取决于数组顺序，
 *      而数组顺序会随着数据加载先后变 —— 同一个界面按同一个键，结果不一样。
 *
 *   4. **不环绕**。一排到头再按右键就停在原地。电视上环绕是灾难：
 *      人按住方向键连按，焦点会从最右瞬间飞到最左，完全失去位置感。
 *
 * 纯函数、不碰 DOM —— 这样它能在 node 里直接测（scripts/test-spatial-focus.mjs）。
 * 取矩形、滚动到可视区那些是调用方的事。
 */

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface FocusRect {
  id: string
  /** 视口坐标，和 getBoundingClientRect 一致 */
  x: number
  y: number
  w: number
  h: number
}

/** 两条线段重叠多少。不重叠返回 0（不返回负数 —— 调用方只关心「有没有重叠」） */
function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
}

/**
 * 边界上的抖动容差（像素）。
 *
 * 磁贴的位置来自 getBoundingClientRect，是小数；同一排的两张可能差 0.5px。
 * 不留容差的话，「近边必须越过」这条会把同排右边那张判成「不在右边」，按右键没反应 ——
 * 而且是偶发的（换个缩放比例就好了），最难查的那一类。
 */
const EPS = 1

export function pickInDirection(rects: readonly FocusRect[], currentId: string, dir: Direction): string | null {
  const cur = rects.find((r) => r.id === currentId)
  if (!cur) return null

  const horizontal = dir === 'left' || dir === 'right'
  /** 主轴上「当前项的近边」和候选必须越过它的方向 */
  const forward = dir === 'right' || dir === 'down'

  let best: { id: string; sameBand: boolean; main: number; cross: number } | null = null

  for (const r of rects) {
    if (r.id === currentId) continue

    // ① 必须真的在那个方向：比的是近边，不是中心
    const curNear = horizontal ? (forward ? cur.x + cur.w : cur.x) : forward ? cur.y + cur.h : cur.y
    const candNear = horizontal ? (forward ? r.x + r.w : r.x) : forward ? r.y + r.h : r.y
    const candFar = horizontal ? (forward ? r.x : r.x + r.w) : forward ? r.y : r.y + r.h
    // 候选的远边（朝着我这一侧的那条边）要越过我的近边，候选才算在前方
    if (forward ? candFar < curNear - EPS : candFar > curNear + EPS) continue
    // 完全重合的（比如一张盖在另一张上）也算不上「在那个方向」
    if (Math.abs(candNear - curNear) < EPS && Math.abs(candFar - curNear) < EPS) continue

    // ② 同一排 / 同一列？横向看垂直重叠，纵向看水平重叠
    const sameBand = horizontal
      ? overlap(cur.y, cur.y + cur.h, r.y, r.y + r.h) > EPS
      : overlap(cur.x, cur.x + cur.w, r.x, r.x + r.w) > EPS

    const main = Math.abs(candFar - curNear)
    // 错位量：两者在副轴上中心差多少
    const cross = horizontal
      ? Math.abs(cur.y + cur.h / 2 - (r.y + r.h / 2))
      : Math.abs(cur.x + cur.w / 2 - (r.x + r.w / 2))

    const cand = { id: r.id, sameBand, main, cross }
    if (!best || better(cand, best)) best = cand
  }

  return best?.id ?? null
}

/** a 是不是比 b 更该被选中。顺序：同排优先 → 主轴近 → 错位小 → id 小（保证确定性） */
function better(
  a: { id: string; sameBand: boolean; main: number; cross: number },
  b: { id: string; sameBand: boolean; main: number; cross: number },
): boolean {
  if (a.sameBand !== b.sameBand) return a.sameBand
  if (Math.abs(a.main - b.main) > EPS) return a.main < b.main
  if (Math.abs(a.cross - b.cross) > EPS) return a.cross < b.cross
  return a.id < b.id
}
