export function el(tag,text,cls){
  const element=document.createElement(tag);
  if(text!=null)element.textContent=text;
  if(cls)element.className=cls;
  return element;
}
export function link(text,href,cls){const a=el('a',text,cls);a.href=href;return a;}
export function panel(host,title,description){
  const box=el('section',null,'panel');
  if(title)box.append(el('h2',title));
  if(description)box.append(el('p',description));
  host.append(box); return box;
}
export function status(host){const out=el('div',null,'msg');out.setAttribute('role','status');host.append(out);return out;}
export function message(out,text,error=false){out.textContent=text;out.className=error?'msg error':'msg';}
export function button(host,text,callback,cls=''){
  const btn=el('button',text,'btn '+cls);btn.type='button';host.append(btn);
  const out=status(host);
  btn.onclick=async()=>{if(btn.disabled)return;btn.disabled=true;message(out,'');
    try{await callback(out);}catch(e){message(out,e.message,true);}finally{btn.disabled=false;}};
  return btn;
}
export function field(form,label,name,type='text',options={}){
  const wrap=el('label',label), input=el(type==='select'?'select':'input');
  if(type!=='select')input.type=type;
  input.name=name;
  for(const [key,value] of Object.entries(options)) if(key==='choices'){
    for(const [id,text] of value)input.add(new Option(text,id));
  }else input[key]=value;
  wrap.append(input);form.append(wrap);return input;
}
export function submit(form,label,callback){
  const btn=el('button',label,'btn primary');btn.type='submit';form.append(btn);const out=status(form);
  form.onsubmit=async e=>{e.preventDefault();if(btn.disabled)return;btn.disabled=true;message(out,'');
    try{await callback(Object.fromEntries(new FormData(form)),out);}catch(err){message(out,err.message,true);}finally{btn.disabled=false;}};
}
export const eq=id=>'eq.'+id;
export const date=value=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'';
export const km=value=>Number.isFinite(value)?(value/1000).toFixed(2)+' km':'—';
export function duration(ms){if(ms==null||!Number.isFinite(+ms))return '—';const s=Math.round(ms);return Math.floor(s/60000)+':'+String(Math.floor(s/1000)%60).padStart(2,'0')+'.'+String(s%1000).padStart(3,'0');}
export function sessionEquipment(row,trackName=row.track?.name){
  return [row.eucName?.trim()||'Unknown vehicle',trackName||(row.track_local_id?'Track unavailable':'No track')].join(' · ');
}
export function sessionBest(row){
  const best=el('span',null,'session-best');
  best.append(el('small','Best lap'),el('strong',row.best_lap_ms>0?duration(row.best_lap_ms):'—'));
  return best;
}
export function record(host,title,detail,href,stat=''){
  const a=link('',href,'record'),body=el('span');body.append(el('b',title),el('small',detail));a.append(body,stat instanceof Node ? stat : el('strong',stat));host.append(a);
}
export function formAt(host){const f=el('form');host.append(f);return f;}
export function metrics(host,items){
  const group=el('div',null,'metrics');for(const [label,value] of items){const box=el('div',label,'metric');box.append(el('b',value));group.append(box);}host.append(group);
}
