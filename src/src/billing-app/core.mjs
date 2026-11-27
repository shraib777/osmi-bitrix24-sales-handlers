export const P='UF_RPA_57_';
export const TYPE_ID=57;
export const STAGES=[325,327,337,339,315];
const CONTRACTS=[2403,2405,2407,2409,2411,2415];
const BILLING={invoice:2417,act:2419,both:2421};
const LABELS={invoice:'Счёт',act:'Акт',both:'Счёт + акт'};
export function assertSource(item,user){
 if(!item||Number(item.typeId)!==57||!Number.isInteger(Number(item.id))||Number(item.id)<1)throw Error('Заявка договора не найдена.');
 if(!Number.isInteger(Number(user?.ID))||Number(user.ID)<1)throw Error('Не определён текущий сотрудник.');
 if(!CONTRACTS.includes(Number(item[P+'DOCUMENT_TYPE'])))throw Error('Выберите договор или допсоглашение.');
 const key=item[P+'VERSION_KEY'];
 if(!STAGES.includes(Number(item.stageId))||!key||item[P+'HEAD_APPROVED_KEY']!==key||item[P+'CLIENT_APPROVED_KEY']!==key)throw Error('Сначала согласуйте текущую версию договора с клиентом и руководителем.');
 if(!item[P+'COUNTERPARTY_NAME']||!item[P+'CLIENT_EMAIL'])throw Error('В договорной заявке отсутствуют контрагент или контакт клиента.');
}
const text=(v,label,max)=>{const s=String(v??'').trim();if(!s||s.length>max)throw Error('Укажите '+label+'.');return s;};
function date(v){const s=String(v||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw Error('Укажите желаемую дату результата.');return s;}
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')}}`:JSON.stringify(v??null);
export function checkpointText(item){
 const slots=['DOCUMENT_TYPE','OTHER_TITLE','COUNTERPARTY_NAME','CLIENT_EMAIL','REQUEST_TEXT','DUE_DATE','PROJECT_URL','CONTRACT_URL','SIGNING_CHANNEL'];
 const refs=v=>(Array.isArray(v)?v:[v]).filter(f=>f&&typeof f==='object'&&f.id);
 const source=refs(item[P+'LEGAL_PROJECT'])[0];if(!source)throw Error('Отсутствует согласованный исходный проект.');
 return stable({sources:[String(source.id)],context:{...Object.fromEntries(slots.map(k=>[k,item[P+k]??null])),SOURCE_FILES:refs(item[P+'SOURCE_FILES']).map(f=>String(f.id))}});
}
async function assertCurrentVersion(item){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(checkpointText(item)));const key=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');if(key!==item[P+'VERSION_KEY'])throw Error('Данные договора изменились после согласования. Требуется повторная проверка.');}
export const sourceKey=i=>JSON.stringify([i.id,i.stageId,...['VERSION_KEY','HEAD_APPROVED_KEY','CLIENT_APPROVED_KEY','COUNTERPARTY_NAME','CLIENT_EMAIL','CONTRACT_EMAIL','PROJECT_URL','SIGNING_CHANNEL'].map(k=>i[P+k]??'')]);
export function childFields(parent,user,form,requestKey){
 assertSource(parent,user);if(!BILLING[form.kind])throw Error('Выберите счёт, акт или оба документа.');
 if(!/^[a-f0-9-]{36}$/.test(requestKey))throw Error('Не определён идентификатор запроса.');
 const amount=text(form.amount,'сумму и валюту',120),period=text(form.period,'период или основание',200),task=text(form.task,'задачу',3000);
 return{[P+'NAME']:`${LABELS[form.kind]} — ${parent[P+'COUNTERPARTY_NAME']}`.slice(0,255),[P+'DOCUMENT_TYPE']:String(BILLING[form.kind]),[P+'COUNTERPARTY_NAME']:parent[P+'COUNTERPARTY_NAME'],[P+'CLIENT_EMAIL']:parent[P+'CLIENT_EMAIL'],[P+'CONTRACT_EMAIL']:parent[P+'CONTRACT_EMAIL']||'',[P+'PROJECT_URL']:parent[P+'PROJECT_URL']||'',[P+'CONTRACT_URL']:`https://myosminozhka.bitrix24.ru/rpa/item/57/${parent.id}/`,[P+'SIGNING_CHANNEL']:String(parent[P+'SIGNING_CHANNEL']||''),[P+'REQUEST_TEXT']:`Сумма: ${amount}\nПериод / основание: ${period}\nЗадача: ${task}`,[P+'DUE_DATE']:date(form.dueDate),[P+'PARENT_REQUEST_ID']:String(parent.id),[P+'PARENT_APPROVED_VERSION']:parent[P+'VERSION_KEY'],[P+'BILLING_REQUEST_KEY']:requestKey};
}
export class LinkedBilling{
 constructor(call){this.call=call;this.attempts=new Map();}
 async load(id){const [u,p]=await Promise.all([this.call('user.current',{}),this.call('rpa.item.get',{typeId:57,id:Number(id)})]);const parent=p.item;assertSource(parent,u);await assertCurrentVersion(parent);return{user:u,parent,key:sourceKey(parent)};}
 async find(requestKey,user){const data=await this.call('rpa.item.list',{typeId:57,filter:{[P+'BILLING_REQUEST_KEY']:requestKey,createdBy:Number(user.ID)}});const rows=data.items||[];if(rows.length>1)throw Error('Найден повтор запроса. Обратитесь к администратору.');const row=rows[0];if(row&&Number(row.createdBy)!==Number(user.ID))throw Error('Не совпал автор заявки.');return row;}
 create(loaded,form,key){if(!this.attempts.has(key))this.attempts.set(key,this.perform(loaded,form,key));return this.attempts.get(key);}
 async perform(loaded,form,key){
 const current=await this.load(loaded.parent.id);if(current.key!==loaded.key||Number(current.user.ID)!==Number(loaded.user.ID))throw Error('Договор или сотрудник изменились. Загрузите актуальные данные.');
 const fields=childFields(current.parent,current.user,form,key);const existing=await this.find(key,current.user);if(existing)return{item:existing,recovered:true};
 let item;try{const result=await this.call('rpa.item.add',{typeId:57,fields});item=result.item;}catch(error){const found=await this.find(key,current.user);if(found)return{item:found,recovered:true};const e=Error('Создание не подтверждено. Проверьте список заявок перед повторным запросом.');e.cause=error;throw e;}
 if(!item?.id||Number(item.createdBy)!==Number(current.user.ID))throw Error('Не удалось подтвердить автора созданной заявки. Обратитесь к администратору.');
 let linked=true;try{await this.call('rpa.comment.add',{typeId:57,itemId:Number(current.parent.id),fields:{description:`Создана связанная заявка «${LABELS[form.kind]}» №${item.id}.\nhttps://myosminozhka.bitrix24.ru/rpa/item/57/${item.id}/`}});}catch{linked=false;}
 return{item,linked};
 }
}
