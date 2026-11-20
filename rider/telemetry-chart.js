// SVG keeps the traces sharp at every display density. All channels share an x-axis;
// channels with the same physical unit also share a vertical scale.
const colors=['#c6f56b','#64d8ff','#ffb86b','#d7a9ff','#ff91af','#64e1bd','#ffee84'];
const ns='http://www.w3.org/2000/svg';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function element(tag,text,cls){
  const node=document.createElement(tag);
  if(text!=null)node.textContent=text;
  if(cls)node.className=cls;
  return node;
}
function svg(tag,attributes){
  const node=document.createElementNS(ns,tag);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
  return node;
}
function action(text,fn){
  const b=element('button',text);b.type='button';b.onclick=fn;return b;
}
function axisLabel(value,axis){
  if(axis==='distance')return value>=1000?(value/1000).toFixed(2)+' km':Math.round(value)+' m';
  const seconds=Math.floor(value/1000);
  return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+(value%1000?'.'+String(Math.floor(value%1000)).padStart(3,'0').slice(0,1):'');
}
function lowerBound(array,target,start,end){
  while(start<end){const mid=Math.floor((start+end)/2);if(array[mid]<target)start=mid+1;else end=mid;}
  return start;
}

// Keep the first, minimum, maximum and last sample in each screen column. This
// preserves a short spike that a fixed every-Nth-sample plot would drop.
function trace(series,values,start,end,scale,columns){
  const {axis,first,last}=series, base=axis[first], span=axis[last]-base;
  const left=Math.max(first,lowerBound(axis,base+span*start,first,last)-1);
  const right=Math.min(last,lowerBound(axis,base+span*end,first,last)+1);
  const x=i=>span?(axis[i]-base-span*start)/(span*(end-start))*1000:0;
  const y=v=>scale.min===scale.max?120:230-220*(v-scale.min)/(scale.max-scale.min);
  const commands=[];
  let pen=false, bucket=-Infinity, a=-1, min=-1, max=-1, b=-1;
  function flush(){
    if(a<0)return;
    let previous=-1;
    for(const i of [a,Math.min(min,max),Math.max(min,max),b]){
      if(i===previous)continue;
      commands.push((pen?'L':'M')+x(i).toFixed(3)+' '+y(values[i-first]).toFixed(3));
      previous=i;pen=true;
    }
    if(a===b&&!Number.isFinite(values[a+1-first])&&!Number.isFinite(values[a-1-first]))commands.push('l0.001 0');
    a=-1;
  }
  for(let i=left;i<=right;i++){
    const v=values[i-first];
    if(!Number.isFinite(v)){flush();pen=false;continue;}
    const column=Math.floor(x(i)*columns/1000);
    if(column!==bucket){flush();bucket=column;}
    if(a<0)a=min=max=i;
    if(v<values[min-first])min=i;
    if(v>values[max-first])max=i;
    b=i;
  }
  flush();
  return commands.join('');
}

