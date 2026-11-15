# AwayFL runtime

- Embedded runtime: `@awayfl/awayfl-embed` 0.1.4, built 2026-10-08.
- Upstream repository: https://github.com/awayfl/awayfl-embed
- Source commit: `afeb360cded781630270bc0b0ae171e5a3d715d3`.
- The checked-in `v0.1.4/` bundle and assets are the upstream `dist/` output. Keep `VERSIONS.txt` with the bundle so its bundled module versions remain auditable.
- `host-v1/` is the 8BitGo integration layer. When it changes, add a new host version directory and update `AWAYFL_HOST_PATH` in `src/emulator/paths.ts`; versioned assets are cached for one year.
- The embed package declares MIT. Its bundled `@awayfl/awayfl-player` declares Apache-2.0; both notices are included alongside the runtime. Bundled transitive module licenses are published by their respective upstream packages.
