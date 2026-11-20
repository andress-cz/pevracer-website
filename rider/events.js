import {sessionEquipment,duration} from './ui.js';
import {lapTable,sectorTimes} from './lap-table.js';
import { mountTrack } from './track-editor.js';

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action) {
  const node = el('button', label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function labeled(name, field) {
  const label = el('label', null, 'ev-field');
  label.append(el('span', name),field);
  return label;
}
function menu(options) {
  const select = el('select');
  for (const [value, label] of options) {
    const option = el('option', label);
    option.value = value;
    select.append(option);
  }
  return select;
}
function disclosure(label) {
  const node = el('details', null, 'ev-fold');
  node.append(el('summary', label));
  return node;
}
function group(...nodes) {
  const row = el('div', null, 'ev-actions');
  row.append(...nodes);
  return row;
}
function date(value) {
  return new Date(value).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'});
}
function when(row) {
  if (row.kind === 'leaderboard') return 'Open leaderboard';
  if (new Date(row.starts_at) > Date.now()) return 'Upcoming';
  if (row.ends_at && new Date(row.ends_at) <= Date.now()) return 'Ended';
  return 'Live';
}
function eligible(row, event) {
  if (!row.is_mine || row.track_local_id !== event.track_local_id) return false;
  if (event.kind === 'leaderboard') return true;
  const time = Date.parse(row.started_at);
  return time >= Date.parse(event.starts_at) - 15*60*1000 && (!event.ends_at || time <= Date.parse(event.ends_at));
}
function ranking(rows, direction, sector, perRider) {
  const matches = [];
  for (const row of rows) {
    if (direction && row.direction !== direction) continue;
    const time = sector === '' ? Number(row.duration_ms) : Number(row.splits[Number(sector)]);
    if (time > 0 && Number.isFinite(time)) matches.push({row,time});
  }
  matches.sort((a,b) => a.time-b.time);
  if (!perRider) return matches;
  const seen = new Set();
  return matches.filter(({row}) => {
    if (seen.has(row.user_id)) return false;
    seen.add(row.user_id);
    return true;
  });
}

function mountRankings(host, initial, go) {
  const controls = el('div', null, 'ev-fields');
  const mode = menu([['best','Best per rider'],['all','All laps']]);
  const direction = menu([]), sector = menu([]);
  controls.append(labeled('View',mode),labeled('Direction',direction),labeled('Rank by',sector));
  const results = el('div');
  host.append(el('h3','Lap results'),controls,results);
  let rows = [], page = 0;
  const pageSize = 50;

  function render() {
    results.replaceChildren();
    // The Android analyzer numbers sectors in the direction of travel.
    if (sector.value !== '' && !direction.value && new Set(rows.map(r=>r.direction ?? '')).size > 1) {
      results.append(el('p','Choose one direction to compare the same sector across laps.'));
      return;
    }
    const ranked = ranking(rows,direction.value,sector.value,mode.value==='best');
    if (!ranked.length) {
      results.append(el('p', rows.length ? 'No timed laps match this selection.' : 'No timed laps have been entered.'));
      return;
    }
    page = Math.min(page, Math.ceil(ranked.length/pageSize)-1);
    const laps=ranked.map(({row},index)=>({...row,place:index+1}));
    results.append(lapTable(laps,{caption:'Lap results',byDirection:false,visible:laps.slice(page*pageSize,(page+1)*pageSize),
      before:[['Place',lap=>String(lap.place)],['Rider',lap=>'@'+lap.username]],
      after:[['Session',lap=>button(lap.session_title||'Open session',()=>go('session',lap.session_id))]]}));
    if (ranked.length>pageSize) {
      const prev=button('Previous',()=>{page--;render();}),next=button('Next',()=>{page++;render();});
      prev.disabled=page===0;next.disabled=(page+1)*pageSize>=ranked.length;
      results.append(group(prev,el('span',String(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,ranked.length)+' of '+ranked.length),next));
    }
  }
  for (const field of [mode,direction,sector]) field.onchange=()=>{page=0;render();};
  function update(laps) {
    rows=laps.map(lap=>({...lap, splits:sectorTimes(lap),lapNumber:lap.lap_number,durationMs:Number(lap.duration_ms)}));
    const directions=[...new Set(rows.map(r=>r.direction).filter(Boolean))].sort();
    const count=rows.reduce((n,row)=>Math.max(n,row.splits.length),0);
    for (const [field, choices] of [[direction,[['','All directions'],...directions.map(d=>[d,d])]],
      [sector,[['','Full lap'],...Array.from({length:count},(_,i)=>[String(i),'Sector '+(i+1)])]]]) {
      const selected=field.value, changed=Array.from(field.options).map(o=>o.value).join('|')!==choices.map(c=>c[0]).join('|') || !field.options.length;
      if (changed) {
        field.replaceChildren(...Array.from(menu(choices).options));
        field.value=choices.some(c=>c[0]===selected)?selected:'';
      }
    }
    render();
  }
  update(initial);
  return update;
}

function createForm(kind, tracks, submit, go) {
  const timed = kind==='event';
  const title = timed ? 'event' : 'leaderboard';
  const details=disclosure('Create '+(timed?'an event':'a leaderboard'));
  if (!tracks.length) {
    details.append(el('p','Save a track to your library before creating '+(timed?'an event':'a leaderboard')+'.'),
      button('Open tracks',()=>go('tracks')));
    return details;
  }
  const form=el('form',null,'ev-create');
  const name=el('input'); name.required=true; name.maxLength=80;
  const track=menu(tracks.map(t=>[t.id,t.name]));
  const access=menu([['friends','Friends'],['invite','Invite link'],['public','All signed-in riders']]);
  const start=el('input'),end=el('input');
  start.type=end.type='datetime-local';start.required=true;
  const now=new Date();start.value=new Date(+now-now.getTimezoneOffset()*60000).toISOString().slice(0,16);
  const fields=el('div',null,'ev-fields');
  fields.append(labeled('Name',name),labeled('Track',track),labeled('Who can join',access));
  if(timed) fields.append(labeled('Starts (local time)',start),labeled('Ends (optional)',end));
  const save=el('button','Create '+title);save.type='submit';
  form.append(fields,el('p','Riders will use a snapshot of the selected track and its timing gates.'),save);
  form.onsubmit=e=>{
    e.preventDefault();
    if (!form.reportValidity()) return;
    submit(async()=>{
      const starts_at=timed?new Date(start.value).toISOString():null;
      const ends_at=timed && end.value?new Date(end.value).toISOString():null;
      if (!name.value.trim()) throw Error('Enter a name.');
      if (ends_at && ends_at<=starts_at) throw Error('The end must be after the start.');
      return {trackId:track.value,name:name.value.trim(),visibility:access.value,kind,starts_at,ends_at};
    });
  };
  details.append(form);
  return details;
}

export async function mountEvents(container, {api,uid,kind='event',id,go,sharing,moderate}) {
  if (!document.querySelector('link[data-pev-events]')) {
    const sheet=el('link');sheet.rel='stylesheet';sheet.href=new URL('events.css',import.meta.url).href;
    sheet.dataset.pevEvents='';document.head.append(sheet);
  }
  const name=kind==='leaderboard'?'leaderboard':'event', listName=name==='event'?'Events':'Leaderboards';
  const root=el('section',null,'ev-view'), content=el('div',null,'ev-content'), status=el('p',null,'ev-status');
  status.setAttribute('role','status');
  root.append(status,content);container.replaceChildren(root);
  let timer=0, generation=0, busy=false, cleanupTrack=null;
  const current = n=>n===generation && root.parentNode===container;
  function stop() {
    clearTimeout(timer); if (cleanupTrack) cleanupTrack(); cleanupTrack=null;
  }
  async function write(action) {
    if (busy) return;
    busy=true;
    const lock=content.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    for(const item of lock) item.disabled=true;
    status.textContent='Saving…';
    try {
      await action();
      if (root.parentNode===container && status.textContent==='Saving…') status.textContent='';
    } catch(error) {
      status.textContent=(error.message || 'The change could not be saved.')+' You can retry the action.';
    } finally {
      busy=false;for(const item of lock) item.disabled=false;
    }
  }
  function appendRow(host,title,sub,action,label) {
    const row=el('div',null,'ev-item'), copy=el('div');
    copy.append(el('strong',title),el('small',sub));
    row.append(copy,button(label,action));host.append(row);
  }
  async function list(n) {
    const [events,tracks]=await Promise.all([
      api.all('rpc/list_events',{kind:'eq.'+kind,order:'created_at.desc,id.asc'}),
      api.all('tracks',{select:'id,name',owner_id:'eq.'+uid,order:'name.asc,id.asc'}),
    ]);
    if (!current(n)) return;
    const create=createForm(kind,tracks,getData=>write(async()=>{
      const {trackId,...body}=await getData();
      const [track]=await api.rows('tracks',{id:'eq.'+trackId,owner_id:'eq.'+uid,select:'doc,local_id,name'});
      if (!track?.doc) throw Error('This track is no longer available. Refresh the list.');
      const [event]=await api.write('events','POST',{select:'id'},{...body,owner_id:uid,
        track_local_id:track.local_id,track_name:track.name,track_doc:track.doc},'return=representation');
      go(kind,event.id);
    }),go);
    content.replaceChildren(group(el('h2',listName),button('Refresh',reload)),create);
    if (!events.length) content.append(el('p','No '+listName.toLowerCase()+' are available to this account yet.'));
    for (const row of events) {
      const parts = [row.track_name,'@'+row.owner_name,when(row)];
      if(row.starts_at) parts.push(date(row.starts_at));
      parts.push(row.member_count+' riders');if(row.is_member) parts.push('Joined');
      appendRow(content,row.name,parts.join(' · '),()=>go(kind,row.id),'Open');
    }
  }

  const lapsForEvent=()=>api.all('rpc/event_laps',{p_event:id,order:'duration_ms.asc,user_id.asc,session_id.asc,lap_number.asc,lap_id.asc'});
  async function detail(n) {
    const [events,snapshots]=await Promise.all([
      api.rows('rpc/list_events',{id:'eq.'+id,kind:'eq.'+kind}),
      api.rows('events',{id:'eq.'+id,select:'track_doc'}),
    ]);
    if (!current(n)) return;
    const event=events[0],snapshot=snapshots[0]?.track_doc;
    if (!event || !snapshot) throw Error('This '+name+' is unavailable to your account.');
    const member=event.is_member,owned=uid===event.owner_id;
    const [laps,riders,entries,sessions,ownTracks]=member ? await Promise.all([
      lapsForEvent(),
      api.all('event_members',{event_id:'eq.'+id,select:'user_id,user:profiles(id,username)',order:'user_id.asc'}),
      api.all('event_entries',{event_id:'eq.'+id,user_id:'eq.'+uid,select:'session_id,session:sessions(id,title,started_at,best_lap_ms,meta->>eucName)',order:'session_id.asc'}),
      api.all('sessions',{owner_id:'eq.'+uid,is_mine:'eq.true',track_local_id:'eq.'+event.track_local_id,
        select:'id,title,is_mine,track_local_id,started_at,best_lap_ms,meta->>eucName',order:'started_at.desc,id.asc'}),
      api.rows('tracks',{owner_id:'eq.'+uid,local_id:'eq.'+event.track_local_id,select:'id'}),
    ]) : [[],[],[],[],[]];
    if (!current(n)) return;
    const details=el('div',null,'ev-head');
    details.append(el('small',when(event)+' · '+({public:'Public',invite:'Invite link',friends:'Friends'}[event.visibility] || '')),
      el('h2',event.name),el('p',event.track_name+' · Organised by @'+event.owner_name));
    if (event.starts_at) details.append(el('p',date(event.starts_at)+(event.ends_at?' – '+date(event.ends_at):' onwards')));
    details.append(el('p',event.member_count+' riders · '+event.entry_count+' entered sessions'));
    content.replaceChildren(group(button('All '+listName.toLowerCase(),()=>go(kind)),button('Refresh',reload)),details);
    const methods=el('div');
    content.append(methods);
    const item={...event,owner:{id:event.owner_id,username:event.owner_name}};
    if (owned && sharing) await sharing(methods,'event',item);
    if (!owned && moderate) await moderate(methods,'event',item);
    if (!current(n)) return;
    if (!member) {
      content.append(el('p','Join to see lap results. Any session you enter, including its full recording, is visible to the other members.'),
        button('Join '+name,()=>write(async()=>{
          await api.write('event_members','POST',{on_conflict:'event_id,user_id'},{event_id:id,user_id:uid},'resolution=ignore-duplicates');
          await reload();
        })));
      return;
    }
    const rankings=el('section',null,'ev-rankings'); content.append(rankings);
    const updateRankings=mountRankings(rankings,laps,go);
    const pollNotice=el('p');rankings.append(pollNotice);
    // Refresh the results independently so keyboard focus, selections and open disclosures survive.
    let previous=JSON.stringify(laps);
    async function poll() {
      if (!current(n) || !root.isConnected) return;
      if (!document.hidden && !busy) {
        try {
          const fresh=await lapsForEvent();
          if (!current(n)) return;
          const signature=JSON.stringify(fresh);
          if (signature!==previous) {previous=signature;updateRankings(fresh);}
          pollNotice.textContent='';
        } catch {
          if(current(n)) pollNotice.textContent='Live updates paused. Refresh to try again.';
          return;
        }
      }
      if (current(n)) timer=setTimeout(poll,15000);
    }
    if (when(event)==='Live') timer=setTimeout(poll,15000);
    const track=disclosure('Event track · '+event.track_name);
    const map=el('div');track.append(map);content.append(track);
    cleanupTrack=mountTrack(map,{doc:snapshot});
    if(!ownTracks.length) track.append(button('Save track to my library',()=>write(async()=>{
      await api.write('tracks','POST',{on_conflict:'owner_id,local_id'},{
        owner_id:uid,local_id:event.track_local_id,name:event.track_name,
        doc:{...snapshot,id:event.track_local_id},visibility:'private',
      },'resolution=ignore-duplicates');
      await reload();
    })));
    const entered=new Map(entries.map(e=>[e.session_id,e.session]));
    const rideList=new Map(sessions.filter(s=>eligible(s,event)).map(s=>[s.id,s]));
    for(const [sessionId,row] of entered) if(!rideList.has(sessionId) && row) rideList.set(sessionId,row);
    const rides=disclosure('My sessions · '+entries.length+' entered');
    rides.append(el('p','Entering a session lets every member open its route and full recording.'));
    if (!rideList.size) rides.append(el('p','No matching sessions. Back up a ride marked Mine on this track'+(name==='event'?' within the event window.':'.')));
    for(const ride of rideList.values()) {
      const isEntered=entered.has(ride.id);
      appendRow(rides,ride.title || 'Ride on '+event.track_name,[date(ride.started_at),sessionEquipment(ride,event.track_name),'Best lap '+duration(ride.best_lap_ms)].join(' · '),()=>write(async()=>{
        if (isEntered) await api.write('event_entries','DELETE',{event_id:'eq.'+id,session_id:'eq.'+ride.id,user_id:'eq.'+uid});
        else await api.write('event_entries','POST',{on_conflict:'event_id,session_id'},
          {event_id:id,session_id:ride.id,user_id:uid},'resolution=ignore-duplicates');
        await reload();
      }),isEntered?'Remove entry':'Enter session');
    }
    content.append(rides);
    const members=disclosure('Riders · '+riders.length);
    const list=el('ul');
    for (const rider of riders) {
      if (!rider.user) continue;
      const entry=el('li','@'+rider.user.username);
      if (moderate && rider.user_id!==uid) await moderate(entry,'rider',{
        id:rider.user_id, owner_id:rider.user_id, owner:rider.user,
      });
      list.append(entry);
    }
    members.append(list);content.append(members);
    if(owned && when(event)==='Live') content.append(button('End event now',()=>{
      if(confirm('End this event now? Sessions started after it ends will no longer qualify.')) write(async()=>{
        await api.write('events','PATCH',{id:'eq.'+id,owner_id:'eq.'+uid},{ends_at:new Date().toISOString()});
        await reload();
      });
    }));
    if(owned) content.append(button('Delete '+name,()=>{
      if(confirm('Delete “'+event.name+'” and its standings for everyone? Entered sessions stay in their owners’ libraries.')) write(async()=>{
        await api.write('events','DELETE',{id:'eq.'+id,owner_id:'eq.'+uid});go(kind);
      });
    }));
    else content.append(button('Leave '+name,()=>{
      if(confirm('Leave “'+event.name+'” and withdraw your sessions from its results?')) write(async()=>{
        await api.write('event_entries','DELETE',{event_id:'eq.'+id,user_id:'eq.'+uid});
        await api.write('event_members','DELETE',{event_id:'eq.'+id,user_id:'eq.'+uid});go(kind);
      });
    }));
  }
  async function reload() {
    const n=++generation;
    stop();content.replaceChildren();status.textContent='Loading '+listName.toLowerCase()+'…';
    try {
      if(id) await detail(n);else await list(n);
      if(current(n)) status.textContent='';
    } catch(error) {
      if(!current(n)) return;
      stop();status.textContent=error.message || 'Could not load '+listName.toLowerCase()+'.';
      content.replaceChildren(group(button('Retry',reload),button('All '+listName.toLowerCase(),()=>go(kind))));
    }
  }
  await reload();
  return ()=>{generation++;stop();};
}
