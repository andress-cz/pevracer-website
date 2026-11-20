import {lapTable,lapLabel} from './lap-table.js';
import {coordinate,gpsDistance} from './telemetry-codec.js';

const rad=Math.PI/180, earth=6371000;
function endpoint(center,width,heading) {
  const lat=center[0]*rad, lon=center[1]*rad, angle=width/earth, br=heading*rad;
  const y=Math.asin(Math.sin(lat)*Math.cos(angle)+Math.cos(lat)*Math.sin(angle)*Math.cos(br));
  const x=lon+Math.atan2(Math.sin(br)*Math.sin(angle)*Math.cos(lat),Math.cos(angle)-Math.sin(lat)*Math.sin(y));
  return [y/rad,x/rad];
}
function gate(lat,lon,bearing,width=15) {
  if(![lat,lon,bearing,width].every(Number.isFinite) || width<=0)throw Error('The selected track has an incomplete gate.');
  const a=endpoint([lat,lon],width,bearing-90), b=endpoint([lat,lon],width,bearing+90);
  return {a,b,bearing,minLat:Math.min(a[0],b[0]),maxLat:Math.max(a[0],b[0]),minLon:Math.min(a[1],b[1]),maxLon:Math.max(a[1],b[1])};
}
function crossing(p,q,g) {
  const [lat,lon]=p.xy,[y,x]=q.xy;
  if(Math.max(lat,y)<g.minLat || Math.min(lat,y)>g.maxLat || Math.max(lon,x)<g.minLon || Math.min(lon,x)>g.maxLon)return null;
  const ax=x-lon,ay=y-lat,bx=g.b[1]-g.a[1],by=g.b[0]-g.a[0];
  const dx=lon-g.a[1],dy=lat-g.a[0],den=ay*bx-ax*by;
  if(Math.abs(den)<1e-18)return null;
  const t=(dx*by-dy*bx)/den,u=(dx*ay-dy*ax)/den;
  if(t<0 || t>1 || u<0 || u>1)return null;
  const br=Math.atan2(Math.sin(ax*rad)*Math.cos(y*rad),Math.cos(lat*rad)*Math.sin(y*rad)-Math.sin(lat*rad)*Math.cos(y*rad)*Math.cos(ax*rad))/rad;
  if(Math.cos((br-g.bearing)*rad)<-1e-14)return null;
  return t;
}
function samplesWithLocation(data) {
  const points=[];
  let prev=null,dist=0;
  for(let i=0;i<data.count;i++) {
    const xy=coordinate(data,i);
    if(!xy || (prev && xy[0]===prev[0] && xy[1]===prev[1]))continue;
    if(prev)dist+=gpsDistance(prev,xy);
    points.push({index:i,ns:BigInt(data.get(i,'elapsed_ns')),xy,dist});
    prev=xy;
  }
  return points;
}
function findCrossings(points,g,debounce) {
  const hits=[];
  let lastIndex=-10,lastDist=-Infinity;
  for(let i=0;i<points.length-1;i++) {
    const a=points[i],b=points[i+1],f=crossing(a,b,g);
    if(f==null)continue;
    const d=a.dist+(b.dist-a.dist)*f;
    if(debounce && (b.index-lastIndex<5 || d-lastDist<50))continue;
    hits.push({pos:i+f,index:a.index,ns:a.ns+BigInt(Math.trunc(Number(b.ns-a.ns)*f))});
    lastIndex=b.index;lastDist=d;
  }
  return hits;
}
function after(hits,pos) {
  let lo=0,hi=hits.length;
  while(lo<hi){
    const mid=(lo+hi)>>>1;
    if(hits[mid].pos<=pos)lo=mid+1;else hi=mid;
  }
  return hits[lo];
}
function sectorsBetween(gates,start,end) {
  let cursor=start;
  const bounds=[start];
  for(const hits of gates) {
    const hit=after(hits,cursor.pos);
    if(hit && hit.pos<=end.pos){bounds.push(hit);cursor=hit;}else bounds.push(null);
  }
  bounds.push(end);
  return bounds.slice(1).map((right,i)=>right && bounds[i]?Math.max(0,Number((right.ns-bounds[i].ns)/1000000n)):0);
}
function direction(points,a,b) {
  if(b-a<2)return null;
  const [lat,lon]=points[(a+b)>>>1].xy;
  let area=0;
  for(let i=a;i<=b;i++){
    const p=points[i].xy,q=points[i===b?a:i+1].xy;
    area+=(p[1]-lon)*(q[0]-lat)-(q[1]-lon)*(p[0]-lat);
  }
  area*=111320**2*Math.max(.000001,Math.cos(lat*rad));
  return Math.abs(area)<100?null:area>0?'CCW':'CW';
}
function majority(laps) {
  let count=0;
  for(const lap of laps){if(lap.direction==='CW')count++;else if(lap.direction==='CCW')count--;}
  return count>0?'CW':count<0?'CCW':null;
}
export function analyzeTrack(data,session,track) {
  const doc=track.doc, points=samplesWithLocation(data), sessionId=session.local_id;
  if(!doc || !sessionId)throw Error('The session or track definition is missing.');
  const isCircuit=doc.mode==='CIRCUIT';
  if(!isCircuit && doc.mode!=='POINT_TO_POINT')throw Error('Unrecognized track mode.');
  const trackId=track.local_id||doc.id;
  const existing=new Map((session.track_local_id===trackId?session.laps??[]:[]).map(l=>[l.startSampleIndex+':'+!!l.outLap+':'+!!l.incomplete,l]));
  function lapFrom(start,end,number,sectors,dir,incomplete=false,outLap=false) {
    const original=existing.get(start.index+':'+outLap+':'+incomplete);
    return {id:original?.id??crypto.randomUUID(),sessionId,trackId,lapNumber:number,
      startNanos:Number(start.ns),endNanos:Number(end.ns),startSampleIndex:start.index,endSampleIndex:end.index,
      durationMs:incomplete?null:Number((end.ns-start.ns)/1000000n),sectorTimesJson:JSON.stringify(sectors),
      direction:dir,incomplete,outLap,hidden:original?.hidden===true};
  }
  function withEdges(runs,start,end) {
    if(!start || !end)return runs;
    const out=[...runs],leading={index:0,ns:BigInt(data.get(0,'elapsed_ns'))};
    const lastIndex=data.count-1,trailing={index:lastIndex,ns:BigInt(data.get(lastIndex,'elapsed_ns'))};
    if(start.index>0)out.unshift(lapFrom(leading,start,0,[],runs[0]?.direction??null,true,true));
    if(end.index<lastIndex)out.push(lapFrom(end,trailing,runs.length+1,[],runs.at(-1)?.direction??null,true));
    return out;
  }
  function passes(reverse) {
    const flip=reverse?180:0, bearing=doc.startFinishBearingDeg;
    const startGate=gate(doc.startFinishLat,doc.startFinishLon,bearing+flip,doc.gateHalfWidthM??15);
    const starts=findCrossings(points,startGate,true);
    if(!starts.length)return {runs:[],laps:[],dir:null,score:0};
    const specs=(doc.sectors??[]).filter(s=>s.index>0).sort((a,b)=>a.index-b.index);
    if(reverse)specs.reverse();
    const gates=specs.map(s=>findCrossings(points,gate(s.entryLat,s.entryLon,(s.bearingDeg??bearing)+flip,s.halfWidthM??15),false));
    const finishes=isCircuit?starts:findCrossings(points,gate(doc.finishLat,doc.finishLon,doc.finishBearingDeg??bearing,doc.finishHalfWidthM??doc.gateHalfWidthM??15),true);
    const runs=[];
    let hits=0;
    for(let i=0;i<starts.length;i++) {
      const start=starts[i],finish=isCircuit?starts[i+1]:after(finishes,start.pos);
      if(!finish)break;
      if(!isCircuit && starts[i+1] && starts[i+1].pos<finish.pos)continue;
      if(finish.ns<=start.ns)continue;
      const secs=sectorsBetween(gates,start,finish);
      const dir=direction(points,Math.floor(start.pos),Math.floor(finish.pos));
      hits+=secs.filter(n=>n>0).length;
      runs.push(lapFrom(start,finish,runs.length+1,secs,dir));
    }
    const dir=majority(runs);
    const laps=isCircuit?withEdges(runs,starts[0],starts.at(-1)):runs;
    return {runs,laps,dir,score:runs.length*1000+hits};
  }
  const forward=passes(false);
  let laps=forward.laps;
  if(isCircuit) {
    const reverse=passes(true);
    if(forward.dir && reverse.dir && forward.dir!==reverse.dir){
      const merged=[];
      const score=l=>JSON.parse(l.sectorTimesJson).filter(v=>v>0).length;
      for(const l of [...forward.runs,...reverse.runs].sort((a,b)=>a.startSampleIndex-b.startSampleIndex)){
        const overlap=merged.findIndex(item=>l.startSampleIndex<item.endSampleIndex && item.startSampleIndex<l.endSampleIndex);
        if(overlap===-1)merged.push(l);
        else if(score(l)>score(merged[overlap]))merged[overlap]=l;
      }
      merged.sort((a,b)=>a.startSampleIndex-b.startSampleIndex).forEach((l,i)=>l.lapNumber=i+1);
      const a=merged[0],b=merged.at(-1);
      laps=withEdges(merged,{index:a.startSampleIndex,ns:BigInt(a.startNanos)},{index:b.endSampleIndex,ns:BigInt(b.endNanos)});
    } else if(reverse.score>forward.score)laps=reverse.laps;
  }
  const complete=laps.filter(l=>!l.incomplete);
  const dir=majority(complete) ?? (points.length?direction(points,0,points.length-1):null);
  for(const l of laps)l.direction??=dir;
  return timingSummary(track,laps,dir);
}
function timingSummary(track,laps,lapDirection) {
  const visible=laps.filter(l=>!l.hidden);
  const best=visible.reduce((n,l)=>!l.incomplete&&!l.outLap&&l.durationMs>0?Math.min(n,l.durationMs):n,Infinity);
  return {track,laps,lapDirection,best_lap_ms:Number.isFinite(best)?best:null,lap_count:visible.length};
}

