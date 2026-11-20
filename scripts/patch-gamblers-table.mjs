/*
 * Godot 的 IDBFS 同步函数藏在生成的闭包里；云存档快照前要先把内存文件系统落进 IndexedDB。
 * 只额外导出这个窄接口，不暴露整套 FS，避免页面 SDK 能任意改写运行时文件。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimePath = resolve(repo, 'public/web/gamblers-table/index.js')
const htmlPath = resolve(repo, 'public/web/gamblers-table/index.html')
const bridgePath = resolve(repo, 'public/web/gamblers-table/8bitgo-save-bridge.js')
const marker = 'Module["8bitgoSyncPersistentFS"]=GodotFS.sync;'
const anchor = 'Module["initFS"]=GodotFS.init;Module["copyToFS"]=GodotFS.copy_to_fs;'

export function patchGamblersTableRuntime() {
  let changed = false
  let source = readFileSync(runtimePath, 'utf8')
  const markers = source.split(marker).length - 1
  if (markers === 0) {
    const anchors = source.split(anchor).length - 1
    if (anchors !== 1) throw new Error(`Gamblers Table Godot FS 导出位置出现 ${anchors} 次，无法安全补丁`)
    source = source.replace(anchor, `${anchor}${marker}`)
    writeFileSync(runtimePath, source)
    changed = true
  } else if (markers !== 1) {
    throw new Error(`Gamblers Table Godot 同步接口标记出现 ${markers} 次，无法安全补丁`)
  }

  const html = readFileSync(htmlPath, 'utf8')
  const matches = html.match(/src=(["'])8bitgo-save-bridge\.js(?:\?v=[\da-f]+)?\1/g) || []
  if (matches.length !== 1) throw new Error(`Gamblers Table 存档桥脚本标签出现 ${matches.length} 次，无法安全版本化`)
  const version = createHash('sha256').update(readFileSync(bridgePath)).digest('hex').slice(0, 16)
  const versioned = `src="8bitgo-save-bridge.js?v=${version}"`
  if (matches[0] !== versioned) {
    writeFileSync(htmlPath, html.replace(matches[0], versioned))
    changed = true
  }
  return changed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = patchGamblersTableRuntime()
  console.log(changed ? '已更新 Gamblers Table 持久化 FS 接口或存档桥版本' : 'Gamblers Table 持久化 FS 接口和存档桥版本已在位')
}
