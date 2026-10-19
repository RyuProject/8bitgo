import { createRoot } from 'react-dom/client'
import '@/index.css'
import { LoadingProgressOverlay } from './LoadingProgressOverlay'

createRoot(document.getElementById('root')!).render(
  <main className="relative bg-black" style={{ width: '100vw', height: '100vh' }}>
    <LoadingProgressOverlay
      loadingLabel="少女祈祷中 · 正在下载游戏…"
      ratio={0.61}
      speedText="745 KB/s"
      discText="本局需下载 503.2 MB / 已下载 306.9 MB"
      speedInDiscText
      progressBoundaries={[]}
    />
  </main>,
)
