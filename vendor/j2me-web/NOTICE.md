# J2ME Web fallback runtime

This directory contains the MIT-licensed runtime from `chentianxiong123/j2me-web`.
Upstream revision: `fe29582808ccf0d24382ed3b0a08953b8e15f386`.

The `src/` runtime files are kept from upstream. 8BitGo adds `embed.html`,
`src/embed.ts`, and `src/embed.css` to load a server-provided JAR inside the
existing player iframe. The upstream license is in `LICENSE` and its README is
preserved as `README.upstream.md`.

The standalone build writes to ignored `public/j2me-web/` during `predev` and
`prebuild`; the generated runtime is included in the client build output.
