// translatorDomGuard：页面翻译把文本节点包进 <font> 后，React 的 removeChild / insertBefore 不再崩
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installTranslatorDomGuard } from '../src/services/translatorDomGuard.ts'

// 极简 DOM：只实现守卫用到的 parentNode / contains / removeChild / insertBefore
class N {
  constructor(name) { this.name = name; this.parentNode = null; this.childNodes = [] }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
  removeChild(c) {
    const i = this.childNodes.indexOf(c)
    if (i < 0) throw new Error('NotFoundError: The node to be removed is not a child of this node.')
    this.childNodes.splice(i, 1); c.parentNode = null; return c
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n)
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length
    if (i < 0) throw new Error('NotFoundError: The node before which the new node is to be inserted is not a child of this node.')
    this.childNodes.splice(i, 0, n); n.parentNode = this; return n
  }
}
const wrap = (parent, text) => { const font = new N('font'); parent.insertBefore(font, text); font.insertBefore(text, null); return font }

const warn = console.warn; console.warn = () => {}
installTranslatorDomGuard(N.prototype)
installTranslatorDomGuard(N.prototype) // 幂等

// 1. 被包一层的文本节点：从真正的父节点删掉
{
  const span = new N('span'), text = new N('#text'); span.insertBefore(text, null)
  const font = wrap(span, text)
  assert.equal(span.removeChild(text), text)
  assert.equal(font.childNodes.length, 0)
}
// 2. 已经不在子树里：当删过了，不抛
{
  const span = new N('span'), stray = new N('#text')
  assert.equal(span.removeChild(stray), stray)
}
// 3. insertBefore 的参照被包一层：插到包装前面
{
  const span = new N('span'), text = new N('#text'); span.insertBefore(text, null)
  const font = wrap(span, text), dot = new N('dot')
  span.insertBefore(dot, text)
  assert.deepEqual(span.childNodes, [dot, font])
}
// 4. 参照完全不在本元素下：追加到末尾
{
  const span = new N('span'), a = new N('a'); span.insertBefore(a, null)
  const b = new N('b'); span.insertBefore(b, new N('elsewhere'))
  assert.deepEqual(span.childNodes, [a, b])
}
// 5. 正常路径不变
{
  const span = new N('span'), a = new N('a'), b = new N('b')
  span.insertBefore(a, null); span.insertBefore(b, a)
  assert.deepEqual(span.childNodes, [b, a]); span.removeChild(b); assert.deepEqual(span.childNodes, [a])
}
console.warn = warn

// 两个入口都必须在首次渲染前装上
for (const f of ['src/entry-client.tsx', 'src/main.tsx']) {
  const s = readFileSync(f, 'utf8')
  const call = s.indexOf('installTranslatorDomGuard()')
  assert.ok(call > 0, `${f} 没装 translatorDomGuard`)
  assert.ok(call < s.search(/hydrateRoot\(|createRoot\(root|createRoot\(document/), `${f} 要在渲染前装`)
}
const counts = readFileSync('src/components/layout/SidebarCounts.tsx', 'utf8')
assert.ok((counts.match(/translate="no"/g) || []).length >= 3, '计数徽标要 translate="no"')
// 「0」与「• N」两种形态必须用不同 key：同 key 时 React 逐个删 [点, N]，N 被挪走就崩
assert.match(counts, /key="empty"/, 'RoomCount 的 0 形态要有自己的 key')
assert.match(counts, /key="live"/, 'RoomCount 的有房形态要有自己的 key')
// 侧栏 RoomCard：⏸ / 👋 出现时以后面的数字为参照 insertBefore，数字不能是裸文本节点
const card = readFileSync('src/components/game/RoomCard.tsx', 'utf8')
assert.match(card, /<span translate="no">📡 \{viewers\}<\/span>/, 'RoomCard 直播在看人数要包进自己的元素')
assert.match(card, /<span translate="no">\{room\.players\}\/\{max\}<\/span>/, 'RoomCard 人数/上限要包进自己的元素')
console.log('translatorDomGuard：全部通过')
