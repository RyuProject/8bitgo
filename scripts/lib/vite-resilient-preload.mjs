/**
 * 懒加载 chunk 的依赖先「暖进 HTTP 缓存、失败就重试」，再交给浏览器的模块加载器（2026-11-19）。
 *
 * 为什么：Vite 的预加载助手（`\0vite/preload-helper.js`）给懒加载 chunk 的每个静态依赖插一个
 * `<link rel=modulepreload>`，不等、不重试。Chromium 153 与 WebKit 26.6 实测，这些依赖里任何一个
 * 请求失败一次（弱网断流、客户端中止、边缘偶发 5xx），失败就被**这一份文档的模块表**记住：
 *   - 报错写的是懒加载入口（`Failed to fetch dynamically imported module: …/GameDetailPage-*.js`）；
 *   - 换查询串重导入口也必然失败，依赖请求都不再发；只有整页刷新能好。
 * 详情页一次要拉 21 个这样的 chunk（14 个不到 4KB），3G 上任何一个抖一下，整页就进兜底页、自动刷新。
 *
 * 现在：JS 依赖先用 fetch() 取一遍（完整读完正文，写进 HTTP 缓存），失败按网络错误 / 5xx 重试一次；
 * 全部取到后才调 Vite 原来的助手（只剩 CSS）和真正的 import() —— 模块加载器读的全是缓存，没有网络环节可失败。
 * fetch() 的失败不进模块表：重试过还取不下来时抛一个打了标记的错误、**不碰模块表**，
 * src/services/moduleLinkRecovery.ts 的 importWithRetry 据此再走一遍完整加载（又会先暖缓存），而不是换查询串。
 *
 * 只在 Chromium 内核上做（navigator.userAgentData 只有 Chromium 89+ 有）。2026-11-19 实测（scripts/test-lazy-imports.mjs 记了数字）：
 *   - Chromium 普通 / 无痕配置：fetch 进的缓存都被模块加载器复用，每个依赖只下一次；
 *   - WebKit 有磁盘缓存时也只下一次，但临时会话（Safari 无痕、Playwright 默认上下文）不复用，每个依赖下两遍 ——
 *     弱网上的 iOS 访客多下一倍不划算，Safari / Firefox 暂时保持 Vite 原来的 modulepreload，失败交给兜底页整页刷新；
 *   - `<link rel=preload as=script crossorigin>` 两家都能被模块加载器复用，但失败的预加载也被复用，重试无效，不能用。
 *
 * 安全边：
 *   - 这一页里 fetch() 从没成功过（内容安全策略、扩展把 fetch 拦了）时不抛，照旧交给模块加载器，等于以前的行为；
 *   - 404 / 410 等确定性错误不重试（部署切换后的旧 chunk，交给兜底页刷新拿新 HTML）；
 *   - 只管现代包（legacy 的 SystemJS 没有依赖表，Vite 传的是 void 0）；HTML 里已有 modulepreload / script 的不重复取；
 *   - 同一个依赖同时被两个懒加载用到只取一次；失败的那次从表里删掉，下一次还能再取。
 *
 * 不靠改 Vite 源码：transform 钩子把助手的 `export const __vitePreload` 改名成 `__vitePreloadVite` 保留下来，
 * 再接上这里的包装。Vite 升级改了助手的写法时直接构建失败（postbuild 还有 check-lazy-imports.mjs 核对产物里的标记）。
 */

export const PRELOAD_HELPER_ID = '\0vite/preload-helper.js'
/** 产物里能看到的标记（错误文字压缩后也留着）：scripts/check-lazy-imports.mjs 据此确认助手确实换上了 */
export const RESILIENT_PRELOAD_MARKER = 'dependency warm-up failed'

/** 打在「暖缓存失败」错误上的属性名；moduleLinkRecovery.ts 读它 */
export const PRELOAD_FAILURE_PROP = '__8bitgoPreloadFailure'

/**
 * 接在 Vite 原助手后面的代码。用到原助手里的 assetsURL / isCssPreloadUrl / __vitePreloadVite（改名后的原函数）。
 * 写成字符串是因为它要原样进浏览器包；scripts/test-lazy-imports.mjs 在 VM 里直接跑它。
 */
