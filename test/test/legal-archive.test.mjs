import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveError, DiskStore, DiskLease, LegalArchiver, P, sha, stable,
  startLegalArchiveFromEnv, startLegalArchiveSafely, validateFileUrl, createArchiveApi, LegalHandoff, LegalRoleSummaries, handoffTarget } from '../../src/src/legal-archive.mjs';

class MemoryBitrix {
  constructor() {
    this.disk = new Map(); this.data = new Map(); this.rpaData = new Map(); this.ids = 100; this.calls = []; this.downloads = 0;
    this.item = { id: 19, stageId: 321, [P + 'DOCUMENT_TYPE']: '2415', [P + 'REQUEST_TEXT']: 'Synthetic' };
    this.disk.set('99', { ID: '99', NAME: 'OSMI Legal RPA 57 - development archive', TYPE: 'folder', PARENT_ID: '1', STORAGE_ID: '1', DELETED_TYPE: '0' });
    this.failAfter = null; this.corruptSnapshots = false; this.onDownload = null; this.onUpdate = null;
  }
  attach(slot, bytes = 'test document') {
    const id = String(++this.ids); this.rpaData.set(id, Buffer.from(bytes)); this.item[P + slot] = { id, name: 'document.docx' }; return id;
  }
  async call(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    let result;
    if (method === 'user.get') {
      result = this.users || [];
    } else if (method === 'disk.folder.getChildren') {
      result = [...this.disk.values()].filter(f => f.PARENT_ID === String(params.id) && f.DELETED_TYPE === '0' && (!params.filter.NAME || f.NAME === params.filter.NAME));
    } else if (method === 'disk.file.get' || method === 'disk.folder.get') {
      result = this.disk.get(String(params.id)); if (!result) throw new ArchiveError('NOT_FOUND');
    } else if (method === 'disk.folder.addSubFolder' || method === 'disk.folder.uploadFile') {
      if ([...this.disk.values()].some(f => f.PARENT_ID === String(params.id) && f.DELETED_TYPE === '0' && f.NAME === params.data.NAME)) throw new ArchiveError('DUPLICATE_NAME');
      const id = String(++this.ids);
      result = { ID: id, NAME: params.data.NAME, TYPE: method.endsWith('addSubFolder') ? 'folder' : 'file', PARENT_ID: String(params.id), DELETED_TYPE: '0' };
      this.disk.set(id, result);
      if (params.fileContent) this.data.set(id, Buffer.from(params.fileContent[1], 'base64'));
    } else if (method === 'disk.file.markDeleted') {
      const file = this.disk.get(String(params.id)); file.DELETED_TYPE = '3'; result = true;
    } else if (method === 'disk.file.uploadVersion') {
      if (this.disk.get(String(params.id)).DELETED_TYPE !== '0') throw new ArchiveError('NOT_FOUND');
      this.data.set(String(params.id), Buffer.from(params.fileContent[1], 'base64')); result = true;
    } else throw new Error('Unexpected method ' + method);
    if (this.failAfter === method) { this.failAfter = null; throw new ArchiveError('BITRIX_TRANSPORT_ERROR'); }
    return { result: structuredClone(result) };
  }
  async download(file) {
    this.downloads++;
    const bytes = this.data.get(String(file.ID)) || this.rpaData.get(String(file.id));
    if (!bytes) throw new ArchiveError('NOT_FOUND');
    if (this.onDownload) { const fn = this.onDownload; this.onDownload = null; fn(); }
    return { bytes: Buffer.from(bytes), name: file.name || file.NAME || 'document.docx' };
  }
  async getItem() { return structuredClone(this.item); }
  async updateItem(id, fields) {
    this.calls.push({ method: 'rpa.item.update', params: { typeId: 57, id, fields: structuredClone(fields) } });
    if (this.onUpdate) { const fn = this.onUpdate; this.onUpdate = null; fn(); }
    for (const [key, value] of Object.entries(fields)) {
      if ([P + 'PROJECT_HISTORY', P + 'PACKAGE_HISTORY', P + 'PACKAGE_DOCUMENTS'].includes(key)) this.item[key] = value.map(v => this.rpaUpload(v, key));
      else this.item[key] = Array.isArray(value) ? this.rpaUpload(value, key) : value;
    }
    if (this.failAfter === 'rpa.item.update') { this.failAfter = null; throw new ArchiveError('BITRIX_TRANSPORT_ERROR'); }
  }
  rpaUpload(value, key) {
    if (!Array.isArray(value)) return structuredClone(value);
    const id = String(++this.ids); this.rpaData.set(id, this.corruptSnapshots && !key.endsWith('HISTORY') ? Buffer.from('corrupt') : Buffer.from(value[1], 'base64'));
    return { id, name: value[0] };
  }
}
async function fixture() {
  const api = new MemoryBitrix(); const source = api.attach('LEGAL_PROJECT');
  const store = new DiskStore(api, 99); const lease = new DiskLease(store);
  assert.equal(await lease.acquire(), true);
  const worker = new LegalArchiver(api, store, lease);
  return { api, source, store, lease, worker, process: () => worker.process(structuredClone(api.item)) };
}
const mutations = api => api.calls.filter(c => /upload|update|addSub|markDeleted/.test(c.method));

