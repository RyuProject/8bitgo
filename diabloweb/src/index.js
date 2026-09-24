import React from 'react';
import ReactDOM from 'react-dom';
import './reset.css';

import App from './App';

ReactDOM.render(<App />, document.getElementById('root'));

/*
  上游这里还有一句 serviceWorker.register()：它会在 /web/diablo/ 注册一个 workbox
  预缓存（app shell + 3MB wasm），scope 是该目录，本身不会污染主站。

  但本站不注册它，理由是「更新会静默变旧」：workbox 的 precache 清单带内容哈希，
  更新部署后老访客仍由旧 SW 供页面，而 /web/diablo 的入口文件名恰好不带哈希 ——
  症状和 AGENTS.md §2.5 记的那次事故一样：代码已经上线，浏览器还在跑上一版，
  刷新也不管用（真正生效要等 SW 自己更新+接管，观感就是「改了没用」）。
  game.worker.js 里的双 wasm 已经由 HTTP 缓存承担，SW 带来的离线能力对本站没有价值。
*/
