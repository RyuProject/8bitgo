/**
 * 方向键焦点导航的单元测试。跑：npm run test:spatial-focus
 *
 * 这一份能这么好测，是因为 lib/spatialFocus.ts 是纯函数：给矩形和方向，返回该去哪个 id。
 * 电视上的毛病（按右键焦点掉了一行、到头了焦点飞回最左、同一个界面两次按出不同结果）
 * 全都是这个函数算错，而在浏览器里它们表现成「偶尔抽风」，极难复现。
 */
import assert from 'node:assert/strict'
import { pickInDirection } from '../src/lib/spatialFocus.ts'

let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

/** 造一个规整的网格：cols×rows，每格 w×h，间距 gap。id 是 `r{行}c{列}` */
const grid = (cols, rows, w = 200, h = 120, gap = 20) => {
  const out = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ id: `r${r}c${c}`, x: c * (w + gap), y: r * (h + gap), w, h })
    }
  }
  return out
}

console.log('\n── 规整网格：四个方向都对 ──')

check('右 / 左 / 下 / 上 各走一格', () => {
  const g = grid(3, 3)
  assert.equal(pickInDirection(g, 'r1c1', 'right'), 'r1c2')
  assert.equal(pickInDirection(g, 'r1c1', 'left'), 'r1c0')
  assert.equal(pickInDirection(g, 'r1c1', 'down'), 'r2c1')
  assert.equal(pickInDirection(g, 'r1c1', 'up'), 'r0c1')
})

check('⚠️ 到头不环绕 —— 一排到头再按右键就停在原地', () => {
  /*
    环绕在电视上是灾难：人按住方向键连按，焦点会从最右瞬间飞到最左，
    完全失去位置感。返回 null 让调用方原地不动。
  */
  const g = grid(3, 3)
  assert.equal(pickInDirection(g, 'r1c2', 'right'), null)
  assert.equal(pickInDirection(g, 'r1c0', 'left'), null)
  assert.equal(pickInDirection(g, 'r2c1', 'down'), null)
  assert.equal(pickInDirection(g, 'r0c1', 'up'), null)
})

console.log('\n── 同一排优先 ──')

check('⚠️ 按右键不许斜着掉到下一排（哪怕下一排那张离得更近）', () => {
  /*
    这是最常见的投诉：人按「右」，焦点掉了一行。
    造一个下一排的磁贴在几何上更近的局面 —— 同排右边那张离得远，
    下一排左下方那张贴得很近。正确答案仍然是同排那张。
  */
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 100 },
    { id: 'sameRowFar', x: 400, y: 0, w: 100, h: 100 },
    { id: 'nextRowNear', x: 110, y: 105, w: 100, h: 100 },
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'sameRowFar')
})

check('同排一个都没有时，才允许挑别排的', () => {
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 100 },
    { id: 'nextRow', x: 110, y: 105, w: 100, h: 100 },
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'nextRow')
})

console.log('\n── 宽磁贴：判的是边，不是中心 ──')

check('⚠️ 一张很宽的磁贴，中心在左边但整个在右边 —— 按右键要能到', () => {
  /*
    用中心点判方向的写法在这里会挂：那张宽磁贴横跨大半屏，中心点落在当前项左侧，
    于是被判成「在左边」，按右键跳不过去 —— 而它明明就在右边。
    判据必须是**边**：它的左边缘越过了我的右边缘。
  */
  const rects = [
    { id: 'cur', x: 500, y: 0, w: 100, h: 100 },
    { id: 'wide', x: 610, y: 0, w: 900, h: 100 }, // 中心在 1060，左边缘 610
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'wide')
})

check('⚠️ 反方向的一律不选（哪怕贴着）', () => {
  const rects = [
    { id: 'cur', x: 500, y: 0, w: 100, h: 100 },
    { id: 'behind', x: 390, y: 0, w: 100, h: 100 },
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), null)
  assert.equal(pickInDirection(rects, 'cur', 'left'), 'behind')
})

