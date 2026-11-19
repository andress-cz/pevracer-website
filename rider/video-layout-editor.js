import {choices,decodeLayout,metrics,styles,widget} from './video-layout.js';

const STORE = 'pev-rider-overlay-layouts-v1';
const anchors = {bl:[.18,.83],br:[.82,.83],tl:[.18,.17],tr:[.82,.17],center:[.5,.5]};
function element(tag,text) {
  const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;
}
function button(text,fn) {
  const node=element('button',text);node.type='button';node.onclick=fn;return node;
}
function field(text,input) {
  const label=element('label',text);label.className='tel-field';label.append(input);return label;
}
function select(choices,value,change) {
  const input=element('select');
  for(const [key,label] of choices)input.add(new Option(label,key));
  input.value=value;input.onchange=()=>change(input.value);
  return input;
}
function numeric(label,value,min,max,step,change) {
  const input=element('input');
  Object.assign(input,{type:'number',min,max,step,value});
  input.oninput=()=>{if(input.value!=='' && input.validity.valid)change(input.valueAsNumber);};
  return field(label,input);
}
function savedLayouts() {
  const parsed=JSON.parse(localStorage.getItem(STORE) || '[]');
  if(!Array.isArray(parsed))throw Error('The browser layout library could not be opened.');
  return parsed;
}
function persist(items){localStorage.setItem(STORE,JSON.stringify(items));}
function saveJson(layout,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(layout,null,2)],{type:'application/json'}));
  const a=element('a');a.href=url;a.download=(name.trim().replace(/[^\w-]+/g,'-').slice(0,64)||'pev-overlay')+'.json';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export function mountLayoutEditor(host, {initial,onChange}) {
  let layout={version:1,widgets:[widget()]},selected=0,preset='',message='';
  if(initial)try{layout=decodeLayout(initial);}catch(error){message=error.message;}
  const root=element('div');root.className='pev-layout';
  const editor=element('div'), library=element('details'), status=element('p');
  library.append(element('summary','Saved layouts and Android JSON'));
  const libraryBody=element('div');library.append(libraryBody);status.setAttribute('role','status');status.textContent=message;
  root.append(editor,library,status);host.append(root);
  function changed(){onChange(layout);}
  function setLayout(doc){layout=decodeLayout(doc);selected=0;draw();changed();}
  function fieldGroup(){const g=element('div');g.className='pev-layout-fields';return g;}
  function tools(){const g=element('div');g.className='pev-layout-tools';return g;}
  function draw(){
    editor.replaceChildren();
    const bar=tools(), add=button('Add gauge',()=>{
      if(layout.widgets.length>=100){status.textContent='The web editor supports up to 100 gauges.';return;}
      const order=['SPEED','VOLTAGE','CURRENT','PWM','MAP_INSET','ALTITUDE'];
      selected=layout.widgets.length;
      layout.widgets.push(widget(order[selected%order.length],selected));draw();changed();
    });
    if(layout.widgets.length){
      const picker=select(layout.widgets.map((w,i)=>[String(i),(i+1)+'. '+metrics[w.metric][0]]),String(selected),v=>{selected=Number(v);draw();});
      bar.append(field('Selected gauge',picker));
    }
    bar.append(add);editor.append(bar);
    const w=layout.widgets[selected];
    if(!w){editor.append(element('p','Add a gauge to include telemetry in the video.'));return;}
    bar.append(button('Remove gauge',()=>{
      layout.widgets.splice(selected,1);selected=Math.max(0,Math.min(selected,layout.widgets.length-1));draw();changed();
    }));
    const group=fieldGroup();
    const metric=select(Object.entries(metrics).map(([k,v])=>[k,v[0]]),w.metric,name=>{
      w.metric=name;const allowed=choices(name);if(!allowed.includes(w.style))w.style=allowed[0];draw();changed();
    });
    const style=select(choices(w.metric).map(k=>[k,styles[k]]),w.style,v=>{w.style=v;draw();changed();});
    const anchor=Object.keys(anchors).find(k=>anchors[k][0]===w.xNorm && anchors[k][1]===w.yNorm)??'custom';
    const placement=select([['custom','Custom'],['bl','Bottom left'],['br','Bottom right'],['tl','Top left'],['tr','Top right'],['center','Center']],anchor,key=>{
      if(anchors[key]){[w.xNorm,w.yNorm]=anchors[key];draw();changed();}
    });
    group.append(field('Gauge',metric),field('Style',style),field('Gauge position',placement));
    for(const [key,label] of [['xNorm','Horizontal center (%)'],['yNorm','Vertical center (%)']]) {
      group.append(numeric(label,Number((w[key]*100).toFixed(3)),0,100,'any',v=>{w[key]=v/100;placement.value='custom';changed();}));
    }
    group.append(numeric('Scale',w.scale,.1,10,'any',v=>{w.scale=v;changed();}),
      numeric('Opacity (%)',Math.round(w.opacity*100),0,100,1,v=>{w.opacity=v/100;changed();}));
    const color=element('input');color.type='color';
    color.value=w.colorArgb==null ? metrics[w.metric][4] : '#'+(w.colorArgb>>>0).toString(16).padStart(8,'0').slice(2);
    color.oninput=()=>{w.colorArgb=(0xff000000|parseInt(color.value.slice(1),16));changed();};
    group.append(field('Accent colour',color));
    if(w.style.includes('SEGMENTS')) group.append(numeric('Bar segments',w.barSegmentCount,3,30,1,v=>{w.barSegmentCount=v;changed();}));
    if(w.style==='SPARKLINE') group.append(numeric('History (s)',w.sparkWindowSec,.1,60,.1,v=>{w.sparkWindowSec=v;changed();}));
    editor.append(group);
    if(w.metric==='LEAN'||w.metric==='PITCH')editor.append(element('p','Motion-sensor angles use the recorded axes. Phone mount calibration is local to Android.'));
    if(w.metric==='SECTOR_DELTA')editor.append(element('p','Delta uses the fastest completed lap in the same direction in this session.'));
    if(w.metric==='MAP_INSET')editor.append(element('p','The inset shows your recorded GPS trace on a plain background.'));
  }
  function libraryView(){
    let items=[];try{items=savedLayouts();}catch{status.textContent='Browser storage is unavailable. You can still export layouts as JSON.';}
    libraryBody.replaceChildren();
    const group=fieldGroup(), actions=tools();
    const name=element('input');name.type='text';name.maxLength=80;name.value=items.find(r=>r.id===preset)?.name || '';
    const saved=select([['','Choose a layout'],...items.map(r=>[r.id,r.name])],preset,key=>{preset=key;name.value=items.find(r=>r.id===key)?.name || '';});
    group.append(field('Saved layout',saved),field('Layout name',name));
    function run(action){try{action();}catch(e){status.textContent=e.message || 'Could not update the layout.';}}
    actions.append(button('Load layout',()=>run(()=>{
      const item=savedLayouts().find(r=>r.id===saved.value);if(!item)throw Error('Choose a saved layout.');
      setLayout(item.layout);status.textContent='Loaded '+item.name+'.';
    })),button('Save layout',()=>run(()=>{
      const label=name.value.trim();if(!label)throw Error('Enter a layout name.');
      const entries=savedLayouts(), existing=entries.find(r=>r.name===label);
      if(existing && !confirm('Replace the saved layout “'+label+'”?')) return;
      const item={name:label,id:existing?.id??crypto.randomUUID(),layout};
      if(existing)entries[entries.indexOf(existing)]=item;else entries.push(item);
      persist(entries);preset=item.id;libraryView();status.textContent='Layout saved in this browser.';
    })),button('Delete saved layout',()=>run(()=>{
      if(!saved.value)throw Error('Choose a saved layout.');
      if(!confirm('Delete this saved layout from this browser?'))return;
      persist(savedLayouts().filter(r=>r.id!==saved.value));preset='';libraryView();status.textContent='Saved layout deleted.';
    })),button('Export layout JSON',()=>saveJson(layout,name.value)));
    const input=element('input');input.type='file';input.accept='.json,application/json';
    input.onchange=async()=>{
      try{const f=input.files[0];if(!f)return;if(f.size>1024*1024)throw Error('Choose a layout file smaller than 1 MB.');
        setLayout((await f.text()).replace(/^\uFEFF/,''));preset='';libraryView();status.textContent='Android layout imported.';
      }catch(error){status.textContent=error instanceof SyntaxError?'The selected file is not valid JSON.':error.message;}
      input.value='';
    };
    libraryBody.append(group,actions,field('Import Android layout JSON',input));
  }
  draw();libraryView();changed();
  return ()=>layout;
}
