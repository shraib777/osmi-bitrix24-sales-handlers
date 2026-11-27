import { createHash, randomUUID } from 'node:crypto';
import { LegalClientReview, ClientReviewError } from './legal-client-review.mjs';
import { buildRoleSummary } from './legal-role-summary.mjs';

// Only the development RPA is enabled. No AI, email, automated approval
// decisions, or public archive endpoints. Native human decisions remain native.
export const TYPE_ID = 57;
export const P = 'UF_RPA_57_';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SOURCE_FIELDS = { LEGAL_PROJECT: 'PROJECT_HISTORY', CONTRACT_PACKAGE: 'PACKAGE_HISTORY',
  INVOICE_FILE: 'PACKAGE_HISTORY', ACT_FILE: 'PACKAGE_HISTORY', FINAL_FILES: 'PACKAGE_HISTORY' };
const CONTEXT_FIELDS = ['DOCUMENT_TYPE', 'OTHER_TITLE', 'COUNTERPARTY_NAME', 'CLIENT_EMAIL',
  'REQUEST_TEXT', 'DUE_DATE', 'PROJECT_URL', 'CONTRACT_URL', 'SIGNING_CHANNEL'];
const SOURCE_KEYS = { LEGAL_PROJECT: 'PROJECT_SOURCE_ID', CONTRACT_PACKAGE: 'CONTRACT_SOURCE_ID',
  INVOICE_FILE: 'INVOICE_SOURCE_ID', ACT_FILE: 'ACT_SOURCE_ID' };
const CHECKPOINTS = {
  321: { sources: ['LEGAL_PROJECT'], targets: ['CLIENT_DOCUMENT'], key: 'VERSION_KEY' },
  327: { sources: ['CONTRACT_PACKAGE'], targets: ['PACKAGE_DOCUMENTS'], key: 'PACKAGE_VERSION_KEY' }
};
export class ArchiveError extends Error {
  constructor(code) { super(code); this.name = 'ArchiveError'; this.code = code; }
}
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const fileRefs = value => (Array.isArray(value) ? value : [value]).filter(x =>
  x && typeof x === 'object' && /^\d+$/.test(String(x.id)) && Number(x.id) > 0);
export const businessContext = item => ({ ...Object.fromEntries(CONTEXT_FIELDS.map(k => [k, item[P + k] ?? null])),
  SOURCE_FILES: fileRefs(item[P + 'SOURCE_FILES']).map(f => String(f.id)) });
const sourceIds = item => Object.fromEntries(Object.keys(SOURCE_FIELDS).map(k => [k, fileRefs(item[P + k]).map(f => String(f.id))]));
const fingerprint = item => sha(stable({ context: businessContext(item), sources: sourceIds(item), stage: Number(item.stageId) }));
const observation = item => sha(stable({ input: fingerprint(item),
  histories: ['PROJECT_HISTORY', 'PACKAGE_HISTORY'].map(k => fileRefs(item[P + k]).map(f => String(f.id))),
  snapshots: ['CLIENT_DOCUMENT', 'PACKAGE_DOCUMENTS', 'SNAPSHOT_INVOICE', 'SNAPSHOT_ACT'].map(k => fileRefs(item[P + k]).map(f => String(f.id))),
  keys: ['VERSION_KEY', 'PACKAGE_VERSION_KEY', 'PROJECT_SOURCE_ID', 'CONTRACT_SOURCE_ID', 'INVOICE_SOURCE_ID', 'ACT_SOURCE_ID'].map(k => item[P + k]),
  hasManagerEmail: Boolean(item[P + 'MANAGER_EMAIL']) }));
const upload = (name, bytes) => [name, bytes.toString('base64')];
const safeName = name => String(name || 'document').split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-100) || 'document';
const active = file => file && String(file.DELETED_TYPE ?? '0') === '0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateFileUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new ArchiveError('INVALID_FILE_URL'); }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ArchiveError('UNTRUSTED_FILE_HOST');
  }
  return url;
}

export function createArchiveApi(webhook, { fetcher = fetch, intervalMs = 1250, extraHosts = [] } = {}) {
  let base;
  try { base = new URL(webhook); } catch { throw new ArchiveError('MISSING_ARCHIVE_WEBHOOK'); }
  if (base.protocol !== 'https:' || base.hostname !== 'myosminozhka.bitrix24.ru' || !base.pathname.startsWith('/rest/') || base.search || base.hash || base.username || base.password) {
    throw new ArchiveError('INVALID_ARCHIVE_WEBHOOK');
  }
  const baseUrl = webhook.replace(/\/[a-z0-9_.-]+\.json(?:\?.*)?$/i, '/').replace(/\/?$/, '/');
  const hosts = new Set([base.hostname, ...extraHosts]);
  let queue = Promise.resolve();
  let lastCall = 0;
  const api = {
    call(method, params) {
      const work = async () => {
        await sleep(Math.max(0, intervalMs - (Date.now() - lastCall)));
        lastCall = Date.now();
        try {
          const response = await fetcher(baseUrl + method + '.json', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
            redirect: 'error', signal: AbortSignal.timeout(25000) });
          const result = await response.json();
          if (!response.ok || result.error) throw new ArchiveError('BITRIX_API_ERROR');
          return result;
        } catch (error) {
          if (error instanceof ArchiveError) throw error;
          // A failed response does not prove that a write was rejected. Each
          // operation reconciles remote state on the next pass instead of retrying.
          throw new ArchiveError('BITRIX_TRANSPORT_ERROR');
        }
      };
      const result = queue.then(work, work);
      queue = result.catch(() => {});
      return result;
    },
    async getItem(id) { return (await api.call('rpa.item.get', { typeId: TYPE_ID, id })).result.item; },
    async updateItem(id, fields) { return api.call('rpa.item.update', { typeId: TYPE_ID, id, fields }); },
    async download(file, maxBytes = MAX_BYTES) {
      let url = file.urlMachine || file.DOWNLOAD_URL;
      for (let attempt = 0; attempt < 4; attempt++) {
        validateFileUrl(url, hosts);
        let response;
        try { response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(25000) }); }
        catch { throw new ArchiveError('FILE_DOWNLOAD_FAILED'); }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new ArchiveError('INVALID_FILE_REDIRECT');
          url = new URL(location, url).href;
          continue;
        }
        if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw new ArchiveError('INVALID_FILE_RESPONSE');
        }
        const chunks = []; let total = 0;
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > maxBytes) { await response.body.cancel().catch(() => {}); throw new ArchiveError('FILE_TOO_LARGE'); }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (/^\s*<(?:!doctype html|html)/i.test(bytes.subarray(0, 100).toString())) throw new ArchiveError('INVALID_FILE_RESPONSE');
        const disposition = response.headers.get('content-disposition') || '';
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
        let name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'document';
        try { if (encoded) name = decodeURIComponent(encoded); } catch { /* Keep the plain filename. */ }
        return { bytes, name: safeName(name) };
      }
      throw new ArchiveError('TOO_MANY_REDIRECTS');
    }
  };
  return api;
}

