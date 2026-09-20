/**
 * Structural performance measurements using fixtures: operation count and materialization.
 * No simulated network delay; no invented cloud latency/FPS/peak-memory measurements.
 */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import oldWorker from './original/rom.js'
import fixedWorker from '../src/index.js'
import { environment,req,count,streamChunks } from './fixtures.mjs'
const data={environment:{node:process.version,storage:'in-memory R2 contract fixture',network:'none',metrics:'counts; not wall-clock or cloud measurements'},samples:[]}
for(const [name,worker] of [['original',oldWorker],['fixed',fixedWorker]]){
  for(const mixed of [false,true]){
    const e=environment();const keys=Array.from({length:1000},(_,i)=>(mixed&&i>=500?'covers/':'roms/')+i)
    const r=await worker.fetch(req('/bulk','POST',{keys},{},true),e);assert.equal(r.status,200)
    data.samples.push({version:name,scenario:mixed?'bulk_500_roms_500_covers':'bulk_1000_roms',r2DeleteCalls:count(e.ROMS,'delete')+count(e.COVERS,'delete')})
  }
  const e=environment();const session=await(await worker.fetch(req('/a?uploads','POST',{}, {},true),e)).json()
  const stats={};const chunk=new Uint8Array(65536);const body=streamChunks(Array.from({length:128},()=>chunk),stats)
  const request=req('/a?uploadId='+session.uploadId+'&partNumber=1','PUT',body,{'Content-Length':'8388608'},true)
  let materialized=0,readBeforeR2=null
  const originalArrayBuffer=request.arrayBuffer.bind(request)
  request.arrayBuffer=async()=>{materialized++;return originalArrayBuffer()}
  const resume=e.ROMS.resumeMultipartUpload.bind(e.ROMS)
  e.ROMS.resumeMultipartUpload=(...args)=>{const u=resume(...args);const p=u.uploadPart;u.uploadPart=async(...values)=>{readBeforeR2=stats.pulls||0;return p(...values)};return u}
  const r=await worker.fetch(request,e);assert.equal(r.status,200)
  data.samples.push({version:name,scenario:'8MiB_known_length_part',requestArrayBufferCalls:materialized,inputChunksReadBeforeR2UploadPart:readBeforeR2,totalInputChunks:stats.pulls,r2ReceivedReadableStream:e.ROMS.stats.streamWrites===1})
}
console.log(JSON.stringify(data,null,2))
await fs.writeFile(new URL('../audit/performance-counts.json',import.meta.url),JSON.stringify(data,null,2)+'\n')
