# Digiverse 来源与构建说明

- 上游：<https://github.com/gaaiyeoi/gamblers-table>
- 固定提交：`446e6ce66f4f12e0afadce4e3fbe9c7f8f37f883`
- 构建命令：`npx vite build --base=/web/gamblers-table/ --target=es2017`
- 产物哈希：见 `source.json`

8BitGo 在构建前只做了三类嵌入适配：把入口语言和 base 固定到站内目录，
加载 `8bitgo-bridge.js` 提供就绪/存档协议，以及加载 `8bitgo-overrides.css`
改善手机小屏布局。游戏逻辑未改写。

## 重新构建

上游当前的 `package.json` 与 `package-lock.json` 不同步，干净环境执行 `npm ci`
会直接失败。重建时需在临时克隆里先执行 `npm install --ignore-scripts`，再运行上面的
Vite 命令；不要在这个目录里直接覆盖已验收产物。

## 许可证状态

固定的上游提交中没有 `LICENSE` / `COPYING` 文件，README 也没有声明再分发条款。
此目录只如实记录来源，不把“GitHub 公开可见”当作开源授权；正式公开部署前
应由项目负责人向上游作者确认授权。
