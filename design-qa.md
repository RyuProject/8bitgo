# Emulator bottom toolbar and MP4 recording QA

- Source visual truth: `/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_WAO3hF/截屏2026-08-29 10.53.29.png`
- Browser-rendered implementation: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-player-bottom.png`
- Focused implementation crop: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-player-bottom-focus.png`
- Grouped comparison: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-player-comparison.png`
- Source pixels: 1860 × 234 px at supplied density
- Implementation pixels: 1265 × 712 px at a 1280 × 720 CSS viewport and 1× capture density
- State: desktop game detail page; the source shows a running EmulatorJS session, while the implementation capture uses the idle player because the visual comparison is scoped to the player frame and toolbar placement rather than game content

## Findings

No actionable P0, P1, or P2 differences remain for the requested change.

## Full-view comparison evidence

The implementation preserves the existing rounded player frame, black game area, white site toolbar, status badge, and right-aligned immersive/fullscreen controls. The intended change is visible: the toolbar is now the final row inside the fixed 16:9 player instead of increasing the page height beneath it.

## Focused region comparison evidence

Browser measurements on the player show:

- player stage: 628 × 353.25 CSS px
- toolbar: 628 × 49 CSS px
- toolbar bottom and player-stage bottom are identical
- toolbar is fully contained within the stage
- page horizontal overflow: 0 px

The source and implementation states differ because no commercial ROM was used for QA. This does not affect the measured parent/child layout relationship; the running-state tools render into the same toolbar element.

## Required fidelity surfaces

- Fonts and typography: existing toolbar type, status labels, button labels, weights, and line heights are unchanged.
- Spacing and layout rhythm: existing toolbar padding and gaps are unchanged; the video region now flexes above the toolbar so the combined player remains 16:9.
- Colors and visual tokens: existing surface, border, status, and button tokens are unchanged.
- Image quality and asset fidelity: the game cover/backdrop rendering is unchanged; no image or icon asset was replaced.
- Copy and content: all player and toolbar copy remains unchanged.

## MP4 recording checks

- A real browser canvas recording produced `video/mp4` through the updated recorder.
- With MP4 support deliberately disabled in the browser test, the same recorder produced `video/webm;codecs=vp9,opus`.
- The downloaded extension continues to follow the Blob's actual MIME type, so a WebM file is never merely renamed to `.mp4`.

## Comparison history

1. Source state: the site toolbar occupied an additional row below the 16:9 game area.
2. First implementation: the toolbar became the last flex row inside the 16:9 player; the game area automatically yielded its actual height instead of being overlaid.
3. Post-fix browser evidence: measured toolbar containment is true with a 0 px bottom gap and no horizontal overflow.

## Interaction and browser checks

- The player keeps its existing idle/start interaction and visible immersive/fullscreen controls.
- Fullscreen continues to target the player stage, which now contains both game area and toolbar.
- TypeScript build and focused lint checks pass.

## Follow-up polish

No P3 follow-up is required for this scoped change.

final result: passed
---

# CS1.6 original-style launcher QA

- Source visual truth: `/Users/zhangwenyu/Documents/GitHub/8bitgo/public/web/cs16/ui/original-menu-background.png`, `/Users/zhangwenyu/Documents/GitHub/8bitgo/public/web/cs16/ui/original-counter-strike-logo.png`, and `cstrike/resource/ClientScheme.res` inside the local CS1.6 base pack.
- Browser-rendered implementation screenshot: Codex in-app browser capture of `http://127.0.0.1:5174/web/cs16/?launcher=2` (the in-app browser exposes the rendered image in-task but no local screenshot path).
- Grouped comparison evidence: Codex in-app browser capture of `http://127.0.0.1:5174/web/cs16/design-qa-compare.html`, with the original 800 × 600 source asset and the rendered launcher shown in the same 1280 × 720 image. The temporary comparison route was removed after review.
- Viewports: 1280 × 720 desktop and 390 × 844 narrow/mobile, device density normalized by the in-app browser.
- Source pixels: 800 × 600. Desktop implementation capture: 1280 × 720. Mobile implementation capture: 390 × 844.
- State: launcher default `New Game`, live whitelist-backed `Find Servers`, loading screen, and a completed de_dust2 launch with one Normal-difficulty YaPB bot.

