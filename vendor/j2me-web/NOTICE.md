# J2ME Web fallback runtime

This directory contains the MIT-licensed runtime from `chentianxiong123/j2me-web`.
Upstream revision: `fe29582808ccf0d24382ed3b0a08953b8e15f386`.

The `src/` runtime files are kept from upstream, except for the 8BitGo changes
listed below. 8BitGo adds `embed.html`, `src/embed.ts`, and `src/embed.css` to
load a server-provided JAR inside the existing player iframe.

8BitGo changes to upstream runtime files (2026-11-15, found by running every
J2ME game on 8bitgo.com in the fallback runtime):

- `src/jvm/natives/nokia.ts` (new): Nokia UI API — `FullCanvas`, `DirectUtils`,
  `DirectGraphics` (flip/rotate drawImage, ARGB colours, polygons, drawPixels /
  getPixels), `DeviceControl`, silent `Sound`.
- `src/jvm/natives/gamelayer.ts` (new): MIDP 2.0 `Layer`, `Sprite`, `TiledLayer`,
  `LayerManager` (bounding-box collisions only).
- `src/jvm/natives/netstub.ts` (new): `javax.microedition.io.Connector` and
  connection interfaces; opening a connection throws ConnectionNotFoundException.
- `src/gfx/gif.ts` (new): synchronous first-frame GIF decoder; `lcdui.ts` uses it
  so GIFs loaded from a game's own resource packs are no longer blank.
- `src/jvm/jvm.ts`: `startApp()` runs on its own thread instead of the event
  thread, so games whose main loop lives in `startApp()` still receive key events.
- `src/jvm/natives/media.ts`: spec values for Player states (100/200/300/400/0),
  `name:descriptor` field keys, `getMediaTime` / `setMediaTime` / `getDuration()J`
  / `getContentType()`, `Manager.playTone(III)`, `RateControl` / `TempoControl`.
- `src/jvm/natives/rms.ts`: spec `RecordStore.getRecord(int, byte[], int)`.
- `src/jvm/natives/lcdui.ts`: `AlertType` object constants; GIF decoding.
- `src/player/detect.ts`: GIF images count when guessing the screen size.
- `src/embed.ts`: an uncaught Java exception in the first 2 seconds is reported
  as a startup error instead of "ready".

The upstream license is in `LICENSE` and its README is preserved as
`README.upstream.md`.

The standalone build writes to ignored `public/j2me-web/` during `predev` and
`prebuild`; the generated runtime is included in the client build output.
