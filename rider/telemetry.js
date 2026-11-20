import {lapOption,sectorTimes} from './lap-table.js';
import {createTelemetryChart} from './telemetry-chart.js';
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
  ['gyro_x','Roll rate','°/s'],['gyro_y','Pitch rate','°/s'],['gyro_z','Yaw rate','°/s'],
  ['time_delta','Time Δ','s'],['speed_delta','Speed Δ','km/h']
];
function metricValue(recording,i,key) {
  if(key==='time_delta'||key==='speed_delta') {
    if(recording!==data||!compareRange)return null;
    const other=compareSource(),[lo,hi]=compareRange;
    const distance=summary.dist[i]-summary.dist[first]+other.summary.dist[lo];
    const axis=other.summary.dist,index=nearest(axis,distance,lo,hi),before=Math.max(lo,index-1);
    const span=axis[index]-axis[before],fraction=span>0?(distance-axis[before])/span:0;
    const a=key==='time_delta'?times[i]-times[first]:speed(data,i);
    const beforeValue=key==='time_delta'?other.summary.times[before]:speed(other.data,before);
    const afterValue=key==='time_delta'?other.summary.times[index]:speed(other.data,index);
    if(beforeValue==null||afterValue==null)return null;
    const b=key==='time_delta'
      ?beforeValue+(afterValue-beforeValue)*fraction-other.summary.times[lo]
      :beforeValue+(afterValue-beforeValue)*fraction;
    return a==null||b==null?null:key==='time_delta'?(a-b)/1000:a-b;
  }
  if (key === 'speed') return speed(recording,i);
  if (key === 'power') {
    const volts = recording.get(i,'voltage_v'), amps = recording.get(i,'current_a');
    return volts == null || amps == null ? null : volts * amps;
  }
  return recording.get(i,key);
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
  const map=el('div',null,'tel-route-map');
  map.setAttribute('role','region');map.setAttribute('aria-label','Ride route on the satellite map');
  let locate=()=>{};
  const usableLaps=(rows,count)=>(Array.isArray(rows)?rows:[]).filter(l=>!l.hidden &&
    Number.isInteger(l.startSampleIndex) && l.startSampleIndex>=0 && l.startSampleIndex<count &&
    (l.endSampleIndex==null || l.endSampleIndex>=l.startSampleIndex));
  const lapRows=usableLaps(session?.laps,data.count);
  let external=null,comparisonTicket=0;
  const compareSource=()=>external || {data,summary,laps:lapRows};
  const keyOptions=lapRows.map((lap,i)=>[String(i),lapOption(lap)]);
  const lap=choose('View',[['','Whole session'],...keyOptions]);
  const compare=choose('Compare with',[['','No comparison'],...keyOptions]);
  compare.control.hidden=true;
  const controls=el('div',null,'tel-controls');
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
      for(const [val,label] of [['','No comparison'],...rows.map((row,i)=>[String(i),lapOption(row)])]) {
        const option=el('option',label); option.value=val;compare.select.append(option);
      }
      if(external && rows.length)compare.select.value='0';
      chooseScope();
    }
    shared.append(add,note);controls.append(shared);
  }
  const mapKey=el('div',null,'rider-map-key');
  const compareReadout=el('p',null,'tel-caption');
  const play=btn('Play',togglePlay);
  const seek=el('input');
  seek.type='range'; seek.min='0'; seek.max=String(last); seek.step='1'; seek.value='0';
  seek.setAttribute('aria-label','Recording position');
  const readout=el('output');
  const scrub=el('div',null,'tel-scrub'); scrub.append(play,seek,readout);
  let selectedIndex=0, first=0, end=last, frame=0, playing=false, started=0, startTime=0;
  let compareRange=null, xAxis='distance';
  const axisChoice=choose('Horizontal axis',[['distance','Distance'],['time','Time']]);
  axisChoice.select.value=xAxis;
  controls.append(axisChoice.control);
  const chart=createTelemetryChart({metrics,metricValue,onSeek:f=>{
    stop();
    const axis=xAxis==='distance'?dist:times;
    setSample(nearest(axis,axis[first]+f*(axis[end]-axis[first]),first,end));
  }});
  // A comparison rider starts at its own lap boundary and runs on the same
  // elapsed clock, even when the chart is comparing distance through the lap.
  function positionAt(recording,axis,lo,hi,time) {
    const i=nearest(axis,time,lo,hi),point=coordinate(recording,i);
    if(i===lo || time>=axis[i] || !point)return point;
    const prev=coordinate(recording,i-1);
    if(!prev)return null;
    const f=(time-axis[i-1])/(axis[i]-axis[i-1]);
    const lonDelta=((point[1]-prev[1]+540)%360)-180;
    return [prev[0]+(point[0]-prev[0])*f,prev[1]+lonDelta*f];
  }
  function updateRiders(time) {
    const point=positionAt(data,times,first,end,time);
    let comparison=null;
    if(compareRange){
      const source=compareSource(), [lo,hi]=compareRange, axis=source.summary.times;
      comparison=positionAt(source.data,axis,lo,hi,axis[lo]+time-times[first]);
    }
    locate(point,comparison,playing);
  }
  const setSample=(i,time=times[i])=>{
    selectedIndex=Math.max(first,Math.min(end,i));
    seek.value=String(selectedIndex);
    readout.textContent=clock(times[selectedIndex]-times[first],true);
    updateRiders(time);
    chart.setSample(selectedIndex);
    seek.setAttribute('aria-valuetext',readout.textContent);
  };
  function lapRange(value,rows=lapRows,count=data.count) {
    if(value==='') return [0,count-1];
    const l=rows[Number(value)];
    return [l.startSampleIndex,Math.min(count-1,l.endSampleIndex??count-1)];
  }
  function chooseScope() {
    stop();
    [first,end]=lapRange(lap.select.value);
    compare.control.hidden=lap.select.value==='';
    for(const opt of compare.select.options) opt.disabled=!external && opt.value!=='' && opt.value===lap.select.value;
    if(compare.control.hidden || (!external && compare.select.value===lap.select.value)) compare.select.value='';
    const source=compareSource();
    compareRange=compare.select.value===''?null:lapRange(compare.select.value,source.laps,source.data.count);
    locate.setScope?.(first,end,compareRange?source.data:null,compareRange?source.summary:null,
      compareRange?.[0],compareRange?.[1]);
    if(xAxis==='distance'&&(dist[end]<=dist[first]||compareRange&&source.summary.dist[compareRange[1]]<=source.summary.dist[compareRange[0]])){
      xAxis='time';axisChoice.select.value=xAxis;
    }
    mapKey.hidden=!compareRange || !summary.points;
    mapKey.replaceChildren();
    compareReadout.textContent='';
    if(compareRange){
      const a=lapRows[+lap.select.value], b=source.laps[+compare.select.value];
      mapKey.append(el('span','Rider · '+lapOption(a),'primary-rider'),el('span','Comparison · '+lapOption(b),'comparison-rider'));
      const delta=(v,w)=>Number.isFinite(v)&&Number.isFinite(w)&&v>0&&w>0?((v-w>=0?'+':'')+((v-w)/1000).toFixed(3)+' s'):'—';
      const bSectors=sectorTimes(b);
      compareReadout.textContent='Lap difference '+delta(a.durationMs,b.durationMs)+
        sectorTimes(a).map((s,i)=>' · S'+(i+1)+' '+delta(s,bSectors[i])).join('');
    }
    seek.min=String(first);seek.max=String(end);
    const attribute=xAxis==='distance'?'dist':'times';
    const plots=[{data,axis:summary[attribute],first,last:end,name:lap.select.value===''?'Whole session':lapOption(lapRows[+lap.select.value])}];
    if(compareRange)plots.push({data:source.data,axis:source.summary[attribute],first:compareRange[0],last:compareRange[1],name:lapOption(source.laps[+compare.select.value])});
    chart.setScope(plots,xAxis);setSample(first);
  }
  function stop() {
    playing=false; cancelAnimationFrame(frame);play.textContent='Play';
  }
  function loop(now) {
    if(!playing || !root.isConnected) {stop();return;}
    const t=startTime+now-started;
    const time=Math.min(t,times[end]);
    setSample(nearest(times,time,first,end),time);
    if(t>=times[end]) stop(); else frame=requestAnimationFrame(loop);
  }
  function togglePlay() {
    if(playing){stop();return;}
    if(selectedIndex===end)setSample(first);
    startTime=times[selectedIndex];started=performance.now();playing=true;
    play.textContent='Pause';frame=requestAnimationFrame(loop);
  }
  lap.select.onchange=compare.select.onchange=chooseScope;
  axisChoice.select.onchange=()=>{xAxis=axisChoice.select.value;chooseScope();};
  seek.oninput=()=>{stop();setSample(Number(seek.value));};
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
  root.append(overview,map,mapKey,controls,chart.box,scrub,compareReadout,exports);
  const video=el('div');root.append(video);
  container.replaceChildren(root);
  if(summary.points){
    import('./route-map.js').then(({mountReplayMap})=>{
      if(!root.isConnected)return;
      locate=mountReplayMap(map,data,summary,session?.track_doc);
      const source=compareSource();
      locate.setScope(first,end,compareRange?source.data:null,compareRange?source.summary:null,
        compareRange?.[0],compareRange?.[1]);
      updateRiders(times[selectedIndex]);
    }).catch(()=>{if(root.isConnected)map.textContent='The satellite map could not be opened.';});
  } else {
    map.className='tel-route-empty';
    map.textContent='GPS coordinates are unavailable for this recording.';
  }
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
  const retry=btn('Retry recording',load);
  async function load(){
    retry.hidden=true;status.textContent='Loading recording…';
    try {
      const blob=await loadRecording();
      if(!area.isConnected)return;
      const data=await decodeRecording(blob);
      if(!area.isConnected)return;
      render(view,data,blob,session,session.title||'ride',onCreateTrack,loadComparisons,loadTracks,onSaveTiming);
      status.textContent='';
    }catch(error){
      status.textContent=error.message || 'Unable to open recording.';
      retry.hidden=false;
    }
  }
  container.replaceChildren(area);
  if(session?.sample_path && typeof loadRecording==='function'){
    area.append(status,retry,view);
    load();
  }else area.append(el('p','No recording file is available for this session.'));
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
