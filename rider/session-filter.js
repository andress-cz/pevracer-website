import {el,field} from './ui.js';

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
    const value=row.lapDirection||'unknown';
    return (!track.value||(row.track_local_id||'none')===track.value) &&
      (!owner.value||(owner.value==='mine')===row.is_mine) &&
      Date.parse(row.started_at)>=from &&
      (!direction.value||direction.value===value||(value==='BOTH'&&direction.value!=='unknown')) &&
      (!vehicle.value||vehicle.value===row.eucName) && (!logger.value||logger.value===row.raceboxName);
  }
  return {box,matches};
}
