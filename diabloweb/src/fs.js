import IdbKvStore from  'idb-kv-store';

/*
  上游这里有一段（**已经被它自己注释掉的**）importStorage()：它会往页面里塞一个
  `https://diablo.rivsoft.net/storage.html` 的隐藏 iframe，再通过 postMessage 把
  本地文件系统（也就是玩家的 DIABDAT.MPQ）整包交给那个第三方域名，
  作者靠它把 GitHub Pages 上的旧数据迁移过来。

  本站**必须让它永远保持关闭**，所以这段代码在这里被整段删掉，只留这条说明：
  页面上写着「文件不会上传到服务器」，而这段代码正好会把整份 MPQ 交给别人 ——
  一旦有人为了「兼容老玩家」把它放开，横幅上的承诺就当场作废。
  存档与 MPQ 只走本目录的 IndexedDB（库名 `diablo_fs`）。
*/

async function downloadFile(store, name) {
  const file = await store.get(name.toLowerCase());
  if (file) {
    const blob = new Blob([file], {type: 'binary/octet-stream'});
    const url = URL.createObjectURL(blob);
    const lnk = document.createElement('a');
    lnk.setAttribute('href', url);
    lnk.setAttribute('download', name);
    document.body.appendChild(lnk);
    lnk.click();
    document.body.removeChild(lnk);
    URL.revokeObjectURL(url);
  } else {
    console.error(`File ${name} does not exist`);
  }
}

async function downloadSaves(store) {
  for (let name of await store.keys()) {
    if (name.match(/\.sv$/i)) {
      downloadFile(store, name);
    }
  }
}

const readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.onabort = () => reject();
  reader.readAsArrayBuffer(file);
});
async function uploadFile(store, files, file) {
  const data = new Uint8Array(await readFile(file));
  files.set(file.name.toLowerCase(), data);
  return store.set(file.name.toLowerCase(), data);
}

export default async function create_fs(load) {
  try {
    const store = new IdbKvStore('diablo_fs');
    const files = new Map();
    for (let [name, data] of Object.entries(await store.json())) {
      files.set(name, data);
    }
    /*if (load) {
      const files = await importStorage();
      if (files) {
        for (let [name, data] of files) {
          files.set(name, data);
          store.set(name, data);
        }
      }
    }*/
    window.DownloadFile = name => downloadFile(store, name);
    window.DownloadSaves = () => downloadSaves(store);
    return {
      files,
      update: (name, data) => store.set(name, data),
      delete: name => store.remove(name),
      clear: () => store.clear(),
      download: name => downloadFile(store, name),
      upload: file => uploadFile(store, files, file),
      fileUrl: async name => {
        const file = await store.get(name.toLowerCase());
        if (file) {
          const blob = new Blob([file], {type: 'binary/octet-stream'});
          return URL.createObjectURL(blob);
        }
      },
    };
  } catch (e) {
    window.DownloadFile = () => console.error('IndexedDB is not supported');
    window.DownloadSaves = () => console.error('IndexedDB is not supported');
    return {
      files: new Map(),
      update: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      download: () => Promise.resolve(),
      upload: () => Promise.resolve(),
      fileUrl: () => Promise.resolve(),
    };
  }  
}
