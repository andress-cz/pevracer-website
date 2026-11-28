import {gatesOf,halfWidth} from './track-gates.js';

// Version 1 matches TrackCodec and the gate ordering used by the Android lap analyzer.
const FORMAT = 'pevracer-track';
const M_PER_DEG = 111195;
const RAD = Math.PI / 180;

export function emptyTrack() {
  return {
    format: FORMAT, version: 1, id: crypto.randomUUID(), name: '', mode: 'CIRCUIT',
    startFinishLat: null, startFinishLon: null, startFinishBearingDeg: 0,
    finishLat: null, finishLon: null, finishBearingDeg: null, finishHalfWidthM: null,
    gateHalfWidthM: 15, minLat: null, minLon: null, maxLat: null, maxLon: null,
    createdAtEpochMs: Date.now(), sectors: [],
  };
}

function finiteRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validPosition(lat, lon) {
  return finiteRange(lat, -90, 90) && finiteRange(lon, -180, 180);
}

function leg(from, to) {
  const lonDelta = ((to.lon - from.lon + 540) % 360) - 180;
  const east = lonDelta * Math.cos((from.lat + to.lat) * RAD / 2);
  const north = to.lat - from.lat;
  return { distance: Math.hypot(east, north) * M_PER_DEG,
    bearing: (Math.atan2(east, north) / RAD + 360) % 360, lonDelta };
}

// Nearest point of a recorded route: its travel bearing and distance (m), or null.
function nearestOnRoute(route, lat, lon) {
  let best=null;
  for (let i=1;i<route.length;i++) {
    const a=route[i-1], b=route[i];
    if (!validPosition(a?.lat,a?.lon) || !validPosition(b?.lat,b?.lon)) continue;
    const ab=leg(a,b), ap=leg(a,{lat,lon});
    if (!(ab.distance>0)) continue;
    const along=Math.max(0,Math.min(ab.distance, ap.distance*Math.cos((ap.bearing-ab.bearing)*RAD)));
    const across=Math.sqrt(Math.max(0, ap.distance**2 + along**2 - 2*ap.distance*along*Math.cos((ap.bearing-ab.bearing)*RAD)));
    if (!best || across<best.distance) best={distance:across, bearing:ab.bearing};
  }
  return best;
}

const angleBetween=(a,b)=>Math.abs((((a-b)%360)+540)%360-180);

/**
 * Like Android: a gate placed on the route takes the route's travel direction there. The route
 * may have been ridden the other way round than the track, so the direction is turned to agree
 * with the start gate. Laps ridden the opposite way still time (all gates reverse together).
 * Returns null away from the route, where the gate keeps its bearing.
 */
export function routeGateBearing(route, doc, lat, lon) {
  if (!Array.isArray(route) || route.length<2) return null;
  const here=nearestOnRoute(route,lat,lon);
  if (!here || here.distance>50) return null;
  let bearing=here.bearing;
  if (validPosition(doc.startFinishLat,doc.startFinishLon) && Number.isFinite(doc.startFinishBearingDeg)) {
    const atStart=nearestOnRoute(route,doc.startFinishLat,doc.startFinishLon);
    if (atStart && atStart.distance<=30 && angleBetween(atStart.bearing,doc.startFinishBearingDeg)>90) bearing=(bearing+180)%360;
  }
  return Number(bearing.toFixed(1));
}

// Same constants and steps as Android's TrackBuilder, so both build the same gates from a ride.
const DEPART_M=40, RETURN_M=12, REVISIT_M=25, NEAR_START_M=30, MIN_TRACK_M=50, MAX_SECTORS=100;
const MAX_CANDIDATES=400, MIN_CANDIDATE_STEP_M=5, TURN_WINDOW_M=25, NEIGHBOUR_M=25, SAME_STRETCH_M=60, MIN_SECTOR_M=30;

// The route from index `from`: a circuit lap ends when it comes back within 12 m of where it
// started, after leaving by 40 m; otherwise it runs to index `to`.
function lapFrom(path, from, circuit, to=path.length-1) {
  const first=path[from];
  let departed=false;
  for (let i=from+1;i<=to;i++) {
    const d=leg(first,path[i]).distance;
    if (circuit && departed && d<RETURN_M) return {points:path.slice(from,i+1), closed:true};
    if (d>DEPART_M) departed=true;
  }
  return {points:path.slice(from,to+1), closed:false};
}

