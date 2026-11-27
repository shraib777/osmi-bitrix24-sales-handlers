import JSZip from 'jszip';
import xml from 'xml-js';
import {diffArrays} from 'diff';
import {createHash} from 'node:crypto';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const AUTHOR='Автоматическое сравнение';
const LIMIT=8*1024*1024;
const REV=new Set(['w:ins','w:del','w:moveFrom','w:moveTo','w:rPrChange','w:pPrChange','w:tblPrChange','w:tcPrChange','w:trPrChange','w:sectPrChange','w:tblGridChange','w:cellIns','w:cellDel','w:cellMerge']);
const clone=n=>structuredClone(n);
const hash=b=>createHash('sha256').update(b).digest('hex');
const el=(name,elements=[],attributes)=>({type:'element',name,...(attributes?{attributes}:{}),elements});
const raw=s=>({type:'text',text:s});
const canonical=n=>JSON.stringify(n);
const walk=(n,f,parent=null)=>{f(n,parent);for(const c of n.elements||[])walk(c,f,n);};
const descendants=(n,name)=>{const a=[];walk(n,x=>{if(x.name===name)a.push(x);});return a;};
const revSignature=n=>hash(canonical(n));
export class ReviewError extends Error{constructor(code){super(code);this.code=code;}}
function parse(s){if(s.length>LIMIT||/<!DOCTYPE|<!ENTITY/i.test(s))throw new ReviewError('UNSAFE_DOCX_XML');let d;try{d=xml.xml2js(s,{compact:false});}catch{throw new ReviewError('INVALID_DOCX_XML');}let count=0;walk(d,()=>{if(++count>100000)throw new ReviewError('DOCX_COMPLEXITY_LIMIT');});return d;}
function project(n,{before=false,common=new Set(),locked=false,units=null,root=true}={}){
 if(n.type==='text')return '';
 if(n.name==='w:p'&&!root)return '';
 if(['w:pPr','w:rPr','w:instrText'].includes(n.name))return '';
 const revision=REV.has(n.name), shared=revision&&common.has(revSignature(n));
 if(['w:ins','w:moveTo'].includes(n.name)&&before&&!shared)return '';
 if(['w:del','w:moveFrom'].includes(n.name)&&(!before||shared))return '';
 let value='';
 if(n.name==='w:t'||n.name==='w:delText')value=(n.elements||[]).map(e=>e.text||'').join('');
 else if(n.name==='w:tab')value='\t';else if(['w:br','w:cr'].includes(n.name))value='\n';
 else{
  for(const c of n.elements||[])value+=project(c,{before,common,locked:locked||revision,units,root:false});
  return value;
 }
 if(units){const start=units.reduce((a,x)=>a+x.text.length,0);units.push({node:n,start,end:start+value.length,text:value,locked:locked||revision});}
 return value;
}
const paragraphs=doc=>descendants(doc,'w:p');
export const acceptedParagraphs=doc=>paragraphs(doc).map(p=>project(p));
const tokens=s=>s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)||[];
function difference(a,b){const r=diffArrays(a,b,{timeout:1500,maxEditLength:8000});if(!r)throw new ReviewError('DOCX_DIFF_COMPLEXITY_LIMIT');return r;}
async function readEntry(f){return new Promise((resolve,reject)=>{let size=0,chunks=[],failed=false;const stream=f.nodeStream('nodebuffer');stream.on('data',b=>{if(failed)return;size+=b.length;if(size>LIMIT){failed=true;stream.pause();stream.destroy?.();reject(new ReviewError('DOCX_PART_TOO_LARGE'));return;}chunks.push(b);});stream.on('error',reject);stream.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});});}

