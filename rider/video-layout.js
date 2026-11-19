import {coordinate,speed} from './telemetry-codec.js';

// Each row uses the enum name, display unit, range and default accent from Android's OverlayMetric.
export const metrics = {
  SPEED:['Speed','km/h',0,80,'#1565c0'], EUC_SPEED:['Vehicle speed','km/h',0,80,'#00897b','vehicle_speed_kmh'],
  CURRENT:['Current','A',-40,80,'#e65100','current_a'], PWM:['PWM','%',0,100,'#6a1b9a','pwm_pct'],
  VOLTAGE:['Voltage','V',50,90,'#2e7d32','voltage_v'], MOTOR_TEMP:['Motor temperature','°C',20,80,'#c62828','motor_temp_c'],
  BATTERY:['Battery','%',0,100,'#00838f','battery_pct'], ALTITUDE:['Altitude','m',0,500,'#5d4037','alt_m'],
  ACCEL:['Acceleration','g',-2,2,'#1e88e5'], ACCEL_LONG:['Longitudinal G','g',-2,2,'#1e88e5','gx'],
  ACCEL_LAT:['Lateral G','g',-2,2,'#ff6f00','gy'], ACCEL_VERT:['Vertical G','g',-2,2,'#7b1fa2','gz'],
  LEAN:['Lean','°',-45,45,'#ff6f00'], PITCH:['Pitch','°',-45,45,'#00897b'],
  HEADING:['Heading','°',0,360,'#455a64','heading_deg'], SECTOR_DELTA:['Sector delta','s',-5,5,'#6a1b9a'],
  LAP_NUMBER:['Lap','',0,50,'#37474f'], MAP_INSET:['Route map','',0,1,'#4fc3f7'], GFORCE_XY:['G-force','g',-2,2,'#1e88e5'],
};
export const styles = {
  NUMBER_BOLD:'Bold number', NUMBER_SLIM:'Slim number', NUMBER_SEGMENT:'Segment display', GAUGE_ARC:'Arc gauge',
  GAUGE_NEEDLE:'Needle gauge', BAR_H_SMOOTH:'Horizontal bar', BAR_H_SEGMENTS:'Segmented horizontal bar',
  BAR_V_SMOOTH:'Vertical bar', BAR_V_SEGMENTS:'Segmented vertical bar', GRADIENT_FULL:'Full-frame tint',
  SPARKLINE:'Sparkline', GFORCE_CROSS:'G-force cross', MAP_INSET:'Route inset',
};
export function choices(metric) {
  if(metric==='MAP_INSET')return ['MAP_INSET'];
  if(metric==='GFORCE_XY')return ['GFORCE_CROSS','NUMBER_BOLD','NUMBER_SLIM','SPARKLINE'];
  if(metric==='LAP_NUMBER')return ['NUMBER_BOLD','NUMBER_SLIM','NUMBER_SEGMENT'];
  if(metric==='SECTOR_DELTA')return ['NUMBER_BOLD','NUMBER_SLIM','NUMBER_SEGMENT','BAR_H_SMOOTH','SPARKLINE','GRADIENT_FULL'];
  return Object.keys(styles).filter(k=>k!=='GFORCE_CROSS' && k!=='MAP_INSET');
}
export function widget(metric='SPEED',index=0) {
  return {id:crypto.randomUUID(),metric,style:choices(metric)[0],xNorm:index%2 ? .80 : .20,
    yNorm:.78 - (Math.floor(index/2)%4)*.19,scale:1,opacity:1,colorArgb:null,rangeMin:null,rangeMax:null,
    barSegmentCount:10,sparkWindowSec:8};
}
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function decodeLayout(raw) {
  let doc=typeof raw==='string'?JSON.parse(raw):raw;
  if(typeof doc?.layoutJson==='string') doc=JSON.parse(doc.layoutJson);
  if(!doc||!Array.isArray(doc.widgets)||(doc.version??1)!==1)throw Error('Choose a version 1 Android overlay layout JSON.');
  if(doc.widgets.length>100)throw Error('The web editor supports up to 100 gauges.');
  return {version:1,widgets:doc.widgets.map(w=>{
    if(!w || typeof w!=='object' || Array.isArray(w))throw Error('The layout contains an invalid gauge.');
    const v={...widget(),xNorm:0.15,yNorm:0.85,...w};
    if(!Object.hasOwn(metrics,v.metric)||!Object.hasOwn(styles,v.style)||!choices(v.metric).includes(v.style))
      throw Error('This layout contains an unsupported metric or gauge style.');
    if(typeof v.id!=='string'||!v.id)throw Error('A gauge is missing its identifier.');
    for(const k of ['xNorm','yNorm','scale','opacity','sparkWindowSec','barSegmentCount']) if(!Number.isFinite(v[k]))throw Error('A gauge setting is invalid.');
    for(const k of ['rangeMin','rangeMax']) if(v[k]!=null && !Number.isFinite(v[k]))throw Error('A gauge range is invalid.');
    if(v.colorArgb!=null && !(Number.isInteger(v.colorArgb)&&v.colorArgb>=-2147483648&&v.colorArgb<=2147483647))throw Error('A gauge colour is invalid.');
    if(!Number.isInteger(v.barSegmentCount)||v.scale<=0||v.scale>10||v.sparkWindowSec<=0)throw Error('A gauge size or interval is invalid.');
    return v;
  })};
}