// The spot the route passes most often: where a lap most likely starts.
function busiestIndex(path) {
  const step=Math.max(1,Math.floor(path.length/80));
  let best=0, bestScore=-1;
  for (let i=0;i<path.length;i+=step) {
    let score=0;
    for (let j=i+20;j<path.length;j+=step) if (leg(path[i],path[j]).distance<REVISIT_M) score++;
    if (score>bestScore) {bestScore=score;best=i;}
  }
  return best;
}

// The first pass by the start gate (from which a circuit lap closes), or -1.
function lapStart(path, start, circuit) {
  const d=path.map(p=>leg(start,p).distance);
  let nearest=-1, nearestD=Infinity;
  for (let i=0;i<path.length;i++) {
    if (d[i]<nearestD) {nearestD=d[i];nearest=i;}
    const closest=d[i]<=NEAR_START_M && (i===0 || d[i-1]>d[i]) && (i===path.length-1 || d[i+1]>=d[i]);
    if (closest && (!circuit || lapFrom(path,i,true).closed)) return i;
  }
  return nearestD<=NEAR_START_M ? nearest : -1;
}

function nearestIndex(path, target, from=0) {
  let best=Math.min(from,path.length-1), bestD=Infinity;
  for (let i=from;i<path.length;i++) {
    const d=leg(target,path[i]).distance;
    if (d<bestD) {bestD=d;best=i;}
  }
  return best;
}

// Positions by distance along a path, with the travel bearing there.
function along(path) {
  const lengths=[0];
  for (let i=1;i<path.length;i++) lengths.push(lengths[i-1]+leg(path[i-1],path[i]).distance);
  const last=path.length-1;
  return {distance:lengths[last], at(meters) {
    let i=1;
    while (i<last && (lengths[i]<meters || lengths[i]===lengths[i-1])) i++;
    const a=path[i-1], b=path[i], section=leg(a,b);
    const t=section.distance>0 ? Math.max(0,Math.min(1,(meters-lengths[i-1])/section.distance)) : 0;
    return {lat:a.lat+(b.lat-a.lat)*t, lon:((a.lon+section.lonDelta*t+540)%360)-180, bearing:section.bearing};
  }};
}

/**
 * Where sectors 2..n start, in metres along the lap. Lines go where a rider crosses them
 * cleanly: on straight stretches rather than in corners, and away from other parts of the lap
 * that pass close by (they would trigger the gate too). Sectors stay roughly equal in length;
 * a line moves off the even split only to find a better spot. Each candidate line costs its
 * turning (degrees over ±25 m) plus a penalty near other parts of the lap, each sector its
 * squared deviation from an equal share, and dynamic programming picks the cheapest set. With
 * no set that fits, the sectors are spaced evenly. Same as Android's TrackBuilder.sectorBreaks.
 */
