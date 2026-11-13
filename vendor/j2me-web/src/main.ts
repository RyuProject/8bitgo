import { App } from './ui/app';
import { embeddedJarBytes, embeddedGame } from './player/pack';
import './ui/styles.css';

const app = new App(document.getElementById('app')!);

async function boot() {
  const params = new URLSearchParams(location.search);

  if (import.meta.env.DEV && params.has('dev')) {
    const res = await fetch('/__dev/jar');
    if (res.ok) {
      app.play(new Uint8Array(await res.arrayBuffer()), 'dev.jar');
      return;
    }
    console.warn('Dev JAR not available:', await res.text());
  }

  // 打包构建：jar 已经内嵌在产物里，直接开玩，不经过库界面。
  const packed = embeddedGame();
  const bytes = embeddedJarBytes();
  if (packed && bytes) {
    document.title = packed.name;
    app.play(bytes, packed.fileName);
    return;
  }

  await app.showLibrary();
}

void boot();