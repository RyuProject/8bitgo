# binjgb runtime

Vendored from https://github.com/binji/binjgb at commit `16621111ed0ee73bcc45c912a823bcebedcffc0f`.

`binjgb.js` and `binjgb.wasm` are the upstream browser build. They are served locally so the GB/GBC fallback does not depend on a third-party CDN. See `LICENSE` for the upstream MIT license.

`binjgb-js.js` is a pure-JavaScript build of the same commit (Emscripten 4.0.20, upstream CMake `-DWASM=OFF` → `-s WASM=0`, export renamed to `BinjgbJs`), loaded only when the browser has no WebAssembly. Rebuild it with `node scripts/build-binjgb-js.mjs` whenever the commit changes; `binjgb-js.json` records its sha256.
