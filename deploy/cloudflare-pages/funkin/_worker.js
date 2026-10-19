const PROMO_VIDEO = 'https://assets.8bitgo.com/web/funkin/v0.8.6-ee9d492-21b8dc3e/mobileRelease.mp4?v=21b8dc3e2d7b61c1f2f7f450141bfb50b1e6d98e8bd1dcac5bc7fa09287796bf'

function harden(response, pathname) {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')

  if (pathname === '/' || pathname.endsWith('.html')) {
    headers.set('Cache-Control', 'no-cache')
  } else if (pathname === '/sw.js') {
    // 浏览器必须每次重新验证 Worker；否则下一版缓存代次无法及时接管和清理旧资源。
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    headers.set('Service-Worker-Allowed', '/')
  } else if (pathname === '/8bitgo-streaming.js' || pathname === '/funkin-prefetch-manifest.json') {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
  } else if (pathname.startsWith('/assets/') || pathname.startsWith('/flixel/') || pathname.startsWith('/manifest/')) {
    // 客户端短缓存避免跨版本长期钉死；Cloudflare 边缘可长期复用同一内容。
    headers.set('Cache-Control', 'public, max-age=3600, s-maxage=31536000, stale-while-revalidate=86400')
  } else if (pathname === '/Funkin.js') {
    headers.set('Cache-Control', 'public, max-age=3600, s-maxage=31536000')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function promoVideo(request) {
  const upstream = new Request(PROMO_VIDEO, request)
  const response = await fetch(upstream)
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Type', 'video/mp4')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/assets/videos/videos/mobileRelease.mp4' && (request.method === 'GET' || request.method === 'HEAD')) {
      return promoVideo(request)
    }
    return harden(await env.ASSETS.fetch(request), url.pathname)
  },
}
