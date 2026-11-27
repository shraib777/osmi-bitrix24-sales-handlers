import test from'node:test';import assert from'node:assert/strict';import{buildBillingActionUrl,P}from'../../src/src/legal-archive.mjs';
const item={id:39,stageId:325,[P+'DOCUMENT_TYPE']:2407,[P+'VERSION_KEY']:'current',[P+'CLIENT_APPROVED_KEY']:'current',[P+'HEAD_APPROVED_KEY']:'current'};
test('action is available after client and manager head approve the current version',()=>{assert.match(buildBillingActionUrl(item,'local.example'),/params\[sourceId\]=39$/);});
test('action is absent for stale consent, cancelled requests, billing and NDA',()=>{for(const changed of[{[P+'HEAD_APPROVED_KEY']:'older'},{[P+'CLIENT_APPROVED_KEY']:''},{stageId:317},{stageId:323},{[P+'DOCUMENT_TYPE']:2417},{[P+'DOCUMENT_TYPE']:2401}])assert.equal(buildBillingActionUrl({...item,...changed},'local.example'),'');});
test('action does not accept arbitrary application codes',()=>{assert.equal(buildBillingActionUrl(item,'https://bad.invalid'), '');});