## Findings

No actionable P0, P1, or P2 differences remain for the requested original-CS1.6 direction.

## Full-view comparison evidence

The grouped comparison shows the launcher using the exact source background crop, original Counter-Strike logo, black translucent panels, square borders, and the source scheme's `255 176 0` amber accent. The form remains on the less visually busy portion of the image at desktop width and collapses above the character art at narrow width without horizontal overflow.

## Focused region comparison evidence

The Create Server panel was inspected at desktop and 390 px widths. Map, BOT count, BOT difficulty, hint copy, and Start remain readable and keyboard-focusable. The original square-corner, low-decoration VGUI density is preserved; no modern rounded card or generic green progress treatment remains.

## Required fidelity surfaces

- Fonts and typography: Verdana/Tahoma fallback, compact weights, uppercase dialog titles, and amber hierarchy match the original ClientScheme family and density.
- Spacing and layout rhythm: the left menu, dialog titlebar, two-column form, separators, and right-aligned action follow the original VGUI proportions; mobile becomes a single-column form without clipped actions.
- Colors and visual tokens: text, borders, muted copy, black field backgrounds, and selection states use the original amber/black palette.
- Image quality and asset fidelity: background and logo are converted directly from bundled original TGA assets; no generated or CSS-drawn replacement artwork is used.
- Copy and content: the launcher keeps the original English menu names while using concise Chinese setup help. The server page accurately says that ordinary UDP servers are not currently reachable from the browser.

## Comparison history

1. Previous launcher: generic radial dark background, rounded controls, English technical paragraph, always-visible logs, and no server-state explanation (P1 visual mismatch).
2. First implementation: source background/logo, original palette, Create Server dialog, real difficulty control, collapsed console, and whitelist-backed Find Servers state.
3. Post-fix evidence: desktop, 390 px mobile, server tab, zero-BOT difficulty disabling, loading state, and completed de_dust2 gameplay all render and behave correctly.

## Interaction and browser checks

- `Find Servers` loads the no-cache runtime directory; Refresh, row selection, double-click/Join and Back preserve selected-menu styling.
- Empty/unreachable relay states remain explicit and do not affect local BOT practice.
- Choosing zero BOTs disables the irrelevant difficulty control and updates the help text.
- `?map=de_dust2&bots=1&difficulty=1` reached live gameplay with YaPB loaded.
- Browser console had no error or warning entries during launcher interaction.
- CS16 pack tests, focused lint, production client build, post-build CS16 artifact verification, and browser compatibility checks pass.

## Follow-up polish

No P3 visual fix is required. Real public-server rows should only replace the current status panel after a restricted WSS-to-UDP transport and server whitelist exist.

final result: passed

---

# Nine-slice center-fill correction recheck

- Source visual truth: `/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_tNhqtP/截屏2026-08-29 14.43.21.png` and the supplied nine-slice SVG files.
- Implementation: `src/components/ui/PixelButton.tsx` with `public/ui/pixel-buttons/white-center.svg` and `green-center.svg`.
- State: homepage hero and genre buttons, default state.

## Findings and fix

- [P1, fixed in code] The previous implementation skipped both center SVGs and substituted a flat color, while the edge SVGs retained their intrinsic aspect ratio. This produced visible breaks at the top, bottom, and center seams.
- The component now renders all nine supplied pieces. Corners retain their proportions, top/bottom/center pieces stretch horizontally as required, left/right/center pieces stretch vertically as required, and the new white center asset fills the central cell.
- Production build and whitespace checks pass.

## Verification blocker

The in-app browser denied local-page access during the post-fix capture, so a fresh browser-rendered screenshot and console check could not be produced in this turn. The already-open preview remains available for manual refresh.

final result: blocked

---

# Homepage special-thanks and friend-links QA

- Placement reference: `/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/codex-clipboard-c52b7309-32c3-4e71-beb6-ab4a6cba3229.png`
- Style reference: `/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_InSrSf/截屏2026-09-09 10.38.04.png`
- Browser-rendered implementation: `/private/tmp/8bitgo-special-thanks-embedded.png`
- Grouped comparison: `/private/tmp/8bitgo-special-thanks-comparison-latest.png`
- Viewports: 1265 × 712 desktop and 390 × 844 mobile

## Findings

