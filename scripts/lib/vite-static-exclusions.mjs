/**
 * Vite 构建时暂存并软链回 `public/` 的大型静态目录。
 *
 * 这里额外列出的模拟器目录只包含带版本号的发布产物：新版本会新增路径，旧 URL 不会
 * 被原地覆盖。因此可以让 `dist/client` 复用仓库里的实体文件，避免每次构建再复制一份；
 * 可变入口（例如 EmulatorJS）仍保留在 dist 快照里，避免部署期间旧页面读到半更新资源。
 */
export const VERSIONED_RUNTIME_DIRS = Object.freeze([
  'dolphin',
  'ppsspp',
])

export const HUGE_STATIC_DIRS = Object.freeze([
  'web/cs15/packs',
  'web/cs16/packs',
  'qemu-wasm',
  'web/terraria/_framework',
  'web/celeste/_framework',
  ...VERSIONED_RUNTIME_DIRS,
])