function validateZipDirectory(bytes){let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}if(end<0)throw new ReviewError('INVALID_DOCX_ZIP');const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);if(count>2500||count===65535||offset+size>end)throw new ReviewError('UNSUPPORTED_DOCX_PACKAGE');let at=offset,total=0;const names=new Set();for(let k=0;k<count;k++){if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw new ReviewError('INVALID_DOCX_ZIP');const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),uncompressed=bytes.readUInt32LE(at+24),len=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32);const name=bytes.subarray(at+46,at+46+len).toString('utf8');if(flags&1||![0,8].includes(method)||uncompressed>32*1024*1024||(total+=uncompressed)>64*1024*1024||name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||names.has(name))throw new ReviewError('UNSUPPORTED_DOCX_PACKAGE');names.add(name);at+=46+len+extra+comment;}if(at!==offset+size)throw new ReviewError('INVALID_DOCX_ZIP');}
async function load(bytes){if(bytes.length>20*1024*1024)throw new ReviewError('DOCX_TOO_LARGE');validateZipDirectory(bytes);let zip;try{zip=await JSZip.loadAsync(bytes);}catch{throw new ReviewError('INVALID_DOCX_ZIP');}const names=Object.keys(zip.files);if(names.length>2500||names.some(n=>n.startsWith('/')||n.split('/').includes('..')||/vbaProject|_xmlsignatures/i.test(n)))throw new ReviewError('UNSUPPORTED_DOCX_PACKAGE');if(!zip.file('word/document.xml'))throw new ReviewError('NOT_A_DOCX_DOCUMENT');return zip;}
function tableShape(doc){return descendants(doc,'w:tbl').map(t=>(t.elements||[]).filter(c=>c.name==='w:tr').map(r=>(r.elements||[]).filter(c=>c.name==='w:tc').length));}
function revisions(doc){const out=[];walk(doc,n=>{if(REV.has(n.name))out.push(revSignature(n));});return out;}
function parentMap(doc){const m=new Map();walk(doc,(n,p)=>{if(p)m.set(n,p);});return m;}
function fragmentRun(run,child){return el('w:r',[...(run.elements||[]).filter(n=>n.name==='w:rPr').map(clone),child],run.attributes?clone(run.attributes):undefined);}
function txtRun(s,del=false,style){return el('w:r',[...(style?[clone(style)]:[]),el(del?'w:delText':'w:t',[raw(s)],{'xml:space':'preserve'})]);}
function markParagraph(p,oldText,common,nextRevision,changes){
 const units=[],newText=project(p,{before:true,common,units}),parts=difference(tokens(oldText),tokens(newText));
 let pos=0;const insertions=[],deletions=[];
 for(const part of parts){const value=part.value.join('');if(part.added){insertions.push({start:pos,end:pos+value.length});pos+=value.length;}else if(part.removed)deletions.push({pos,text:value});else pos+=value.length;}
 if(!insertions.length&&!deletions.length)return;
 const parents=parentMap(p), edits=new Map(), pendingAfter=[];
 for(const range of insertions)for(const u of units){const a=Math.max(u.start,range.start),b=Math.min(u.end,range.end);if(a<b){if(u.locked)throw new ReviewError('UNMARKED_CHANGE_INTERSECTS_CLIENT_REVISION');if(!edits.has(u.node))edits.set(u.node,{ins:[],del:[]});edits.get(u.node).ins.push({start:a-u.start,end:b-u.start});}}
 for(const d of deletions){const u=units.find(u=>d.pos>=u.start&&d.pos<u.end);if(!u){pendingAfter.push(d);continue;}if(u.locked){if(d.pos!==u.start)throw new ReviewError('UNMARKED_CHANGE_INTERSECTS_CLIENT_REVISION');let n=u.node;while(parents.get(n)&&!REV.has(n.name))n=parents.get(n);const par=parents.get(n);if(!par)throw new ReviewError('UNSUPPORTED_REVISION_BOUNDARY');const idx=par.elements.indexOf(n);par.elements.splice(idx,0,nextRevision('w:del',[txtRun(d.text,true)]));continue;}if(!edits.has(u.node))edits.set(u.node,{ins:[],del:[]});edits.get(u.node).del.push({pos:d.pos-u.start,text:d.text});}
 const runs=new Set([...edits.keys()].map(n=>parents.get(n)));for(const run of runs){if(run?.name!=='w:r')throw new ReviewError('UNSUPPORTED_TEXT_CONTAINER');const par=parents.get(run),replacement=[];for(const child of run.elements||[]){if(child.name==='w:rPr')continue;const e=edits.get(child);if(!e){replacement.push(fragmentRun(run,clone(child)));continue;}if(!['w:t','w:tab','w:br','w:cr'].includes(child.name))throw new ReviewError('UNSUPPORTED_TEXT_CONTAINER');const u=units.find(u=>u.node===child),value=u.text;const points=[...new Set([0,value.length,...e.ins.flatMap(v=>[v.start,v.end]),...e.del.map(v=>v.pos)])].sort((a,b)=>a-b);
  for(let k=0;k<points.length;k++){const at=points[k];for(const d of e.del.filter(d=>d.pos===at))replacement.push(nextRevision('w:del',[txtRun(d.text,true,(run.elements||[]).find(x=>x.name==='w:rPr'))]));if(k===points.length-1)break;const end=points[k+1],inside=e.ins.some(v=>at>=v.start&&end<=v.end);let c;if(child.name==='w:t')c=el('w:t',[raw(value.slice(at,end))],{...(child.attributes||{}),'xml:space':'preserve'});else{if(at!==0||end!==value.length)throw new ReviewError('UNSUPPORTED_TEXT_BOUNDARY');c=clone(child);}const piece=fragmentRun(run,c);replacement.push(inside?nextRevision('w:ins',[piece]):piece);}
 }
 const idx=par.elements.indexOf(run);if(idx<0)throw new ReviewError('UNSUPPORTED_TEXT_CONTAINER');par.elements.splice(idx,1,...replacement);}
 for(const d of pendingAfter)p.elements.push(nextRevision('w:del',[txtRun(d.text,true)]));
 changes.push({before:oldText,after:project(p),insertions:insertions.length,deletions:deletions.length});
}
function paragraphMark(p,kind,nextRevision){let props=(p.elements||[]).find(n=>n.name==='w:pPr');if(!props){props=el('w:pPr');p.elements.unshift(props);}let runProps=props.elements.find(n=>n.name==='w:rPr');if(!runProps){runProps=el('w:rPr');props.elements.push(runProps);}if(!runProps.elements.some(n=>['w:ins','w:del'].includes(n.name)))runProps.elements.push(nextRevision(kind,[]));}
function addParagraph(p,common,nextRevision,changes){const before=project(p,{before:true,common});markParagraph(p,'',common,nextRevision,changes);if(before)paragraphMark(p,'w:ins',nextRevision);}
function deletedParagraph(old,nextRevision){const p=el('w:p',[nextRevision('w:del',[txtRun(old,true)])]);paragraphMark(p,'w:del',nextRevision);return p;}
function mergePart(base,client,nextRevision,changes){
 if(paragraphs(client).some(p=>descendants((p.elements||[]).find(n=>n.name==='w:pPr')||{},'w:ins').length||descendants((p.elements||[]).find(n=>n.name==='w:pPr')||{},'w:del').length))throw new ReviewError('EXISTING_PARAGRAPH_MARK_REVISION_REQUIRES_MANUAL_REVIEW');
 if(canonical(tableShape(base))!==canonical(tableShape(client)))throw new ReviewError('TABLE_STRUCTURE_REQUIRES_MANUAL_REVIEW');
 if(descendants(base,'w:txbxContent').length||descendants(client,'w:txbxContent').length)throw new ReviewError('TEXTBOX_REQUIRES_MANUAL_REVIEW');
 const common=new Set(revisions(base).filter(x=>revisions(client).includes(x))),old=paragraphs(base),fresh=paragraphs(client),ops=difference(old.map(p=>project(p)),fresh.map(p=>project(p,{before:true,common}))),parents=parentMap(client);
 let ai=0,bi=0;for(let i=0;i<ops.length;i++){const op=ops[i];if(!op.removed&&!op.added){ai+=op.count;bi+=op.count;continue;}
  const removed=op.removed?op.value:[],added=op.added?op.value:((ops[i+1]?.added)?ops[++i].value:[]);
  if(removed.length===added.length){for(let k=0;k<added.length;k++)markParagraph(fresh[bi+k],removed[k],common,nextRevision,changes);ai+=removed.length;bi+=added.length;continue;}
  // Pure paragraph insertions/deletions preserve the client's nodes and metadata.
  if(removed.length&&added.length)throw new ReviewError('PARAGRAPH_RESTRUCTURE_REQUIRES_MANUAL_REVIEW');
  if(added.length){for(let k=0;k<added.length;k++)addParagraph(fresh[bi+k],common,nextRevision,changes);bi+=added.length;continue;}
  const anchor=fresh[bi]||fresh[fresh.length-1],par=parents.get(anchor);if(!par||par.name==='w:tc')throw new ReviewError('PARAGRAPH_DELETE_REQUIRES_MANUAL_REVIEW');let index=par.elements.indexOf(anchor)+(bi>=fresh.length?1:0);for(const text of removed){par.elements.splice(index++,0,deletedParagraph(text,nextRevision));changes.push({before:text,after:'',insertions:0,deletions:1});}ai+=removed.length;
 }
}
function visibleTextIgnoringDeletedParagraphs(doc){return paragraphs(doc).filter(p=>!descendants((p.elements||[]).find(n=>n.name==='w:pPr')||{},'w:del').length).map(p=>project(p));}
export async function annotateClientDocx(baseBytes,clientBytes,{now=new Date().toISOString()}={}){
 const [baseZip,clientZip]=await Promise.all([load(baseBytes),load(clientBytes)]);const parts=Object.keys(clientZip.files).filter(n=>/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(n));const baseParts=Object.keys(baseZip.files).filter(n=>/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(n));if(canonical([...parts].sort())!==canonical([...baseParts].sort()))throw new ReviewError('DOCX_PART_STRUCTURE_REQUIRES_MANUAL_REVIEW');
 const docs=new Map(),allOldRevisions=[];let maxId=0;for(const name of parts){const a=parse((await readEntry(baseZip.file(name))).toString()),b=parse((await readEntry(clientZip.file(name))).toString());if(name==='word/document.xml'&&(!descendants(b,'w:document').length||descendants(b,'w:document')[0].attributes?.['xmlns:w']!==W))throw new ReviewError('UNSUPPORTED_WORD_NAMESPACE');walk(b,n=>{const id=Number(n.attributes?.['w:id']);if(Number.isFinite(id))maxId=Math.max(maxId,id);});docs.set(name,{a,b,accepted:visibleTextIgnoringDeletedParagraphs(b),revisions:revisions(b)});allOldRevisions.push(...revisions(b));}
 const changes=[];const nextRevision=(kind,children)=>el(kind,children,{'w:id':String(++maxId),'w:author':AUTHOR,'w:date':now});
 for(const[name,d]of docs){const start=changes.length;mergePart(d.a,d.b,nextRevision,changes);for(const c of changes.slice(start))c.part=name;if(canonical(visibleTextIgnoringDeletedParagraphs(d.b))!==canonical(d.accepted))throw new ReviewError('CLIENT_VISIBLE_TEXT_CHANGED');const after=new Map();for(const signature of revisions(d.b))after.set(signature,(after.get(signature)||0)+1);for(const signature of d.revisions){if(!after.get(signature))throw new ReviewError('CLIENT_REVISIONS_CHANGED');after.set(signature,after.get(signature)-1);}if([...new Set(d.revisions)].some(x=>after.get(x)!==0))throw new ReviewError('CLIENT_REVISIONS_DUPLICATED');if(changes.length>start)clientZip.file(name,xml.js2xml(d.b,{compact:false}),{date:clientZip.file(name).date});}
 let settings=clientZip.file('word/settings.xml');if(!settings)throw new ReviewError('DOCX_SETTINGS_MISSING');const s=parse((await readEntry(settings)).toString());const root=s.elements.find(n=>n.name==='w:settings');if(!root)throw new ReviewError('UNSUPPORTED_WORD_NAMESPACE');root.elements??=[];const track=descendants(s,'w:trackRevisions')[0];if(track){track.attributes={...(track.attributes||{}),'w:val':'true'};}else root.elements.push(el('w:trackRevisions',[],{'w:val':'true'}));clientZip.file('word/settings.xml',xml.js2xml(s,{compact:false}),{date:settings.date});
 const bytes=await clientZip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});return{bytes,changes,report:{schema:1,baselineSha256:hash(baseBytes),clientSha256:hash(clientBytes),outputSha256:hash(bytes),author:AUTHOR,existingRevisionsRetained:allOldRevisions.length,newChangeGroups:changes.length,coverage:'text changes in paragraphs, matching table structure and matching document parts; formatting-only changes require lawyer review'}};
}