No actionable P0, P1, or P2 differences remain for the requested change.

## Placement and visual comparison

The special-thanks fieldset is part of the FAQ left column, immediately below the blog/about actions and inside the area identified in the placement reference. It no longer creates a separate full-width homepage row. Its border, rounded corners, inset legend, line weight, typography, and surface color reuse the existing player-community fieldset language.

Image links render at exactly 88 × 31 px. Text links share the 31 px height, keep an 88 px minimum width, and expand only as needed for their label. The contents use wrapping flex layout, so multiple friend links can flow onto additional lines without moving the fieldset out of the FAQ column.

## Responsive and interaction checks

- Desktop: the fieldset stays aligned with the FAQ introduction column while the accordion remains in the right column.
- Mobile: reading order is introduction → actions → special thanks → FAQ accordion; page horizontal overflow is 0 px.
- Image failures fall back to the text presentation, preserving a usable outbound link.
- Links open in a new tab and include keyboard-visible focus styling.
- The admin list and editor were checked in text and image modes; the narrow admin navigation now scrolls horizontally instead of collapsing labels.

## Verification

- Friend-link validation tests: passed (6 groups).
- Existing role/permission tests: passed (25 checks).
- TypeScript project build: passed.
- Client production build and EmulatorJS artifact check: passed.
- Server SSR production build: passed.
- Whitespace/error-marker check: passed.

## Known deployment step

No production database was mutated during QA. The idempotent server migration must run before the admin page and public list are used in a deployed environment.

final result: passed

---

# Homepage pixel-button and genre-icon QA

- Source visual truth: `/Users/zhangwenyu/Downloads/截屏2026-08-29 14.31.54.png`, together with the supplied button and icon SVG files in `/Users/zhangwenyu/Desktop/未命名文件夹/`.
- Browser-rendered implementation: `/private/tmp/8bitgo-home-buttons-desktop.jpg`
- Viewport: 1600 × 900 CSS px, device scale factor 1.
- Source pixels: 1602 × 370. Implementation pixels: 1600 × 900.
- State: Simplified Chinese homepage, default button state. The source is a focused crop, so comparison uses the matching hero/button region.

## Findings

No actionable P0, P1, or P2 differences remain for the requested change.

## Full-view comparison evidence

The two hero actions remain in the same order and retain the green-primary / white-secondary hierarchy. The supplied pixel-art edge pieces surround a flexible center, so both labels fit without stretching the corner artwork. The genre shortcuts remain a wrapping horizontal group beneath the hero.

## Focused region comparison evidence

The hero button region was inspected at desktop and narrow responsive widths. The green button keeps the existing play icon as requested. The white button uses the supplied `运行我的ROM.svg`. Nine supplied genre SVGs map to their matching genre IDs; genres without a supplied replacement retain their existing icons.

## Required fidelity surfaces

- Fonts and typography: the existing font, weight, size, and label copy are preserved.
- Spacing and layout rhythm: action spacing, compact genre spacing, wrapping, and responsive layout remain intact.
- Colors and visual tokens: the requested green/white hierarchy remains, with the green center matched to the supplied SVG palette.
- Image quality and asset fidelity: all replacements use the supplied vector assets; pixel icons retain crisp rendering.
- Copy and content: all labels and destinations are unchanged.

## Comparison history

1. First pass: transparent gaps appeared around the flexible center (P1).
2. Fix: preserved all nine grid positions and added a source-matched center fill.
3. Post-fix desktop and narrow captures show continuous fills and intact pixel edges.

## Interaction and browser checks

- `/games` and `/play-local` links are visible and retain their correct destinations.
- Browser console check returned no errors.
- Production build passed.
- Lint passed with pre-existing warnings in generated EmulatorJS files and unrelated scripts.

## Follow-up polish

No P3 follow-up is required for this scoped change.

final result: passed

---

# Whole-site page skeleton QA

