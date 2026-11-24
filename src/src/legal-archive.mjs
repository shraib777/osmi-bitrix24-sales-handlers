import { createHash, randomUUID } from 'node:crypto';

// Only the development RPA is enabled by this integration. No AI, email,
// approval decisions, stage changes, or public archive endpoints.
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
  async process(item) {
    const last = this.observed.get(String(item.id));
    if (last && last.key === observation(item) && Date.now() - last.at < 12 * 60 * 60 * 1000) return;
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
    const spec = checkpointFor(item);
    if (spec) await this.checkpoint(item, folder, spec, records);
    const after = await this.api.getItem(item.id);
    if (fingerprint(after) === fingerprint(item)) {
      if (this.observed.size >= 2000) this.observed.clear();
      this.observed.set(String(item.id), { key: observation(after), at: Date.now() });
    }
  }
}

export function startLegalArchiveFromEnv(env = process.env, { logger = console.log, apiFactory = createArchiveApi } = {}) {
  if (env.LEGAL_ARCHIVE_ENABLED !== 'true') return { enabled: false, stop: async () => {} };
  const api = apiFactory(env.LEGAL_ARCHIVE_WEBHOOK_URL);
  const store = new DiskStore(api, env.LEGAL_ARCHIVE_FOLDER_ID);
  const lease = new DiskLease(store);
  const archiver = new LegalArchiver(api, store, lease);
  const allow = new Set((env.LEGAL_ARCHIVE_ALLOWED_ITEM_IDS || '').split(',').filter(Boolean));
  const pollMs = Math.max(30000, Number(env.LEGAL_ARCHIVE_POLL_MS || 60000));
  if (!Number.isFinite(pollMs) || [...allow].some(id => !/^\d+$/.test(id))) throw new ArchiveError('INVALID_ARCHIVE_CONFIG');
  let stopped = false, timer, running;
  const log = fields => logger(JSON.stringify({ ...fields, component: 'legal_archive', aiEnabled: false }));
  const once = async () => {
    const type = (await api.call('rpa.type.get', { id: TYPE_ID })).result.type;
    if (type.title !== 'Юридические документы — разработка') throw new ArchiveError('UNEXPECTED_RPA_TYPE');
    const root = (await api.call('disk.folder.get', { id: store.root })).result;
    if (root.NAME !== 'OSMI Legal RPA 57 - development archive' || String(root.STORAGE_ID) !== '1' || String(root.PARENT_ID) !== '1' || !active(root)) throw new ArchiveError('UNEXPECTED_ARCHIVE_FOLDER');
    if (!await lease.acquire()) { log({ event: 'lease_busy' }); return; }
    let start = 0, processed = 0;
    for (;;) {
      if (stopped) break;
      const page = await api.call('rpa.item.list', { typeId: TYPE_ID, start, order: { id: 'ASC' } });
      for (const item of page.result.items) {
        if (stopped) break;
        if (allow.size && !allow.has(String(item.id))) continue;
        try { await archiver.process(item); processed++; }
        catch (error) { log({ event: 'item_error', itemId: item.id, code: error instanceof ArchiveError ? error.code : 'UNEXPECTED_ERROR' }); }
      }
      if (page.next === undefined) break;
      if (Number(page.next) <= start) throw new ArchiveError('INVALID_PAGINATION');
      start = Number(page.next);
    }
    log({ event: 'poll_complete', processed });
  };
  const tick = () => {
    if (stopped) return;
    running = once().catch(error => log({ event: 'poll_error', code: error instanceof ArchiveError ? error.code : 'UNEXPECTED_ERROR' }))
      .finally(() => { if (!stopped) { timer = setTimeout(tick, pollMs); timer.unref?.(); } });
  };
  timer = setTimeout(tick, 1000); timer.unref?.();
  return { enabled: true, async stop() {
    stopped = true; clearTimeout(timer);
    await running;
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
