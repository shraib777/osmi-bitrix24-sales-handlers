const P = 'UF_RPA_57_';
const TYPES = {2401:'Исходящий NDA',2403:'ДС на сроки',2405:'ДС на работы',2407:'Договор на работы',2409:'Договор на поддержку',2411:'Договор на лицензию и токены',2413:'Гарантийное письмо',2415:'Иное',2417:'Счёт',2419:'Акт',2421:'Счёт + акт'};
const CHANNELS = {2423:'ЭДО + email',2425:'Email',2427:'Бумага + email'};
const STAGES = {
  309:['manager','Менеджер: уточнение заявки','Ответьте на вопросы в ленте и дополните заявку.'],
  311:['system','Подготовка проекта','Подключение AI ожидает регламентов юриста.'],
  313:['lawyer','Юрист: подготовка «Иное»','Подготовьте документ; правовые формулировки исправляет юрист. Недостающие факты запросите у менеджера в ленте.'],
  319:['lawyer','Юрист: проверка проекта','Проверьте правовые условия и исправьте проект AI. Недостающие факты запросите у менеджера в ленте.'],
  321:['manager','Менеджер: согласие клиента','Получите ответ клиента на указанную версию. Зафиксируйте согласие или правки в БП.'],
  323:['head','Руководитель менеджера: согласование договора','Согласуйте условия либо верните конкретные замечания.'],
  325:['anna','Анна: подготовка договора','Подготовьте согласованный комплект и выполните предусмотренную этапом отправку. Email пока отправляется вручную.'],
  327:['manager','Менеджер: проверка договора','Проверьте указанную версию подготовленного комплекта либо верните Анне замечания.'],
  329:['head','Руководитель менеджера: согласование счёта / акта','Подтвердите заявку менеджера на подготовку счёта / акта либо верните замечания.'],
  331:['anna','Анна: подготовка счёта / акта','Подготовьте требуемые документы и передайте комплект менеджеру на проверку.'],
  333:['manager','Менеджер: проверка счёта / акта','Проверьте указанную версию счёта / акта либо верните Анне замечания.'],
  335:['anna','Анна: отправка счёта / акта','Отправьте проверенный комплект вручную по email всем адресатам; при выборе ЭДО также загрузите его в ЭДО.'],
  337:['gd','ГД: подпись только в ЭДО','Подпишите проверенный комплект в ЭДО либо верните замечания по текущему маршруту.'],
  339:['anna','Анна: финальный комплект','Соберите необходимые подписи, загрузите финальные файлы и зафиксируйте статус в ленте.'],
  315:['system','Завершено','Финальный результат и история доступны в полной карточке.'],
  317:['system','Отменено','Обработка заявки отменена. История и документы сохранены.']
};
const clean = (v, n = 500) => String(v ?? '').replace(/<[^>]*>/g,' ').replace(/\[(?:\/?(?:b|i|u|quote|code|url)[^\]]*)\]/gi,'').replace(/[\r\t]/g,' ').trim().slice(0,n);
const val = (item,k) => clean(item[P+k]) || 'не указано';
const files = value => (Array.isArray(value) ? value : [value]).filter(f=>f && typeof f==='object' && f.id);
export const summaryRole = stage => STAGES[stage]?.[0] || 'system';
export function literalFacts(text) {
  const lines = String(text || '').split(/\r?\n/);
  const get = re => { const line=lines.find(l=>re.test(l.trim())); return line ? clean(line.replace(/^\s*[^:：]+[:：]\s*/,''),250) : 'не указано явно в заявке'; };
  return { amount:get(/^(?:сумма|цена|стоимость)\s*[:：]/iu), payment:get(/^(?:оплата|условия оплаты)\s*[:：]/iu), period:get(/^(?:период|сроки|срок работ)\s*[:：]/iu), changes:get(/^(?:изменения|что меняется)\s*[:：]/iu) };
}
export function recipientSummary(item) {
  const rows=[['Менеджер',item[P+'MANAGER_EMAIL']],['Представитель клиента',item[P+'CLIENT_EMAIL']],['Адрес из договора',item[P+'CONTRACT_EMAIL']]];
  const seen = new Set();
  return rows.map(([label,email])=>{const s=clean(email,200);if(!s)return `${label}: не указано`;const duplicate=seen.has(s.toLowerCase());seen.add(s.toLowerCase());return `${label}: ${s}${duplicate?' (совпадает с другим адресатом)':''}`;});
}
export function buildRoleSummary(item, {stageId=Number(item.stageId), timeline=[]}={}) {
  const [role,title,action]=STAGES[stageId] || ['system','Передача документа','Версия сохраняется перед передачей следующему участнику.'];
  const facts=literalFacts(item[P+'REQUEST_TEXT']);
  const billing=[2417,2419,2421].includes(Number(item[P+'DOCUMENT_TYPE']));
  const project=[313,319,321,323,325].includes(stageId);
  const key=String(item[P+(project?'VERSION_KEY':'PACKAGE_VERSION_KEY')] || '');
  const list=project?files(item[P+'CLIENT_DOCUMENT']):[...files(item[P+'PACKAGE_DOCUMENTS']),...files(item[P+'SNAPSHOT_INVOICE']),...files(item[P+'SNAPSHOT_ACT'])];
  const approved=(field,expected) => expected && item[P+field]===expected ? 'подтверждено для этой версии' : 'нет подтверждения этой версии';
  const lines=[title,`Заявка №${item.id} · ${TYPES[item[P+'DOCUMENT_TYPE']]||'Тип не указан'} · ${val(item,'COUNTERPARTY_NAME')}`];
  if(Number(item[P+'DOCUMENT_TYPE'])===2415)lines.push(`Документ: ${val(item,'OTHER_TITLE')}`);
  lines.push(`Действие: ${action}`,`Желаемая дата результата: ${val(item,'DUE_DATE')}`);
  if(key)lines.push(`Версия: ${key.slice(0,12)}${list.length?` · файлов: ${list.length}`:''}`);
  else lines.push('Версия: сохранённая копия ещё не подготовлена');
  if(role==='head'||role==='anna'||role==='gd')lines.push(`Из заявки — сумма: ${facts.amount}; оплата: ${facts.payment}`,`Из заявки — сроки / период: ${facts.period}; изменения: ${facts.changes}`);
  if(role==='manager'||role==='lawyer'||role==='head')lines.push(`Задача менеджера: ${clean(item[P+'REQUEST_TEXT'],450)||'не указана'}`);
  if(!billing && [321,323,325,327,337,339].includes(stageId)) {
    lines.push(`Согласие клиента: ${clean(item[P+'CLIENT_PROOF'],230)||'не зафиксировано'}`);
    if(stageId!==321)lines.push(`Привязка согласия клиента: ${approved('CLIENT_APPROVED_KEY',String(item[P+'VERSION_KEY']||''))}`);
  }
  if([325,327,337,339].includes(stageId)&&!billing)lines.push(`Согласование руководителя: ${approved('HEAD_APPROVED_KEY',String(item[P+'VERSION_KEY']||''))}`);
  if([335,337,339].includes(stageId))lines.push(`Проверка комплекта менеджером: ${approved('PACKAGE_APPROVED_KEY',String(item[P+'PACKAGE_VERSION_KEY']||''))}`);
  if(role==='anna'||role==='gd')lines.push(`Обмен: ${CHANNELS[item[P+'SIGNING_CHANNEL']]||'не указан'}`);
  if(role==='anna')lines.push(...recipientSummary(item),`Статус: ${val(item,'PROCESS_STATUS')}`);
  if(role==='gd')lines.push('Документ в ЭДО и реквизиты отправки — в ленте заявки.');
  const comments=timeline.filter(r=>r.action==='comment' && !/\[legal-(?:error|recovered|cancel|summary|handoff)/.test(String(r.description)) && Number(r.userId)>0).slice(0,2);
  for(const r of comments)lines.push(`Комментарий ${clean(r.createdTime,25)}: ${clean(r.textDescription??r.description,220)}`);
  if(item[P+'TECH_ERROR'])lines.push(`Требует внимания: ${clean(item[P+'TECH_ERROR'],250)}`);
  lines.push(`Подробности, документы, архив и вся переписка: https://myosminozhka.bitrix24.ru/rpa/item/57/${item.id}/`);
  return {role,text:lines.join('\n')};
}