export const RESILIENT_PRELOAD_CODE = `
const __8bitgoWarmRetryMs = [600];
const __8bitgoWarmHeadersMs = 15000;
const __8bitgoWarmStallMs = 15000;
const __8bitgoWarmed = {};
let __8bitgoFetchWorks = false;
function __8bitgoSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function __8bitgoWarmError(message, permanent) {
  const error = new Error(message);
  error.permanent = permanent;
  return error;
}
async function __8bitgoFetchFully(href) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const arm = (ms) => {
    clearTimeout(timer);
    if (controller) timer = setTimeout(() => controller.abort(), ms);
  };
  arm(__8bitgoWarmHeadersMs);
  try {
    const response = await fetch(href, { credentials: "same-origin", priority: "high", signal: controller ? controller.signal : undefined });
    __8bitgoFetchWorks = true;
    if (!response.ok) {
      const status = response.status;
      throw __8bitgoWarmError("HTTP " + status, status >= 400 && status < 500 && status !== 408 && status !== 429);
    }
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      for (;;) {
        arm(__8bitgoWarmStallMs);
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    } else {
      await response.arrayBuffer();
    }
  } finally {
    clearTimeout(timer);
  }
}
function __8bitgoWarm(href) {
  if (__8bitgoWarmed[href]) return __8bitgoWarmed[href];
  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await __8bitgoFetchFully(href);
        return;
      } catch (error) {
        if ((error && error.permanent) || attempt >= __8bitgoWarmRetryMs.length) throw error;
        await __8bitgoSleep(__8bitgoWarmRetryMs[attempt]);
      }
    }
  })();
  __8bitgoWarmed[href] = promise;
  promise.catch(() => {
    if (__8bitgoWarmed[href] === promise) delete __8bitgoWarmed[href];
  });
  return promise;
}
function __8bitgoWarmSupported() {
  try {
    return typeof fetch === "function" && typeof navigator !== "undefined" && !!navigator.userAgentData;
  } catch (error) {
    return false;
  }
}
function __8bitgoLoadedHrefs() {
  const hrefs = new Set();
  try {
    const links = document.getElementsByTagName("link");
    for (let i = 0; i < links.length; i++) if (links[i].href) hrefs.add(links[i].href);
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) if (scripts[i].src) hrefs.add(scripts[i].src);
  } catch (error) {}
  return hrefs;
}
export const __vitePreload = function preload(baseModule, deps, importerUrl) {
  if (!__VITE_IS_MODERN__ || !deps || !deps.length || !__8bitgoWarmSupported()) {
    return __vitePreloadVite(baseModule, deps, importerUrl);
  }
  const css = [];
  const js = [];
  const loaded = __8bitgoLoadedHrefs();
  for (const dep of deps) {
    let href = "";
    try {
      href = new URL(assetsURL(dep, importerUrl), import.meta.url).href;
    } catch (error) {
      css.push(dep);
      continue;
    }
    if (isCssPreloadUrl(new URL(href))) css.push(dep);
    else if (!loaded.has(href)) js.push(href);
  }
  if (!js.length) return __vitePreloadVite(baseModule, css, importerUrl);
  const failed = [];
  let allPermanent = true;
  return Promise.all(js.map((href) => __8bitgoWarm(href).catch((error) => {
    failed.push(href);
    if (!error || !error.permanent) allPermanent = false;
  }))).then(() => {
    if (failed.length && !__8bitgoFetchWorks) {
      // 这一页里 fetch() 从没成功过：可能是策略 / 扩展拦了 fetch，不是网络问题 —— 原样交回 Vite（含 modulepreload），等于以前的行为
      return __vitePreloadVite(baseModule, deps, importerUrl);
    }
    if (failed.length) {
      const names = failed.map((href) => href.split("/").pop().split("?")[0]);
      const error = new TypeError("Failed to fetch dynamically imported module (${RESILIENT_PRELOAD_MARKER}): " + names.join(", "));
      const failure = { failed: names.slice(0, 6) };
      if (allPermanent) failure.permanent = true;
      Object.defineProperty(error, ${JSON.stringify(PRELOAD_FAILURE_PROP)}, { value: failure, configurable: true });
      throw error;
    }
    return __vitePreloadVite(baseModule, css, importerUrl);
  });
};
`

/** 把 Vite 原助手改造成「原函数改名 + 接上包装」；认不出写法就返回 null（调用方让构建失败） */
export function patchPreloadHelper(code) {
  const exportRe = /export\s+const\s+__vitePreload\s*=/
  if (!exportRe.test(code)) return null
  if (!/\bassetsURL\b/.test(code) || !/\bisCssPreloadUrl\b/.test(code)) return null
  return `${code.replace(exportRe, 'const __vitePreloadVite =')}\n${RESILIENT_PRELOAD_CODE}`
}

export function resilientPreloadPlugin() {
  return {
    name: '8bitgo:resilient-preload',
    apply: 'build',
    transform: {
      filter: { id: /^\0vite\/preload-helper\.js$/ },
      handler(code, id) {
        if (id !== PRELOAD_HELPER_ID) return null
        const patched = patchPreloadHelper(code)
        if (!patched) {
          this.error('Vite 的预加载助手写法变了（找不到 export const __vitePreload / assetsURL / isCssPreloadUrl）：'
            + '更新 scripts/lib/vite-resilient-preload.mjs，别让懒加载依赖退回「失败一次整页坏掉」')
        }
        return { code: patched, map: null }
      },
    },
  }
}