function sectorBreaks(route, sectorCount, circuit) {
  if (sectorCount<2) return [];
  const total=route.distance;
  const even=[];for (let i=1;i<sectorCount;i++) even.push(total*i/sectorCount);
  const step=Math.max(MIN_CANDIDATE_STEP_M,total/MAX_CANDIDATES);
  const count=Math.trunc(total/step);
  if (count<2) return even;
  const dist=[], points=[];
  for (let k=0;k<=count;k++) {dist.push(k*step);points.push(route.at(k*step));}
  const cost=dist.map((d,k)=>{
    const back=route.at(Math.max(0,d-TURN_WINDOW_M)), ahead=route.at(Math.min(total,d+TURN_WINDOW_M));
    const turn=angleBetween(leg(back,points[k]).bearing,leg(points[k],ahead).bearing);
    let crowded=false;
    for (let j=0;j<=count;j++) {
      let apart=Math.abs(dist[j]-d);
      if (circuit) apart=Math.min(apart,total-apart);
      if (apart>SAME_STRETCH_M && leg(points[k],points[j]).distance<NEIGHBOUR_M) {crowded=true;break;}
    }
    return Math.min(turn,90)/30+(crowded?3:0);
  });
  const ideal=total/sectorCount, minLength=Math.max(0.35*ideal,MIN_SECTOR_M), maxLength=1.9*ideal;
  const lengthCost=length=>{
    if (length<minLength || length>maxLength) return Infinity;
    const off=(length-ideal)/ideal;
    return 4*off*off;
  };
  const lines=sectorCount-1;
  const best=Array.from({length:lines},()=>new Array(count+1).fill(Infinity));
  const from=Array.from({length:lines},()=>new Array(count+1).fill(-1));
  for (let k=1;k<count;k++) best[0][k]=lengthCost(dist[k])+cost[k];
  for (let m=1;m<lines;m++) for (let k=1;k<count;k++) for (let i=1;i<k;i++) {
    const prev=best[m-1][i];
    if (prev===Infinity) continue;
    const c=prev+lengthCost(dist[k]-dist[i])+cost[k];
    if (c<best[m][k]) {best[m][k]=c;from[m][k]=i;}
  }
  let end=-1, endCost=Infinity;
  for (let k=1;k<count;k++) {
    const c=best[lines-1][k]+lengthCost(total-dist[k]);
    if (c<endCost) {endCost=c;end=k;}
  }
  if (end<0) return even;
  const picked=[];
  for (let m=lines-1,k=end;m>=0;m--) {picked.push(dist[k]);k=from[m][k];}
  return picked.reverse();
}

function checkSectorCount(sectorCount) {
  if (!Number.isInteger(sectorCount) || sectorCount<1 || sectorCount>MAX_SECTORS) throw Error('Use 1 to 100 sectors.');
}

/**
 * A circuit starts where the route first closes a lap (or, if it never comes back to its first
 * point, at its most revisited spot) and gets `sectorCount` sectors along that one lap, divided
 * as sectorBreaks describes. Point to point runs from the first to the last position. The interchange stores gate
 * geometry and track bounds, while the route stays in the recording.
 */
export function trackFromRoute(points, {name = 'New track', mode = 'CIRCUIT', sectorCount = 3} = {}) {
  const path = points.filter(p => p && validPosition(p.lat, p.lon));
  if (path.length < 10) throw Error('A track needs at least ten GPS positions.');
  checkSectorCount(sectorCount);
  if (!['CIRCUIT','POINT_TO_POINT'].includes(mode)) throw Error('Choose a valid track type.');
  const circuit = mode === 'CIRCUIT';
  const from = circuit && !lapFrom(path,0,true).closed ? busiestIndex(path) : 0;
  const lap = lapFrom(path,from,circuit).points;
  const route = along(lap);
  if (route.distance < MIN_TRACK_M) throw Error('A track needs at least 50 m of GPS data.');
  const doc = emptyTrack();
  doc.mode = mode;
  doc.name = name;
  for (const [i,meters] of [0,...sectorBreaks(route,sectorCount,circuit)].entries()) {
    const p = route.at(meters);
    doc.sectors.push({index:i, name:'S'+(i+1), entryLat:p.lat, entryLon:p.lon, bearingDeg:p.bearing, halfWidthM:15});
  }
  const first = lap[0], last = lap[lap.length-1];
  doc.startFinishLat = first.lat; doc.startFinishLon = first.lon;
  doc.startFinishBearingDeg = doc.sectors[0].bearingDeg;
  if (!circuit) {
    doc.finishLat = last.lat; doc.finishLon = last.lon;
    doc.finishBearingDeg = route.at(route.distance).bearing; doc.finishHalfWidthM = 15;
  }
  doc.minLat = doc.maxLat = first.lat;
  doc.minLon = doc.maxLon = first.lon;
  for (const p of lap) {
    doc.minLat = Math.min(doc.minLat,p.lat); doc.maxLat = Math.max(doc.maxLat,p.lat);
    doc.minLon = Math.min(doc.minLon,p.lon); doc.maxLon = Math.max(doc.maxLon,p.lon);
  }
  return exportDoc(doc);
}

/**
 * New sector list for `doc`: `sectorCount` sectors (divided as sectorBreaks describes) along
 * one lap that starts at the start gate (point to point: one run from the start to the finish gate). Bearings follow
 * the start gate's direction even when the route was ridden the other way. Like Android's
 * TrackBuilder.suggestSectors.
 */
