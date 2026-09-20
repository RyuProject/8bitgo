import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { load, stubs } from './helpers/target.mjs'
process.env.J2ME_UPLOAD_CONCURRENCY='1'
process.env.J2ME_PROXY_CONCURRENCY='1'
process.env.J2ME_PROXY_TIMEOUT_MS='30'
let releaseWrite
const pending=new Promise(resolve=>{releaseWrite=resolve})
globalThis.__jarStore={put:()=>pending,remove:async()=>true,touch:async()=>false,sweep:async()=>0}
stubs({'temporary-jar-store.js':`export class TemporaryJarStore{constructor(){return globalThis.__jarStore}}`,'site-urls.js':`export const assetBaseUrl=()=> 'https://local-test.invalid'`})
const j2me=await load('src/j2me.js')
const jar=await readFile(new URL('./fixtures/minimal.jar',import.meta.url))
function response(){const r=new EventEmitter();r.statusCode=200;r.headers={};r.setHeader=(k,v)=>{r.headers[k]=v};r.status=n=>{r.statusCode=n;return r};r.json=v=>{r.data=v;return r};r.send=r.json;r.end=r.json;return r}
const req=()=>({body:jar,ip:'203.0.113.7',headers:{}})
test('disconnect does not release upload capacity while disk mutation still holds a buffer',async()=>{
 const a=req(),ra=response();let accepted=false;j2me.uploadGate(a,ra,()=>{accepted=true});assert.ok(accepted)
 const task=j2me.uploadJar(a,ra);ra.destroyed=true;ra.emit('close')
 const rb=response();j2me.uploadGate(req(),rb,()=>assert.fail('accepted during outstanding write'));assert.equal(rb.statusCode,503)
 releaseWrite(`tmp-${'a'.repeat(32)}.jar`);await task
 const rc=response();accepted=false;j2me.uploadGate(req(),rc,()=>{accepted=true});assert.ok(accepted);rc.emit('close')
})
test('proxy deadline aborts a stalled response body and releases concurrency',async()=>{
 const original=globalThis.fetch;let cancelled=0
 globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled++}}))
 // Keep the test alive; AbortSignal.timeout intentionally has an unref'ed timer.
 const keep=setTimeout(()=>{},500)
 try{
  const r=response();await j2me.j2meJarProxy({params:{name:'a.jad'},headers:{}},r);assert.equal(r.statusCode,504);assert.equal(cancelled,1)
  globalThis.fetch=async()=>new Response('ok');const next=response();await j2me.j2meJarProxy({params:{name:'a.jad'},headers:{}},next);assert.equal(next.statusCode,200)
 }finally{clearTimeout(keep);globalThis.fetch=original}
})
test('downstream disconnect cancels outstanding remote fetch',async()=>{
 const original=globalThis.fetch;let signal
 globalThis.fetch=async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({}))}
 const r=response();const task=j2me.j2meJarProxy({params:{name:'a.jad'},headers:{}},r)
 await new Promise(setImmediate);r.destroyed=true;r.emit('close');await task
 assert.equal(signal.aborted,true);globalThis.fetch=original
})
