import {gatesOf} from './track-gates.js';

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

// The interchange stores gate geometry and track bounds, while the route stays in the recording.
export function trackFromRoute(points, {name = 'New track', mode = 'CIRCUIT', sectorCount = 3} = {}) {
  const path = points.filter(p => p && validPosition(p.lat, p.lon));
  if (path.length < 10) throw Error('A track needs at least ten GPS positions.');
  if (!Number.isInteger(sectorCount) || sectorCount < 1 || sectorCount > 100) throw Error('Use 1 to 100 sectors.');
  if (!['CIRCUIT','POINT_TO_POINT'].includes(mode)) throw Error('Choose a valid track type.');
  const first = path[0];
  const lengths = [0];
  let departed = false;
  for (let i=1; i<path.length; i++) {
    lengths.push(lengths[i-1] + leg(path[i-1], path[i]).distance);
    const fromStart = leg(first, path[i]).distance;
    if (mode === 'CIRCUIT' && departed && fromStart < 12) break;
    if (fromStart > 40) departed = true;
  }
  const last = lengths.length - 1;
  const distance = lengths[last];
  if (distance < 50) throw Error('A track needs at least 50 m of GPS data.');
  let cursor = 1;
  function atMeters(meters) {
    while (cursor < last && (lengths[cursor] < meters || lengths[cursor] === lengths[cursor-1])) cursor++;
    const a = path[cursor-1], b = path[cursor], section = leg(a,b);
    const t = section.distance > 0 ? (meters-lengths[cursor-1])/section.distance : 0;
    return {lat: a.lat + (b.lat-a.lat)*t, lon: ((a.lon + section.lonDelta*t + 540) % 360) - 180,
      bearing: section.bearing};
  }
  const doc = emptyTrack();
  doc.mode = mode;
  doc.name = name;
  for (let i=0;i<sectorCount;i++) {
    const p = atMeters(distance * i / sectorCount);
    doc.sectors.push({index:i, name:'S'+(i+1), entryLat:p.lat, entryLon:p.lon, bearingDeg:p.bearing, halfWidthM:15});
  }
  doc.startFinishLat = first.lat; doc.startFinishLon = first.lon;
  doc.startFinishBearingDeg = doc.sectors[0].bearingDeg;
  if (mode === 'POINT_TO_POINT') {
    const finish = atMeters(distance);
    doc.finishLat = path[last].lat; doc.finishLon = path[last].lon;
    doc.finishBearingDeg = finish.bearing; doc.finishHalfWidthM = 15;
  }
  doc.minLat = doc.maxLat = first.lat;
  doc.minLon = doc.maxLon = first.lon;
  for (let i=1; i<=last; i++) {
    const p = path[i];
    doc.minLat = Math.min(doc.minLat,p.lat); doc.maxLat = Math.max(doc.maxLat,p.lat);
    doc.minLon = Math.min(doc.minLon,p.lon); doc.maxLon = Math.max(doc.maxLon,p.lon);
  }
  return exportDoc(doc);
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
        !validPosition(s.entryLat,s.entryLon) || (s.bearingDeg != null && !Number.isFinite(s.bearingDeg)) ||
        !Number.isFinite(s.halfWidthM ?? 15) || (s.halfWidthM ?? 15) <= 0)
      throw Error('Each sector needs a valid position, name, width and unique index.');
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

function exportDoc(doc) {
  const copy = structuredClone(doc);
  copy.format = FORMAT;
  copy.version = 1;
  copy.name = copy.name.trim();
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
        putGate(doc,selected,{[key]:v});draw();
      },attrs);
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
        bearingDeg:doc.startFinishBearingDeg,halfWidthM:doc.gateHalfWidthM ?? 15});
      const highest=doc.sectors.reduce((last,s)=>Math.max(last,s.index),0);
      const index=highest+1;
      doc.sectors.push({index,name:'S'+(index+1),entryLat:null,entryLon:null,bearingDeg:g.bearing ?? 0,halfWidthM:15});
      selected='sector-'+index;placing=true;redrawEditor();
      say('Set the sector coordinates or place it on the map.');
    }));
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
        putGate(doc,selected,{lat:Number(position.lat.toFixed(7)),lon:Number(position.lng.toFixed(7))});
        placing=false;redrawEditor();say('Gate position updated.');
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