check('⚠️ 横着盖过来的宽磁贴不算「在右边」（判中心点的写法在这里会挂）', () => {
  /*
    这一条是上面那条的**真正**版本 —— 上面那个用中心点算也照样通过，等于没测到。
    这里的宽磁贴从我左边就开始了（550 起），只是很长，中心落在我右边 1000。
    判中心：它中心在右边 -> 按右键跳进去，而它明明盖在我身上，人看到的是焦点原地打转。
    判边：它朝我这一侧的边（左边缘 550）没越过我的右边缘 600 -> 不算在右边。
  */
  const rects = [
    { id: 'cur', x: 500, y: 0, w: 100, h: 100 },
    { id: 'overlapWide', x: 550, y: 0, w: 900, h: 100 }, // 中心 1000，左边缘 550
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), null)
})

check('⚠️ 同排有好几个时，去最近的那个（不是最远的）', () => {
  /*
    上面那条「各走一格」是从中间格出发的，同方向上只有一个候选 ——
    主轴比距离那段代码根本没被执行到。从最左出发才有两个候选。
  */
  const g = grid(3, 3)
  assert.equal(pickInDirection(g, 'r1c0', 'right'), 'r1c1')
  assert.equal(pickInDirection(g, 'r1c2', 'left'), 'r1c1')
  assert.equal(pickInDirection(g, 'r0c1', 'down'), 'r1c1')
})

check('⚠️ 半像素的重叠不算「同一排」', () => {
  /*
    EPS 的真正用处在这儿。下一排那张只和我错开 0.4px（渲染出来就是挨着的两排），
    容差为 0 的话它会被算成「同排」，而且离得更近 -> 按右键掉一行。
    容差为 1 才认得出「这是下一排」，于是老老实实去同排那张远的。
  */
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 100 },
    { id: 'trueSameRow', x: 400, y: 0, w: 100, h: 100 },
    { id: 'nextRowHairline', x: 110, y: 99.6, w: 100, h: 100 }, // 只重叠 0.4px
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'trueSameRow')
})

check('⚠️ 都不同排时，比错位量（谁更对得齐谁赢），不是比 id', () => {
  /*
    两个候选主轴距离一模一样、都不在同一排，只有错位量不同。
    不比错位量就会掉到 id 决胜上 —— 这里故意让 id 顺序和正确答案相反：
    该赢的叫 zz，该输的叫 aa。
  */
  const rects = [
    { id: 'cur', x: 0, y: 0, w: 100, h: 100 },
    { id: 'zz-near', x: 200, y: 150, w: 100, h: 100 }, // 错位 150
    { id: 'aa-far', x: 200, y: -350, w: 100, h: 100 }, // 错位 350
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'zz-near')
})

console.log('\n── 结果必须是确定的 ──')

check('⚠️ 两个对称的候选，谁赢不能取决于数组顺序', () => {
  /*
    没有这条的话，同一个界面按同一个键会得到不同结果 —— 因为数组顺序
    会随着数据加载先后变（哪个平台的磁贴先到就排在前面）。
    人的感受是「这个遥控器有时候好使有时候不好使」，而且永远复现不了。
  */
  const a = { id: 'aaa', x: 200, y: -60, w: 100, h: 100 }
  const b = { id: 'bbb', x: 200, y: 60, w: 100, h: 100 }
  const cur = { id: 'cur', x: 0, y: 0, w: 100, h: 100 }
  const one = pickInDirection([cur, a, b], 'cur', 'right')
  const two = pickInDirection([cur, b, a], 'cur', 'right')
  assert.equal(one, two, `换个数组顺序结果就变了：${one} vs ${two}`)
})

console.log('\n── 边界情况 ──')

check('当前 id 不在表里 / 表是空的 → null，不抛', () => {
  assert.equal(pickInDirection(grid(2, 2), 'nope', 'right'), null)
  assert.equal(pickInDirection([], 'x', 'right'), null)
})

check('只有自己一个 → null（不会选中自己）', () => {
  assert.equal(pickInDirection([{ id: 'only', x: 0, y: 0, w: 10, h: 10 }], 'only', 'down'), null)
})

check('⚠️ 半像素抖动不该让同排的跳不过去', () => {
  /*
    磁贴位置来自 getBoundingClientRect，是小数：同一排两张可能差 0.5px。
    没有容差的话「同排」判定会偶发失败，表现为某些缩放比例下按右键没反应。
  */
  const rects = [
    { id: 'cur', x: 0, y: 0.4, w: 100, h: 100 },
    { id: 'right', x: 100.6, y: 0, w: 100, h: 100 },
  ]
  assert.equal(pickInDirection(rects, 'cur', 'right'), 'right')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 方向键焦点：${pass} 条全过`)
