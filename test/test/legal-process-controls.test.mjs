import test from 'node:test';
import assert from 'node:assert/strict';
import { LegalProcessControls, ArchiveError, P } from '../../src/src/legal-archive.mjs';

class ControlApi {
  constructor() {
    this.item = { id: 19, stageId: 321, createdBy: 7 };
    this.rows = []; this.calls = []; this.workflows = []; this.ids = 100;
    this.lease = { assert: async () => { if (this.lostLease) throw new ArchiveError('WORKER_LEASE_LOST'); } };
    this.controls = new LegalProcessControls(this, this.lease);
  }
  command(userId = 7, text = 'ОТМЕНИТЬ ЗАЯВКУ: Клиент отказался от договора') {
    this.rows.push({ id: ++this.ids, typeId: 57, itemId: 19, userId, action: 'comment', description: text });
  }
  workflow(id = 'wf1') {
    this.workflows.push({ ID: id, MODULE_ID: 'rpa', ENTITY: 'Bitrix\\Rpa\\Integration\\Bizproc\\Document\\Item', DOCUMENT_ID: '57:19' });
  }
  async getItem() { return structuredClone(this.item); }
  async updateItem(id, fields) {
    this.calls.push({ method: 'rpa.item.update', params: { id, fields } });
    Object.assign(this.item, fields);
  }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'rpa.timeline.listForItem') return { result: { timeline: structuredClone(this.rows.slice(params.start, params.start + 50)) } };
    if (method === 'rpa.comment.add') {
      const row = { id: ++this.ids, typeId: 57, itemId: 19, action: 'comment', userId: 1, description: params.fields.description };
      this.rows.push(row);
      if (this.failCommentAfter) { this.failCommentAfter = false; throw new ArchiveError('BITRIX_TRANSPORT_ERROR'); }
      return { result: { comment: row } };
    }
    if (method === 'im.notify.system.add') {
      if (this.failNotify) throw new ArchiveError('BITRIX_TRANSPORT_ERROR');
      return { result: ++this.ids };
    }
    if (method === 'bizproc.workflow.instances') return { result: structuredClone(this.workflows) };
    if (method === 'bizproc.workflow.terminate') {
      this.workflows = this.workflows.filter(w => w.ID !== params.ID);
      if (this.failTerminateAfter) { this.failTerminateAfter = false; throw new ArchiveError('BITRIX_TRANSPORT_ERROR'); }
      return { result: true };
    }
    throw new Error('Unexpected method: ' + method);
  }
}
const writes = a => a.calls.filter(c => !['rpa.timeline.listForItem', 'bizproc.workflow.instances'].includes(c.method));

