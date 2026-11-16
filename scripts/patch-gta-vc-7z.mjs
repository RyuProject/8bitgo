import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(repo, 'public/web/gta-vc')
const assets = resolve(root, 'assets')

function one(source, before, after, label) {
  if (source.includes(after)) return source
  const count = source.split(before).length - 1
  assert.equal(count, 1, `${label} 匹配到 ${count} 处，拒绝改写上游运行时`)
  return source.replace(before, after)
}

function hashName(prefix, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10)
  return `${prefix}-${hash}.js`
}

function patchExpandedImg(worker) {
  const before = String.raw`function gr(e){let t=e.find(e=>/(^|\/)models\/gta3\.img$/i.test(e));if(!t)return null;let n=t.slice(0,t.length-15),r=new Map;for(let t of e)t.toLowerCase().startsWith(n.toLowerCase())&&r.set(t.slice(n.length).toLowerCase(),t);return r}`
  const previous = String.raw`function gr(e){let __8bgExpandedImg=/(^|\/)models\/gta3\.img(?:\/|$)/i,t=e.find(e=>__8bgExpandedImg.test(e));if(!t)return null;let r=__8bgExpandedImg.exec(t),n=t.slice(0,r.index+(r[1]?1:0)),i=new Map;for(let r of e)r.toLowerCase().startsWith(n.toLowerCase())&&i.set(r.slice(n.length).toLowerCase(),r);for(let e of["models/gta3.img","anim/cuts.img"])if(!i.has(e)){let t=[...i].find(([t])=>t.startsWith(e+"/"));t&&i.set(e,t[1])}return i}`
  const previousPatched = String.raw`function gr(e){let __8bgExpandedImg=/(^|\/)models\/gta3\.img(?:\/|$)/i,t=e.find(e=>__8bgExpandedImg.test(e));if(!t)return null;let r=__8bgExpandedImg.exec(t),n=t.slice(0,r.index+(r[1]?1:0)),i=new Map;for(let r of e)r.toLowerCase().startsWith(n.toLowerCase())&&i.set(r.slice(n.length).toLowerCase(),r);let a=new Set;for(let e of["models/gta3.img","anim/cuts.img"])if(!i.has(e)){let t=[...i].find(([t])=>t.startsWith(e+"/"));t&&(i.set(e,t[1]),a.add(e.split("/").pop()))}return i.expandedImgFiles=a,i}`
  const after = String.raw`function gr(e){let __8bgExpandedImg=/(^|\/)models\/gta3\.img(?:\/|$)/i,t=e.find(e=>__8bgExpandedImg.test(e));if(!t)return null;let r=__8bgExpandedImg.exec(t),n=t.slice(0,r.index+(r[1]?1:0)),i=new Map;for(let r of e)r.toLowerCase().startsWith(n.toLowerCase())&&i.set(r.slice(n.length).toLowerCase(),r);let a=new Set;for(let e of["models/gta3.img","anim/cuts.img","audio/sfx.raw"])if(!i.has(e)){let t=[...i].find(([t])=>t.startsWith(e+"/"));t&&(i.set(e,t[1]),a.add(e.split("/").pop()))}return i.expandedContainerFiles=a,i}`
  let result = worker.includes(after) ? worker : worker.includes(previousPatched)
    ? worker.replace(previousPatched, after)
    : worker.includes(previous)
      ? worker.replace(previous, after)
      : one(worker, before, after, 'IMG / 音频目录路径识别')

  const oldHashCheck = 'async function _r(e,t){let n=hr.filter(t=>!e.has(t)),r=[];'
  const priorHashCheck = 'async function _r(e,t){let __8bgExpandedImgFiles=e.expandedImgFiles,n=hr.filter(t=>!e.has(t)),r=[];'
  const newHashCheck = 'async function _r(e,t){let __8bgExpandedContainerFiles=e.expandedContainerFiles,n=hr.filter(t=>!e.has(t)),r=[];'
  if (result.includes(priorHashCheck)) result = result.replace(priorHashCheck, newHashCheck)
  else result = one(result, oldHashCheck, newHashCheck, '展开目录完整文件校验')
  result = one(result,
    'if(__8bgExpandedImgFiles?.has(e))continue;',
    'if(__8bgExpandedContainerFiles?.has(e))continue;',
    '展开容器跳过单文件哈希')

  result = one(result,
    's=new Set(u.dataFiles),c=new Set(u.revcFiles),l=new Map;for(let t of mr){',
    's=new Set(u.dataFiles),c=new Set(u.revcFiles),l=new Map,__8bgIndex=t;for(let t of mr){',
    '展开 IMG 路径索引')

  const oldReader = String.raw`for(let t of mr){let n=er(await e.read(o(t.dir)));for(let e of n)l.set(t.prefix+e.name,{img:t.img,...e})}let d=t=>e.readRange(o(t.img),t.offset,t.size)`
  const previousReader = String.raw`for(let t of mr){let n=er(await e.read(o(t.dir)));for(let e of n){let r=(t.prefix+e.name).toLowerCase(),i=t.get(r);l.set(r,{img:t.img,...e,path:i,expanded:Boolean(i)})}}let d=t=>t.expanded?e.read(o(t.path)):e.readRange(o(t.img),t.offset,t.size)`
  const newReader = String.raw`for(let t of mr){let n=er(await e.read(o(t.dir)));for(let e of n){let r=(t.prefix+e.name).toLowerCase(),i=__8bgIndex.has(r);l.set(r,{img:t.img,...e,path:r,expanded:i})}}let d=t=>t.expanded?e.read(o(t.path)):e.readRange(o(t.img),t.offset,t.size)`
  result = result.includes(newReader) ? result : result.includes(previousReader)
    ? result.replace(previousReader, newReader)
    : one(result, oldReader, newReader, 'IMG 成员读取路径')

  const oldAudioList = 'f=[...t.keys()].filter(e=>e.startsWith(`audio/`)&&/\\.(wav|mp3|adf)$/.test(e)&&!s.has(e)),p=await e.read(o(`audio/sfx.sdt`))'
  const priorAudioList = 'let __8bgExpandedRawAudio=[...t.keys()].some(e=>/^audio\\/sfx\\.raw\\/\\d+\\.mp3$/i.test(e)),f=[...t.keys()].filter(e=>e.startsWith(`audio/`)&&/\\.(wav|mp3|adf)$/.test(e)&&!s.has(e)&&!(__8bgExpandedRawAudio&&/^audio\\/sfx\\.raw\\/\\d+\\.mp3$/i.test(e))),p=await e.read(o(`audio/sfx.sdt`))'
  const newAudioList = '__8bgExpandedRawAudio=[...t.keys()].some(e=>/^audio\\/sfx\\.raw\\/\\d+\\.mp3$/i.test(e)),f=[...t.keys()].filter(e=>e.startsWith(`audio/`)&&/\\.(wav|mp3|adf)$/.test(e)&&!s.has(e)&&!(__8bgExpandedRawAudio&&/^audio\\/sfx\\.raw\\/\\d+\\.mp3$/i.test(e))),p=await e.read(o(`audio/sfx.sdt`))'
  result = result.includes(newAudioList) ? result : result.includes(priorAudioList)
    ? result.replace(priorAudioList, newAudioList)
    : one(result, oldAudioList, newAudioList, '展开的 MP3 音效目录识别')
  // 旧版测试补丁曾把 let 插进同一条逗号声明里；改为函数作用域的普通变量。
  result = result.replace(',let __8bgExpandedRawAudio=', ',__8bgExpandedRawAudio=')

  const syncMp3 = 'function pr(e,t){let n=ar(t),r=or(e,t,n),i=new Qn(1,n,fr(n)),a=[],o=1152*16;for(let e=0;e<r.length;e+=o){let t=i.encodeBuffer(r.subarray(e,e+o));t.length&&a.push(t)}let s=i.flush();'
  const asyncMp3 = 'async function pr(e,t){let n=ar(t),r=or(e,t,n),i=new Qn(1,n,fr(n)),a=[],o=1152*16;for(let e=0;e<r.length;e+=o){let t=i.encodeBuffer(r.subarray(e,e+o));t.length&&a.push(t);await new Promise(resolve=>setTimeout(resolve,0))}let s=i.flush();'
  result = one(result, syncMp3, asyncMp3, 'MP3 转换期间让出 Worker 事件循环')
  result = result.replace(
    'async()=>pr(dr(await e.readRange(S,n,r)),i).bytes',
    'async()=>(await pr(dr(await e.readRange(S,n,r)),i)).bytes')
  result = result.replace('return pr(i,r).bytes', 'return(await pr(i,r)).bytes')

  const oldWavReader = 'for(let t of f)await b(t,async()=>{let n=await e.read(o(t));if(t.endsWith(`.adf`))return tr(n);if(!t.endsWith(`.wav`))return n;let{rate:r,samples:i}=ur(n);return(await pr(i,r)).bytes})'
  const newWavReader = 'for(let t of f)await b(t,async()=>{let n=await e.read(o(t));if(t.endsWith(`.adf`))return tr(n);if(!t.endsWith(`.wav`)||n[0]===73&&n[1]===68&&n[2]===51)return n;let{rate:r,samples:i}=ur(n);return(await pr(i,r)).bytes})'
  result = one(result, oldWavReader, newWavReader, '直拷带 ID3 标记的 WAV 扩展名 MP3')

  const oldSfxLoop = 'x=m.map(e=>ar(e.rate)),S=o(`audio/sfx.raw`);for(let t=0;t<m.length;t++){let{offset:n,size:r,rate:i}=m[t];await b(`audio/sfx.raw/${t}.mp3`,async()=>(await pr(dr(await e.readRange(S,n,r)),i)).bytes)}'
  const newSfxLoop = 'x=m.map(e=>ar(e.rate)),S=__8bgExpandedRawAudio?null:o(`audio/sfx.raw`);for(let t=0;t<m.length;t++){let{offset:n,size:r,rate:i}=m[t];await b(`audio/sfx.raw/${t}.mp3`,async()=>__8bgExpandedRawAudio?await e.read(o(`audio/sfx.raw/${t}.mp3`)):(await pr(dr(await e.readRange(S,n,r)),i)).bytes)}'
  result = result.includes(newSfxLoop) ? result : one(result, oldSfxLoop, newSfxLoop, '复用已编码 MP3 音效')

  const oldCleanup = `}finally{clearInterval(t)}}})();`
  const brokenCleanup = `}finally{clearInterval(t);if(typeof e.data?.cleanupRoot==="string"&&/^_gta_vc_7z_[0-9a-f-]{36}$/i.test(e.data.cleanupRoot)){try{await c(await navigator.storage.getDirectory(),e.data.cleanupRoot)}catch(r){console.warn("[convert] 临时 7z 清理失败",r)}}}})();`
  const newCleanup = `}finally{clearInterval(t);if(typeof e.data?.cleanupRoot==="string"&&/^_gta_vc_7z_[0-9a-f-]{36}$/i.test(e.data.cleanupRoot)){try{await c(await navigator.storage.getDirectory(),e.data.cleanupRoot)}catch(r){console.warn("[convert] 临时 7z 清理失败",r)}}}}})();`
  result = result.includes(newCleanup) ? result : result.includes(brokenCleanup)
    ? result.replace(brokenCleanup, newCleanup)
    : one(result, oldCleanup, newCleanup, '7z 临时文件清理')
  return result
}

