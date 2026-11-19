import {coordinate, decodeRecording, elapsedMs, exportRecording, gpsDistance, speed} from './telemetry-codec.js';
import {mountVideo} from './telemetry-video.js';
import {mountTiming} from './timing.js';

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function btn(label, fn) {
  const node = el('button',label);
  node.type = 'button';
  node.addEventListener('click',fn);
  return node;
}
function choose(label, options) {
  const select = el('select');
  select.setAttribute('aria-label',label);
  for (const [value,name] of options) {
    const option = el('option', name);
    option.value = value;
    select.append(option);
  }
  const control = el('label',label,'tel-field');
  control.append(select);
  return {select,control};
}
function clock(ms, precise = false) {
  if (!Number.isFinite(ms)) return '—';
  const t = Math.abs(Math.round(ms));
  const seconds = String(Math.floor(t / 1000) % 60).padStart(2,'0');
  return (ms < 0 ? '−' : '') + Math.floor(t / 60000) + ':' + seconds + (precise ? '.' + String(t % 1000).padStart(3,'0') : '');
}
function save(blob,name) {
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 45000);
}
const metrics = [
  ['speed','Speed','km/h'],['gps_speed_mps','GPS speed','m/s'],['vehicle_speed_kmh','Vehicle speed','km/h'],
  ['alt_m','Altitude','m'],['heading_deg','Heading','°'],['voltage_v','Voltage','V'],['current_a','Current','A'],
  ['power','Power','W'],['pwm_pct','PWM','%'],['motor_temp_c','Motor temperature','°C'],
  ['battery_pct','Battery','%'],['pitch_deg','Pitch','°'],['h_acc_m','Position accuracy','m'],
  ['gx','Longitudinal acceleration','g'],['gy','Lateral acceleration','g'],['gz','Vertical acceleration','g'],
  ['gyro_x','Roll rate','°/s'],['gyro_y','Pitch rate','°/s'],['gyro_z','Yaw rate','°/s']
];
function metricValue(data,i,key) {
  if (key === 'speed') return speed(data,i);
  if (key === 'power') {
    const volts = data.get(i,'voltage_v'), amps = data.get(i,'current_a');
    return volts == null || amps == null ? null : volts * amps;
  }
  return data.get(i,key);
}
function prepare(data) {
  const times = new Float64Array(data.count), dist = new Float64Array(data.count);
  let last, distance = 0, points = 0, north = -Infinity, south = Infinity, east = -Infinity, west = Infinity, centerLon = null;
  let peak = -Infinity, totalSpeed = 0, speedCount = 0;
  const base = elapsedMs(data,0);
  for (let i=0; i<data.count; i++) {
    times[i] = Math.max(times[i-1] ?? 0, elapsedMs(data,i) - base);
    const p = coordinate(data,i);
    if (p) {
      centerLon ??= p[1];
      const lon = centerLon + ((p[1] - centerLon + 540) % 360) - 180;
      north = Math.max(north,p[0]); south = Math.min(south,p[0]);
      east = Math.max(east,lon); west = Math.min(west,lon);
      if (last) distance += gpsDistance(last,p);
      last = p;
      points++;
    }
    dist[i] = distance;
    const velocity = speed(data,i);
    if (velocity != null) { peak = Math.max(peak,velocity); totalSpeed += velocity; speedCount++; }
  }
  return {times,dist,distance,points,north,south,east,west,centerLon,peak,mean:speedCount ? totalSpeed/speedCount : null};
}
function nearest(times,time,lo=0,hi=times.length-1) {
  while (lo<hi) {
    const mid = (lo+hi) >>> 1;
    if (times[mid] < time) lo=mid+1; else hi=mid;
  }
  return lo;
}
function rangePoints(first,last,maxCount) {
  const step = Math.max(1, Math.ceil((last-first+1)/maxCount));
  const out = [];
  for (let i=first; i<last; i+=step) out.push(i);
  out.push(last);
  return out;
}
function panel(label,width,height) {
  const box = el('div',null,'tel-plot');
  box.style.aspectRatio = String(width) + '/' + height;
  const canvas = el('canvas');
  canvas.width=width; canvas.height=height;
  canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',label);
  const ctx=canvas.getContext('2d');
  const cursor=el('span',null,'tel-cursor');
  cursor.setAttribute('aria-hidden','true');
  box.append(canvas,cursor);
  return {box,canvas,ctx,cursor,width,height};
}
function background(p) {
  const {ctx,width,height}=p;
  ctx.fillStyle='#13231c'; ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='#30453a'; ctx.lineWidth=1; ctx.beginPath();
  for(let x=0;x<width;x+=50) { ctx.moveTo(x,0); ctx.lineTo(x,height); }
  for(let y=0;y<height;y+=50) { ctx.moveTo(0,y); ctx.lineTo(width,y); }
  ctx.stroke();
}
function cursor(p,x,y) {
  p.cursor.hidden=x==null;
  if (x==null) return;
  p.cursor.style.left=(x/p.width*100)+'%';
  if (y != null) p.cursor.style.top=(y/p.height*100)+'%';
}
function route(data,summary,p) {
  background(p);
  if (!summary.points) {
    p.box.replaceChildren(el('p','GPS coordinates were unavailable for this recording.'));
    return () => {};
  }
  const {centerLon,west,east,north,south}=summary;
  const cos=Math.max(.0001,Math.cos((north+south)*Math.PI/360));
  const scale=Math.min((p.width-56)/Math.max(.00001,(east-west)*cos),(p.height-56)/Math.max(.00001,north-south));
  function xy(i) {
    const point=coordinate(data,i);
    if (!point) return null;
    const lon=centerLon+((point[1]-centerLon+540)%360)-180;
    return [p.width/2+(lon-(west+east)/2)*cos*scale,p.height/2+((north+south)/2-point[0])*scale];
  }
  p.ctx.lineWidth=3;
  let last=null;
  for (const i of rangePoints(0,data.count-1,3500)) {
    const pos=xy(i);
    if(pos && last) {
      const v=speed(data,i);
      const ratio=v==null || summary.peak<=0 ? 0 : Math.min(1,Math.max(0,v/summary.peak));
      p.ctx.strokeStyle='hsl('+String(163-ratio*93)+' 72% 66%)';
      p.ctx.beginPath(); p.ctx.moveTo(...last); p.ctx.lineTo(...pos); p.ctx.stroke();
    }
    last=pos;
  }
  return i => {
    const point=xy(i);
    cursor(p,point?.[0],point?.[1]);
  };
}
function lapName(lap) {
  if (lap.outLap) return 'Out lap';
  return 'Lap '+lap.lapNumber+(lap.direction?' · '+lap.direction:'')+(lap.incomplete?' (incomplete)':'');
}
function sectorTimes(lap) {
  try {
    const values=JSON.parse(lap.sectorTimesJson || '[]');
    return Array.isArray(values) ? values : [];
  } catch { return []; }
}
function render(container,data,blob,session,name,onCreateTrack,loadComparisons,loadTracks,onSaveTiming) {
  const summary=prepare(data), {times,dist}=summary, last=data.count-1;
  const root=el('section',null,'tel-view');
  const overview=el('div',null,'tel-stats');
  const stat=(label,value) => {
    const box=el('div'); box.append(el('span',label),el('strong',value)); overview.append(box);
  };
  stat('Recorded time',clock(times[last]));
  stat('Distance',(summary.distance/1000).toFixed(2)+' km');
  stat('Peak speed',Number.isFinite(summary.peak)?summary.peak.toFixed(1)+' km/h':'—');
  stat('Average speed',summary.mean==null?'—':summary.mean.toFixed(1)+' km/h');
  const timedLaps=(session?.laps??[]).filter(l=>!l.hidden && !l.outLap && !l.incomplete && l.durationMs>0);
  if(timedLaps.length){
    const best=timedLaps.reduce((a,b)=>a.durationMs<=b.durationMs?a:b);
    stat('Best lap',clock(best.durationMs,true));
    // Sector numbering differs across directions and gate layouts.
    const groups=new Map();
    for(const l of timedLaps){
      const sectors=sectorTimes(l);
      if(!sectors.length)continue;
      const key=[l.direction??'',sectors.length].join('/');
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(sectors);
    }
    for(const [dir,entries] of groups){
      const fastest=Array(entries[0].length).fill(Infinity);
      for(const sectors of entries)sectors.forEach((v,i)=>{if(v>0)fastest[i]=Math.min(fastest[i],v);});
      if(fastest.every(Number.isFinite) && entries.length>1){
        const [direction,count]=dir.split('/');
        stat('Ideal lap'+(groups.size>1?' · '+[direction,count+' sectors'].filter(Boolean).join(' · '):''),clock(fastest.reduce((a,b)=>a+b),true));
      }
    }
  }
  const map=panel('GPS route with current sample position',720,300);
  const locate=route(data,summary,map);
  const line=panel('Selected telemetry over the ride',720,210);
  line.cursor.className='tel-line-cursor';
  const usableLaps=(rows,count)=>(Array.isArray(rows)?rows:[]).filter(l=>!l.hidden &&
    Number.isInteger(l.startSampleIndex) && l.startSampleIndex>=0 && l.startSampleIndex<count &&
    (l.endSampleIndex==null || l.endSampleIndex>=l.startSampleIndex));
  const lapRows=usableLaps(session?.laps,data.count);
  let external=null,comparisonTicket=0;
  const compareSource=()=>external || {data,summary,laps:lapRows};
  const keyOptions=lapRows.map((lap,i)=>[String(i),lapName(lap)]);
  const lap=choose('View',[['','Whole session'],...keyOptions]);
  const compare=choose('Compare with',[['','No comparison'],...keyOptions]);
  compare.control.hidden=true;
  const channel=choose('Telemetry',metrics.map(([key,label,unit])=>[key,label+' ('+unit+')']));
  const controls=el('div',null,'tel-controls');
  controls.append(channel.control);
  if(lapRows.length) controls.append(lap.control,compare.control);
  if(loadComparisons && lapRows.length) {
    const shared=el('div',null,'tel-controls');
    const note=el('p');note.setAttribute('role','status');
    const other=choose('Comparison session',[['','Current session']]);
    const add=btn('Compare across sessions',async()=>{
      add.disabled=true;
      try {
        const sources=await loadComparisons();
        if(!root.isConnected)return;
        if(!sources.length){note.textContent='No other recordings on this track are available.';add.disabled=false;return;}
        for(const source of sources) {
          const opt=el('option',source.title);opt.value=source.id;other.select.append(opt);
        }
        other.select.onchange=async()=>{
          const ticket=++comparisonTicket;
          external=null;setComparisonLaps(lapRows);
          const source=sources.find(row=>row.id===other.select.value);
          if(!source){note.textContent='';return;}
          note.textContent='Loading comparison recording…';
          try{
            const {session:comparisonSession,blob:comparisonFile}=await source.load();
            const comparisonData=await decodeRecording(comparisonFile);
            if(ticket!==comparisonTicket || !root.isConnected)return;
            const rows=usableLaps(comparisonSession.laps,comparisonData.count);
            if(!rows.length){other.select.value='';note.textContent='This recording has no timed laps.';return;}
            external={data:comparisonData,summary:prepare(comparisonData),laps:rows};
            setComparisonLaps(rows);
            note.textContent='';
          }catch(error){if(ticket===comparisonTicket){other.select.value='';note.textContent=error.message||'Could not load the comparison.';}}
        };
        shared.replaceChildren(other.control,note);
        if(lap.select.value===''){lap.select.value='0';chooseScope();}
      }catch(error){note.textContent=error.message||'Could not load comparable sessions.';add.disabled=false;}
    });
    function setComparisonLaps(rows) {
      compare.select.replaceChildren();
      for(const [val,label] of [['','No comparison'],...rows.map((row,i)=>[String(i),lapName(row)])]) {
        const option=el('option',label); option.value=val;compare.select.append(option);
      }
      if(external && rows.length)compare.select.value='0';
      chooseScope();
    }
    shared.append(add,note);controls.append(shared);
  }
  const caption=el('p',null,'tel-caption');
  const compareReadout=el('p',null,'tel-caption');
  const play=btn('Play',togglePlay);
  const seek=el('input');
  seek.type='range'; seek.min='0'; seek.max=String(last); seek.step='1'; seek.value='0';
  seek.setAttribute('aria-label','Recording position');
  const readout=el('output');
  const scrub=el('div',null,'tel-scrub'); scrub.append(play,seek,readout);
  let selectedIndex=0, first=0, end=last, frame=0, playing=false, started=0, startTime=0;
  let activeMetric='speed', unit='km/h', compareRange=null, xAxis='time';
  const tick=el('div',null,'tel-readout');
  const setSample=(i)=>{
    selectedIndex=Math.max(first,Math.min(end,i));
    seek.value=String(selectedIndex);
    readout.textContent=clock(times[selectedIndex]-times[first],true);
    const v=metricValue(data,selectedIndex,activeMetric);
    tick.textContent=(v==null?'—':v.toFixed(1))+' '+unit+'  ·  '+(dist[selectedIndex]/1000).toFixed(2)+' km';
    locate(selectedIndex);
    const pos=fraction(selectedIndex,first,end);
    cursor(line,20+pos*(line.width-40));
    seek.setAttribute('aria-valuetext',readout.textContent);
  };
  function fraction(i,from,to,seriesSummary=summary) {
    const axis=xAxis==='distance'?seriesSummary.dist:seriesSummary.times;
    const span=axis[to]-axis[from];
    return span>0?(axis[i]-axis[from])/span:0;
  }
  function lapRange(value,rows=lapRows,count=data.count) {
    if(value==='') return [0,count-1];
    const l=rows[Number(value)];
    return [l.startSampleIndex,Math.min(count-1,l.endSampleIndex??count-1)];
  }
  function drawChart() {
    background(line);
    const ranges=[[first,end],...(compareRange?[compareRange]:[])];
    const series=ranges.map(([a,b],n)=>{
      const source=n?compareSource():{data,summary};
      return rangePoints(a,b,2400).map(i=>[fraction(i,a,b,source.summary),metricValue(source.data,i,activeMetric)]);
    });
    let low=Infinity,high=-Infinity;
    for(const points of series) for(const [,v] of points) if(v!=null) { low=Math.min(low,v); high=Math.max(high,v); }
    const missing=!Number.isFinite(low);
    for(let n=0;n<series.length;n++) {
      const ctx=line.ctx;
      ctx.strokeStyle=n?'#ffb96c':'#bbf344'; ctx.lineWidth=3;
      ctx.beginPath();
      let pen=false;
      for(const [f,v] of series[n]) {
        if(v==null) {pen=false; continue;}
        const x=20+f*(line.width-40), y=high===low?line.height/2:line.height-36-(v-low)/(high-low)*(line.height-62);
        if(!pen) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        pen=true;
      }
      ctx.stroke();
    }
    line.ctx.fillStyle='#d9e7d5'; line.ctx.font='16px sans-serif';
    if(!missing) line.ctx.fillText(high.toFixed(1)+' '+unit,10,18);
    caption.textContent=missing?'This recording has no samples for the selected channel.':
      (compareRange?'Green: '+lapName(lapRows[+lap.select.value])+' · Orange: '+lapName(compareSource().laps[+compare.select.value])+' · ':'')+
      (xAxis==='distance'?'Distance through each lap':'Elapsed time')+' · '+low.toFixed(1)+' to '+high.toFixed(1)+' '+unit;
  }
  function chooseScope() {
    stop();
    [first,end]=lapRange(lap.select.value);
    compare.control.hidden=lap.select.value==='';
    for(const opt of compare.select.options) opt.disabled=!external && opt.value!=='' && opt.value===lap.select.value;
    if(compare.control.hidden || (!external && compare.select.value===lap.select.value)) compare.select.value='';
    const source=compareSource();
    compareRange=compare.select.value===''?null:lapRange(compare.select.value,source.laps,source.data.count);
    xAxis=compareRange && dist[end]>dist[first] && source.summary.dist[compareRange[1]]>source.summary.dist[compareRange[0]]?'distance':'time';
    compareReadout.textContent='';
    if(compareRange){
      const a=lapRows[+lap.select.value], b=source.laps[+compare.select.value];
      const delta=(v,w)=>Number.isFinite(v)&&Number.isFinite(w)&&v>0&&w>0?((v-w>=0?'+':'')+((v-w)/1000).toFixed(3)+' s'):'—';
      const bSectors=sectorTimes(b);
      compareReadout.textContent='Lap difference '+delta(a.durationMs,b.durationMs)+
        sectorTimes(a).map((s,i)=>' · S'+(i+1)+' '+delta(s,bSectors[i])).join('');
    }
    seek.min=String(first);seek.max=String(end);
    drawChart();setSample(first);
  }
  function stop() {
    playing=false; cancelAnimationFrame(frame);play.textContent='Play';
  }
  function loop(now) {
    if(!playing || !root.isConnected) {stop();return;}
    const t=startTime+now-started;
    setSample(nearest(times,t,first,end));
    if(t>=times[end]) stop(); else frame=requestAnimationFrame(loop);
  }
  function togglePlay() {
    if(playing){stop();return;}
    if(selectedIndex===end)setSample(first);
    startTime=times[selectedIndex];started=performance.now();playing=true;
    play.textContent='Pause';frame=requestAnimationFrame(loop);
  }
  lap.select.onchange=compare.select.onchange=chooseScope;
  channel.select.onchange=()=>{
    activeMetric=channel.select.value;unit=metrics.find(m=>m[0]===activeMetric)[2];
    drawChart();setSample(selectedIndex);
  };
  seek.oninput=()=>{stop();setSample(Number(seek.value));};
  line.box.onclick=e=>{
    stop();
    const rect=line.box.getBoundingClientRect();
    const f=Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*line.width-20)/(line.width-40)));
    const axis=xAxis==='distance'?dist:times;
    setSample(nearest(axis,axis[first]+f*(axis[end]-axis[first]),first,end));
  };
  const exports=el('div',null,'tel-actions');
  const formats=[['csv','PEV Racer CSV'],['racebox','RaceBox CSV']];
  if(summary.points)formats.push(['vbo','VBO']);
  const format=choose('Export format',formats);
  const stem=name.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,76)||'ride';
  const rawName=blob.name || stem+'.pevr.gz';
  exports.append(format.control,btn('Export file',()=>{
    const out=format.select.value;
    save(exportRecording(data,out,Date.parse(session?.started_at)),stem+(out==='racebox'?'-racebox':'')+(out==='vbo'?'.vbo':'.csv'));
  }),btn('Download original',()=>save(blob,rawName)));
  if(onCreateTrack && summary.points>=10) exports.append(btn('Build track from route',()=>{
    const points=[];
    const step=Math.max(1,Math.ceil(summary.points/3000));
    let seen=0;
    for(let i=0;i<data.count;i++){
      const point=coordinate(data,i);
      if(point && (seen++%step===0 || seen===summary.points))points.push({lat:point[0],lon:point[1]});
    }
    onCreateTrack(points,name);
  }));
  root.append(overview,map.box,controls,line.box,tick,scrub,caption,compareReadout,exports);
  const video=el('div');root.append(video);
  container.replaceChildren(root);
  chooseScope();
  if(loadTracks && summary.points>1 && session) {
    const timing=el('div');root.append(timing);
    mountTiming(timing,{data,session,loadTracks,onSaveTiming});
  }
  mountVideo(video,{
    data,times,laps:session?.laps ?? [],layoutJson:session?.meta?.videoOverlayLayoutJson,name:stem, current:()=>times[selectedIndex],
    seek:t=>{if(lap.select.value!==''){lap.select.value='';chooseScope();}stop();setSample(nearest(times,t));}
  });
}

