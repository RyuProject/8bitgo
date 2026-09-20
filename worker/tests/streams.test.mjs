/**
 * FixedLengthStream SHIM tests. This is not the Cloudflare native implementation.
 * It exercises control flow, cancellation, and exact byte-count failures offline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeBody } from '../src/common.js'
import { req, bytes, streamChunks } from './fixtures.mjs'
class FixedLengthShim extends TransformStream {
  constructor(expected) {
    let total = 0
    super({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > expected) throw Error('too many bytes')
        controller.enqueue(chunk)
      },
      flush() { if (total !== expected) throw Error('too few bytes') },
    })
  }
}
async function withShim(fn) {
  const old=globalThis.FixedLengthStream;globalThis.FixedLengthStream=FixedLengthShim
  try{return await fn()}finally{if(old===undefined)delete globalThis.FixedLengthStream;else globalThis.FixedLengthStream=old}
}
test('known-length writer consumes FixedLengthStream with exact bytes (shim)',async()=>{
  await withShim(async()=>{
    const r=req('/a','PUT',streamChunks([bytes('ab'),bytes('cd')]),{'Content-Length':'4'})
    const result=await writeBody(r,32,async body=>new Response(body).text())
    assert.equal(result,'abcd')
  })
})
for(const [declared,payload] of [[5,'abc'],[2,'abc']])test('length mismatch rejected before writer commits (shim) '+declared,async()=>{
  await withShim(async()=>{
    let committed=false
    await assert.rejects(writeBody(req('/a','PUT',payload,{'Content-Length':String(declared)}),32,async body=>{await new Response(body).arrayBuffer();committed=true}))
    assert.equal(committed,false)
  })
})
test('upstream write failure before reading does not hang pumping (shim)',{timeout:2000},async()=>{
  await withShim(async()=>{
    const r=req('/a','PUT',streamChunks([bytes('abc')]),{'Content-Length':'3'})
    await assert.rejects(writeBody(r,32,async()=>{throw Error('storage failure')}),/storage failure/)
  })
})