- Source visual truth: `/Users/zhangwenyu/Downloads/截屏2026-08-29 11.05.17.png`
- Browser-rendered home implementation: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-skeleton-desktop.png`
- Browser-rendered mobile implementation: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-skeleton-mobile.png`
- Additional route evidence: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-skeleton-games.png`, `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-skeleton-detail.png`
- Source pixels: 2468 × 466 px at the supplied density
- Desktop screenshot pixels: 1425 × 950 px; browser viewport override requested at 1440 × 960; screenshot output normalized by the in-app browser
- Mobile screenshot pixels: 375 × 812 px; browser viewport override requested at 390 × 844; screenshot output normalized by the in-app browser
- State: page-data request deliberately held open so the real loading state remains visible; the source is a cropped reference from another site, so comparison is qualitative for skeleton language rather than a pixel-identical page clone

## Findings

No actionable P0, P1, or P2 differences remain for the requested change.

## Full-view comparison evidence

The supplied reference keeps real page copy and imagery visible while replacing asynchronous content with a row of light pill placeholders. The 8BitGo implementation follows the same hierarchy: its existing navigation and branded home banner stay visible, then genre chips and game sections use layout-matched placeholders. The implementation intentionally retains 8BitGo's green accent, rounded-card tokens, white canvas, and pixel typography instead of copying the reference site's neutral styling.

## Focused region comparison evidence

The final home chip row mirrors the reference's defining structure: each light rounded pill contains a circular placeholder and a short text line. Game-library and game-detail captures verify that list cards, the 16:9 player region, metadata rows, and sidebar card all reserve their real proportions. A separate focused crop was not needed because the chip internals and card shapes are clearly readable in the full-view captures.

## Required fidelity surfaces

- Fonts and typography: loaded page copy keeps the existing Geist Pixel / Ark Pixel stack, weights, line heights, and hierarchy; the skeleton introduces no fake text.
- Spacing and layout rhythm: chip height, 8 px gaps, card grid columns, player aspect ratio, content padding, radii, and mobile wrapping follow the real components. Mobile main-content overflow measured 0 px.
- Colors and visual tokens: placeholders use the existing `surface-2`, `surface-3`, `line`, and `brand` tokens; contrast is visible on the light site without becoming a second visual theme.
- Image quality and asset fidelity: the existing 8BitGo logo, banner treatment, and game-cover regions are preserved. No visible logo, illustration, or icon was recreated with placeholder art.
- Copy and content: loading states do not invent user-facing copy; all real headings, descriptions, filters, and navigation labels remain unchanged.

## Comparison history

1. First visual pass: the general layout and green sweep matched the requested direction, but the home pills were solid rounded bars and missed the reference's circular-icon-plus-line anatomy (P2).
2. Fix: changed the homepage and generic route pills to bordered 8BitGo chip shells containing separate circular and line placeholders.
3. Post-fix evidence: the revised desktop and mobile captures show the intended chip structure, stable content hierarchy, and no horizontal overflow.

## Interaction and browser checks

- Tested the home loading state at desktop and mobile sizes.
- Clicked the real sidebar “全部游戏” link and verified navigation to `/games` displayed 30 skeleton elements while data remained pending.
- Verified the game-library and game-detail loading layouts.
- Fresh-browser console check returned no errors or warnings.
- TypeScript, focused lint, client build, server build, and whitespace checks pass.

## Follow-up polish

No P3 follow-up is required for this scoped change.

final result: passed

---

Latest status for the nine-slice center-fill correction: the implementation and production build pass, but the required fresh browser capture was denied by local-page permissions. See “Nine-slice center-fill correction recheck” above.

final result: blocked

---

# Current task final status

The homepage special-thanks placement, friend-link wrapping, 88 × 31 image sizing, responsive behavior, admin workflow, and production builds were visually and functionally verified in the current task. See “Homepage special-thanks and friend-links QA” above for the complete evidence.

final result: passed

---

## 2026-10-17 PvZ Pages 加载画面

**Design QA — PvZ Pages 加载画面**

- Source visual truth path: `/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/codex-clipboard-00cab5b0-d115-49b1-9036-140fb1c24a4a.png`
- Implementation screenshot evidence: Codex 内置浏览器对照页 `http://127.0.0.1:4175/pvz-loading-qa.html`（本轮已捕获并排画面）
- Implementation URL: `http://127.0.0.1:4173/web/PvZ/cn/`（由 `.cloudflare-pages/pvz` 构建产物提供）
- Viewport: 对照 1440 × 900 CSS px；另验收 390 × 844 竖屏、844 × 390 横屏与默认桌面窗口
- Density normalization: `devicePixelRatio = 1`；参考图 640 × 480 px，生成画面 1280 × 960 px，二者均按 4:3 等比缩放到相同对照框
- State: 自动资源加载中，真实进度为 0%，木牌进度条可见

