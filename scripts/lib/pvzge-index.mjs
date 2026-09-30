import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PVZGE_INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>PvZ2 Gardendless</title>
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1,minimal-ui=true" />
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="format-detection" content="telephone=no">
  <base href="/web/PvZ2/">
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div id="GameDiv" cc_exact_fit_screen="true">
    <div id="Cocos3dGameContainer">
      <canvas id="GameCanvas" tabindex="99"></canvas>
    </div>
  </div>

  <script src="src/polyfills.bundle.js" charset="utf-8"></script>
  <script src="src/system.bundle.js" charset="utf-8"></script>
  <script src="src/import-map.json" type="systemjs-importmap" charset="utf-8"></script>
  <script>System.import('./index.js').catch(function (err) { console.error(err); })</script>
  <script src="tmpPatch.js" charset="utf-8"></script>
</body>
</html>
`

export function writeCleanPvzgeIndex(outDir) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), PVZGE_INDEX_HTML)
}

export function prepareExistingPvzge(outDir) {
  const indexFile = join(outDir, 'index.html')
  // PvZ2 大目录刻意不进 Git；没有安装过就保持缺失，不能因一次普通构建造出残缺运行时。
  if (!existsSync(indexFile)) return 'missing'

  const before = readFileSync(indexFile, 'utf8')
  if (before === PVZGE_INDEX_HTML) return 'unchanged'

  // 旧目录会跨 git pull 保留，只重写这份很小的入口即可修正 base 并清掉第三方注入。
  writeCleanPvzgeIndex(outDir)
  return 'repaired'
}