async function transferFixture() {
  const f=await fixture();
  const controls={timeline:async()=>[],cancel:async()=>({cancelled:false})};
  const summaries=new LegalRoleSummaries(f.api,f.lease,controls);
  const handoff=new LegalHandoff(f.api,f.store,f.lease,f.worker,controls,summaries,{stageId:341});
  f.api.item.stageId=341;f.api.item.previousStageId=313;f.api.item.movedTime='2026-11-26T19:00:00+03:00';f.api.item.movedBy=579;
  return {...f,controls,summaries,handoff};
}
test('handoff stores immutable document and recipient summary before the next native task',async()=>{
  const f=await transferFixture();
  const result=await f.handoff.process(19);
  assert.equal(result.target,321);assert.equal(f.api.item.stageId,321);
  const receipt=[...f.api.disk.values()].find(x=>x.NAME.startsWith('handoff-'));
  assert.ok(receipt);assert.ok(f.api.item[P+'VERSION_KEY']);
  assert.equal((await f.store.readJson(receipt)).transferredBy,579);
  const move=f.api.calls.findIndex(c=>c.method==='rpa.item.update'&&c.params.fields.stageId===321);
  assert.ok(f.api.calls.slice(0,move).some(c=>c.method==='rpa.item.update'&&c.params.fields[P+'ROLE_SUMMARY']?.includes('Менеджер: согласие клиента')));
  assert.equal(f.api.item[P+'HANDOFF_RECEIPT_KEY'],result.receipt);
});
test('two transfers before the periodic worker runs retain both original versions',async()=>{
  const f=await transferFixture();await f.handoff.process(19);
  const first=[...f.api.disk.values()].find(x=>x.NAME.startsWith('handoff-'));
  const firstBytes=Buffer.from(f.api.data.get(first.ID));
  const firstSource=f.source;
  f.api.attach('LEGAL_PROJECT','Second lawyer version');
  f.api.item.stageId=341;f.api.item.previousStageId=313;f.api.item.movedTime='2026-11-26T19:00:20+03:00';
  await f.handoff.process(19);
  const receipts=[...f.api.disk.values()].filter(x=>x.NAME.startsWith('handoff-'));
  assert.equal(receipts.length,2);assert.deepEqual(f.api.data.get(first.ID),firstBytes);
  assert.equal(f.api.item[P+'PROJECT_HISTORY'].length,2);
  assert.ok((await f.store.readJson(first)).files.some(r=>r.sourceId===firstSource));
});
test('failed archive verification cannot hand off a document or create a ready receipt',async()=>{
  const f=await transferFixture();f.api.corruptSnapshots=true;
  await assert.rejects(f.handoff.process(19),/SNAPSHOT_COPY_NOT_VERIFIED/);
  assert.equal(f.api.item.stageId,341);
  assert.ok(![...f.api.disk.values()].some(x=>x.NAME.startsWith('handoff-')));
});
test('missing documents prevent the next participant from receiving a task',async()=>{
  const f=await transferFixture();delete f.api.item[P+'LEGAL_PROJECT'];
  await assert.rejects(f.handoff.process(19),/HANDOFF_REQUIRED_FILE_MISSING/);
  assert.equal(f.api.item.stageId,341);
});
test('client approval cannot be carried to a different source version',async()=>{
  const f=await transferFixture();await f.handoff.process(19);
  f.api.attach('LEGAL_PROJECT','Unapproved edit');f.api.item[P+'CLIENT_PROOF']='Agreed on previous version';
  f.api.item.stageId=341;f.api.item.previousStageId=321;f.api.item.movedTime='2026-11-26T19:02:00+03:00';
  await assert.rejects(f.handoff.process(19),/HANDOFF_PROJECT_VERSION_CHANGED/);
  assert.equal(f.api.item.stageId,341);assert.equal(f.api.item[P+'CLIENT_APPROVED_KEY'],'');
});
test('billing handoff requires both invoice and act and preserves both snapshots',async()=>{
  const f=await transferFixture();delete f.api.item[P+'LEGAL_PROJECT'];
  f.api.item[P+'DOCUMENT_TYPE']='2421';f.api.item.previousStageId=331;
  f.api.attach('INVOICE_FILE','Invoice');
  await assert.rejects(f.handoff.process(19),/HANDOFF_REQUIRED_FILE_MISSING/);
  f.api.attach('ACT_FILE','Act');
  assert.equal((await f.handoff.process(19)).target,333);
  assert.ok(f.api.item[P+'SNAPSHOT_INVOICE']);assert.ok(f.api.item[P+'SNAPSHOT_ACT']);
});
test('cancellation during capture keeps the archive but prevents the next task',async()=>{
  const f=await transferFixture();f.controls.cancel=async()=>{f.api.item.stageId=317;return {cancelled:true};};
  assert.equal((await f.handoff.process(19)).cancelled,true);
  assert.equal(f.api.item.stageId,317);assert.equal(f.api.item[P+'PROJECT_HISTORY'].length,1);
  assert.ok(!f.api.calls.some(c=>c.method==='rpa.item.update'&&c.params.fields.stageId===321));
});
test('lost successful stage-change response reconciles without duplicate handoff',async()=>{
  const f=await transferFixture();const update=f.api.updateItem.bind(f.api);
  f.api.updateItem=async(id,fields)=>{await update(id,fields);if(fields.stageId===321)throw new ArchiveError('BITRIX_TRANSPORT_ERROR');};
  assert.equal((await f.handoff.process(19)).transferred,true);
  assert.equal((await f.handoff.process(19)).skipped,true);
  assert.equal([...f.api.disk.values()].filter(x=>x.NAME.startsWith('handoff-')).length,1);
});
test('handoff routing keeps manager, head, Anna and GD decisions separate',()=>{
  const base={ [P+'DOCUMENT_TYPE']:'2415',[P+'SIGNING_CHANNEL']:'2423'};
  for(const[from,to]of [[313,321],[319,321],[321,323],[323,325],[325,327],[327,337],[337,339],[339,315]])assert.equal(handoffTarget({...base,previousStageId:from}),to);
  const billing={...base,[P+'DOCUMENT_TYPE']:'2421'};
  for(const[from,to]of [[329,331],[331,333],[333,335],[335,337],[337,315]])assert.equal(handoffTarget({...billing,previousStageId:from}),to);
  assert.equal(handoffTarget({...billing,previousStageId:335,[P+'SIGNING_CHANNEL']:'2425'}),315);
  assert.throws(()=>handoffTarget({...billing,previousStageId:313}),/INVALID_HANDOFF_ROUTE/);
});

