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
