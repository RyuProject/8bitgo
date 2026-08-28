# Random game button design QA

- Source visual truth:
  - `/Users/zhangwenyu/Downloads/Button/SVG/Button 1.svg`
  - `/Users/zhangwenyu/Downloads/Button/SVG/Button 2.svg`
  - `/Users/zhangwenyu/Downloads/Button/SVG/Button_3.svg`
  - `/Users/zhangwenyu/Downloads/Button/SVG/Button2_mini.svg`
- Implementation screenshot: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-mobile-drawer.png`
- Diagnostic screenshot from the first pass: `/Users/zhangwenyu/Documents/GitHub/8bitgo/design-qa-implementation.png`
- Viewport: 390 × 844 CSS px
- Source dimensions: 1092.4 × 468.82 SVG design units when the left, middle, and right pieces are assembled
- Implementation dimensions: 390 × 844 px screenshot at a 390 × 844 CSS viewport; browser capture was 1:1
- State: mobile navigation drawer open; random-game button enabled and idle

## Full-view comparison evidence

The three source SVG pieces and the rendered mobile implementation were opened in one grouped browser comparison. The implementation preserves the source palette, stepped corners, highlight, outline, and lower shadow. The button remains aligned to the existing 223 px navigation content width without changing nearby sidebar rhythm.

## Focused region comparison evidence

The rendered button measures 223 × 44 CSS px. Its pieces meet exactly:

- left: x 8 → 30.7578125
- stretchable middle: x 30.7578125 → 208.2421875
- right: x 208.2421875 → 231

There are no fractional gaps or overlaps at either seam. The dice marker is absent, and the label is centered to within browser sub-pixel precision. It uses the requested cream `rgb(252, 250, 229)` / `#fcfae5`, is shifted upward by 4 px in total, stays on one line, and has equal `scrollWidth` and `clientWidth` (91 px), so it is not clipped.

## Required fidelity surfaces

- Fonts and typography: existing pixel font, 13 px bold label, 4 px upward optical adjustment, and unchanged localized copy are retained; no wrapping or truncation in Chinese.
- Spacing and layout rhythm: 44 px button height and 223 px width preserve the former sidebar slot; the following community box keeps its original position.
- Colors and visual tokens: the supplied SVG colors are used without redrawing or substitution; the label uses the requested `#fcfae5` foreground.
- Image quality and asset fidelity: the supplied SVG paths remain vector assets. End caps keep their original aspect ratio, while only the authored middle piece stretches horizontally.
- Copy and content: “随机玩一个游戏” remains unchanged; the dice marker has been intentionally removed per the latest request.

## Findings

No actionable P0, P1, or P2 differences remain.

## Comparison history

1. First pass found a P1 seam failure: the middle SVG kept its intrinsic aspect ratio inside a flexible image box, leaving large blank gaps before both end caps. Evidence: `design-qa-implementation.png`.
2. Fixed by cropping each source piece to its authored viewBox and setting `preserveAspectRatio="none"` only on the stretchable middle assets.
3. Post-fix browser evidence: `design-qa-mobile-drawer.png`; measured piece boundaries are contiguous and the grouped source/implementation comparison shows the intended artwork intact.
4. Follow-up refinements moved only the label upward by 4 px in total (another 3 px from the prior position) and changed its foreground to `#fcfae5`; final browser computed values confirm `translate: 0px -4px` and `rgb(252, 250, 229)`.
5. Latest refinement removed the dice marker. Browser evidence confirms no `🎲` remains in the button text and the label center differs from the button center by less than 0.001 px.

## Interaction and browser checks

- The primary click interaction was tested and still navigates to `/games` when the random API is unavailable.
- Desktop sidebar and mobile drawer states were rendered and inspected.
- Browser console warnings/errors after the final reload: none.

## Follow-up polish

No P3 follow-up is required for this scoped replacement.

final result: passed