function sampleAt(times, time) {
  let low=0, high=times.length-1;
  while(low<high) {
    const mid=(low+high)>>>1;
    if(times[mid]<time)low=mid+1;else high=mid;
  }
  return low;
}
function sectorTimes(lap) {
  try {const array=lap.sectorTimesMs ?? JSON.parse(lap.sectorTimesJson??'[]');return Array.isArray(array)?array:[];} catch {return [];}
}
function metricValue(context,index,key) {
  const data=context.data, field=metrics[key][5];
  if(field) return data.get(index,field);
  if(key==='SPEED')return speed(data,index);
  if(key==='LAP_NUMBER'||key==='SECTOR_DELTA') {
    const lap=context.laps?.find(l=>!l.hidden && index>=l.startSampleIndex && index<=(l.endSampleIndex??data.count-1));
    if(!lap)return null;
    if(key==='LAP_NUMBER')return lap.lapNumber;
    if(lap.outLap||lap.incomplete||!sectorTimes(lap).length || !Number.isFinite(lap.startNanos)) return null;
    const reference=(context.laps??[]).filter(l=>!l.hidden&&!l.outLap&&!l.incomplete&&l.direction===lap.direction&&l.durationMs>0&&sectorTimes(l).length)
      .reduce((best,l)=>!best||l.durationMs<best.durationMs?l:best,null);
    if(!reference)return null;
    const progress=clamp((index-lap.startSampleIndex)/Math.max(1,(lap.endSampleIndex??data.count-1)-lap.startSampleIndex),0,1);
    return (Math.max(0,(data.get(index,'elapsed_ns')-lap.startNanos)/1e6)-reference.durationMs*progress)/1000;
  }
  const gx=data.get(index,'gx'), gy=data.get(index,'gy'), gz=data.get(index,'gz');
  if(key==='GFORCE_XY')return gx==null||gy==null?null:Math.hypot(gx,gy);
  if(key==='ACCEL')return gx!=null||gy!=null?Math.hypot(gx??0,gy??0):gz==null?null:Math.abs(gz);
  if(key==='PITCH')return gx!=null&&gy!=null&&gz!=null?Math.atan2(-gx,Math.hypot(gy,gz))*180/Math.PI:data.get(index,'pitch_deg');
  if(key==='LEAN')return gx!=null&&gy!=null&&gz!=null?Math.atan2(gy,gz)*180/Math.PI:null;
  return null;
}
function valueText(key,v) {
  if(!Number.isFinite(v)) return '—';
  if(key==='SECTOR_DELTA')return (v>0?'+':'')+v.toFixed(2);
  if(key.startsWith('ACCEL')||key==='GFORCE_XY')return v.toFixed(2);
  return v.toFixed(['VOLTAGE','PITCH','LEAN'].includes(key)?1:0);
}
const heat=t=>'hsl('+Math.round((1-t)*115)+' 82% 58%)';
function color(w){
  if(w.colorArgb==null)return metrics[w.metric][4];
  const n=w.colorArgb>>>0;return 'rgba('+[(n>>>16)&255,(n>>>8)&255,n&255,(n>>>24)/255].join(',')+')';
}
function text(c,str,x,y,size,fill='#fff',bold=false) {
  c.fillStyle=fill;c.font=(bold?'bold ':'')+size+'px system-ui, sans-serif';
  c.textAlign='center';c.textBaseline='alphabetic';c.shadowColor='#101714';c.shadowBlur=2;
  c.fillText(str,x,y);c.shadowBlur=0;
}
function segmentNumber(c,str,color) {
  const segments=['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
  const lines={a:[3,-20,17,-20],b:[19,-18,19,-2],c:[19,2,19,18],d:[17,20,3,20],
    e:[1,18,1,2],f:[1,-2,1,-18],g:[3,0,17,0]};
  c.strokeStyle=color;c.fillStyle=color;c.lineWidth=3;c.lineCap='round';
  let x=-str.length*13;
  for(const digit of str) {
    if(digit==='.')c.fillRect(x+6,17,4,4);
    else{
      const lit=segments[Number(digit)]??'g';
      c.beginPath();
      for(const s of lit){const [a,b,d,e]=lines[s];c.moveTo(x+a,b);c.lineTo(x+d,e);}
      if(digit==='+'){c.moveTo(x+10,-8);c.lineTo(x+10,8);}
      c.stroke();
    }
    x+=26;
  }
}
function routeMap(data) {
  const points=[];
  const stride=Math.max(1,Math.ceil(data.count/1200));
  for(let i=0;i<data.count;i+=stride){const p=coordinate(data,i);if(p)points.push(p);}
  if(!points.length)return null;
  const lon0=points[0][1],lon=lng=>((lng-lon0+540)%360)-180;
  const lats=points.map(p=>p[0]), lons=points.map(p=>lon(p[1]));
  const lo=Math.min(...lats), hi=Math.max(...lats),west=Math.min(...lons),east=Math.max(...lons);
  const aspect=Math.max(.001,Math.cos((lo+hi)*Math.PI/360));
  const scale=Math.min(186/Math.max(.000001,(east-west)*aspect),126/Math.max(.000001,hi-lo));
  const point=p=>[(lon(p[1])-(west+east)/2)*aspect*scale,((lo+hi)/2-p[0])*scale];
  const path=new Path2D();
  points.forEach((p,i)=>{const [x,y]=point(p);if(i===0)path.moveTo(x,y);else path.lineTo(x,y);});
  return {path,point};
}

export function createPainter(context) {
  let map;
  return (c,width,height,layout,timeMs)=>{
    if(!context.times.length || timeMs<0 || timeMs>context.times.at(-1)) return '';
    const i=sampleAt(context.times,timeMs), readouts=[];
    const ordered=[...layout.widgets].sort((a,b)=>Number(b.style==='GRADIENT_FULL')-Number(a.style==='GRADIENT_FULL'));
    for(const w of ordered){
      const [name,unit,low,high]=metrics[w.metric],v=metricValue(context,i,w.metric);
      const label=valueText(w.metric,v), accented=color(w),unitText=label+(unit?' '+unit:'');
      const min=w.rangeMin??low, max=w.rangeMax??high;
      const f=Number.isFinite(v)?clamp((v-(max>min?min:low))/(max>min?max-min:high-low),0,1):0;
      if(w.metric!=='MAP_INSET')readouts.push(name+' '+unitText);
      c.save();c.globalAlpha=clamp(w.opacity,0,1);
      if(w.style==='GRADIENT_FULL'){
        if(Number.isFinite(v)){c.globalAlpha*=.55;c.fillStyle=heat(f);c.fillRect(0,0,width,height);}
        c.restore();continue;
      }
      c.translate(width*clamp(w.xNorm,0,1),height*clamp(w.yNorm,0,1));
      const s=width/1080*w.scale;c.scale(s,s);
      if(w.style==='MAP_INSET'){
        map??=routeMap(context.data);c.fillStyle='rgba(13,28,21,.85)';c.fillRect(-100,-70,200,140);
        if(map){
          c.strokeStyle='#97cbb8';c.lineWidth=3;c.stroke(map.path);
          const pos=coordinate(context.data,i);
          if(pos){const [x,y]=map.point(pos);c.beginPath();c.arc(x,y,5,0,2*Math.PI);c.fillStyle='#c1f04d';c.fill();}
        }
      } else if(w.style==='GFORCE_CROSS'){
        c.fillStyle='rgba(13,28,21,.8)';c.beginPath();c.arc(0,0,65,0,2*Math.PI);c.fill();
        c.strokeStyle='#a0b5a7';c.lineWidth=1;c.beginPath();c.moveTo(-65,0);c.lineTo(65,0);c.moveTo(0,-65);c.lineTo(0,65);c.stroke();
        const gx=context.data.get(i,'gx'),gy=context.data.get(i,'gy');
        if(gx!=null&&gy!=null){const range=Math.max(Math.abs(min),Math.abs(max),.01);c.fillStyle=accented;c.beginPath();c.arc(60*clamp(gy/range,-1,1),-60*clamp(gx/range,-1,1),6,0,2*Math.PI);c.fill();}
        text(c,unitText,0,84,16);
      } else if(w.style==='SPARKLINE'){
        c.fillStyle='rgba(13,28,21,.8)';c.fillRect(-110,-35,220,70);
        const first=sampleAt(context.times,timeMs-w.sparkWindowSec*1000),points=[];
        const stride=Math.max(1,Math.ceil((i-first+1)/120));
        for(let j=first;j<i;j+=stride)points.push([j,metricValue(context,j,w.metric)]);
        points.push([i,v]);
        const vals=points.map(p=>p[1]).filter(Number.isFinite);
        const lower=Math.min(min,...vals),upper=Math.max(max,...vals);
        c.strokeStyle=accented;c.lineWidth=2.5;c.beginPath();let started=false;
        for(const [j,val] of points){if(!Number.isFinite(val)){started=false;continue;}const x=-102+204*(j-first)/Math.max(1,i-first),y=27-54*(val-lower)/Math.max(.000001,upper-lower);if(started)c.lineTo(x,y);else c.moveTo(x,y);started=true;}
        c.stroke();text(c,name,0,-40,15);
      } else if(w.style.startsWith('BAR_')){
        const vertical=w.style.startsWith('BAR_V'), segmented=w.style.endsWith('SEGMENTS');
        const x=vertical?-14:-100,y=vertical?-90:-11,bw=vertical?28:200,bh=vertical?180:22;
        c.fillStyle='rgba(240,250,241,.4)';c.fillRect(x,y,bw,bh);
        const n=segmented?clamp(w.barSegmentCount,3,30):1, count=segmented?Math.floor(n*f):1;
        for(let j=0;j<count;j++){
          c.fillStyle=heat(segmented?(j+1)/n:f);
          if(vertical)c.fillRect(x,y+bh*(1-(segmented?(j+1)/n:f)),bw,segmented?bh/n-2:bh*f);
          else c.fillRect(x+j*bw/n,y,segmented?bw/n-2:bw*f,bh);
        }
        text(c,name+' '+unitText,0,y+bh+18,16);
      } else if(w.style==='GAUGE_ARC' || w.style==='GAUGE_NEEDLE'){
        const arc=w.style==='GAUGE_ARC';c.lineCap='round';c.beginPath();
        if(arc){
          c.lineWidth=12;c.strokeStyle='rgba(240,250,241,.5)';c.arc(0,31,70,Math.PI,2*Math.PI);c.stroke();
          if(f){c.beginPath();c.strokeStyle=heat(f);c.arc(0,31,70,Math.PI,Math.PI*(1+f));c.stroke();}
        } else {
          c.fillStyle='rgba(20,24,28,.72)';c.arc(0,0,77,0,Math.PI*2);c.fill();
          c.lineWidth=2;c.strokeStyle='#aaa';c.stroke();
          for(let j=0;j<=10;j++){const a=(-135+27*j)*Math.PI/180;c.beginPath();c.moveTo(61*Math.cos(a),61*Math.sin(a));c.lineTo(71*Math.cos(a),71*Math.sin(a));c.stroke();}
          const a=(-135+270*f)*Math.PI/180;c.strokeStyle=accented;c.lineWidth=5;c.beginPath();c.moveTo(0,0);c.lineTo(56*Math.cos(a),56*Math.sin(a));c.stroke();
        }
        text(c,label,0,arc?8:44,arc?36:28,'#fff',true);text(c,name+' '+unit,0,arc?30:98,16);
      } else if(w.style==='NUMBER_SEGMENT'){
        segmentNumber(c,label,accented);text(c,name+' '+unit,0,-30,17);
      } else {
        const slim=w.style==='NUMBER_SLIM';text(c,name.toUpperCase(),0,slim?-28:-32,slim?16:18,'#e6e9e6');
        text(c,unitText,0,slim?18:20,slim?40:48,accented,!slim);
      }
      c.restore();
    }
    return readouts.join(' · ');
  };
}
