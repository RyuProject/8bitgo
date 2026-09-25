/**
 * `/play/<slug>` —— 跨源隔离的整页游玩外壳。
 *
 * 为什么要单开一页、为什么不能把隔离头加在详情页上，见 shared/isolated-embeds.js 的说明。
 * 一句话：SharedArrayBuffer 要求**顶层文档**发 COOP + COEP，而 require-corp 会掐掉
 * 详情页上的字节收录脚本和跨源封面图（没有 CORP 头的跨源资源一律拦掉），
 * `credentialless` 又被 Safari 全线不支持。
 *
 * 这一页刻意不走 SSR、不引 React、不引任何第三方资源 —— 它只有一个 iframe 和一条返回链接。
 * 内容越少，require-corp 能掐掉的东西就越少，这是这个方案能成立的全部理由。
 */
import { SITE_LANGUAGES, SITE_DEFAULT_LANGUAGE } from '../../../shared/site-languages.js'
import { isolatedEmbedFor } from '../../../shared/isolated-embeds.js'

const LANG_CODES = new Set(SITE_LANGUAGES.map((l) => l.code))

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 返回链接要带回当前语言前缀，否则英文用户点返回会掉到中文页。
 * 默认语言（简体中文）用裸路径，见 shared/site-languages.js。
 */
function langPrefix(lang) {
  return !lang || lang === SITE_DEFAULT_LANGUAGE ? '' : `/${lang}`
}

function funnelScript(slug, funnel) {
  if (!funnel) return ''
  // 三个值都经过严格白名单；仍把 `<` 转义，避免以后放宽字段时误造出 </script>。
  const config = JSON.stringify({ slug, ...funnel }).replace(/</g, '\\u003c')
  return `<script>
(() => {
  const c=${config}, frame=document.querySelector('iframe'), sent=new Set();
  const report=(event,detail) => {
    if(sent.has(event)) return;
    sent.add(event);
    fetch('/api/games/'+encodeURIComponent(c.slug)+'/startup', {
      method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, keepalive:true,
      body:JSON.stringify({visitId:c.visitId,attemptId:c.attemptId,event,runtime:'html5',platform:'',elapsedMs:Math.max(0,Date.now()-c.startedAt),detail})
    }).then(r=>{if(!r.ok) throw new Error(String(r.status))}).catch(()=>sent.delete(event));
  };
  const playable=()=>{report('first_frame');report('game_playable')};
  const inspect=()=>{
    try {
      const canvas=frame.contentDocument&&frame.contentDocument.querySelector('canvas');
      if(canvas&&canvas.width>1&&canvas.height>1) requestAnimationFrame(()=>requestAnimationFrame(playable));
    } catch {}
  };
  frame.addEventListener('load',()=>{report('iframe_loaded');report('download_complete');inspect()});
  frame.addEventListener('focus',()=>report('first_interaction'));
  window.addEventListener('message',(event)=>{
    if(event.source!==frame.contentWindow) return;
    const m=event.data;
    if(!m||m.source!=='8bitgo-runtime-bridge'||m.version!==1) return;
    if(m.type==='first-frame') report('first_frame');
    else if(m.type==='game-playable') playable();
    else if(m.type==='first-interaction') report('first_interaction');
    else if(m.type==='failed') report('failed',String(m.detail||'HTML5 游戏报告启动失败').slice(0,160));
  });
  setTimeout(()=>{if(!sent.has('game_playable'))report('slow_start','等待 game_playable 已超过 20 秒')},Math.max(0,20000-(Date.now()-c.startedAt)));
  setTimeout(()=>{if(!sent.has('game_playable'))report('timeout','等待 game_playable 超过 120 秒')},Math.max(0,120000-(Date.now()-c.startedAt)));
})();
</script>`
}

function shell({ slug, lang, embed, title, funnel }) {
  const back = `${langPrefix(lang)}/games/${encodeURIComponent(slug)}`
  return `<!doctype html>
<html lang="${escapeHtml(lang || SITE_DEFAULT_LANGUAGE)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, follow">
<title>${escapeHtml(title || slug)} · 8BitGo</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b0f;color:#e5e7eb;
    font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{display:flex;flex-direction:column;overscroll-behavior:none}
  /* 返回条压在安全区下面，iPhone 横屏时不会被刘海吃掉 */
  header{flex:none;display:flex;align-items:center;gap:.75rem;
    padding:.5rem max(.75rem,env(safe-area-inset-right)) .5rem max(.75rem,env(safe-area-inset-left));
    background:#111118;border-bottom:1px solid #26262e}
  header a{color:#9ca3af;text-decoration:none}
  header a:hover{color:#fff}
  header strong{font-weight:600;color:#f3f4f6}
  iframe{flex:1;width:100%;border:0;display:block;background:#000}
</style>
</head>
<body>
<header>
  <a href="${escapeHtml(back)}">&larr; 返回</a>
  <strong>${escapeHtml(title || slug)}</strong>
</header>
<!--
  allow 里的 cross-origin-isolated 是给「游戏在别的域名上」那种情形准备的：
  这个权限策略默认只给 self，跨源子框架不会自动继承，不写就拿不到 SharedArrayBuffer。
  同源部署时它是多余的，但无害，所以两种形态共用一份外壳。
  这里刻意不加 sandbox —— 游戏要用 localStorage / IndexedDB 存档，
  而它是我们自己部署的同源（或自有子域）内容，沙箱只会挡自己的路。
-->
<iframe
  src="${escapeHtml(embed)}"
  title="${escapeHtml(title || slug)}"
  allow="fullscreen; autoplay; gamepad; cross-origin-isolated; clipboard-read; clipboard-write"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
${funnelScript(slug, funnel)}
</body>
</html>`
}

/**
 * Express 处理器。命中登记表才吐外壳，否则 next() —— 交给下面的 SSR 去渲染 404，
 * 免得随便一个 /play/xxx 都返回一个空 iframe。
 */
export function playShell(req, res, next) {
  const lang = req.params.lang
  // /:lang/play/:slug 这条路由的 :lang 不是语言时，说明这个 URL 压根不是游玩页
  if (lang !== undefined && !LANG_CODES.has(lang)) return next()

  const slug = decodeURIComponent(req.params.slug ?? '')
  const entry = isolatedEmbedFor(slug)
  if (!entry) return next()

  const idOk = (value) => /^[A-Za-z0-9_-]{8,64}$/.test(String(value ?? ''))
  const startedAt = Number(req.query.fs)
  const funnel = idOk(req.query.fv) && idOk(req.query.fa) && Number.isFinite(startedAt) &&
    startedAt <= Date.now() + 5_000 && startedAt >= Date.now() - 10 * 60_000
    ? { visitId: String(req.query.fv), attemptId: String(req.query.fa), startedAt }
    : null

  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      /**
       * 这两个头是整套方案的核心：只有顶层文档发了它们，iframe 里的游戏才拿得到
       * SharedArrayBuffer。少一个都不行，而且必须是 require-corp（credentialless
       * Safari 不认，见 shared/isolated-embeds.js）。
       */
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // 薄外壳页别进索引，详情页才是这款游戏的正主
      'X-Robots-Tag': 'noindex, follow',
      'Cache-Control': 'public, max-age=0, s-maxage=300',
    })
    .end(shell({ slug, lang, embed: entry.embed, title: entry.title, funnel }))
}