export function mountTiming(container,{data,session,loadTracks,onSaveTiming}) {
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
  const button=(text,handler)=>{const b=el('button',text);b.type='button';b.onclick=handler;return b;};
  const box=el('details');box.className='tel-video';
  box.append(el('summary','Change track'));
  const controls=el('div'),status=el('p'),result=el('div');status.setAttribute('role','status');
  box.append(controls,status,result);container.replaceChildren(box);
  const start=button('Choose track',async()=>{
    start.disabled=true;status.textContent='Loading tracks…';
    try{
      const tracks=await loadTracks();
      if(!container.isConnected)return;
      if(!tracks.length){status.textContent='Save a track before analyzing gate crossings.';start.disabled=false;return;}
      const select=el('select');select.setAttribute('aria-label','Track for timing');
      for(const track of tracks){const o=el('option',track.name);o.value=track.id;select.append(o);}
      if(tracks.some(t=>t.id===session.track_id))select.value=session.track_id;
      const label=el('label','Track for timing');label.className='tel-field';label.append(select);
      select.onchange=()=>{result.replaceChildren();status.textContent='';};
      const preview=button('Preview lap times',()=>{
        result.replaceChildren();
        try{
          const track=tracks.find(t=>t.id===select.value),analysis=analyzeTrack(data,session,track);
          if(!analysis.laps.length){status.textContent='No gate crossings found on this track.';return;}
          const completed=analysis.laps.filter(l=>!l.incomplete);
          status.textContent=completed.length+' completed laps. Choose the laps to include before saving.';
          const table=el('div');result.append(table);
          function drawPreview(){
            table.replaceChildren(lapTable(analysis.laps,{caption:'Preview lap times',after:[['Include',lap=>{
              const check=el('input');check.type='checkbox';check.checked=!lap.hidden;
              check.setAttribute('aria-label','Include '+lapLabel(lap));
              check.onchange=()=>{
                lap.hidden=!check.checked;drawPreview();
                table.querySelectorAll('input')[analysis.laps.indexOf(lap)].focus();
              };
              return check;
            }]]}));
          }
          drawPreview();
          if(onSaveTiming){
            const save=button('Save track and lap times',async()=>{
              save.disabled=true;controls.inert=true;result.inert=true;
              try{await onSaveTiming(timingSummary(track,analysis.laps,analysis.lapDirection));status.textContent='Track and lap times saved.';}
              catch(error){status.textContent=error.message||'Could not save updated timing.';save.disabled=false;}
              finally{controls.inert=false;result.inert=false;}
            });
            result.append(save);
          }
        }catch(error){status.textContent=error.message||'Could not analyze track gates.';}
      });
      controls.className='tel-controls';controls.replaceChildren(label,preview);status.textContent='';
    }catch(error){status.textContent=error.message||'Could not load tracks.';start.disabled=false;}
  });
  controls.append(start);
}