function patchConverterApp(app, oldWorkerName, newWorkerName) {
  const zipOnly = 'if(!/\\.zip$/i.test(e.name)){h(`errors.notZip`);return}x({kind:`zip`,file:e})'
  const zipAnd7z = 'if(/\\.7z$/i.test(e.name)){window.dispatchEvent(new CustomEvent("8bg-gta-vc-7z-file",{detail:{file:e}}));return}if(!/\\.zip$/i.test(e.name)){h(`errors.notZip`);return}x({kind:`zip`,file:e})'
  let result = one(app, zipOnly, zipAnd7z, '拖放 .7z 文件入口')

  const folderInput = 'C=(e,t)=>{Y(f,e),x({kind:`folder`,entries:t})};t.addEventListener(`change`'
  const folderEvent = 'C=(e,t,r)=>{Y(f,e),x({kind:`folder`,entries:t,cleanupRoot:r})};window.addEventListener("8bg-gta-vc-import-folder",e=>{let t=e.detail;t&&C(t.root,t.entries,t.cleanupRoot)});t.addEventListener(`change`'
  result = one(result, folderInput, folderEvent, '7z 解包目录接入转换器')

  const progressInput = String.raw`n.onmessage=async e=>{let t=e.data;if(d(),`
  const progressEvent = String.raw`n.onmessage=async e=>{let t=e.data;window.dispatchEvent(new CustomEvent("8bg-gta-vc-convert-status",{detail:t}));if(d(),`
  result = one(result, progressInput, progressEvent, '转换状态通知')

  const unsupported = 'g(`status.unsupported`,`error`),h(`errors.apis`);return'
  const unsupportedNotified = 'g(`status.unsupported`,`error`),h(`errors.apis`);window.dispatchEvent(new CustomEvent("8bg-gta-vc-setup",{detail:{ready:false}}));return'
  if (!result.includes(unsupportedNotified)) {
    result = one(result, unsupported, unsupportedNotified, '不支持环境通知自动加载器')
  }

  const serviceWorkerFailed = 'g(`status.loadFailed`,`error`),h(`errors.serviceWorker`,{message:e.message});return'
  const serviceWorkerFailedNotified = 'g(`status.loadFailed`,`error`),h(`errors.serviceWorker`,{message:e.message});window.dispatchEvent(new CustomEvent("8bg-gta-vc-setup",{detail:{ready:false}}));return'
  if (!result.includes(serviceWorkerFailedNotified)) {
    result = one(result, serviceWorkerFailed, serviceWorkerFailedNotified, 'Service Worker 错误通知自动加载器')
  }

  const setupComplete = '),w){g(`status.ready`,`ready`),_(!0),o.style.display=`none`;return}g(`status.missing`,`missing`),console.log(`[setup] waiting for file selection`)'
  const setupCompleteNotified = '),w){g(`status.ready`,`ready`),_(!0),o.style.display=`none`,window.dispatchEvent(new CustomEvent("8bg-gta-vc-setup",{detail:{ready:true}}));return}g(`status.missing`,`missing`),window.dispatchEvent(new CustomEvent("8bg-gta-vc-setup",{detail:{ready:false}})),console.log(`[setup] waiting for file selection`)'
  if (!result.includes(setupCompleteNotified)) {
    result = one(result, setupComplete, setupCompleteNotified, '已有资源检查结果通知自动加载器')
  }

  if (oldWorkerName !== newWorkerName) {
    result = result.replace(/\/assets\/worker-[\w-]+\.js/g, `/assets/${newWorkerName}`)
  }
  return result
}

