const status=document.querySelector('#status');
const failure=(result)=>{const e=result.error();const code=typeof e==='string'?e:e?.error||'API_ERROR';return /^[A-Z0-9_ .-]{1,100}$/i.test(code)?code:'API_ERROR';};
const call=(method,params)=>new Promise((resolve,reject)=>BX24.callMethod(method,params,r=>r.error()?reject(Error(failure(r))):resolve(r.data())));
BX24.init(async()=>{
 if(BX24.getDomain()!=='myosminozhka.bitrix24.ru'||!BX24.isAdmin()){status.textContent='Подключение доступно администратору рабочего Bitrix24.';return;}
 const handler='https://osmi-bitrix24-sales-handlers.onrender.com/legal/billing';
 try{
  const handlers=await call('placement.get',{});
  if(!Array.isArray(handlers))throw Error('INVALID_PLACEMENT_RESPONSE');
  if(!handlers.some(x=>(x.placement||x.PLACEMENT)==='REST_APP_URI'&&(x.handler||x.HANDLER)===handler))await call('placement.bind',{PLACEMENT:'REST_APP_URI',HANDLER:handler,TITLE:'Запросить счёт / акт'});
  status.textContent='Действие подключено.';BX24.installFinish();
 }catch(e){status.textContent='Регистрация действия не подтверждена: '+e.message+'.';}
});
