import {ArchiveError,P} from '../../src/src/legal-archive.mjs';
export class MemoryBitrix {
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
