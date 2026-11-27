import fs from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
// Mount on the existing service only after the local Bitrix application has
// been approved. No webhook, OAuth token, refresh token or request body is logged
// or persisted. The SDK calls REST in the employee's own authenticated frame.
export function mountLinkedBilling(app,{enabled=false}={}){
 if(!enabled)return;
 const headers=res=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');res.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://api.bitrix24.com; style-src 'self'; frame-ancestors https://myosminozhka.bitrix24.ru; connect-src https://myosminozhka.bitrix24.ru https://api.bitrix24.com");};
 const handler=async(req,res)=>{let options={};try{options=JSON.parse(req.body?.PLACEMENT_OPTIONS||'{}');}catch{}const id=/^[1-9]\d*$/.test(String(options.sourceId||''))?String(options.sourceId):'';headers(res);res.type('html').send((await fs.readFile(path.join(root,'index.html'),'utf8')).replace('__SOURCE_ID__',id));};
 const install=async(req,res)=>{headers(res);res.type('html').send(await fs.readFile(path.join(root,'install.html'),'utf8'));};
 app.get('/legal/billing/install',install);app.post('/legal/billing/install',install);
 app.get('/legal/billing',handler);app.post('/legal/billing',handler);
 for(const f of['core.mjs','app.mjs','app.css','install.mjs'])app.get('/legal/billing/'+f,async(req,res)=>{headers(res);res.type(f.endsWith('.css')?'css':'js').send(await fs.readFile(path.join(root,f),'utf8'));});
}
