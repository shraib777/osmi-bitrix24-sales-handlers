import test from 'node:test';
import assert from 'node:assert/strict';
import {DiskStore,DiskLease,LegalArchiver,P} from '../../src/src/legal-archive.mjs';
import {LegalClientReview} from '../../src/src/legal-client-review.mjs';
import {ReviewError} from '../../src/src/docx-review.mjs';
import {MemoryBitrix} from '../support/memory-bitrix.mjs';
async function fixture(){
 const api=new MemoryBitrix(),store=new DiskStore(api,99),lease=new DiskLease(store);await lease.acquire();
 api.attach('LEGAL_PROJECT','baseline bytes');await new LegalArchiver(api,store,lease).process(await api.getItem());
 const key=api.item[P+'VERSION_KEY'];api.item[P+'CLIENT_APPROVED_KEY']=key;api.item[P+'HEAD_APPROVED_KEY']=key;api.item[P+'CLIENT_PROOF']='old consent';
 api.item.stageId=343;api.item.previousStageId=321;api.item.movedTime='2026-11-27T17:00:00+03:00';api.attach('CLIENT_RETURN_FILE','client original');
 const controls={cancel:async()=>{},recover:async()=>{}};
 let runs=0;const review=new LegalClientReview(api,store,lease,controls,{stageId:343,annotate:async()=>{runs++;return{bytes:Buffer.from('working review'),report:{newChangeGroups:1},changes:[{before:'10',after:'30'}]};}});
 return{api,store,lease,controls,review,key,get runs(){return runs;}};
}
test('client original and baseline are frozen, working copies verified before lawyer route',async()=>{
 const f=await fixture(),result=await f.review.process(19);assert.equal(result.target,313);assert.equal(f.api.item.stageId,313);
 assert.equal(f.api.item[P+'CLIENT_APPROVED_KEY'],'');assert.equal(f.api.item[P+'HEAD_APPROVED_KEY'],'');assert.equal(f.api.item[P+'CLIENT_PROOF'],'');assert.equal(f.api.item[P+'CLIENT_REFERENCE_VERSION'],f.key);
 for(const k of['LEGAL_PROJECT','CLIENT_REVIEWED_FILE'])assert.equal((await f.api.download(f.api.item[P+k])).bytes.toString(),'working review');
 const records=[...f.api.disk.values()];assert.ok(records.some(x=>x.NAME.startsWith('client-original-')));assert.ok(records.some(x=>x.NAME.startsWith('client-baseline-')));
 const move=f.api.calls.findIndex(c=>c.params?.fields?.stageId===313),copies=f.api.calls.findIndex(c=>c.params?.fields?.[P+'CLIENT_REVIEWED_FILE']);assert.ok(move>copies);
});
test('named template return goes directly to lawyer review without AI generation',async()=>{const f=await fixture();f.api.item[P+'DOCUMENT_TYPE']='2401';await f.review.process(19);assert.equal(f.api.item.stageId,319);});
test('unsupported input preserves client original and explicitly asks manual comparison',async()=>{const f=await fixture();f.review.annotate=async()=>{throw new ReviewError('TABLE_STRUCTURE_REQUIRES_MANUAL_REVIEW');};const r=await f.review.process(19);assert.equal(r.manual,true);assert.match(f.api.item[P+'CLIENT_REVIEW_STATUS'],/ручное сравнение/);assert.equal((await f.api.download(f.api.item[P+'LEGAL_PROJECT'])).bytes.toString(),'client original');});
test('comments-only return does not replace the working document or wait for AI',async()=>{const f=await fixture();delete f.api.item[P+'CLIENT_RETURN_FILE'];const old=f.api.item[P+'LEGAL_PROJECT'].id;const r=await f.review.process(19);assert.equal(r.reason,'NO_NEW_CLIENT_FILE');assert.equal(f.api.item[P+'LEGAL_PROJECT'].id,old);assert.equal(f.runs,0);});
test('missing verified baseline blocks routing',async()=>{const f=await fixture();f.api.item[P+'VERSION_KEY']='invalid';await assert.rejects(f.review.process(19),/BASELINE_NOT_FROZEN/);assert.equal(f.api.item.stageId,343);});
test('technical coded error is retried rather than misreported as unsupported document',async()=>{const f=await fixture();f.review.annotate=async()=>{throw Object.assign(Error('temporary'),{code:'NETWORK'});};await assert.rejects(f.review.process(19),/temporary/);assert.equal(f.api.item.stageId,343);});
test('lost successful upload response recovers without overwriting copies or running comparison twice',async()=>{const f=await fixture();f.api.failAfter='rpa.item.update';await assert.rejects(f.review.process(19));assert.equal(f.api.item.stageId,343);const file=f.api.item[P+'LEGAL_PROJECT'].id;await f.review.process(19);assert.equal(f.api.item.stageId,313);assert.equal(f.api.item[P+'LEGAL_PROJECT'].id,file);assert.equal(f.runs,1);});
test('incorrectly stored working file blocks next native task',async()=>{const f=await fixture();f.api.corruptSnapshots=true;await assert.rejects(f.review.process(19),/COPY_NOT_VERIFIED/);assert.equal(f.api.item.stageId,343);});
test('cancellation stops comparison and routing',async()=>{const f=await fixture();f.controls.cancel=async()=>{f.api.item.stageId=317;};const r=await f.review.process(19);assert.equal(r.cancelled,true);assert.equal(f.runs,0);});
