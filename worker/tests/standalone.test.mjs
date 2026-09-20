import test from 'node:test'
import assert from 'node:assert/strict'
import modular from '../src/index.js'
import standalone from '../standalone/rom-worker.js'
import embed from '../standalone/embed-worker.js'
import { environment,req } from './fixtures.mjs'
test('single-file bundle matches modular ROM responses and bytes',async()=>{
  for(const [path,method,headers] of [['/a','GET',{}],['/a','GET',{Range:'bytes=-2'}],['/a','HEAD',{}],['/%GG','GET',{}],['/a?uploadId=','DELETE',{}]]){
    const e1=environment(),e2=environment();e1.ROMS.seed('a','abcdef');e2.ROMS.seed('a','abcdef')
    const a=await modular.fetch(req(path,method,undefined,headers,true),e1),b=await standalone.fetch(req(path,method,undefined,headers,true),e2)
    assert.equal(a.status,b.status);assert.equal(await a.text(),await b.text());assert.deepEqual([...a.headers],[...b.headers])
  }
})
test('standalone bundle completes the multipart round trip',async()=>{
  const e=environment();const s=await(await standalone.fetch(req('/a?uploads','POST',{}, {},true),e)).json()
  const p=await(await standalone.fetch(req('/a?uploadId='+s.uploadId+'&partNumber=1','PUT','data',{'Content-Length':'4'},true),e)).json()
  const r=await standalone.fetch(req('/a?uploadId='+s.uploadId,'POST',{parts:[p],marker:s.marker},{},true),e)
  assert.equal(r.status,200);assert.equal((await r.json()).markerRemoved,true);assert.equal(await(await standalone.fetch(req('/a'),e)).text(),'data')
})
test('standalone embed blocks absolute upstream input',async()=>{
  assert.equal((await embed.fetch(req('/vcsky/https://untrusted.test/a'),{VCSKY_UPSTREAM:'https://trusted.test/vcsky/'})).status,400)
})