export function suggestSectors(route, doc, sectorCount) {
  checkSectorCount(sectorCount);
  const path=(route ?? []).filter(p => p && validPosition(p.lat, p.lon));
  if (!validPosition(doc.startFinishLat,doc.startFinishLon)) throw Error('Place the start gate first.');
  const circuit=doc.mode==='CIRCUIT';
  if (!circuit && !validPosition(doc.finishLat,doc.finishLon)) throw Error('Place the finish gate first.');
  const missing=circuit ? 'The recorded route needs one full lap through the start gate.'
    : 'The recorded route needs one run from the start to the finish gate.';
  const from=path.length<2 ? -1 : lapStart(path,{lat:doc.startFinishLat,lon:doc.startFinishLon},circuit);
  if (from<0) throw Error(missing);
  const to=circuit ? path.length-1 : nearestIndex(path,{lat:doc.finishLat,lon:doc.finishLon},from+1);
  if (to<=from) throw Error(missing);
  const lap=lapFrom(path,from,circuit,to);
  if (circuit && !lap.closed) throw Error(missing);
  const route2=along(lap.points);
  if (route2.distance<MIN_TRACK_M) throw Error(missing);
  const flip=angleBetween(route2.at(0).bearing, doc.startFinishBearingDeg ?? 0)>90;
  const width=halfWidth(doc.gateHalfWidthM);
  const first=doc.sectors?.find(s=>s.index===0);
  const sectors=[{index:0, name:first?.name || 'S1', entryLat:doc.startFinishLat, entryLon:doc.startFinishLon,
    bearingDeg:doc.startFinishBearingDeg, halfWidthM:width}];
  for (const [n,meters] of sectorBreaks(route2,sectorCount,circuit).entries()) {
    const i=n+1, p=route2.at(meters);
    const bearing=flip ? (p.bearing+180)%360 : p.bearing;
    sectors.push({index:i, name:'S'+(i+1), entryLat:p.lat, entryLon:p.lon, bearingDeg:Number(bearing.toFixed(1)), halfWidthM:width});
  }
  return sectors;
}

function validateDoc(doc) {
  if (!doc || !/^(pev|euc)racer-track$/.test(doc.format ?? FORMAT) || (doc.version ?? 1) !== 1)
    throw Error('Choose a version 1 PEV Racer track file.');
  if (typeof doc.name !== 'string' || !doc.name.trim()) throw Error('Enter a track name.');
  if (typeof doc.id !== 'string' || !doc.id || !Number.isSafeInteger(doc.createdAtEpochMs) ||
      !['CIRCUIT', 'POINT_TO_POINT'].includes(doc.mode)) throw Error('The track header is incomplete.');
  const sectors = doc.sectors ?? [];
  if (!Array.isArray(sectors)) throw Error('The sector list is invalid.');
  const seen = new Set();
  for (const s of sectors) {
    if (!s || !Number.isSafeInteger(s.index) || s.index < 0 || seen.has(s.index) || typeof s.name !== 'string' ||
        !validPosition(s.entryLat,s.entryLon) || (s.bearingDeg != null && !Number.isFinite(s.bearingDeg)))
      throw Error('Each sector needs a valid position, name and unique index.');
    seen.add(s.index);
  }
  for (const gate of gatesOf(doc)) {
    if (!validPosition(gate.lat, gate.lon)) throw Error('Enter valid latitude and longitude for ' + gate.name + '.');
    if (!Number.isFinite(gate.bearing) || !Number.isFinite(gate.width) || gate.width <= 0)
      throw Error('Enter a bearing and positive half-width for ' + gate.name + '.');
  }
  if (!validPosition(doc.minLat, doc.minLon) || !validPosition(doc.maxLat, doc.maxLon) ||
      doc.minLat > doc.maxLat || doc.minLon > doc.maxLon) throw Error('The track bounds are invalid.');
}