export function createTelemetryChart({metrics,metricValue,onSeek}){
  const box=element('section',null,'ride-chart');
  const heading=element('h3','Telemetry chart');
  const picker=element('details',null,'chart-picker'), summary=element('summary','Choose metrics');
  const choices=element('fieldset');choices.append(element('legend','Displayed metrics'));
  const options=element('div',null,'chart-options');choices.append(options);picker.append(summary,choices);
  const selected=new Set(['speed']);
  const legend=element('ul',null,'chart-key');
  legend.setAttribute('aria-label','Selected metrics and vertical scales');
  const viewport=element('div',null,'chart-viewport');
  viewport.tabIndex=0;
  viewport.setAttribute('role','group');viewport.setAttribute('aria-label','Telemetry chart. Use plus and minus to zoom, left and right arrows to pan, or Home to reset.');
  const plot=svg('svg',{viewBox:'0 0 1000 240',preserveAspectRatio:'none',role:'img','aria-label':'Ride telemetry traces'});
  const grid=svg('g',{stroke:'#526357','vector-effect':'non-scaling-stroke'});
  for(const y of [10,65,120,175,230])grid.append(svg('line',{x1:0,x2:1000,y1:y,y2:y,'stroke-width':1,'vector-effect':'non-scaling-stroke'}));
  const lines=svg('g',{});plot.append(grid,lines);
  const cursor=element('span',null,'chart-playhead');cursor.setAttribute('aria-hidden','true');viewport.append(plot,cursor);
  const axisLabels=element('div',null,'chart-axis'), help=element('p',null,'chart-caption'), tools=element('div',null,'chart-tools');
  const selection=element('span');selection.setAttribute('role','status');
  const minus=action('Zoom out',()=>zoom(2)),plus=action('Zoom in',()=>zoom(.5)),reset=action('Reset zoom',()=>setWindow(0,1));
  const prev=action('Pan left',()=>pan(-.5)),next=action('Pan right',()=>pan(.5));
  tools.append(minus,plus,reset,prev,next,selection);
  box.append(heading,picker,legend,viewport,axisLabels,tools,help);
  let sources=[],axisName='time',start=0,end=1,index=0,frame=0,columns=640;
  let legendValues=new Map();
  for(const [key,label,unit] of metrics){
    const wrap=element('label'), input=element('input');input.type='checkbox';input.checked=selected.has(key);
    wrap.append(input,document.createTextNode(label+' ('+unit+')'));options.append(wrap);
    input.onchange=()=>{
      if(input.checked)selected.add(key);else selected.delete(key);
      for(const source of sources)if(!input.checked)source.cache.delete(key);
      draw();
    };
  }
  function channel(source,key){
    if(source.cache.has(key))return source.cache.get(key);
    const values=new Float64Array(source.last-source.first+1);
    let min=Infinity,max=-Infinity;
    for(let i=source.first;i<=source.last;i++){
      const v=metricValue(source.data,i,key);
      values[i-source.first]=Number.isFinite(v)?v:NaN;
      if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}
    }
    const result={values,min,max};source.cache.set(key,result);return result;
  }
  function position(){
    const s=sources[0];if(!s)return 0;
    const span=s.axis[s.last]-s.axis[s.first];return span?(s.axis[index]-s.axis[s.first])/span:0;
  }
  function mark(){
    const f=position();cursor.hidden=f<start||f>end||!selected.size;
    cursor.style.left=clamp((f-start)/(end-start)*100,0,100)+'%';
    const s=sources[0];
    if(s)for(const [key,[out,unit]] of legendValues){
      const value=metricValue(s.data,index,key);
      out.textContent=Number.isFinite(value)?value.toFixed(1)+' '+unit:'—';
    }
  }
  function draw(){
    if(!sources.length)return;
    const s=sources[0], span=s.axis[s.last]-s.axis[s.first];
    const channels=metrics.filter(([key])=>selected.has(key));
    const byUnit=new Map();
    for(const [key,,unit] of channels){
      const scale=byUnit.get(unit)??{min:Infinity,max:-Infinity};
      for(const source of sources){const c=channel(source,key);scale.min=Math.min(scale.min,c.min);scale.max=Math.max(scale.max,c.max);}
      byUnit.set(unit,scale);
    }
    legend.replaceChildren();legendValues=new Map();lines.replaceChildren();
    for(const [n,[key,label,unit]] of channels.entries()){
      const scale=byUnit.get(unit),color=colors[n%colors.length];
      const item=element('li'),swatch=element('i'),out=element('b');
      swatch.style.background=color;swatch.setAttribute('aria-hidden','true');legendValues.set(key,[out,unit]);
      const present=sources.some(source=>Number.isFinite(channel(source,key).min));
      item.append(swatch,element('span',label),out,element('small',present?'Scale '+scale.min.toFixed(1)+'–'+scale.max.toFixed(1)+' '+unit:'No samples'));legend.append(item);
      if(!present)continue;
      for(const [j,source] of sources.entries()){
        const {values}=channel(source,key);
        const line=svg('path',{d:trace(source,values,start,end,scale,columns),fill:'none',stroke:color,'stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-linecap':'round','stroke-linejoin':'round'});
        if(j)line.setAttribute('stroke-dasharray','5 5');
        lines.append(line);
      }
    }
    axisLabels.replaceChildren(...[start,(start+end)/2,end].map(f=>element('span',axisLabel(span*f,axisName))));
    help.textContent=!selected.size?'Choose at least one metric to plot.':(sources.length===2?'Solid lines show '+sources[0].name+'. Dashed lines show '+sources[1].name+'. ':'')+
      (axisName==='distance'?'Distance through the lap.':'Elapsed time.')+(byUnit.size>1?' Each unit uses the vertical scale shown above.':'');
    selection.textContent=Math.round(1/(end-start)*10)/10+'×';
    minus.disabled=reset.disabled=end-start>=.999999;plus.disabled=end-start<=minSpan()*1.001;
    prev.disabled=start<=.00000001;next.disabled=end>=.99999999;
    viewport.classList.toggle('chart-zoomed',end-start<.999999);
    mark();
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(box.isConnected)draw();});}
  function minSpan(){return Math.min(1,Math.max(1/4096,2/Math.max(1,(sources[0]?.last??0)-(sources[0]?.first??0))));}
  function setWindow(left,width){
    width=clamp(width,minSpan(),1);start=clamp(left,0,1-width);end=start+width;schedule();
  }
  function zoom(factor,anchor){
    const width=end-start,f=position();
    const center=anchor??(f>=start&&f<=end?f:(start+end)/2);
    const target=clamp(width*factor,minSpan(),1);
    setWindow(center-(center-start)/width*target,target);
  }
  function pan(direction){setWindow(start+direction*(end-start),end-start);}
  function point(e){const rect=viewport.getBoundingClientRect();return clamp((e.clientX-rect.left)/rect.width,0,1);}
  viewport.onwheel=e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();zoom(Math.exp(clamp(e.deltaY,-180,180)*.008),start+point(e)*(end-start));};
  viewport.onkeydown=e=>{
    const keys={'+':()=>zoom(.5),'=':()=>zoom(.5),'-':()=>zoom(2),ArrowLeft:()=>pan(-.25),ArrowRight:()=>pan(.25),Home:()=>setWindow(0,1)};
    if(keys[e.key]){e.preventDefault();keys[e.key]();}
  };
  let drag=null;
  viewport.onpointerdown=e=>{
    if(!e.isPrimary||e.button!==0||!sources.length)return;
    drag={x:e.clientX,start,width:end-start,moved:false};viewport.setPointerCapture(e.pointerId);
  };
  viewport.onpointermove=e=>{
    if(!e.isPrimary||!drag)return;
    const delta=e.clientX-drag.x;
    if(Math.abs(delta)>4)drag.moved=true;
    if(drag.moved)setWindow(drag.start-delta/viewport.clientWidth*drag.width,drag.width);
  };
  viewport.onpointerup=e=>{
    if(!e.isPrimary||!drag)return;
    if(!drag.moved)onSeek(start+point(e)*(end-start));drag=null;
  };
  viewport.onpointercancel=viewport.onlostpointercapture=()=>{drag=null;};
  const observer=new ResizeObserver(()=>{
    if(!box.isConnected){observer.disconnect();return;}
    const nextColumns=Math.max(1,Math.ceil(viewport.clientWidth));
    if(columns!==nextColumns){columns=nextColumns;schedule();}
  });
  observer.observe(viewport);
  return {
    box,
    setScope(rows,axis){
      sources=rows.map(s=>({...s,cache:new Map()}));axisName=axis;start=0;end=1;index=rows[0].first;draw();
    },
    setSample(i){
      index=i;
      const f=position();
      if((f<start||f>end) && end-start<1)setWindow(f-(end-start)*.5,end-start);
      mark();
    }
  };
}
