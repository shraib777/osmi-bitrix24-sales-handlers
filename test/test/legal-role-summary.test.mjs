import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRoleSummary,literalFacts,recipientSummary,summaryRole} from '../../src/src/legal-role-summary.mjs';
const P='UF_RPA_57_';
const item={id:19,stageId:323,[P+'DOCUMENT_TYPE']:'2403',[P+'COUNTERPARTY_NAME']:'ТЕСТ — Альфа',[P+'REQUEST_TEXT']:'Нужно ДС.\nСумма: 100 000 руб.\nОплата: 50% аванс\nСроки: 01.12 → 15.12\nИзменения: продление срока',[P+'VERSION_KEY']:'abc123def456xyz',[P+'CLIENT_PROOF']:'Клиент согласовал',[P+'CLIENT_APPROVED_KEY']:'abc123def456xyz'};
test('five roles have different actions and keep the full details link',()=>{
 const roles=new Set();for(const stageId of [321,323,319,331,337]){const result=buildRoleSummary(item,{stageId});roles.add(result.role);assert.match(result.text,/https:\/\/myosminozhka.bitrix24.ru\/rpa\/item\/57\/19\//);}
 assert.equal(roles.size,5);assert.equal(summaryRole(323),'head');assert.equal(summaryRole(321),'manager');
 assert.match(buildRoleSummary(item,{stageId:337}).text,/Подпишите.*в ЭДО/);
});
test('financial facts are literal source text, without invented totals or terms',()=>{
 assert.equal(literalFacts(item[P+'REQUEST_TEXT']).amount,'100 000 руб.');
 assert.match(buildRoleSummary(item).text,/Из заявки — сумма: 100 000 руб./);
 const missing=literalFacts('Сделайте договор на 100 часов');assert.match(missing.amount,/не указано/);
});
test('a client reply without matching version key is not presented as approved',()=>{
 const text=buildRoleSummary({...item,[P+'CLIENT_APPROVED_KEY']:'old'}).text;
 assert.match(text,/Привязка согласия клиента: нет подтверждения этой версии/);
});
test('Anna sees all three recipient sources and duplicate addresses are marked',()=>{
 const result=recipientSummary({...item,[P+'MANAGER_EMAIL']:'Manager@example.test',[P+'CLIENT_EMAIL']:'manager@example.test'});
 assert.match(result[1],/совпадает/);assert.match(result[2],/не указано/);
});
test('technical audit comments are omitted and human comments remain attributed to source text',()=>{
 const text=buildRoleSummary(item,{timeline:[{action:'comment',userId:1,description:'System [legal-handoff:1]'},{action:'comment',userId:579,createdTime:'2026-11-26',description:'Уточните период'}]}).text;
 assert.doesNotMatch(text,/System/);assert.match(text,/Комментарий 2026-11-26: Уточните период/);
});