export function exportDoc(doc) {
  const copy = structuredClone(doc);
  copy.format = FORMAT;
  copy.version = 1;
  copy.name = copy.name.trim();
  // Android stores widths as numbers. Never save a cleared or invalid width as null.
  copy.gateHalfWidthM = halfWidth(copy.gateHalfWidthM);
  for (const s of copy.sectors ?? []) if (s) s.halfWidthM = halfWidth(s.halfWidthM, s.index === 0 ? copy.gateHalfWidthM : undefined);
  if (copy.mode === 'POINT_TO_POINT') copy.finishHalfWidthM = halfWidth(copy.finishHalfWidthM, copy.gateHalfWidthM);
  const gates = gatesOf(copy);
  if (gates.every(g => validPosition(g.lat,g.lon))) {
    const lats = gates.map(g => g.lat), lons = gates.map(g => g.lon);
    // Retain the native track bounds, which may include a route between distant gates.
    copy.minLat = lats.reduce((v,x) => Math.min(v,x), copy.minLat ?? Infinity);
    copy.minLon = lons.reduce((v,x) => Math.min(v,x), copy.minLon ?? Infinity);
    copy.maxLat = lats.reduce((v,x) => Math.max(v,x), copy.maxLat ?? -Infinity);
    copy.maxLon = lons.reduce((v,x) => Math.max(v,x), copy.maxLon ?? -Infinity);
  }
  validateDoc(copy);
  return copy;
}

function putGate(doc, key, updates) {
  if (key.startsWith('sector-')) {
    const s = doc.sectors.find(s => key === 'sector-' + s.index);
    const fields = {name:'name', lat:'entryLat', lon:'entryLon', bearing:'bearingDeg', width:'halfWidthM'};
    for (const [k,v] of Object.entries(updates)) s[fields[k]] = v;
  } else {
    const fields = key === 'finish'
      ? {lat:'finishLat', lon:'finishLon', bearing:'finishBearingDeg', width:'finishHalfWidthM'}
      : {lat:'startFinishLat', lon:'startFinishLon', bearing:'startFinishBearingDeg', width:'gateHalfWidthM'};
    for (const [k,v] of Object.entries(updates)) doc[fields[k]] = v;
    if (key === 'start') {
      const first = doc.sectors.find(s => s.index === 0);
      if (first) {
        const fields = {lat:'entryLat', lon:'entryLon', bearing:'bearingDeg', width:'halfWidthM'};
        for (const [k,v] of Object.entries(updates)) first[fields[k]] = v;
      }
    }
  }
}

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function btn(text, fn) {
  const el = node('button',text); el.type = 'button'; el.addEventListener('click',fn); return el;
}
function labeled(text, field) {
  const label = node('label',undefined,'tg-field'); label.append(node('span',text),field); return label;
}
function textField(value, onInput, options = {}) {
  const input = node('input');
  Object.assign(input,options);
  input.value = value ?? '';
  input.addEventListener('input', () => onInput(input.type === 'number' ? (input.value === '' ? null : input.valueAsNumber) : input.value));
  return input;
}
function option(value, label) {
  const el = node('option', label); el.value = value; return el;
}

function download(doc) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)], {type:'application/json'}));
  const a=node('a'); a.href=url; a.download=(doc.name.replace(/[^a-z\d_-]+/gi,'_').slice(0,80) || 'track') + '.pevtrack';
  a.click();setTimeout(() => URL.revokeObjectURL(url),1000);
}