export function mountTelemetry(container,{session,loadRecording,onCreateTrack,loadComparisons,loadTracks,onSaveTiming}) {
  const area=el('section',null,'tel-module');
  area.append(el('h3','Telemetry replay'));
  const status=el('p'); status.setAttribute('role','status');
  const view=el('div');
  const open=btn('Open recording',async()=>{
    open.disabled=true;status.textContent='Loading recording…';
    try {
      const blob=await loadRecording();
      const data=await decodeRecording(blob);
      if(!area.isConnected)return;
      render(view,data,blob,session,session.title||'ride',onCreateTrack,loadComparisons,loadTracks,onSaveTiming);
      open.remove();status.textContent='';
    }catch(error){status.textContent=error.message || 'Unable to open recording.';open.disabled=false;}
  });
  if(session?.sample_path && typeof loadRecording==='function') area.append(open,status,view);
  else area.append(el('p','No recording file is available for this session.'));
  container.replaceChildren(area);
}
export function mountLocalAnalysis(container,{onCreateTrack,onSaveSession}={}) {
  const area=el('section',null,'tel-module');
  const file=el('input'); file.type='file';file.accept='.vbo,.csv,.gz,.pevr';
  const label=el('label','Open a recording file','tel-field');label.append(file);
  const info=el('p','Open a PEV Racer recording, RaceBox CSV or VBO file to analyze it in your browser.');
  const status=el('p');status.setAttribute('role','status');
  const view=el('div');
  const importArea=el('div');
  let latest=0;
  file.onchange=async()=>{
    const selection=file.files[0], ticket=++latest;
    if(!selection)return;
    importArea.replaceChildren();view.replaceChildren();status.textContent='Reading '+selection.name+'…';
    try{
      const data=await decodeRecording(selection);
      if(ticket!==latest || !area.isConnected)return;
      render(view,data,selection,null,selection.name.replace(/\.(pevr\.gz|gz|vbo|csv|pevr)$/i,''),onCreateTrack);
      status.textContent=selection.name+' · '+data.count.toLocaleString()+' samples';
      if(onSaveSession){
        const mine=el('input');mine.type='checkbox';
        const label=el('label',null,'tel-check');label.append(mine,document.createTextNode('I recorded this ride'));
        const save=btn('Save private session',async()=>{
          save.disabled=true;file.disabled=true;mine.disabled=true;status.textContent='Saving to your cloud library…';
          try{
            await onSaveSession(data,selection.name.replace(/\.(pevr\.gz|gz|vbo|csv|pevr)$/i,''),selection,mine.checked);
            status.textContent='Session saved to your private library.';
          }catch(error){status.textContent=error.message||'Could not save this session.';save.disabled=false;mine.disabled=false;}
          finally{file.disabled=false;}
        });
        importArea.append(label,save);
      }
    }catch(error){if(ticket===latest)status.textContent=error.message || 'Unable to read this file.';}
  };
  area.append(info,label,status,importArea,view);container.replaceChildren(area);
}
