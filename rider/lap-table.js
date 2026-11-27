import {duration, el} from './ui.js';

export function sectorTimes(lap) {
  const value = lap.sectorTimesJson ?? lap.sector_times;
  try {
    const values = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(values) ? values.map(time => Number(time) > 0 ? Number(time) : null) : [];
  } catch { return []; }
}

// LapAnalyzer.idealLap: best known sector times over visible timed laps of one direction,
// using the most common sector count (ties prefer more sectors). One lap is enough.
export function idealLap(laps) {
  const candidates = laps.filter(l => !l.incomplete && !l.outLap && !l.hidden && sectorTimes(l).length);
  if (!candidates.length || new Set(candidates.map(l => l.direction).filter(Boolean)).size > 1) return null;
  const counts = new Map();
  for (const l of candidates) counts.set(sectorTimes(l).length, (counts.get(sectorTimes(l).length) ?? 0) + 1);
  const size = [...counts].reduce((a,b) => b[1] > a[1] || b[1] === a[1] && b[0] > a[0] ? b : a)[0];
  const best = Array(size).fill(Infinity), sources = Array(size).fill(null);
  for (const l of candidates) {
    const values = sectorTimes(l);
    if (values.length !== size) continue;
    values.forEach((t, i) => { if (t >= 1 && t < best[i]) { best[i] = t; sources[i] = l; } });
  }
  if (!best.every(Number.isFinite)) return null;
  return {sectorTimesMs:best, totalMs:best.reduce((a,b) => a+b, 0), sourceLapNumbers:sources.map(l => l.lapNumber)};
}
// Android's groupLapsByDirection: first-seen direction first, laps without one form their own group.
export function directionGroups(laps) {
  const groups = new Map();
  for (const lap of laps) {
    const key = lap.direction ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lap);
  }
  return groups;
}

export function lapLabel(lap) {
  if (lap.outLap) return 'Out lap';
  return 'Lap '+lap.lapNumber+(lap.incomplete ? ' (incomplete)' : '');
}

export function lapOption(lap) {
  return [lapLabel(lap),lap.direction,lap.durationMs > 0 ? duration(lap.durationMs) : 'Untimed'].filter(Boolean).join(' · ');
}

// Each view supplies its own leading and trailing columns. Scores include the
// complete result set even when only one page of laps is currently visible.
export function lapTable(laps,{caption,before=[],after=[],visible=laps,byDirection=true}={}) {
  const wrap=el('div',null,'table-wrap lap-times');
  const table=el('table');
  table.setAttribute('aria-label',caption);
  const scores=new Map(), splits=new Map();
  let sectorCount=0;
  const group=lap=>byDirection ? lap.direction || '' : '';
  for (const lap of laps) {
    const values=sectorTimes(lap);
    splits.set(lap,values);
    sectorCount=Math.max(sectorCount,values.length);
    if (lap.hidden || lap.outLap || lap.incomplete || !(lap.durationMs>0)) continue;
    const key=group(lap);
    if (!scores.has(key)) scores.set(key,{time:Infinity,sectors:[]});
    const best=scores.get(key);
    best.time=Math.min(best.time,lap.durationMs);
    values.forEach((time,i)=>{
      if (time>0) best.sectors[i]=Math.min(time,best.sectors[i]??Infinity);
    });
  }
  const headers=[...before.map(([name])=>name),'Lap','Dir','Δ','Time',
    ...Array.from({length:sectorCount},(_,i)=>'S'+(i+1)),...after.map(([name])=>name)];
  const header=table.createTHead().insertRow();
  for(const label of headers) {
    const th=el('th',label);th.scope='col';
    if(label==='Δ') th.title='Gap to fastest lap';
    header.append(th);
  }
  const body=table.createTBody();
  for(const lap of visible) {
    const tr=body.insertRow(),best=scores.get(group(lap));
    const timed=!lap.hidden&&!lap.outLap&&!lap.incomplete&&lap.durationMs>0;
    function extra(columns) {
      for(const [,content] of columns) tr.insertCell().append(content(lap));
    }
    function timingCell(value,fastest,title) {
      const cell=tr.insertCell();
      cell.textContent=value>0 ? duration(value) : '—';
      if(timed && value>0 && value===fastest) {
        cell.className='fastest';cell.title=title;
        cell.setAttribute('aria-label',cell.textContent+' · '+title);
      }
    }
    extra(before);
    tr.insertCell().textContent=lapLabel(lap)+(lap.hidden?' · Hidden':'');
    tr.insertCell().textContent=lap.direction || '—';
    const gap=tr.insertCell();
    const delta=timed && best ? lap.durationMs-best.time : null;
    gap.textContent=delta==null?'—':(delta?'+' : '')+(delta/1000).toFixed(3);
    if(delta>0) gap.className='lap-gap';
    timingCell(lap.durationMs,best?.time,'Fastest lap');
    const values=splits.get(lap);
    for(let i=0;i<sectorCount;i++) timingCell(values[i],best?.sectors[i],'Fastest sector '+(i+1));
    extra(after);
  }
  wrap.append(table);return wrap;
}
