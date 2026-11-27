import{createHash}from'node:crypto';import{annotateClientDocx,ReviewError}from'./docx-review.mjs';
const P='UF_RPA_57_',sha=b=>createHash('sha256').update(b).digest('hex');
const refs=v=>(Array.isArray(v)?v:[v]).filter(f=>f&&typeof f==='object'&&f.id);
const json=v=>JSON.stringify(v);
const upload=(name,b)=>[name,b.toString('base64')];
export class ClientReviewError extends Error{constructor(code){super(code);this.code=code;}}
function context(i){const baseline=refs(i[P+'CLIENT_DOCUMENT'])[0];return{baselineId:String(baseline?.id||''),version:i[P+'VERSION_KEY']||i[P+'CLIENT_REFERENCE_VERSION']||'',moved:String(i.movedTime||'')};}
function input(i){const c=context(i),returned=refs(i[P+'CLIENT_RETURN_FILE'])[0];const candidate=sha(json({...c,returnedId:String(returned?.id||''),schema:1}));const reused=returned&&String(returned.id)===String(i[P+'CLIENT_RETURN_USED_ID'])&&candidate!==i[P+'CLIENT_REVIEW_KEY'];return{...c,returnedId:reused?'':String(returned?.id||''),schema:1};}
const keyFor=i=>sha(json(input(i)));
const target=i=>Number(i[P+'DOCUMENT_TYPE'])===2415?313:319;
function timestamp(s){const m=/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(s);const d=new Date(m?`${m[3]}-${m[2]}-${m[1]}T${m[4]}+03:00`:s);if(!Number.isFinite(d.getTime()))throw new ClientReviewError('CLIENT_REVIEW_TIME_MISSING');return d.toISOString();}
export class LegalClientReview{
 constructor(api,store,lease,controls,{stageId,annotate=annotateClientDocx}={}){Object.assign(this,{api,store,lease,controls,stageId,annotate});}
 async process(id){let item=await this.api.getItem(id);if(Number(item.stageId)!==this.stageId)return{skipped:true};if(Number(item.previousStageId)!==321)throw new ClientReviewError('INVALID_CLIENT_REVIEW_ROUTE');const state=input(item),key=keyFor(item),destination=target(item);if(!state.moved)throw new ClientReviewError('CLIENT_REVIEW_TIME_MISSING');await this.controls.cancel(id,{dryRun:false});if(Number((await this.api.getItem(id)).stageId)===317)return{cancelled:true};
 const guard=async()=>{const current=await this.api.getItem(id);if(Number(current.stageId)!==this.stageId||String(current.movedTime)!==state.moved||keyFor(current)!==key)throw new ClientReviewError('CLIENT_REVIEW_INPUT_CHANGED');await this.lease.assert();return current;};
 if(!state.returnedId){await guard();await this.api.updateItem(id,{[P+'CLIENT_REFERENCE_VERSION']:state.version,[P+'CLIENT_REVIEW_KEY']:key,[P+'CLIENT_REVIEW_STATUS']:'Новый файл клиента не приложен. Проверьте замечания в ленте.',[P+'CLIENT_PROOF']:'',[P+'CLIENT_APPROVED_KEY']:'',[P+'HEAD_APPROVED_KEY']:'',[P+'VERSION_KEY']:''});await this.move(id,destination,state.moved);return{transferred:true,target:destination,manual:true,reason:'NO_NEW_CLIENT_FILE'};}
 const baseline=refs(item[P+'CLIENT_DOCUMENT'])[0],returned=refs(item[P+'CLIENT_RETURN_FILE'])[0];if(!baseline||!state.version||!returned)throw new ClientReviewError('CLIENT_REVIEW_BASELINE_MISSING');const folder=await this.store.folder(id);const originalRecord=await this.store.find(folder,`client-review-${key}.json`);let record=originalRecord?await this.store.readJson(originalRecord):null;
 if(!record){
  const matches=(await this.store.children(folder)).filter(f=>f.NAME.startsWith(`checkpoint-VERSION_KEY-${state.version}`));let checkpoint;for(const f of matches){const cp=await this.store.readJson(f);if(cp.key===state.version&&cp.targetIds?.map(String).includes(state.baselineId)){checkpoint=cp;break;}}
  if(!checkpoint)throw new ClientReviewError('CLIENT_REVIEW_BASELINE_NOT_FROZEN');const source=await this.store.find(folder,`source-LEGAL_PROJECT-${checkpoint.sourceIds[0]}.json`);if(!source)throw new ClientReviewError('CLIENT_REVIEW_BASELINE_NOT_ARCHIVED');const sourceRecord=await this.store.readJson(source);
  const [base,client]=await Promise.all([this.api.download(baseline),this.api.download(returned)]);if(sha(base.bytes)!==sourceRecord.sha256)throw new ClientReviewError('CLIENT_REVIEW_BASELINE_HASH_CHANGED');
  await this.lease.assert();const original=await this.store.put(folder,`client-original-${key}-${state.returnedId}`,client.bytes);const reference=await this.store.put(folder,`client-baseline-${key}`,base.bytes);let output,report,manual=false,reason='';
  try{const result=await this.annotate(base.bytes,client.bytes,{now:timestamp(state.moved)});output=result.bytes;report=result.report;report.changes=result.changes.slice(0,100).map(c=>({...c,before:c.before.slice(0,1000),after:c.after.slice(0,1000)}));report.reportTruncated=result.changes.length>100;}catch(e){if(!(e instanceof ReviewError))throw e;manual=true;reason=e.code;output=client.bytes;report={coverage:'manual_review_required',reason};}
  const generated=await this.store.put(folder,`client-working-${key}${manual?'':'.docx'}`,output);
  record={schema:1,typeId:57,itemId:String(id),key,input:state,requestedAt:state.moved,originalBlobId:String(original.ID),baselineBlobId:String(reference.ID),outputBlobId:String(generated.ID),outputSha256:sha(output),manual,reason,report,filename:manual?String(returned.name||'client-return.docx').split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(-100):'Клиентские правки с рецензиями.docx'};
  await guard();await this.store.putJson(folder,`client-review-${key}.json`,record);
 }
 if(record.key!==key||record.itemId!==String(id)||record.input.version!==state.version)throw new ClientReviewError('CLIENT_REVIEW_RECORD_MISMATCH');
 const current=await guard();const f=await this.api.call('disk.file.get',{id:record.outputBlobId});const output=(await this.api.download(f.result)).bytes;if(sha(output)!==record.outputSha256)throw new ClientReviewError('CLIENT_REVIEW_OUTPUT_HASH_CHANGED');
 const copyMatches=async value=>{const ref=refs(value)[0];return Boolean(ref)&&sha((await this.api.download(ref)).bytes)===record.outputSha256;};
 if(current[P+'CLIENT_REVIEW_KEY']!==key){
  await this.api.updateItem(id,{[P+'CLIENT_REFERENCE_VERSION']:state.version,[P+'CLIENT_REVIEW_KEY']:key,[P+'CLIENT_RETURN_USED_ID']:state.returnedId,[P+'CLIENT_REVIEWED_FILE']:upload(record.filename,output),[P+'LEGAL_PROJECT']:upload(record.filename,output),[P+'CLIENT_REVIEW_STATUS']:record.manual?`Требуется ручное сравнение: ${record.reason}. Исходные файлы сохранены; автоматическая разметка не подтверждена.`:`Рецензии дополнены. Новых групп изменений: ${record.report.newChangeGroups}. Исходные исправления и комментарии клиента сохранены. Форматирование проверяет юрист.`,[P+'CLIENT_PROOF']:'',[P+'CLIENT_APPROVED_KEY']:'',[P+'HEAD_APPROVED_KEY']:'',[P+'VERSION_KEY']:''});
 }
 const after=await guard();if(!await copyMatches(after[P+'CLIENT_REVIEWED_FILE'])||!await copyMatches(after[P+'LEGAL_PROJECT']))throw new ClientReviewError('CLIENT_REVIEW_COPY_NOT_VERIFIED');
 await this.controls.cancel(id,{dryRun:false});if(Number((await this.api.getItem(id)).stageId)===317)return{cancelled:true};await guard();await this.controls.recover(id);await this.move(id,destination,state.moved);return{transferred:true,target:destination,manual:record.manual,changes:record.report.newChangeGroups||0};
 }
 async move(id,destination,moved){const c=await this.api.getItem(id);if(Number(c.stageId)!==this.stageId||String(c.movedTime)!==moved)throw new ClientReviewError('CLIENT_REVIEW_INPUT_CHANGED');await this.lease.assert();try{await this.api.updateItem(id,{stageId:destination});}catch(e){if(Number((await this.api.getItem(id)).stageId)!==destination)throw e;}if(Number((await this.api.getItem(id)).stageId)===this.stageId)throw new ClientReviewError('CLIENT_REVIEW_STAGE_NOT_CHANGED');}
}