const workerName = readdirSync(assets).find((file) => /^worker-[\w-]+\.js$/.test(file))
const appName = readdirSync(assets).find((file) => /^index-[\w-]+\.js$/.test(file))
assert.ok(workerName && appName, 'GTA VC 缺少上游 app / converter worker')

const oldWorkerPath = resolve(assets, workerName)
const workerSource = readFileSync(oldWorkerPath, 'utf8')
const patchedWorker = patchExpandedImg(workerSource)
const nextWorkerName = hashName('worker', patchedWorker)
const nextWorkerPath = resolve(assets, nextWorkerName)
if (nextWorkerName !== workerName) {
  writeFileSync(nextWorkerPath, patchedWorker)
  renameSync(oldWorkerPath, `${oldWorkerPath}.old`)
  const oldPath = `${oldWorkerPath}.old`
  // 在同目录先写入完整的新内容，再删除旧哈希文件，避免留下两份可被构建选中的 Worker。
  const fs = await import('node:fs/promises')
  await fs.unlink(oldPath)
}

const oldAppPath = resolve(assets, appName)
const appSource = readFileSync(oldAppPath, 'utf8')
const patchedApp = patchConverterApp(appSource, workerName, nextWorkerName)
const nextAppName = hashName('index', patchedApp)
const nextAppPath = resolve(assets, nextAppName)
if (nextAppName !== appName) {
  writeFileSync(nextAppPath, patchedApp)
  renameSync(oldAppPath, `${oldAppPath}.old`)
  const fs = await import('node:fs/promises')
  await fs.unlink(`${oldAppPath}.old`)
}

const indexPath = resolve(root, 'index.html')
let index = readFileSync(indexPath, 'utf8')
index = one(index, `/assets/${appName}`, `/assets/${nextAppName}`, 'HTML 主入口脚本')
writeFileSync(indexPath, index)
console.log(`GTA VC 7z 转换补丁已应用：${nextAppName} / ${nextWorkerName}`)