export class DiskStore {
  constructor(api, rootFolderId) {
    if (!/^\d+$/.test(String(rootFolderId)) || Number(rootFolderId) < 2) throw new ArchiveError('INVALID_ARCHIVE_FOLDER');
    this.api = api; this.root = String(rootFolderId);
  }
  async children(id, filter = {}) {
    const result = []; let start = 0;
    for (;;) {
      const page = await this.api.call('disk.folder.getChildren', { id, filter: { ...filter, DELETED_TYPE: 0 }, start });
      if (!Array.isArray(page.result)) throw new ArchiveError('INVALID_DISK_RESPONSE');
      result.push(...page.result.filter(active));
      if (page.next === undefined) return result;
      if (Number(page.next) <= start) throw new ArchiveError('INVALID_PAGINATION');
      start = Number(page.next);
    }
  }
  async find(id, name) {
    const matches = (await this.children(id, { NAME: name })).filter(f => f.NAME === name);
    if (matches.length > 1) throw new ArchiveError('DUPLICATE_ARCHIVE_NAME');
    return matches[0];
  }
  async folder(itemId) {
    if (!/^\d+$/.test(String(itemId))) throw new ArchiveError('INVALID_ITEM_ID');
    const name = `rpa-${TYPE_ID}-item-${itemId}`;
    let folder = await this.find(this.root, name);
    if (!folder) {
      try { folder = (await this.api.call('disk.folder.addSubFolder', { id: this.root, data: { NAME: name } })).result; }
      catch { folder = await this.find(this.root, name); if (!folder) throw new ArchiveError('ARCHIVE_FOLDER_CREATE_FAILED'); }
    }
    if (folder.TYPE !== 'folder' || String(folder.PARENT_ID) !== this.root) throw new ArchiveError('INVALID_ITEM_FOLDER');
    return String(folder.ID);
  }
  async read(file, maxBytes) {
    const current = (await this.api.call('disk.file.get', { id: file.ID })).result;
    if (!active(current)) throw new ArchiveError('ARCHIVE_FILE_REMOVED');
    return this.api.download(current, maxBytes);
  }
  async readJson(file) {
    try { return JSON.parse((await this.read(file, MAX_JSON_BYTES)).bytes.toString('utf8')); }
    catch (e) { if (e instanceof ArchiveError) throw e; throw new ArchiveError('INVALID_ARCHIVE_RECORD'); }
  }
  async put(id, name, bytes) {
    let file = await this.find(id, name);
    if (!file) {
      try { file = (await this.api.call('disk.folder.uploadFile', { id, data: { NAME: name },
        fileContent: upload(name, bytes), generateUniqueName: false })).result; }
      catch { file = await this.find(id, name); if (!file) throw new ArchiveError('ARCHIVE_UPLOAD_FAILED'); }
    }
    if (file.TYPE !== 'file' || String(file.PARENT_ID) !== String(id)) throw new ArchiveError('INVALID_ARCHIVE_FILE');
    if (sha((await this.read(file)).bytes) !== sha(bytes)) throw new ArchiveError('ARCHIVE_HASH_MISMATCH');
    return file;
  }
  async putJson(id, name, value) { return this.put(id, name, Buffer.from(stable(value))); }
}

// The uniquely named Bitrix file is an exclusive lease shared by old and new
// Render instances. Only expired leases/our own lease go to the recoverable trash.
export class DiskLease {
  constructor(store, { now = Date.now, ttlMs = 180000, owner = randomUUID() } = {}) {
    this.store = store; this.now = now; this.ttlMs = ttlMs; this.owner = owner; this.file = null; this.expires = 0;
    this.name = 'legal-archive-worker-lease.json';
  }
  async acquire() {
    if (this.file) { await this.assert(); return true; }
    const existing = await this.store.find(this.store.root, this.name);
    if (existing) {
      const state = await this.store.readJson(existing);
      if (state.schema !== 1 || !Number.isFinite(state.expires)) throw new ArchiveError('INVALID_WORKER_LEASE');
      if (state.expires > this.now()) return false;
      await this.store.api.call('disk.file.markDeleted', { id: existing.ID });
    }
    const expires = this.now() + this.ttlMs;
    const value = { schema: 1, typeId: TYPE_ID, owner: this.owner, expires };
    try {
      const response = await this.store.api.call('disk.folder.uploadFile', { id: this.store.root,
        data: { NAME: this.name }, fileContent: upload(this.name, Buffer.from(stable(value))), generateUniqueName: false });
      this.file = response.result;
    } catch {
      // Reconcile a timed-out successful create, but never adopt another owner's lease.
      const file = await this.store.find(this.store.root, this.name);
      if (!file || (await this.store.readJson(file)).owner !== this.owner) return false;
      this.file = file;
    }
    this.expires = expires;
    await this.assert();
    return true;
  }
  async assert() {
    if (!this.file || this.now() >= this.expires) { this.file = null; throw new ArchiveError('WORKER_LEASE_EXPIRED'); }
    const current = (await this.store.api.call('disk.file.get', { id: this.file.ID })).result;
    if (!active(current) || String(current.PARENT_ID) !== this.store.root) { this.file = null; throw new ArchiveError('WORKER_LEASE_LOST'); }
    if (this.expires - this.now() < this.ttlMs * 2 / 3) {
      const expires = this.now() + this.ttlMs;
      const value = { schema: 1, typeId: TYPE_ID, owner: this.owner, expires };
      await this.store.api.call('disk.file.uploadVersion', { id: this.file.ID,
        fileContent: upload(this.name, Buffer.from(stable(value))) });
      this.expires = expires;
    }
  }
  async release() {
    if (!this.file) return;
    const id = this.file.ID;
    try { await this.assert(); await this.store.api.call('disk.file.markDeleted', { id }); }
    finally { this.file = null; }
  }
}

