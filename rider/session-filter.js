import {el,field} from './ui.js';

// SessionListFilters.direction: CW/CCW use LapDirection.storageIncludes (BOTH counts for
// either, case-insensitive); Unknown is only a session without a stored direction.
export function directionMatches(stored,wanted){
  if(!wanted)return true;
  if(wanted==='unknown')return stored==null;
  if(stored==null)return false;
  const value=String(stored).toUpperCase();
  return value==='BOTH'||value===wanted;
}

export function sessionFilter(host,rows){
  const box=el('details',null,'panel');box.append(el('summary','Filter sessions'));host.append(box);
  const fields=el('div',null,'cols');box.append(fields);
  function select(label,name,choices){return field(fields,label,name,'select',{choices:[['','Any'],...choices]});}
  function values(key){return [...new Set(rows.map(r=>r[key]).filter(Boolean))].sort().map(v=>[v,v]);}
  const trackNames=new Map(rows.filter(r=>r.track_local_id).map(r=>[r.track_local_id,r.track?.name||r.track_local_id]));
  const track=select('Track','track',[['none','Unlinked'],...trackNames]);
  const owner=select('Ownership','owner',[['mine','My rides'],['other','Other rides']]);
  const date=select('Date','date',[['today','Today'],['7','Last 7 days'],['30','Last 30 days'],['year','This year']]);
  const direction=select('Direction','direction',[['CW','Clockwise'],['CCW','Counterclockwise'],['unknown','Unknown']]);
  const vehicle=select('Vehicle','vehicle',values('eucName'));
  const logger=select('Logger','logger',values('raceboxName'));
  function matches(row){
    const now=new Date();
    let from=-Infinity;
    if(date.value==='year')from=new Date(now.getFullYear(),0,1).getTime();
    else if(date.value==='today')from=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    else if(date.value)from=Date.now()-Number(date.value)*86400000;
    return (!track.value||(row.track_local_id||'none')===track.value) &&
      (!owner.value||(owner.value==='mine')===row.is_mine) &&
      Date.parse(row.started_at)>=from &&
      directionMatches(row.lapDirection,direction.value) &&
      (!vehicle.value||vehicle.value===row.eucName) && (!logger.value||logger.value===row.raceboxName);
  }
  return {box,matches};
}
