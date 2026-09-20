/** Differential evidence; ALL R2/fetch/ASSETS are local fixtures. No real remote requests. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import oldRom from './original/rom.js'
import oldEmbed from './original/embed.js'
import newRom from '../src/index.js'
import newEmbed from '../embed-vc/src/index.js'
import { environment,req,count,streamChunks,bytes } from './fixtures.mjs'
const results=[]
async function compare(id,scenario) {
  const before=await scenario(oldRom,oldEmbed)
  const after=await scenario(newRom,newEmbed)
  results.push({id,before,after})
}
async function localFetch(fn,action) {
  const saved=globalThis.fetch;globalThis.fetch=fn
  try{return await action()}finally{globalThis.fetch=saved}
}
const proxyEnv={VCSKY_UPSTREAM:'https://trusted.test/vcsky/',VCBR_UPSTREAM:'https://br.trusted.test/vcsky/',BASE_PATH:'/embed/vc',UPSTREAM_CACHE_TTL:'86400'}
async function make(worker,e,key='a') {
  return (await worker.fetch(req('/'+key+'?uploads','POST',{}, {},true),e)).json()
}
async function upload(worker,e,s) {
  return (await worker.fetch(req('/'+s.key+'?uploadId='+s.uploadId+'&partNumber=1','PUT','abc',{'Content-Length':'3'},true),e)).json()
}
await compare('P01_proxy_absolute_target',async(rom,embed)=>{
  const targets=[];let status
  await localFetch(async url=>{targets.push(url);return new Response('mock')},async()=>{
    status=(await embed.fetch(req('/vcsky/https://untrusted.test/arbitrary'),proxyEnv)).status
  });return {status,targets}
})
await compare('P02_proxy_query_preservation',async(rom,embed)=>{
  const targets=[];await localFetch(async url=>{targets.push(url);return new Response('mock')},async()=>{await embed.fetch(req('/vcsky/a.dat?v=2&signature=test'),proxyEnv)});return targets
})
await compare('P03_proxy_error_cache',async(rom,embed)=>{
  let options,out
  await localFetch(async(url,opts)=>{options=opts.cf;return new Response('unavailable',{status:503})},async()=>{
    const r=await embed.fetch(req('/vcsky/a.dat'),proxyEnv);out={status:r.status,cacheControl:r.headers.get('Cache-Control')}
  });return {...out,cf:options}
})
await compare('P04_if_range_changed',async worker=>{
  const e=environment();e.ROMS.seed('a','new-content');const r=await worker.fetch(req('/a','GET',undefined,{Range:'bytes=4-','If-Range':'"old"'}),e)
  return {status:r.status,body:await r.text()}
})
await compare('P05_if_match',async worker=>{
  const e=environment();e.ROMS.seed('a','abc');const r=await worker.fetch(req('/a','GET',undefined,{'If-Match':'"wrong"'}),e);return {status:r.status}
})
await compare('P06_suffix_range',async worker=>{
  const e=environment();e.ROMS.seed('a','abcdef');const r=await worker.fetch(req('/a','GET',undefined,{Range:'bytes=-2'}),e)
  return {status:r.status,body:await r.text(),contentLength:r.headers.get('Content-Length'),contentRange:r.headers.get('Content-Range')}
})
await compare('P07_conditional_HEAD',async worker=>{
  const e=environment();const o=e.ROMS.seed('a','abc');return {status:(await worker.fetch(req('/a','HEAD',undefined,{'If-None-Match':o.httpEtag}),e)).status}
})
await compare('P08_malformed_url',async worker=>{
  try{return {status:(await worker.fetch(req('/%GG'),environment())).status}}catch(e){return {uncaught:e.name}}
})
await compare('P09_empty_upload_id_DELETE',async worker=>{
  const e=environment();e.ROMS.seed('a','important');const r=await worker.fetch(req('/a?uploadId=','DELETE',undefined,{},true),e)
  return {status:r.status,finalObjectStillExists:e.ROMS.objects.has('a')}
})
await compare('P10_cover_resurrection',async worker=>{
  const e=environment();e.ROMS.seed('covers/a.png','old');e.COVERS.seed('covers/a.png','new')
  const r=await worker.fetch(req('/covers/a.png','DELETE',undefined,{},true),e)
  return {deleteStatus:r.status,subsequentGet:(await worker.fetch(req('/covers/a.png'),e)).status,legacyCopyRemains:e.ROMS.objects.has('covers/a.png')}
})
await compare('P11_dual_bucket_pagination',async worker=>{
  const e=environment(true,2);for(let i=0;i<5;i++){e.ROMS.seed('roms/'+i);e.COVERS.seed('covers/'+i)}
  let cursor,seen=0,pages=0,error
  try{do{const r=await worker.fetch(req('/list'+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,{},true),e)
    const j=await r.json();if(!r.ok){error=j.error;break}seen+=j.objects.length;pages++;cursor=j.cursor
  }while(cursor&&pages<10)}catch(e){error=e.message}
  return {seen,pages,error:error||null}
})
await compare('P12_transient_abort',async worker=>{
  const e=environment();const s=await make(worker,e);e.ROMS.fail.abort=Error('temporary service failure')
  const r=await worker.fetch(req('/a?uploadId='+s.uploadId+'&marker='+encodeURIComponent(s.marker),'DELETE',undefined,{},true),e)
  const j=await r.json();return {status:r.status,ok:j.ok,markerRemains:e.ROMS.objects.has(s.marker),activeUploadRemains:e.ROMS.uploads.has(s.uploadId)}
})
await compare('P13_transient_part_failure',async worker=>{
  const e=environment();const s=await make(worker,e);e.ROMS.fail.uploadPart=Error('temporary')
  const r=await worker.fetch(req('/a?uploadId='+s.uploadId+'&partNumber=1','PUT','abc',{},true),e)
  const j=await r.json();return {status:r.status,fatal:j.fatal,retryable:j.retryable||false}
})
await compare('P14_transient_complete_failure',async worker=>{
  const e=environment();const s=await make(worker,e);const p=await upload(worker,e,s);e.ROMS.fail.complete=Error('temporary')
  const r=await worker.fetch(req('/a?uploadId='+s.uploadId,'POST',{parts:[p],marker:s.marker},{},true),e)
  const j=await r.json();return {status:r.status,fatal:j.fatal,retryable:j.retryable||false}
})
await compare('P15_wrong_marker_cleanup',async worker=>{
  const e=environment();const a=await make(worker,e,'a'),b=await make(worker,e,'b');const p=await upload(worker,e,a)
  const r=await worker.fetch(req('/a?uploadId='+a.uploadId,'POST',{parts:[p],marker:b.marker},{},true),e)
  return {status:r.status,unrelatedMarkerRemains:e.ROMS.objects.has(b.marker),ownMarkerRemains:e.ROMS.objects.has(a.marker)}
})
await compare('P16_cleanup_after_first_page',async worker=>{
  const e=environment(false,2);const s=await make(worker,e);const record=e.ROMS.objects.get(s.marker);e.ROMS.objects.delete(s.marker)
  for(let i=0;i<5;i++)e.ROMS.seed('_uploads/a'+i,'',{customMetadata:{key:'other',uploadId:'other'}})
  e.ROMS.seed('_uploads/zzzz','',{customMetadata:record.customMetadata});const p=await upload(worker,e,s)
  const r=await worker.fetch(req('/a?uploadId='+s.uploadId,'POST',{parts:[p]},{},true),e)
  const j=await r.json();return {claimedMarkerRemoved:j.markerRemoved,actualMarkerRemains:e.ROMS.objects.has('_uploads/zzzz')}
})
await compare('P17_unknown_length_single_PUT_limit',async worker=>{
  const e=environment();e.MAX_UPLOAD_MB='1';const stats={};const chunk=new Uint8Array(700000)
  const r=await worker.fetch(req('/a','PUT',streamChunks([chunk,chunk,chunk],stats),{},true),e)
  return {status:r.status,storedSize:e.ROMS.objects.get('a')?.size||0,chunksRead:stats.pulls,cancelled:!!stats.cancelled}
})
await compare('P18_bulk_delete_calls',async worker=>{
  const e=environment();const keys=Array.from({length:1000},(_,i)=>i<500?'roms/'+i:'covers/'+i)
  const r=await worker.fetch(req('/bulk','POST',{keys},{},true),e)
  return {status:r.status,romsCalls:count(e.ROMS,'delete'),coversCalls:count(e.COVERS,'delete'),totalCalls:count(e.ROMS,'delete')+count(e.COVERS,'delete')}
})
await compare('P19_HTML_transformation_headers',async(rom,embed)=>{
  const html='<html><head></head><body>test</body></html>'
  const e={...proxyEnv,ASSETS:{fetch:async()=>new Response(html,{headers:{'Content-Type':'text/html','Content-Length':String(bytes(html).length),'Content-Encoding':'gzip',ETag:'"old-html"'}})}}
  const r=await embed.fetch(req('/embed/vc/'),e);const body=await r.text()
  return {bodyBytes:bytes(body).length,contentLength:r.headers.get('Content-Length'),contentEncoding:r.headers.get('Content-Encoding'),etag:r.headers.get('ETag')}
})
await compare('P20_known_length_part_materialization',async worker=>{
  const e=environment();const s=await make(worker,e);let buffers=0
  const request=req('/a?uploadId='+s.uploadId+'&partNumber=1','PUT',new Uint8Array(8*1024*1024),{'Content-Length':String(8*1024*1024)},true)
  const base=request.arrayBuffer.bind(request);request.arrayBuffer=async()=>{buffers++;return base()}
  const r=await worker.fetch(request,e)
  return {status:r.status,requestArrayBufferCalls:buffers,r2ReceivedStream:e.ROMS.stats.streamWrites===1}
})
await compare('P21_missing_upload_id_overwrites_final_object',async worker=>{
  const e=environment();e.ROMS.seed('a','original-complete-file')
  const r=await worker.fetch(req('/a?partNumber=1','PUT','one-part',{},true),e)
  return {status:r.status,finalObject:new TextDecoder().decode(e.ROMS.objects.get('a').data)}
})
// Sanity checks that the experiment actually differentiates the intended behavior.
assert.equal(results[0].before.targets[0],'https://untrusted.test/arbitrary')
assert.equal(results[0].after.targets.length,0)
assert.equal(results.find(x=>x.id==='P18_bulk_delete_calls').before.totalCalls,1000)
assert.equal(results.find(x=>x.id==='P18_bulk_delete_calls').after.totalCalls,2)
const report={environment:{node:process.version,network:'mocked; no remote requests',storage:'in-memory API model; not native R2',streams:'Node WHATWG streams; workerd not installed'},results}
console.log(JSON.stringify(report,null,2))
await fs.mkdir(new URL('../audit/',import.meta.url),{recursive:true})
await fs.writeFile(new URL('../audit/differential-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