test('disabled archive performs no calls and invalid config cannot stop the CRM service', () => {
  let calls = 0; const options = { apiFactory: () => { calls++; throw new ArchiveError('INVALID_CONFIG'); }, logger: () => {} };
  assert.equal(startLegalArchiveFromEnv({}, options).enabled, false);
  assert.equal(calls, 0);
  assert.equal(startLegalArchiveSafely({ LEGAL_ARCHIVE_ENABLED: 'true' }, options).enabled, false);
});
test('persists copies and recovers after complete loss of process memory', async () => {
  const f = await fixture(); await f.process();
  const key = f.api.item[P + 'VERSION_KEY']; assert.ok(key);
  const before = mutations(f.api).length;
  await f.lease.release();
  const store = new DiskStore(f.api, 99); const lease = new DiskLease(store);
  assert.equal(await lease.acquire(), true);
  const afterAcquire = mutations(f.api).length;
  await new LegalArchiver(f.api, store, lease).process(structuredClone(f.api.item));
  assert.equal(mutations(f.api).length, afterAcquire);
  assert.equal(f.api.item[P + 'VERSION_KEY'], key);
  assert.equal(f.api.item[P + 'PROJECT_HISTORY'].length, 1);
  assert.ok(before > 1);
});
test('archive blobs remain unchanged after a source replacement and approvals are reset', async () => {
  const f = await fixture(); await f.process();
  const oldKey = f.api.item[P + 'VERSION_KEY'];
  const blob = [...f.api.disk.values()].find(x => x.NAME.startsWith('blob-'));
  const oldBytes = Buffer.from(f.api.data.get(blob.ID));
  f.api.item[P + 'CLIENT_PROOF'] = 'old proof'; f.api.item[P + 'HEAD_APPROVED_KEY'] = 'old';
  f.api.attach('LEGAL_PROJECT', 'new text'); await f.process();
  assert.notEqual(f.api.item[P + 'VERSION_KEY'], oldKey);
  assert.equal(f.api.item[P + 'CLIENT_PROOF'], ''); assert.equal(f.api.item[P + 'HEAD_APPROVED_KEY'], '');
  assert.deepEqual(f.api.data.get(blob.ID), oldBytes); assert.equal(f.api.item[P + 'PROJECT_HISTORY'].length, 2);
});
test('only one Render instance can hold a lease', async () => {
  const f = await fixture(); const second = new DiskLease(new DiskStore(f.api, 99));
  assert.equal(await second.acquire(), false);
  await f.lease.release(); assert.equal(await second.acquire(), true);
});
test('stale lease can be reclaimed and the old owner cannot write', async () => {
  let now = 1000;
  const api = new MemoryBitrix(); const store = new DiskStore(api, 99);
  const old = new DiskLease(store, { now: () => now, ttlMs: 300 }); assert.equal(await old.acquire(), true);
  now = 1400;
  const next = new DiskLease(store, { now: () => now, ttlMs: 300 }); assert.equal(await next.acquire(), true);
  await assert.rejects(old.assert(), /WORKER_LEASE_EXPIRED/);
  const worker = new LegalArchiver(api, store, old);
  const writes = mutations(api).length; await assert.rejects(worker.writeItem(19, {}), /WORKER_LEASE_EXPIRED/);
  assert.equal(mutations(api).length, writes);
});
test('renewal keeps a live worker lease', async () => {
  let now = 1000; const api = new MemoryBitrix();
  const lease = new DiskLease(new DiskStore(api, 99), { now: () => now, ttlMs: 300 }); await lease.acquire();
  now = 1150; await lease.assert();
  assert.equal(lease.expires, 1450);
  assert.ok(api.calls.some(c => c.method === 'disk.file.uploadVersion'));
});
test('ambiguous successful lease create is recovered without adopting another owner', async () => {
  const api = new MemoryBitrix(); api.failAfter = 'disk.folder.uploadFile';
  const lease = new DiskLease(new DiskStore(api, 99)); assert.equal(await lease.acquire(), true);
  assert.equal(await new DiskLease(new DiskStore(api, 99)).acquire(), false);
});
test('lost disk upload response reconciles the immutable file', async () => {
  const f = await fixture(); f.api.failAfter = 'disk.folder.uploadFile'; await f.process();
  assert.ok(f.api.item[P + 'VERSION_KEY']);
  assert.equal([...f.api.disk.values()].filter(x => x.NAME.startsWith('blob-')).length, 1);
});
test('lost RPA history response recovers without duplicate', async () => {
  const f = await fixture(); f.api.failAfter = 'rpa.item.update';
  await assert.rejects(f.process(), /BITRIX_TRANSPORT_ERROR/);
  await f.process(); assert.equal(f.api.item[P + 'PROJECT_HISTORY'].length, 1);
});
test('corrupted snapshot cannot publish a ready version', async () => {
  const f = await fixture(); f.api.corruptSnapshots = true;
  await assert.rejects(f.process(), /SNAPSHOT_COPY_NOT_VERIFIED/);
  assert.equal(f.api.item[P + 'VERSION_KEY'], '');
});
test('context change including source attachments creates a new version', async () => {
  const f = await fixture(); await f.process(); const before = f.api.item[P + 'VERSION_KEY'];
  f.api.item[P + 'SOURCE_FILES'] = [{ id: '999' }]; await f.process();
  assert.notEqual(f.api.item[P + 'VERSION_KEY'], before);
});
test('return to an earlier context keeps both immutable receipts and survives restart', async () => {
  const f = await fixture(); await f.process();
  const key = f.api.item[P + 'VERSION_KEY'];
  const firstReceipt = [...f.api.disk.values()].find(x => x.NAME.startsWith('checkpoint-'));
  const firstBytes = Buffer.from(f.api.data.get(firstReceipt.ID));
  f.api.item[P + 'REQUEST_TEXT'] = 'Changed facts'; await f.process();
  assert.notEqual(f.api.item[P + 'VERSION_KEY'], key);
  f.api.item[P + 'REQUEST_TEXT'] = 'Synthetic'; await f.process();
  assert.equal(f.api.item[P + 'VERSION_KEY'], key);
  assert.deepEqual(f.api.data.get(firstReceipt.ID), firstBytes);
  assert.equal([...f.api.disk.values()].filter(x => x.NAME.includes('-copy-')).length, 1);
  const before = mutations(f.api).length;
  await new LegalArchiver(f.api, new DiskStore(f.api, 99), f.lease).process(structuredClone(f.api.item));
  assert.equal(mutations(f.api).length, before);
  assert.equal(f.api.item[P + 'PROJECT_HISTORY'].length, 1);
});
test('replacement of an approval copy is verified and recorded without rewriting history', async () => {
  const f = await fixture(); await f.process();
  const key = f.api.item[P + 'VERSION_KEY'];
  f.api.attach('CLIENT_DOCUMENT', 'wrong replacement'); await f.process();
  assert.equal(f.api.item[P + 'VERSION_KEY'], key);
  assert.equal((await f.api.download(f.api.item[P + 'CLIENT_DOCUMENT'])).bytes.toString(), 'test document');
  assert.equal([...f.api.disk.values()].filter(x => x.NAME.includes('-copy-')).length, 1);
});
test('corruption during an earlier-context restoration cannot publish a ready copy', async () => {
  const f = await fixture(); await f.process();
  f.api.item[P + 'REQUEST_TEXT'] = 'Changed facts'; await f.process();
  f.api.item[P + 'REQUEST_TEXT'] = 'Synthetic'; f.api.corruptSnapshots = true;
  await assert.rejects(f.process(), /SNAPSHOT_COPY_NOT_VERIFIED/);
  assert.equal(f.api.item[P + 'VERSION_KEY'], '');
});
test('concurrent source change cannot publish the stale snapshot', async () => {
  const f = await fixture(); f.api.onDownload = () => f.api.attach('LEGAL_PROJECT', 'new text');
  await assert.rejects(f.process(), /ITEM_CHANGED_DURING_CAPTURE/);
  assert.ok(!f.api.item[P + 'VERSION_KEY']);
});
test('both invoice and act are required and copied separately', async () => {
  const f = await fixture(); f.api.item = { id: 19, stageId: 333, [P + 'DOCUMENT_TYPE']: '2421' };
  f.api.attach('INVOICE_FILE', 'invoice'); await f.process(); assert.ok(!f.api.item[P + 'PACKAGE_VERSION_KEY']);
  f.api.attach('ACT_FILE', 'act'); await f.process(); assert.ok(f.api.item[P + 'PACKAGE_VERSION_KEY']);
  assert.equal((await f.api.download(f.api.item[P + 'SNAPSHOT_INVOICE'])).bytes.toString(), 'invoice');
  assert.equal((await f.api.download(f.api.item[P + 'SNAPSHOT_ACT'])).bytes.toString(), 'act');
});
test('history preserves older entries and never deletes document versions', async () => {
  const f = await fixture(); const oldId = f.api.attach('CONTRACT_PACKAGE', 'older document');
  f.api.item[P + 'PROJECT_HISTORY'] = [{ id: oldId }]; await f.process();
  assert.equal(String(f.api.item[P + 'PROJECT_HISTORY'][0].id), oldId);
  assert.ok(!f.api.calls.some(c => /delete|markDeleted/.test(c.method)));
});
test('cold worker rejects a corrupted immutable Disk record', async () => {
  const f = await fixture(); await f.process(); const blob = [...f.api.disk.values()].find(x => x.NAME.startsWith('blob-'));
  f.api.data.set(blob.ID, Buffer.from('corrupt'));
  await assert.rejects(new LegalArchiver(f.api, new DiskStore(f.api, 99), f.lease).process(structuredClone(f.api.item)), /ARCHIVE_HASH_MISMATCH/);
});
test('untrusted hosts and credential-bearing URLs are rejected', () => {
  for (const url of ['http://portal.test', 'https://evil.test/file', 'https://user@portal.test/file', 'https://portal.test:8080']) {
    assert.throws(() => validateFileUrl(url, new Set(['portal.test'])), ArchiveError);
  }
});
test('safe API errors do not expose webhook, token, server response or document body', async () => {
  const api = createArchiveApi('https://myosminozhka.bitrix24.ru/rest/1/secret/', { intervalMs: 0,
    fetcher: async () => { throw new Error('secret and document'); } });
  await assert.rejects(api.call('rpa.item.get', {}), error => error.message === 'BITRIX_TRANSPORT_ERROR');
});
test('download redirect to an untrusted host is blocked before the second request', async () => {
  let requests = 0;
  const api = createArchiveApi('https://myosminozhka.bitrix24.ru/rest/1/secret/', { intervalMs: 0,
    fetcher: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/stolen' } }); } });
  await assert.rejects(api.download({ urlMachine: 'https://myosminozhka.bitrix24.ru/file' }), /UNTRUSTED_FILE_HOST/);
  assert.equal(requests, 1);
});
test('hash and canonical serialization are stable across key order', () => {
  assert.equal(sha(stable({ b: 1, a: 2 })), sha(stable({ a: 2, b: 1 })));
});
test('unchanged items do not download documents again on every poll', async () => {
  const f = await fixture(); await f.process();
  const calls = f.api.calls.length, downloads = f.api.downloads;
  await f.process();
  assert.equal(f.api.calls.length, calls);
  assert.equal(f.api.downloads, downloads);
});
test('new source is still processed if it appears just after a successful checkpoint', async () => {
  const f = await fixture(); await f.process();
  f.api.attach('LEGAL_PROJECT', 'changed after checkpoint');
  await f.process();
  assert.equal(f.api.item[P + 'PROJECT_SOURCE_ID'], String(f.api.item[P + 'LEGAL_PROJECT'].id));
  assert.equal(f.api.item[P + 'PROJECT_HISTORY'].length, 2);
});
test('manager email comes from the exact server-reported author profile', async () => {
  const f = await fixture(); f.api.item.createdBy = '7';
  f.api.users = [{ ID: '8', EMAIL: 'wrong@example.test' }, { ID: '7', EMAIL: 'author@example.test' }];
  await f.process();
  assert.equal(f.api.item[P + 'MANAGER_EMAIL'], 'author@example.test');
  assert.ok(f.api.calls.filter(c => c.method === 'rpa.item.update').every(c => c.params.typeId === 57 && c.params.id === 19 && !('stageId' in c.params.fields)));
});
test('missing author profile never substitutes another person email', async () => {
  const f = await fixture(); f.api.item.createdBy = '7'; f.api.users = [{ ID: '8', EMAIL: 'wrong@example.test' }];
  await assert.rejects(f.process(), /AUTHOR_EMAIL_UNAVAILABLE/);
  assert.ok(!f.api.item[P + 'MANAGER_EMAIL']);
});