test('error is visible in the card and feed; same episode does not repeat notifications across restarts', async () => {
  const a = new ControlApi();
  await a.controls.reportError(19, new ArchiveError('FILE_TOO_LARGE'));
  assert.match(a.item[P + 'TECH_ERROR'], /FILE_TOO_LARGE/);
  assert.equal(a.rows.length, 1);
  assert.deepEqual(a.calls.filter(c => c.method === 'im.notify.system.add').map(c => c.params.USER_ID), [1, 7]);
  const before = writes(a).length;
  await new LegalProcessControls(a, a.lease).reportError(19, new ArchiveError('FILE_TOO_LARGE'));
  assert.equal(writes(a).length, before);
});
test('recovery is recorded once and a later recurrence creates a fresh episode', async () => {
  const a = new ControlApi();
  await a.controls.reportError(19, new ArchiveError('FILE_TOO_LARGE'));
  await a.controls.recover(19); await a.controls.recover(19);
  assert.equal(a.item[P + 'TECH_ERROR'], ''); assert.equal(a.rows.length, 2);
  await a.controls.reportError(19, new ArchiveError('FILE_TOO_LARGE'));
  assert.equal(a.rows.length, 3);
});
test('lost comment response reconciles without duplicate and raw exceptions stay private', async () => {
  const a = new ControlApi(); a.failCommentAfter = true;
  await assert.rejects(a.controls.reportError(19, Error('SECRET WEBHOOK AND DOCUMENT')), /TRANSPORT/);
  await a.controls.reportError(19, Error('SECRET WEBHOOK AND DOCUMENT'));
  assert.equal(a.rows.length, 1);
  assert.doesNotMatch(JSON.stringify(a.rows) + JSON.stringify(a.item), /SECRET/);
});
test('ambiguous notification send is not blindly repeated', async () => {
  const a = new ControlApi(); a.failNotify = true;
  await assert.rejects(a.controls.reportError(19, Error()), /TRANSPORT/);
  a.failNotify = false;
  await a.controls.reportError(19, Error());
  assert.equal(a.calls.filter(c => c.method === 'im.notify.system.add').length, 1);
  assert.ok(a.item[P + 'TECH_ERROR']);
});
test('lost worker lease prevents comments, notifications and cancellation writes', async () => {
  const a = new ControlApi(); a.lostLease = true; a.command(); a.workflow();
  await assert.rejects(a.controls.reportError(19, Error()), /WORKER_LEASE_LOST/);
  await assert.rejects(a.controls.cancel(19, { dryRun: false }), /WORKER_LEASE_LOST/);
  assert.equal(writes(a).length, 0);
});
test('cancellation dry-run lists exact workflows without changing any data', async () => {
  const a = new ControlApi(); a.command(); a.workflow();
  const plan = await a.controls.cancel(19);
  assert.equal(plan.dryRun, true); assert.deepEqual(plan.workflowIds, ['wf1']);
  assert.equal(writes(a).length, 0); assert.equal(a.item.stageId, 321);
});
test('cancellation stops workflows and preserves card and evidence without fake approvals', async () => {
  const a = new ControlApi(); a.command(); a.workflow(); a.workflow('wf2');
  a.item[P + 'LEGAL_PROJECT'] = { id: 66 }; a.item[P + 'PROJECT_HISTORY'] = [{ id: 67 }];
  const result = await a.controls.cancel(19, { dryRun: false });
  assert.equal(result.cancelled, true); assert.equal(a.item.stageId, 317); assert.equal(a.workflows.length, 0);
  assert.deepEqual(a.item[P + 'PROJECT_HISTORY'], [{ id: 67 }]);
  assert.ok(!a.calls.some(c => /kill|delete|task.do|markDeleted/.test(c.method)));
  const before = writes(a).length;
  await new LegalProcessControls(a, a.lease).cancel(19, { dryRun: false });
  assert.equal(writes(a).length, before);
});
test('third-party comments, empty reasons and completed requests cannot cancel a document', async () => {
  const a = new ControlApi(); a.command(17); a.command(7, 'ОТМЕНИТЬ ЗАЯВКУ: ');
  assert.equal((await a.controls.cancel(19, { dryRun: false })).cancelled, false);
  a.command(1); a.item.stageId = 315;
  assert.equal((await a.controls.cancel(19, { dryRun: false })).reason, 'already_completed');
  assert.equal(writes(a).length, 0);
});
test('unrelated workflow from a bad filter is never terminated', async () => {
  const a = new ControlApi(); a.command(); a.workflow(); a.workflows[0].DOCUMENT_ID = '11:19';
  await assert.rejects(a.controls.cancel(19, { dryRun: false }), /WORKFLOW_OUTSIDE_ITEM/);
  assert.equal(writes(a).length, 0);
});
test('lost termination response is reconciled against the exact item', async () => {
  const a = new ControlApi(); a.command(); a.workflow(); a.failTerminateAfter = true;
  assert.equal((await a.controls.cancel(19, { dryRun: false })).cancelled, true);
  assert.equal(a.calls.filter(c => c.method === 'bizproc.workflow.terminate').length, 1);
});
test('old cancellation command cannot cancel a reopened request', async () => {
  const a = new ControlApi(); a.command();
  a.item[P + 'CANCELLED_COMMAND_ID'] = String(a.rows[0].id);
  assert.equal((await a.controls.cancel(19, { dryRun: false })).reason, 'command_already_processed');
  assert.equal(writes(a).length, 0);
});