function checkpointFor(item) {
  if (CHECKPOINTS[item.stageId]) return CHECKPOINTS[item.stageId];
  if (Number(item.stageId) !== 333) return null;
  const sources = { 2417: ['INVOICE_FILE'], 2419: ['ACT_FILE'], 2421: ['INVOICE_FILE', 'ACT_FILE'] }[item[P + 'DOCUMENT_TYPE']];
  return sources ? { sources, targets: sources.map(s => s === 'INVOICE_FILE' ? 'SNAPSHOT_INVOICE' : 'SNAPSHOT_ACT'), key: 'PACKAGE_VERSION_KEY' } : null;
}

export class LegalArchiver {
  constructor(api, store, lease) {
    this.api = api; this.store = store; this.lease = lease;
    // Disposable optimization only. A cold process always rebuilds/validates the
    // archive from Bitrix; this cache is never required for correctness/recovery.
    this.observed = new Map();
  }
  async writeItem(id, fields) { await this.lease.assert(); return this.api.updateItem(id, fields); }
  async record(item, slot, file, folder) {
    const name = `source-${slot}-${file.id}.json`;
    const saved = await this.store.find(folder, name);
    let record;
    if (saved) {
      record = await this.store.readJson(saved);
      if (record.schema !== 1 || record.typeId !== TYPE_ID || String(record.itemId) !== String(item.id) ||
          record.slot !== slot || String(record.sourceId) !== String(file.id) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new ArchiveError('INVALID_ARCHIVE_RECORD');
    } else {
      const { bytes, name: filename } = await this.api.download(file);
      const hash = sha(bytes);
      await this.lease.assert();
      const blob = await this.store.put(folder, `blob-${hash}-${safeName(filename)}`, bytes);
      record = { schema: 1, typeId: TYPE_ID, itemId: item.id, slot, sourceId: String(file.id),
        sha256: hash, filename: safeName(filename), blobId: String(blob.ID),
        context: businessContext(item), capturedAt: new Date().toISOString() };
      // Recover an accepted record upload with identical bytes after a lost response.
      await this.lease.assert();
      const existing = await this.store.find(folder, name);
      if (existing) record = await this.store.readJson(existing);
      else await this.store.putJson(folder, name, record);
    }
    const blob = (await this.api.call('disk.file.get', { id: record.blobId })).result;
    if (String(blob.PARENT_ID) !== String(folder)) throw new ArchiveError('ARCHIVE_BLOB_OUTSIDE_ITEM');
    const data = (await this.store.read(blob)).bytes;
    if (sha(data) !== record.sha256) throw new ArchiveError('ARCHIVE_HASH_MISMATCH');
    return { ...record, bytes: data };
  }
  async history(item, slot, file, folder) {
    const record = await this.record(item, slot, file, folder);
    const historyField = P + SOURCE_FIELDS[slot];
    const indexName = `history-${slot}-${file.id}.json`;
    let saved = await this.store.find(folder, indexName);
    let index = saved ? await this.store.readJson(saved) : null;
    let current = await this.api.getItem(item.id);
    let entries = fileRefs(current[historyField]);
    if (index && entries.some(f => String(f.id) === String(index.historyFileId))) return record;
    // Covers historical copies created by the previous prototype and ambiguous uploads.
    let match;
    for (const candidate of entries) {
      if (sha((await this.api.download(candidate)).bytes) === record.sha256) { match = candidate; break; }
    }
    if (!match && saved) throw new ArchiveError('HISTORY_LINK_REMOVED');
    if (!match) {
      const oldIds = new Set(entries.map(f => String(f.id)));
      await this.writeItem(item.id, { [historyField]: [...entries.map(f => ({ id: f.id })),
        upload(`archive-${slot}-${file.id}-${record.filename}`, record.bytes)] });
      current = await this.api.getItem(item.id);
      match = fileRefs(current[historyField]).find(f => !oldIds.has(String(f.id)));
      if (!match || sha((await this.api.download(match)).bytes) !== record.sha256) throw new ArchiveError('HISTORY_COPY_NOT_VERIFIED');
    }
    index = { schema: 1, sourceId: String(file.id), sha256: record.sha256, historyFileId: String(match.id) };
    // Index records are immutable; if a history link was manually removed, restore
    // the original link when it still exists instead of replacing the ledger.
    if (saved && String(index.historyFileId) !== String((await this.store.readJson(saved)).historyFileId)) {
      throw new ArchiveError('HISTORY_LINK_REMOVED');
    }
    if (!saved) { await this.lease.assert(); await this.store.putJson(folder, indexName, index); }
    return record;
  }
  async checkpoint(item, folder, spec, records) {
    const refs = spec.sources.map(s => fileRefs(item[P + s]));
    if (refs.some(x => x.length !== 1)) return;
    const key = sha(stable({ sources: refs.map(x => String(x[0].id)), context: businessContext(item) }));
    const name = `checkpoint-${spec.key}-${key}.json`;
    const matches = (state, cp) => cp && cp.key === key && cp.typeId === TYPE_ID && String(cp.itemId) === String(item.id) &&
      spec.targets.every((target, i) => fileRefs(state[P + target]).length === 1 && String(fileRefs(state[P + target])[0]?.id) === String(cp.targetIds[i]));
    const copyName = ids => `checkpoint-${spec.key}-${key}-copy-${sha(stable(ids))}.json`;
    let saved = await this.store.find(folder, name);
    let checkpoint = saved ? await this.store.readJson(saved) : null;
    // Returning to a previously approved context can require a fresh RPA copy.
    // Resolve its own immutable receipt instead of replacing the first receipt.
    if (checkpoint && !matches(item, checkpoint)) {
      const copy = await this.store.find(folder, copyName(spec.targets.map(target => String(fileRefs(item[P + target])[0]?.id))));
      if (copy) { saved = copy; checkpoint = await this.store.readJson(copy); }
    }
    const bindingsMatch = spec.sources.every((s, i) => String(item[P + SOURCE_KEYS[s]]) === String(refs[i][0].id));
    if (item[P + spec.key] === key && matches(item, checkpoint) && bindingsMatch) return;
    const current = await this.api.getItem(item.id);
    if (fingerprint(current) !== fingerprint(item)) throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
    if (!matches(current, checkpoint)) {
      const fields = { [P + spec.key]: '', [P + 'PACKAGE_APPROVED_KEY']: '' };
      for (let i = 0; i < spec.sources.length; i++) {
        const r = records.get(`${spec.sources[i]}:${refs[i][0].id}`);
        if (!r) throw new ArchiveError('SOURCE_NOT_ARCHIVED');
        const value = upload(`snapshot-${spec.sources[i]}-${refs[i][0].id}-${r.filename}`, r.bytes);
        fields[P + spec.targets[i]] = spec.targets[i] === 'PACKAGE_DOCUMENTS' ? [value] : value;
      }
      if (spec.key === 'VERSION_KEY') {
        fields[P + 'CLIENT_APPROVED_KEY'] = ''; fields[P + 'HEAD_APPROVED_KEY'] = '';
        if (current[P + spec.key]) fields[P + 'CLIENT_PROOF'] = '';
      }
      await this.writeItem(item.id, fields);
    }
    const after = await this.api.getItem(item.id);
    if (fingerprint(after) !== fingerprint(item)) throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
    const targetIds = [];
    for (let i = 0; i < spec.targets.length; i++) {
      const copied = fileRefs(after[P + spec.targets[i]]);
      const record = records.get(`${spec.sources[i]}:${refs[i][0].id}`);
      if (copied.length !== 1 || sha((await this.api.download(copied[0])).bytes) !== record.sha256) throw new ArchiveError('SNAPSHOT_COPY_NOT_VERIFIED');
      targetIds.push(String(copied[0].id));
    }
    checkpoint = { schema: 1, typeId: TYPE_ID, itemId: item.id, key, sourceIds: refs.map(x => String(x[0].id)),
      targetIds, context: businessContext(item) };
    let receiptName = name;
    if (saved && stable(await this.store.readJson(saved)) !== stable(checkpoint)) {
      receiptName = copyName(targetIds);
      saved = await this.store.find(folder, receiptName);
      if (saved && stable(await this.store.readJson(saved)) !== stable(checkpoint)) throw new ArchiveError('CHECKPOINT_SNAPSHOT_CHANGED');
    }
    if (!saved) { await this.lease.assert(); await this.store.putJson(folder, receiptName, checkpoint); }
    const final = await this.api.getItem(item.id);
    if (fingerprint(final) !== fingerprint(item) || !matches(final, checkpoint)) throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
    const fields = { [P + spec.key]: key };
    spec.sources.forEach((s, i) => { fields[P + SOURCE_KEYS[s]] = String(refs[i][0].id); });
    await this.writeItem(item.id, fields);
  }
  async process(item, { checkpointSpec, force = false } = {}) {
    const last = this.observed.get(String(item.id));
    if (!force && last && last.key === observation(item) && Date.now() - last.at < 12 * 60 * 60 * 1000) return;
    await this.lease.assert();
    if (item.createdBy && !item[P + 'MANAGER_EMAIL']) {
      const users = (await this.api.call('user.get', { ID: item.createdBy })).result;
      const matches = Array.isArray(users) ? users.filter(u => String(u.ID) === String(item.createdBy)) : [];
      if (matches.length !== 1 || !matches[0].EMAIL) throw new ArchiveError('AUTHOR_EMAIL_UNAVAILABLE');
      await this.writeItem(item.id, { [P + 'MANAGER_EMAIL']: matches[0].EMAIL });
    }
    const anyFiles = Object.keys(SOURCE_FIELDS).some(s => fileRefs(item[P + s]).length);
    if (!anyFiles) return;
    const folder = await this.store.folder(item.id);
    const records = new Map();
    for (const slot of Object.keys(SOURCE_FIELDS)) for (const file of fileRefs(item[P + slot])) {
      records.set(`${slot}:${file.id}`, await this.history(item, slot, file, folder));
    }
    const spec = checkpointSpec === undefined ? checkpointFor(item) : checkpointSpec;
    if (spec) await this.checkpoint(item, folder, spec, records);
    const after = await this.api.getItem(item.id);
    if (fingerprint(after) === fingerprint(item)) {
      if (this.observed.size >= 2000) this.observed.clear();
      this.observed.set(String(item.id), { key: observation(after), at: Date.now() });
    }
    return { folder, records };
  }
}

export function handoffTarget(item) {
  const billing = ['2417', '2419', '2421'].includes(String(item[P + 'DOCUMENT_TYPE']));
  const edo = String(item[P + 'SIGNING_CHANNEL']) === '2423';
  const fixed = { 313:321, 319:321, 321:323, 323:325, 325:327, 329:331, 331:333, 333:335, 339:315 };
  const from = Number(item.previousStageId);
  const target = fixed[from] || (from === 327 ? (edo ? 337 : 339) : from === 335 ? (edo ? 337 : 315) : from === 337 ? (billing ? 315 : 339) : null);
  if (!target || (billing && [313,319,321,323,325,327,339].includes(from)) || (!billing && [329,331,333,335].includes(from))) throw new ArchiveError('INVALID_HANDOFF_ROUTE');
  return target;
}
const transferInput = item => sha(stable({ context:businessContext(item), sources:sourceIds(item), contractEmail:item[P+'CONTRACT_EMAIL']||'', clientProof:item[P+'CLIENT_PROOF']||'' }));
function transferSpec(item) {
  const from = Number(item.previousStageId);
  if ([313,319].includes(from)) return CHECKPOINTS[321];
  if (from === 325) return CHECKPOINTS[327];
  if (from === 331) return checkpointFor({ ...item, stageId:333 });
  return null;
}
function requireFiles(item, slots) {
  if (slots.some(slot => !fileRefs(item[P+slot]).length)) throw new ArchiveError('HANDOFF_REQUIRED_FILE_MISSING');
}
function validateTransfer(item) {
  const from = Number(item.previousStageId);
  const spec = transferSpec(item);
  if (spec) requireFiles(item,spec.sources);
  if (from === 339) requireFiles(item,['FINAL_FILES']);
  if ([321,323].includes(from)) {
    requireFiles(item,['LEGAL_PROJECT','CLIENT_DOCUMENT']);
    const key = sha(stable({ sources:[String(fileRefs(item[P+'LEGAL_PROJECT'])[0].id)], context:businessContext(item) }));
    if (item[P+'VERSION_KEY'] !== key || String(item[P+'PROJECT_SOURCE_ID']) !== String(fileRefs(item[P+'LEGAL_PROJECT'])[0].id)) throw new ArchiveError('HANDOFF_PROJECT_VERSION_CHANGED');
    if (!String(item[P+'CLIENT_PROOF']||'').trim()) throw new ArchiveError('HANDOFF_CLIENT_APPROVAL_MISSING');
    if (from === 323 && item[P+'CLIENT_APPROVED_KEY'] !== key) throw new ArchiveError('HANDOFF_CLIENT_APPROVAL_MISSING');
  }
  if ([327,333,335,337,339].includes(from)) {
    const slots = [327,339].includes(from) || (from===337 && !['2417','2419','2421'].includes(String(item[P+'DOCUMENT_TYPE']))) ? ['CONTRACT_PACKAGE'] : checkpointFor({ ...item, stageId:333 })?.sources;
    if (!slots) throw new ArchiveError('INVALID_HANDOFF_ROUTE');
    requireFiles(item,slots);
    const key=sha(stable({ sources:slots.map(s=>String(fileRefs(item[P+s])[0].id)), context:businessContext(item) }));
    if (item[P+'PACKAGE_VERSION_KEY']!==key) throw new ArchiveError('HANDOFF_PACKAGE_VERSION_CHANGED');
    if ([335,337,339].includes(from) && item[P+'PACKAGE_APPROVED_KEY']!==key) throw new ArchiveError('HANDOFF_MANAGER_APPROVAL_MISSING');
  }
}

export class LegalRoleSummaries {
  constructor(api,lease,controls) { this.api=api; this.lease=lease; this.controls=controls; }
  async update(itemId, {stageId}={}) {
    const item=await this.api.getItem(itemId);
    const timeline=await this.controls.timeline(itemId);
    const result=buildRoleSummary(item,{stageId:stageId??Number(item.stageId),timeline});
    const key=sha(result.text);
    if(item[P+'ROLE_SUMMARY_KEY']!==key || item[P+'ROLE_SUMMARY']!==result.text) {
      await this.lease.assert();
      const current=await this.api.getItem(itemId);
      if(fingerprint(current)!==fingerprint(item))throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
      await this.api.updateItem(itemId,{[P+'ROLE_SUMMARY']:result.text,[P+'ROLE_SUMMARY_KEY']:key});
    }
    return result;
  }
}

// Human approval remains in native RPA tasks. Their successful action enters
// this automatic stage; the next human task is created only after verified
// archival, an immutable transfer receipt, and the recipient's summary exist.
export class LegalHandoff {
  constructor(api,store,lease,archiver,controls,summaries,{stageId}={}) {
    if(!Number.isInteger(stageId)||stageId<1)throw new ArchiveError('INVALID_HANDOFF_STAGE');
    Object.assign(this,{api,store,lease,archiver,controls,summaries,stageId});
  }
  async process(itemId) {
    let item=await this.api.getItem(itemId);
    if(Number(item.stageId)!==this.stageId)return {skipped:true};
    const target=handoffTarget(item), from=Number(item.previousStageId), input=transferInput(item);
    const moved=String(item.movedTime||'');
    if(!moved)throw new ArchiveError('HANDOFF_TIME_MISSING');
    validateTransfer(item);
    const record=await this.archiver.process(item,{checkpointSpec:transferSpec(item),force:true});
    let current=await this.api.getItem(itemId);
    if(Number(current.stageId)!==this.stageId || Number(current.previousStageId)!==from || String(current.movedTime)!==moved || transferInput(current)!==input)throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
    const fields={};
    if(from===321)fields[P+'CLIENT_APPROVED_KEY']=current[P+'VERSION_KEY'];
    if(from===323)fields[P+'HEAD_APPROVED_KEY']=current[P+'VERSION_KEY'];
    if([327,333].includes(from))fields[P+'PACKAGE_APPROVED_KEY']=current[P+'PACKAGE_VERSION_KEY'];
    if(Object.keys(fields).length){await this.lease.assert();await this.api.updateItem(itemId,fields);}
    const folder=record?.folder||await this.store.folder(itemId);
    const id=sha(stable({itemId:String(itemId),from,target,moved,input}));
    const receipt={schema:1,typeId:TYPE_ID,itemId:String(itemId),from,target,transferredBy:Number(item.movedBy)||null,requestedAt:moved,input,
      files:[...(record?.records?.values()||[])].map(r=>({slot:r.slot,sourceId:r.sourceId,sha256:r.sha256,blobId:r.blobId})).sort((a,b)=>`${a.slot}:${a.sourceId}`.localeCompare(`${b.slot}:${b.sourceId}`))};
    await this.lease.assert();
    await this.store.putJson(folder,`handoff-${id}.json`,receipt);
    if(current[P+'TECH_ERROR']&&this.controls.recover)await this.controls.recover(itemId);
    if(this.summaries)await this.summaries.update(itemId,{stageId:target});
    // Cancellation and concurrent edits must be checked again after I/O.
    await this.controls.cancel(itemId,{dryRun:false});
    current=await this.api.getItem(itemId);
    if(Number(current.stageId)===317)return {cancelled:true};
    if(Number(current.stageId)!==this.stageId || Number(current.previousStageId)!==from || String(current.movedTime)!==moved || transferInput(current)!==input)throw new ArchiveError('ITEM_CHANGED_DURING_CAPTURE');
    await this.lease.assert();
    await this.api.updateItem(itemId,{[P+'HANDOFF_RECEIPT_KEY']:id,[P+'TECH_ERROR']:'',[P+'TECH_ERROR_KEY']:''});
    await this.lease.assert();
    try { await this.api.updateItem(itemId,{stageId:target}); }
    catch(error) { if(Number((await this.api.getItem(itemId)).stageId)!==target)throw error; }
    const after=await this.api.getItem(itemId);
    if(Number(after.stageId)===this.stageId)throw new ArchiveError('HANDOFF_STAGE_NOT_CHANGED');
    return {transferred:true,from,target,receipt:id,files:receipt.files.length};
  }
}

// Feed comments are the audited source of a cancellation request. Never infer
// its author from item.updatedBy: background archival also updates that field.
export class LegalProcessControls {
  constructor(api, lease) { this.api = api; this.lease = lease; }
  async timeline(itemId) {
    const rows = []; let start = 0;
    for (;;) {
      const page = await this.api.call('rpa.timeline.listForItem', { typeId: TYPE_ID, itemId, start });
      const batch = page.result?.timeline;
      if (!Array.isArray(batch)) throw new ArchiveError('INVALID_TIMELINE');
      if (batch.some(r => Number(r.typeId) !== TYPE_ID || String(r.itemId) !== String(itemId))) throw new ArchiveError('TIMELINE_OUTSIDE_ITEM');
      rows.push(...batch);
      if (page.next === undefined && batch.length < 50) return rows;
      const next = Number(page.next ?? start + 50);
      if (next <= start) throw new ArchiveError('INVALID_PAGINATION');
      start = next;
    }
  }
  async commentOnce(itemId, marker, message) {
    if ((await this.timeline(itemId)).some(r => r.action === 'comment' && Number(r.userId) === 1 && String(r.description).includes(marker))) return;
    await this.lease.assert();
    await this.api.call('rpa.comment.add', { typeId: TYPE_ID, itemId, fields: { description: `${message}\n${marker}` } });
  }
  async reportError(itemId, error) {
    const code = error instanceof ArchiveError && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
    // A lost lease must stop this instance, not let it write alongside the owner.
    await this.lease.assert();
    let item = await this.api.getItem(itemId);
    const signature = sha(stable({ code, input: fingerprint(item) }));
    const previous = String(item[P + 'TECH_ERROR_KEY'] || '');
    let event = previous.startsWith(signature + ':') ? previous : `${signature}:${randomUUID()}:new`;
    const message = `Техническая ошибка автоматизации (${code}). Обработка будет повторена автоматически. Если ошибка сохраняется, обратитесь к администратору.`;
    if (item[P + 'TECH_ERROR'] !== message || previous !== event) {
      await this.api.updateItem(itemId, { [P + 'TECH_ERROR']: message, [P + 'TECH_ERROR_KEY']: event });
    }
    const episode = event.split(':')[1];
    await this.commentOnce(itemId, `[legal-error:${episode}]`, message);
    if (event.endsWith(':new')) {
      // Webhook notifications ignore TAG. Persist the attempt before sending;
      // an ambiguous transport failure must not create a notification every poll.
      event = `${signature}:${episode}:notification-attempted`;
      await this.lease.assert();
      await this.api.updateItem(itemId, { [P + 'TECH_ERROR_KEY']: event });
      const authorId = Number(item.createdBy);
      for (const userId of new Set([1, authorId].filter(id => Number.isInteger(id) && id > 0))) {
        await this.lease.assert();
        await this.api.call('im.notify.system.add', { USER_ID: userId,
          MESSAGE: `Ошибка автоматизации заявки №${itemId}: ${code}. [URL=https://myosminozhka.bitrix24.ru/rpa/item/57/${itemId}/]Открыть заявку[/URL]` });
      }
    }
  }
  async recover(itemId) {
    const item = await this.api.getItem(itemId);
    if (!item[P + 'TECH_ERROR_KEY'] && !item[P + 'TECH_ERROR']) return;
    await this.commentOnce(itemId, `[legal-recovered:${sha(String(item[P + 'TECH_ERROR_KEY']))}]`, 'Обработка автоматизации восстановлена. Техническая ошибка снята.');
    await this.lease.assert();
    await this.api.updateItem(itemId, { [P + 'TECH_ERROR']: '', [P + 'TECH_ERROR_KEY']: '' });
  }
  async workflows(itemId) {
    const identity = { MODULE_ID: 'rpa', ENTITY: 'Bitrix\\Rpa\\Integration\\Bizproc\\Document\\Item', DOCUMENT_ID: `${TYPE_ID}:${itemId}` };
    const rows = []; let start = 0;
    for (;;) {
      const page = await this.api.call('bizproc.workflow.instances', {
        // This portal returns ENTITY with doubled backslashes, and filtering
        // on the canonical single-backslash value silently returns no rows.
        // Filter by module/document, then verify the class on every result.
        SELECT: ['ID', ...Object.keys(identity)], FILTER: { MODULE_ID: identity.MODULE_ID, DOCUMENT_ID: identity.DOCUMENT_ID }, ORDER: { ID: 'ASC' }, start });
      if (!Array.isArray(page.result) || page.result.some(r => !r.ID || r.MODULE_ID !== identity.MODULE_ID || r.DOCUMENT_ID !== identity.DOCUMENT_ID ||
          String(r.ENTITY).replace(/\\+/g, '\\') !== identity.ENTITY)) throw new ArchiveError('WORKFLOW_OUTSIDE_ITEM');
      rows.push(...page.result);
      if (page.next === undefined) return rows;
      if (Number(page.next) <= start) throw new ArchiveError('INVALID_PAGINATION');
      start = Number(page.next);
    }
  }
  async cancel(itemId, { dryRun = true } = {}) {
    let item = await this.api.getItem(itemId);
    if (Number(item.stageId) === 315) return { cancelled: false, reason: 'already_completed' };
    const rows = await this.timeline(itemId);
    const command = rows.filter(r => r.action === 'comment' && [1, Number(item.createdBy)].includes(Number(r.userId)) && /^\s*ОТМЕНИТЬ ЗАЯВКУ:\s*\S[\s\S]{2,999}\s*$/iu.test(String(r.textDescription ?? r.description)))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!command) return { cancelled: false, reason: 'no_authorized_command' };
    if (String(item[P + 'CANCELLED_COMMAND_ID']) === String(command.id)) return { cancelled: Number(item.stageId) === 317, reason: 'command_already_processed' };
    const workflows = await this.workflows(itemId);
    const plan = { itemId, commandId: command.id, authorId: command.userId, workflowIds: workflows.map(w => w.ID), targetStageId: 317 };
    if (dryRun) return { dryRun: true, ...plan };
    // Freeze the exact request before touching active workflows. No approval
    // task is completed to achieve cancellation, and no files are deleted.
    const reason = String(command.textDescription ?? command.description).replace(/^\s*ОТМЕНИТЬ ЗАЯВКУ:\s*/iu, '').replace(/[<>\[\]]/g, '').trim();
    await this.commentOnce(itemId, `[legal-cancel-request:${command.id}]`, `Принята отмена заявки по комментарию №${command.id}, автор ${command.userId}. Причина: ${reason}\nЗадания и напоминания останавливаются.`);
    let pending = workflows;
    for (let round = 0; pending.length && round < 3; round++) {
      for (const w of pending) {
        await this.lease.assert();
        try { await this.api.call('bizproc.workflow.terminate', { ID: w.ID, STATUS: `Отмена RPA 57:${itemId}, комментарий ${command.id}` }); }
        catch (e) {
          // A successful termination may have lost its response. Reconcile only
          // against this exact item's current instances, never kill blindly.
          if ((await this.workflows(itemId)).some(current => current.ID === w.ID)) throw e;
        }
      }
      pending = await this.workflows(itemId);
    }
    if (pending.length) throw new ArchiveError('CANCELLATION_STILL_RUNNING');
    item = await this.api.getItem(itemId);
    if (Number(item.stageId) === 315) throw new ArchiveError('CANCELLATION_COMPLETED_CONCURRENTLY');
    await this.lease.assert();
    if (Number(item.stageId) !== 317) await this.api.updateItem(itemId, { stageId: 317 });
    if (Number((await this.api.getItem(itemId)).stageId) !== 317) throw new ArchiveError('CANCELLATION_NOT_VERIFIED');
    if ((await this.workflows(itemId)).length) throw new ArchiveError('CANCELLATION_STILL_RUNNING');
    await this.lease.assert();
    await this.api.updateItem(itemId, { [P + 'CANCELLED_COMMAND_ID']: String(command.id) });
    await this.commentOnce(itemId, `[legal-cancelled:${command.id}]`, `Заявка отменена по комментарию №${command.id}. Задания и напоминания остановлены. Карточка, причина отмены и архив документов сохранены.`);
    return { cancelled: true, ...plan };
  }
}

