/**
 * 街机核心只在 ZIP 根目录按成员名找 ROM；套一层文件夹的成员等同于缺失。
 * 上传前拦住，比传完、打包完、部署后才从 MAME 的 NOT FOUND 日志里反推问题便宜得多。
 */
export function arcadeArchiveLayoutProblem(entries: readonly { name: string }[]): string | null {
  const nested = entries.filter((entry) => entry.name.includes('/'))
  if (!nested.length) return null
  const sample = nested.slice(0, 3).map((entry) => entry.name).join('、')
  return (
    `ZIP 里有 ${nested.length} 个文件套在子目录中（例如 ${sample}）。` +
    'FBNeo / MAME 只读取 ZIP 根目录的 ROM 成员；请先拍平目录再上传，否则核心会报缺文件。'
  )
}
