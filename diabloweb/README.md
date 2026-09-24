# diabloweb（上游源码，本站集成在 `/web/diablo`）

这是 [d07RiV/diabloweb](https://github.com/d07RiV/diabloweb) 的源码副本，本站只做了构建与站点
集成方面的改动。**构建方式、踩过的坑、验收步骤全部写在仓库根目录 `AGENTS.md` 的 §2.28.5**，
改这个工程之前先读那一节。

- 构建：在仓库根目录跑 `npm run diablo:build`（会构建 → 同步到 `public/web/diablo/` → 自检）。
- 产物：`public/web/diablo/`（进 git，随站点发布）；本目录的 `build/` 只是中间产物，不进 git。
- **本页不含任何游戏数据**：`DIABDAT.MPQ` / `spawn.mpq` 由玩家自己提供，只写进他自己的
  浏览器 IndexedDB。仓库里不要出现这些文件。

上游 README 原文（作为出处说明保留）：

> ## Diablo 1 for web browsers!
>
> This project is based on https://github.com/diasurgical/devilution.
>
> Source code to build the WebAssembly modules is here: https://github.com/d07RiV/devilution
>
> I've modified the code to remove all dependencies and exposed the minimal required interface with JS,
> allowing the game to be compiled into WebAssembly.
>
> Event handling (especially in the menus) had to be modified significantly to fit the JS model.
>
> The project is hosted on https://d07RiV.github.io/diabloweb/ along with spawn.mpq from the shareware
> version (place it in the public folder to run locally). This allows shareware version to be played
> anywhere, even on mobile phones. To play the full game, you must use your own DIABDAT.MPQ that you can
> obtain with the original copy of the game from GoG.