export function buildBillingActionUrl(item,code){
 if(!/^local\.[a-zA-Z0-9._-]+$/.test(code||'')||!/^\d+$/.test(String(item.id)))return '';
 const key=item[P+'VERSION_KEY'];const ready=[2403,2405,2407,2409,2411,2415].includes(Number(item[P+'DOCUMENT_TYPE']))&&[325,327,337,339,315].includes(Number(item.stageId))&&key&&item[P+'HEAD_APPROVED_KEY']===key&&item[P+'CLIENT_APPROVED_KEY']===key;
 return ready?`https://myosminozhka.bitrix24.ru/marketplace/view/${code}/?params[sourceId]=${item.id}`:'';
}

export function startLegalArchiveFromEnv(env = process.env, { logger = console.log, apiFactory = createArchiveApi } = {}) {
  if (env.LEGAL_ARCHIVE_ENABLED !== 'true') return { enabled: false, stop: async () => {} };
  const api = apiFactory(env.LEGAL_ARCHIVE_WEBHOOK_URL);
  const store = new DiskStore(api, env.LEGAL_ARCHIVE_FOLDER_ID);
  const lease = new DiskLease(store);
  const archiver = new LegalArchiver(api, store, lease);
  const controls = new LegalProcessControls(api, lease);
  const feedbackEnabled = env.LEGAL_PROCESS_FEEDBACK_ENABLED === 'true';
  const cancellationEnabled = env.LEGAL_PROCESS_CANCELLATION_ENABLED === 'true';
  const summariesEnabled = env.LEGAL_ROLE_SUMMARIES_ENABLED === 'true';
  const reviewEnabled = env.LEGAL_CLIENT_REVIEW_ENABLED === 'true';
  const review = reviewEnabled ? new LegalClientReview(api,store,lease,controls,{stageId:Number(env.LEGAL_CLIENT_REVIEW_STAGE_ID)}) : null;
  if(reviewEnabled&&(!cancellationEnabled||!Number.isInteger(review.stageId)||review.stageId<1))throw new ArchiveError('INVALID_CLIENT_REVIEW_CONFIG');
  const billingCode=env.LEGAL_BILLING_APP_ENABLED==='true'?env.LEGAL_BILLING_APP_CODE:'';
  if(billingCode&&!/^local\.[a-zA-Z0-9._-]+$/.test(billingCode))throw new ArchiveError('INVALID_BILLING_APP_CODE');
  const billingLink=async item=>{if(!billingCode)return;const url=buildBillingActionUrl(item,billingCode);if((item[P+'BILLING_ACTION_URL']||'')!==url){await lease.assert();await api.updateItem(item.id,{[P+'BILLING_ACTION_URL']:url});}};
  const handoffEnabled = env.LEGAL_HANDOFF_ENABLED === 'true';
  const summaries = summariesEnabled ? new LegalRoleSummaries(api,lease,controls) : null;
  const handoff = handoffEnabled ? new LegalHandoff(api,store,lease,archiver,controls,summaries,{stageId:Number(env.LEGAL_HANDOFF_STAGE_ID)}) : null;
  if(handoffEnabled&&!cancellationEnabled)throw new ArchiveError('HANDOFF_REQUIRES_CANCELLATION');
  const allow = new Set((env.LEGAL_ARCHIVE_ALLOWED_ITEM_IDS || '').split(',').filter(Boolean));
  const pollMs = Math.max(30000, Number(env.LEGAL_ARCHIVE_POLL_MS || 60000));
  if (!Number.isFinite(pollMs) || [...allow].some(id => !/^\d+$/.test(id))) throw new ArchiveError('INVALID_ARCHIVE_CONFIG');
  const handoffPollMs=Math.max(5000,Number(env.LEGAL_HANDOFF_POLL_MS||5000));
  if(!Number.isFinite(handoffPollMs))throw new ArchiveError('INVALID_HANDOFF_POLL');
  let stopped = false, timer, running, priorityTimer, priorityRunning, verified=false;
  const locks=new Map();
  const locked=async(id,fn)=>{const key=String(id),next=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}};
  const log = fields => logger(JSON.stringify({ ...fields, component: 'legal_archive', aiEnabled: false }));
  const report=async(itemId,error)=>{
    log({event:'item_error',itemId,code:error instanceof ArchiveError||error instanceof ClientReviewError?error.code:'UNEXPECTED_ERROR'});
    if(feedbackEnabled){try{await controls.reportError(itemId,error instanceof ClientReviewError?new ArchiveError(error.code):error);}catch(e){log({event:'feedback_error',itemId,code:e instanceof ArchiveError?e.code:'UNEXPECTED_ERROR'});}}
  };
  const once = async () => {
    const type = (await api.call('rpa.type.get', { id: TYPE_ID })).result.type;
    if (type.title !== 'Юридические документы — разработка') throw new ArchiveError('UNEXPECTED_RPA_TYPE');
    const root = (await api.call('disk.folder.get', { id: store.root })).result;
    if (root.NAME !== 'OSMI Legal RPA 57 - development archive' || String(root.STORAGE_ID) !== '1' || String(root.PARENT_ID) !== '1' || !active(root)) throw new ArchiveError('UNEXPECTED_ARCHIVE_FOLDER');
    if(handoffEnabled){const stage=(await api.call('rpa.stage.get',{id:handoff.stageId})).result.stage;if(Number(stage.typeId)!==TYPE_ID||stage.code!=='archive_handoff')throw new ArchiveError('UNEXPECTED_HANDOFF_STAGE');}
    if(review){const stage=(await api.call('rpa.stage.get',{id:review.stageId})).result.stage;if(Number(stage.typeId)!==TYPE_ID||stage.code!=='client_review')throw new ArchiveError('UNEXPECTED_CLIENT_REVIEW_STAGE');}
    verified=true;
    if (!await lease.acquire()) { log({ event: 'lease_busy' }); return; }
    let start = 0, processed = 0;
    for (;;) {
      if (stopped) break;
      const page = await api.call('rpa.item.list', { typeId: TYPE_ID, start, order: { id: 'ASC' } });
      for (const item of page.result.items) {
        if (stopped) break;
        if (allow.size && !allow.has(String(item.id))) continue;
        try {
          await locked(item.id,async()=>{
            if (cancellationEnabled) await controls.cancel(item.id, { dryRun: false });
            const current=await api.getItem(item.id);
            if((handoff && Number(current.stageId)===handoff.stageId)||(review&&Number(current.stageId)===review.stageId))return;
            await archiver.process(current);
            await billingLink(await api.getItem(item.id));
            if (feedbackEnabled) await controls.recover(item.id);
            if(summariesEnabled && ![315,317].includes(Number(current.stageId)))await summaries.update(item.id);
          });
          processed++;
        } catch (error) {
          await report(item.id,error);
        }
      }
      if (page.next === undefined) break;
      if (Number(page.next) <= start) throw new ArchiveError('INVALID_PAGINATION');
      start = Number(page.next);
    }
    log({ event: 'poll_complete', processed });
  };
  const priority=async()=>{
    if(!verified||!await lease.acquire())return;
    let start=0;
    for(;;){
      const activeStages=[309,311,313,319,321,323,325,327,329,331,333,335,337,339,...(billingCode?[315]:[]),...[handoff?.stageId,review?.stageId].filter(Boolean)];
      const priorityStages=summariesEnabled?activeStages:[...new Set([handoff?.stageId,review?.stageId,...(billingCode?[325,327,337,339,315]:[])].filter(Boolean))];
      const page=await api.call('rpa.item.list',{typeId:TYPE_ID,filter:{stageId:priorityStages},start,order:{id:'ASC'}});
      if(!Array.isArray(page.result?.items))throw new ArchiveError('INVALID_HANDOFF_LIST');
      const prioritized=[...page.result.items].sort((a,b)=>(Number(b.stageId)===handoff?.stageId)-(Number(a.stageId)===handoff?.stageId));
      for(const item of prioritized){
        if(stopped)break;
        // Never rely on a server-side filter alone before a mutation.
        if(!activeStages.includes(Number(item.stageId)))continue;
        if(allow.size&&!allow.has(String(item.id)))continue;
        try{
          if(review&&Number(item.stageId)===review.stageId){const result=await locked(item.id,()=>review.process(item.id));if(result.transferred)log({event:'client_review_complete',itemId:item.id,target:result.target,manual:result.manual,changes:result.changes});}
          else if(handoff&&Number(item.stageId)===handoff.stageId){const result=await locked(item.id,()=>handoff.process(item.id));if(result.transferred){await billingLink(await api.getItem(item.id));log({event:'handoff_complete',itemId:item.id,from:result.from,target:result.target,files:result.files});}}
          else if(billingCode)await locked(item.id,()=>billingLink(item));
          if(summariesEnabled&&!String(item[P+'ROLE_SUMMARY']||'').startsWith(buildRoleSummary(item).text.split('\n')[0]+'\n'))await locked(item.id,()=>summaries.update(item.id));
        }
        catch(error){await report(item.id,error);}
      }
      if(stopped||page.next===undefined)break;
      if(Number(page.next)<=start)throw new ArchiveError('INVALID_PAGINATION');start=Number(page.next);
    }
  };
  const priorityTick=()=>{
    if(stopped)return;
    priorityRunning=priority().catch(e=>log({event:'handoff_poll_error',code:e instanceof ArchiveError?e.code:'UNEXPECTED_ERROR'}))
      .finally(()=>{if(!stopped){priorityTimer=setTimeout(priorityTick,handoffPollMs);priorityTimer.unref?.();}});
  };
  const tick = () => {
    if (stopped) return;
    running = once().catch(error => log({ event: 'poll_error', code: error instanceof ArchiveError ? error.code : 'UNEXPECTED_ERROR' }))
      .finally(() => { if (!stopped) { timer = setTimeout(tick, pollMs); timer.unref?.(); } });
  };
  timer = setTimeout(tick, 1000); timer.unref?.();
  if(handoff||review){priorityTimer=setTimeout(priorityTick,2000);priorityTimer.unref?.();}
  return { enabled: true, async stop() {
    stopped = true; clearTimeout(timer);clearTimeout(priorityTimer);
    await Promise.allSettled([running,priorityRunning]);
    await lease.release().catch(() => {});
  } };
}

export function startLegalArchiveSafely(env = process.env, options = {}) {
  try { return startLegalArchiveFromEnv(env, options); }
  catch (error) {
    (options.logger || console.log)(JSON.stringify({ component: 'legal_archive', event: 'configuration_error',
      code: error instanceof ArchiveError ? error.code : 'UNEXPECTED_ERROR', aiEnabled: false }));
    return { enabled: false, stop: async () => {} };
  }
}
