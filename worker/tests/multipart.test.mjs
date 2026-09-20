import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import { environment, req, count, streamChunks, bytes } from './fixtures.mjs'
async function create(e, key='roms/a', body={}) {
  const r=await worker.fetch(req('/'+key+'?uploads','POST',body,{},true),e)
  assert.equal(r.status,200);return r.json()
}
async function part(e, session, data='abc') {
  const r=await worker.fetch(req('/'+session.key+'?uploadId='+session.uploadId+'&partNumber=1','PUT',data,{'Content-Length':String(bytes(data).length)},true),e)
  assert.equal(r.status,200);return r.json()
}
test('multipart complete preserves bytes, metadata and original success fields',async()=>{
  const e=environment();const s=await create(e,'covers/a.webp',{contentType:'image/webp',size:3,name:'封面.webp'});assert(s.marker.startsWith('_uploads/v2-'))
  const p=await part(e,s)
  const r=await worker.fetch(req('/'+s.key+'?uploadId='+s.uploadId,'POST',{parts:[p],marker:s.marker},{},true),e)
  assert.equal(r.status,200);const j=await r.json();assert(j.ok);assert(j.markerRemoved);assert.equal(j.size,3)
  assert.equal(new TextDecoder().decode(e.COVERS.objects.get(s.key).data),'abc');assert(!e.COVERS.objects.has(s.marker));assert.equal(e.COVERS.objects.get(s.key).httpMetadata.contentType,'image/webp')
})
test('known-length part is streamed; Request.arrayBuffer is never called',async()=>{
  const e=environment();const s=await create(e);const r=req('/roms/a?uploadId='+s.uploadId+'&partNumber=1','PUT','abc',{'Content-Length':'3'},true)
  r.arrayBuffer=()=>{throw Error('must not buffer known-length part')}
  assert.equal((await worker.fetch(r,e)).status,200);assert.equal(e.ROMS.stats.streamWrites,1)
})
test('unknown-length part remains compatible via bounded fallback',async()=>{
  const e=environment();const s=await create(e);const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&partNumber=1','PUT',streamChunks([bytes('abc')]),{},true),e)
  assert.equal(r.status,200);assert.equal(e.ROMS.uploads.get(s.uploadId).parts.get(1).data.length,3)
})
test('unknown oversized part cancels at limit, never consumes arbitrary body to EOF',async()=>{
  const e=environment();const s=await create(e);const stats={};const chunk=new Uint8Array(17*1024*1024)
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&partNumber=1','PUT',streamChunks([chunk,chunk,chunk],stats),{},true),e)
  assert.equal(r.status,413);assert.equal(stats.pulls,2);assert(stats.cancelled);assert.equal(count(e.ROMS,'uploadPart'),0)
})
for (const n of ['0','10001','1.2','nope']) test('partNumber validation '+n,async()=>{
  const e=environment();const s=await create(e);const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&partNumber='+n,'PUT','a',{},true),e);assert.equal(r.status,400)
})
test('empty part rejected',async()=>{
  const e=environment();const s=await create(e);const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&partNumber=1','PUT','',{'Content-Length':'0'},true),e);assert.equal(r.status,400)
})
test('transient uploadPart failures are retryable 503, not fatal 409',async()=>{
  const e=environment();const s=await create(e);e.ROMS.fail.uploadPart=Error('temporary R2 outage')
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&partNumber=1','PUT','abc',{},true),e);assert.equal(r.status,503)
  const j=await r.json();assert.equal(j.fatal,false);assert.equal(j.retryable,true);assert(e.ROMS.objects.has(s.marker))
})
test('explicit NoSuchUpload is fatal 409',async()=>{
  const e=environment();const r=await worker.fetch(req('/roms/a?uploadId=missing&partNumber=1','PUT','abc',{},true),e)
  assert.equal(r.status,409);assert.equal((await r.json()).fatal,true)
})
test('transient complete failures preserve multipart session and marker',async()=>{
  const e=environment();const s=await create(e);const p=await part(e,s);e.ROMS.fail.complete=Error('temporary')
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId,'POST',{parts:[p],marker:s.marker},{},true),e)
  assert.equal(r.status,503);assert.equal((await r.json()).fatal,false);assert(e.ROMS.objects.has(s.marker));assert(e.ROMS.uploads.has(s.uploadId))
})
test('abort failure retains marker and reports failure instead of success',async()=>{
  const e=environment();const s=await create(e);e.ROMS.fail.abort=Error('temporary')
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&marker='+encodeURIComponent(s.marker),'DELETE',undefined,{},true),e)
  assert.equal(r.status,503);const j=await r.json();assert.equal(j.ok,false);assert.equal(j.markerRemoved,false);assert(e.ROMS.objects.has(s.marker))
})
test('explicit nonexistent upload abort still cleans matching marker',async()=>{
  const e=environment();const s=await create(e);e.ROMS.uploads.delete(s.uploadId)
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId+'&marker='+encodeURIComponent(s.marker),'DELETE',undefined,{},true),e)
  assert.equal(r.status,200);assert(!e.ROMS.objects.has(s.marker))
})
test('supplied unrelated marker cannot delete another upload ledger',async()=>{
  const e=environment();const a=await create(e,'a'),b=await create(e,'b');const p=await part(e,a)
  const r=await worker.fetch(req('/a?uploadId='+a.uploadId,'POST',{parts:[p],marker:b.marker},{},true),e)
  assert.equal(r.status,200);assert(e.ROMS.objects.has(b.marker));assert(!e.ROMS.objects.has(a.marker))
})
test('legacy random markers are verified, and missing client marker scans beyond first page',async()=>{
  const e=environment(false,2);const s=await create(e);const m=e.ROMS.objects.get(s.marker);e.ROMS.objects.delete(s.marker)
  for(let i=0;i<5;i++)e.ROMS.seed('_uploads/a'+i+'.marker','',{customMetadata:{key:'other',uploadId:'other'}})
  e.ROMS.seed('_uploads/zzzz.marker','',{customMetadata:m.customMetadata});const p=await part(e,s)
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId,'POST',{parts:[p]},{},true),e)
  assert.equal(r.status,200);assert.equal((await r.json()).markerRemoved,true);assert(!e.ROMS.objects.has('_uploads/zzzz.marker'));assert.equal(count(e.ROMS,'list'),3)
})
test('v2 marker cleanup uses point lookup, not bucket scans',async()=>{
  const e=environment();const s=await create(e);const p=await part(e,s)
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId,'POST',{parts:[p]},{},true),e)
  assert.equal((await r.json()).markerRemoved,true);assert.equal(count(e.ROMS,'list'),0);assert.equal(count(e.COVERS,'list'),0)
})
test('legacy scan budget exhaustion returns markerRemoved=false, never false success',async()=>{
  const e=environment(false,1);const s=await create(e);const m=e.ROMS.objects.get(s.marker);e.ROMS.objects.delete(s.marker)
  for(let i=0;i<30;i++)e.ROMS.seed('_uploads/a'+i,'',{customMetadata:{key:'other',uploadId:'other'}})
  e.ROMS.seed('_uploads/zzzz','',{customMetadata:m.customMetadata});const p=await part(e,s)
  const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId,'POST',{parts:[p]},{},true),e)
  const j=await r.json();assert.equal(j.ok,true);assert.equal(j.markerRemoved,false);assert(e.ROMS.objects.has('_uploads/zzzz'))
})
test('marker write failure aborts newly created session',async()=>{
  const e=environment();e.ROMS.fail.put=Error('temporary');const r=await worker.fetch(req('/a?uploads','POST',{}, {},true),e)
  assert.equal(r.status,503);assert.equal(e.ROMS.uploads.size,0);assert.equal(count(e.ROMS,'abort'),1)
})
test('marker write AND abort failure returns recoverable upload identity',async()=>{
  const e=environment();e.ROMS.fail.put=Error('temporary');e.ROMS.fail.abort=Error('temporary');const r=await worker.fetch(req('/a?uploads','POST',{}, {},true),e)
  const j=await r.json();assert.equal(r.status,503);assert(j.cleanupRequired);assert(j.uploadId);assert(j.marker);assert(e.ROMS.uploads.has(j.uploadId))
})
test('multipart listing advances independent cursors in both buckets',async()=>{
  const e=environment(true,2);for(let i=0;i<5;i++)for(const b of [e.ROMS,e.COVERS])b.seed('_uploads/'+i,'',{customMetadata:{key:b.name+'/'+i,uploadId:'u'+i}})
  const seen=new Set();let cursor,pages=0
  do{const j=await(await worker.fetch(req('/multipart'+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,{},true),e)).json()
    for(const o of j.uploads){const k=o.bucket+':'+o.marker;assert(!seen.has(k));seen.add(k)}cursor=j.cursor;assert(++pages<10)
  }while(cursor);assert.equal(seen.size,10);assert.equal(pages,3)
})
test('explicit marker-only delete never claims the multipart upload was aborted',async()=>{
  const e=environment();const s=await create(e);const r=await worker.fetch(req('/multipart?marker='+encodeURIComponent(s.marker),'DELETE',undefined,{},true),e)
  assert.equal(r.status,200);assert((await r.json()).markerOnly);assert(e.ROMS.uploads.has(s.uploadId));assert.equal(count(e.ROMS,'abort'),0)
})
test('invalid parts rejected without completing R2',async()=>{
  const e=environment();const s=await create(e)
  for(const parts of [[],[{partNumber:2,etag:'a'}],[{partNumber:1,etag:{}}],[{partNumber:1,etag:'a'},{partNumber:1,etag:'b'}]]){
    const r=await worker.fetch(req('/roms/a?uploadId='+s.uploadId,'POST',{parts},{},true),e);assert.equal(r.status,400)
  }assert.equal(count(e.ROMS,'complete'),0)
})
test('JSON request size is capped before multipart session creation',async()=>{
  const e=environment();const r=await worker.fetch(req('/a?uploads','POST',{name:'x'.repeat(20000)},{},true),e)
  assert.equal(r.status,413);assert.equal(count(e.ROMS,'createMultipartUpload'),0)
})

// Protect legitimate Unicode metadata against an unnecessarily narrow local cap.
test('long UTF-8 key and filename remain supported with a long upload identifier',async()=>{
  const e=environment(false)
  const key='a'.repeat(1024), id='u'.repeat(512)
  e.ROMS.createMultipartUpload=async(k,options)=>{
    e.ROMS.uploads.set(id,{key:k,options,parts:new Map()})
    return e.ROMS.resumeMultipartUpload(k,id)
  }
  const r=await worker.fetch(req('/'+key+'?uploads','POST',{name:'中'.repeat(200)},{},true),e)
  assert.equal(r.status,200)
  const result=await r.json()
  assert.equal(result.uploadId,id)
  assert.equal(e.ROMS.objects.get(result.marker).customMetadata.name,'中'.repeat(200))
})
