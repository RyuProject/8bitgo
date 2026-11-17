/**
 * 按 ES 模块语法检查一段 JavaScript，不执行它。
 *
 * EmulatorJS 的 loader 用 `import()` 加载 emulator.min.js，文件里只要有一处语法错误，import 就整份失败，
 * 玩家只看到「Failed to load emulator.min.js because it's likely that the minified files are missing」——
 * 和「文件缺失」一模一样（2026-11-17 线上拳皇 97：补丁写进去的正则没转义 `/`）。补丁 / 构建检查只查字符串
 * 在不在是不够的，必须真解析一遍。
 *
 * 走 `node --input-type=module --check`（从 stdin 读），不依赖文件所在目录的 package.json `type`。
 * stderr 写临时文件而不是管道：node 报错时会先打印出错的整行源码（压缩文件一行几百 KB），
 * macOS 上退出前只刷出管道里前 64KB，SyntaxError 那一行就丢了。
 *
 * @param {string} source
 * @returns {string} 空串表示语法正确；否则是 SyntaxError 那一行
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function moduleSyntaxError(source) {
  const dir = mkdtempSync(join(tmpdir(), 'js-syntax-'))
  const errFile = join(dir, 'stderr.txt')
  const fd = openSync(errFile, 'w')
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      stdio: ['pipe', 'ignore', fd],
    })
    if (r.status === 0) return ''
    const lines = readFileSync(errFile, 'utf8').split('\n')
    const reason = lines.find((line) => /^\w*Error\b/.test(line.trim()))?.trim()
    return reason || r.error?.message || `node --check 退出码 ${r.status}`
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}