**Full-view Comparison Evidence**

- 构图：实现保留了参考图的上方游戏标题、中间花园对阵场景、左侧植物、右侧僵尸和底部木牌加载器；主要视觉层级一致。
- 字体与排版：标题使用粗窄展示字与深色描边，接近参考图的游戏 Logo 量感；木牌使用高对比衬线大写字和等宽百分比，缩小后仍清楚。
- 间距与节奏：标题、角色场景和加载木牌均落在 4:3 安全区；木牌居中且不遮挡关键角色面部。非 4:3 屏幕使用同图模糊延展，不裁掉左右角色。
- 色彩与视觉 token：蓝天、亮绿植物、紫色右侧树林、棕色木牌与参考图同一色彩关系；暗角只用于提升标题和进度的可读性。
- 图像质量：实现使用 1280 × 960、209 KB WebP，无参考图右下水印；默认桌面、手机竖屏与横屏均未出现拉伸、透明边或低清晰度问题。
- 文案与内容：保留 `LOADING...`，增加真实百分比和低干扰的 `8BitGo · Web Edition`；增加内容属于功能性状态反馈，不改变参考图的信息层级。

**Focused Region Comparison Evidence**

- 已单独检查顶部 Logo 与底部木牌区域：描边、对比度、木纹层次、进度槽和百分比在 390 px 窄屏仍可辨认。
- 其它细节不需要额外局部裁切：并排 4:3 对照中角色、道路、房屋、标题与加载控件均已清晰可见。

**Findings**

- 无可执行的 P0 / P1 / P2 视觉差异。
- [P3] 竖屏上下会出现模糊延展背景；这是为了完整保留 4:3 角色构图的有意取舍，比裁切主画面更稳妥。

**Primary Interactions Tested**

- 自动加载开始时全屏启动画面出现。
- 进度控件暴露 `progressbar`、0–100 范围和当前值，屏幕阅读器状态可读。
- 390 × 844 与 844 × 390 两个移动端方向不溢出、不裁掉木牌。
- 已检查控制台：加载画面 CSS / WebP / DOM 未产生错误；localhost 对生产资源域的请求受线上 CORS 策略限制，未作为视觉缺陷计入。

**Comparison History**

- Pass 1：参考图与实现首次并排比较即未发现 P0 / P1 / P2；无需视觉返工。

**Implementation Checklist**

- [x] 4:3 高分辨率无水印场景
- [x] 真实下载 / 写盘进度接入木牌
- [x] 中英文入口同步注入
- [x] 桌面、手机竖屏与横屏验证
- [x] Pages 构建包与 Worker 检查
- [x] 错误时保留原资源选择页回退

**Follow-up Polish**

- 可选：以后若提供更接近原作的已授权 Logo 素材，可替换当前 CSS 文本标题；不影响本次验收。

final result: passed

---

# 2026-10-18 加载进度界面视觉核验

- 参考图：`/var/folders/hg/rws3swzs2gnc5zs48b6ln5r80000gn/T/TemporaryItems/NSIRD_screencaptureui_lurobS/截屏2026-10-18 21.54.03.png`
- 实现页：`http://127.0.0.1:5175/__loading-progress-qa.html`
- 核验视口：736 × 183
- 固定状态：简体中文、61%、总计 503.2 MB、已下载 306.9 MB、745 KB/s、无广告填充

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| 标题层级 | 通过 | 阶段文案保持白色，61% 使用品牌绿色突出。 |
| 下载信息 | 通过 | 第二行稳定显示“总量 / 已下载量 · 实时速度”，不会挤动标题。 |
| 进度条 | 通过 | 黑色底、灰色轨道、绿色圆角进度与 61% 状态一致。 |
| 数字稳定性 | 通过 | 百分比、已下载量和速度均使用等宽数字，刷新时不左右抖动。 |
| 无障碍信息 | 通过 | `progressbar` 同时暴露当前百分比和完整可读状态。 |

参考图第二行只有总量；本次按需求增加真实的“已下载”数值，并把网速放在同一行。这是有意差异，其余布局、间距、颜色和层级保持一致。

final result: passed