export function mountTrack(container, {doc:initial, onSave, route=[]} = {}) {
  if (!document.querySelector('link[data-pev-track]')) {
    const css = node('link');css.rel='stylesheet';css.href=new URL('track-editor.css',import.meta.url).href;
    css.dataset.pevTrack='';document.head.append(css);
  }
  const editable = typeof onSave === 'function';
  let doc = structuredClone(initial ?? emptyTrack());
  doc.sectors ??= [];
  const root=node('section',undefined,'tg'), status=node('p',undefined,'tg-status');
  status.setAttribute('role','status');
  const map=node('div',undefined,'tg-map');map.setAttribute('role','region');map.setAttribute('aria-label','Timing gates on the satellite map');
  const form=node('form'); const panel=node('div',undefined,'tg-panel'), summary=node('div',undefined,'tg-summary');
  root.append(map,form,status);container.replaceChildren(root);
  let selected='start', placing=false, mapView=null, disposed=false, refit=true;
  const draw=() => {
    if (!mapView) return;
    mapView.draw(doc,selected,placing,refit);
    refit=false;
  };
  const say=message => { status.textContent=message; };
  function summaryView() {
    const gates=gatesOf(doc), list=node('dl');
    for (const g of gates) {
      list.append(node('dt',g.name),node('dd',validPosition(g.lat,g.lon) ?
        g.lat.toFixed(6)+', '+g.lon.toFixed(6)+' · '+g.bearing+'° · ±'+g.width+' m' : 'Coordinates needed'));
    }
    summary.replaceChildren(node('strong',doc.mode === 'CIRCUIT' ? 'Circuit' : 'Point to point'),list);
  }
  function check(action) {
    try {
      if (!form.reportValidity()) return;
      action(exportDoc(doc));
    } catch(error) {say(error.message);}
  }
  function redrawEditor() {
    form.replaceChildren();
    const gates=gatesOf(doc);
    const g=gates.find(item=>item.key===selected) || gates[0];selected=g.key;
    if (!editable) {
      summaryView();form.append(summary,btn('Download track file',()=>check(download)));draw();return;
    }
    const top=node('div',undefined,'tg-fields');
    const mode=node('select');mode.append(option('CIRCUIT','Circuit'),option('POINT_TO_POINT','Point to point'));mode.value=doc.mode;
    mode.onchange=() => {
      doc.mode=mode.value;placing=false;
      if (doc.mode==='CIRCUIT') {doc.finishLat=null;doc.finishLon=null;doc.finishBearingDeg=null;doc.finishHalfWidthM=null;}
      redrawEditor();
    };
    top.append(labeled('Track name',textField(doc.name,v=>{doc.name=v;},{required:true})),labeled('Track type',mode));
    const select=node('select');
    for(const item of gates) select.append(option(item.key,item.name || 'Sector'));
    select.value=selected;select.onchange=()=>{
      selected=select.value;placing=false;redrawEditor();
      const target=gatesOf(doc).find(item=>item.key===selected);
      if(target)mapView?.reveal(target.lat,target.lon);
    };
    const fields=node('div',undefined,'tg-fields');
    if (selected.startsWith('sector-')) fields.append(labeled('Sector name',textField(g.name,value=>{
      putGate(doc,selected,{name:value});select.selectedOptions[0].textContent=value || 'Sector';draw();
    },{required:true})));
    for(const [key,label,min,max] of [
      ['lat','Latitude',-90,90],['lon','Longitude',-180,180],['bearing','Travel bearing (°)',null,null],
      ['width','Gate half-width (m)',0.000001,null],
    ]) {
      const attrs={type:'number',step:'any',required:true};
      if(min!=null) attrs.min=min;if(max!=null) attrs.max=max;
      const input=textField(g[key],v=>{
        // A cleared or non-positive width keeps the previous one instead of saving null.
        if(key==='width' && !(Number.isFinite(v) && v>0))return;
        putGate(doc,selected,{[key]:v});draw();
      },attrs);
      if(key==='width')input.addEventListener('change',()=>{
        if(!(input.valueAsNumber>0))input.value=String(gatesOf(doc).find(item=>item.key===selected)?.width ?? 15);
      });
      if(key==='lat'||key==='lon')input.addEventListener('change',()=>{
        const target=gatesOf(doc).find(item=>item.key===selected);
        if(target)mapView?.reveal(target.lat,target.lon);
      });
      fields.append(labeled(label,input));
    }
    const gateTools=node('div',undefined,'tg-actions');
    const place=btn(placing?'Cancel placement':'Place gate on map',()=>{
      placing=!placing;redrawEditor();say(placing?'Click or tap a position on the map.':'');
    });
    place.setAttribute('aria-pressed',String(placing));
    gateTools.append(place,btn('Add sector gate',()=>{
      if (!doc.sectors.some(s=>s.index===0)) doc.sectors.unshift({index:0,name:'S1',entryLat:doc.startFinishLat,entryLon:doc.startFinishLon,
        bearingDeg:doc.startFinishBearingDeg,halfWidthM:halfWidth(doc.gateHalfWidthM)});
      const highest=doc.sectors.reduce((last,s)=>Math.max(last,s.index),0);
      const index=highest+1;
      doc.sectors.push({index,name:'S'+(index+1),entryLat:null,entryLon:null,bearingDeg:g.bearing ?? 0,halfWidthM:halfWidth(doc.gateHalfWidthM)});
      selected='sector-'+index;placing=true;redrawEditor();
      say('Set the sector coordinates or place it on the map.');
    }));
    if (route.length>=10) {
      const count=textField(doc.sectors.length || 3,()=>{},{type:'number',min:1,max:100,step:1});
      const countLabel=node('label',undefined,'tg-inline');countLabel.append(node('span','Sectors'),count);
      gateTools.append(countLabel,btn('Suggest sectors',()=>{
        try {
          doc.sectors=suggestSectors(route,doc,count.valueAsNumber);
          selected='start';placing=false;redrawEditor();
          say(doc.sectors.length+' sectors along one lap, with lines on straights where possible. Check them on the map, then save.');
        } catch(error) {say(error.message);}
      }));
    }
    if (selected.startsWith('sector-')) {
      const index=Number(selected.slice(7));
      const ordered=doc.sectors.filter(s=>s.index>0).sort((a,b)=>a.index-b.index);
      const pos=ordered.findIndex(s=>s.index===index);
      for(const [label,delta] of [['Move earlier',-1],['Move later',1]]) {
        const target=ordered[pos+delta], move=btn(label,()=>{
          ordered[pos].index=target.index;target.index=index;selected='sector-'+ordered[pos].index;
          redrawEditor();
        });
        move.disabled=!target;gateTools.append(move);
      }
      gateTools.append(btn('Remove sector gate',()=>{
        doc.sectors=doc.sectors.filter(s=>s.index!==index).sort((a,b)=>a.index-b.index);
        for(const s of doc.sectors) if(s.index>index) s.index--;
        selected='start';placing=false;redrawEditor();
      }));
    }
    map.classList.toggle('tg-placing',placing);
    panel.replaceChildren(labeled('Timing gate',select),fields,gateTools);
    const io=node('div',undefined,'tg-actions');
    const save=node('button','Save track','tg-save');save.type='submit';
    const file=node('input');file.type='file';file.accept='.pevtrack,.euctrack,.json';file.hidden=true;
    file.onchange=async()=>{
      const f=file.files[0];if(!f)return;
      try {
        if (f.size>2*1024*1024) throw Error('Track files must be under 2 MB.');
        const imported=JSON.parse((await f.text()).replace(/^\uFEFF/,''));
        validateDoc(imported);
        const current=doc;doc={...imported,id:current.id,createdAtEpochMs:current.createdAtEpochMs,format:FORMAT,sectors:imported.sectors ?? []};
        selected='start';placing=false;refit=true;redrawEditor();say('Imported into the editor. Save to keep this track.');
      } catch(error) {say(error instanceof SyntaxError?'The file does not contain valid track JSON.':error.message);}
      file.value='';
    };
    io.append(save,btn('Import track file',()=>file.click()),btn('Download track file',()=>check(download)),file);
    form.append(top,panel,io);draw();
  }
  form.onsubmit=async e=>{
    e.preventDefault();
    if (!editable || form.inert) return;
    try {
      const result=exportDoc(doc);
      form.inert=true;say('Saving track…');
      await onSave(result);say('Track saved.');
    } catch(error){say(error.message || 'Could not save this track.');}
    finally{form.inert=false;}
  };
  redrawEditor();
  import('./route-map.js').then(({mountGateMap})=>{
    if(disposed || !map.isConnected)return;
    mapView=mountGateMap(map,{route,
      onPlace: editable ? position=>{
        if(!placing || form.inert)return;
        const lat=Number(position.lat.toFixed(7)),lon=Number(position.lng.toFixed(7));
        const bearing=routeGateBearing(route,doc,lat,lon);
        putGate(doc,selected,bearing==null?{lat,lon}:{lat,lon,bearing});
        placing=false;redrawEditor();say(bearing==null?'Gate position updated.':'Gate placed across the route at '+bearing+'°.');
      } : null,
      onSelect: editable ? key=>{
        if(placing || form.inert)return;
        selected=key;redrawEditor();
      } : null
    });
    draw();
  }).catch(()=>{if(!disposed)map.textContent='The satellite map could not be opened.';});
  return () => {disposed=true;mapView?.remove();};
}
