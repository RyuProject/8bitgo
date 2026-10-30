import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')

assert.doesNotMatch(source, /import\s+\{\s*TouchPad\s*\}\s+from\s+['"]\.\/TouchPad['"]/, '触屏手柄不能静态进入播放器主模块')
assert.match(source, /const loadTouchPad = \(\) => import\('\.\/TouchPad'\)/, '触屏手柄应独立成按需 chunk')
assert.match(source, /lazy\(\(\) => loadTouchPad\(\)\.then\(\(\{ TouchPad \}\) => \(\{ default: TouchPad \}\)\)\)/)
assert.match(source, /if \(!touchDevice \|\| !caps\.has\('touchpad'\)\) return[\s\S]*?loadTouchPad\(\)\.catch/, '只在触屏设备且运行时确实需要时提前预载')
assert.equal((source.match(/<LazyTouchPad\b/g) ?? []).length, 2, '浮层和行内布局都必须使用同一个懒加载组件')
assert.equal((source.match(/<Suspense fallback=\{null\}>[\s\S]*?<LazyTouchPad\b/g) ?? []).length, 2, '两种布局都必须有非阻塞的 Suspense 边界')

console.log('✅ 触屏手柄已从播放器主模块拆出，并只为确实需要的触屏会话预载')
