import {lapTable} from './lap-table.js';
import {auth,client} from './api.js';
import {sessionFilter} from './session-filter.js';
import {el,eq,link,panel,button,formAt,field,submit,message,record,sessionEquipment,sessionBest,metrics,date,duration,km} from './ui.js';
import {mountEvents} from './events.js';
import {mountTrack,emptyTrack,trackFromRoute} from './track-editor.js';
import {mountTelemetry,mountLocalAnalysis} from './telemetry.js';
import {mountBackup} from './backup.js';
import {mountCommunity,mountSharing,mountModeration,rules} from './community.js';
import {createSatelliteMap,L} from './satellite-map.js';
import {decodeRecording} from './telemetry-codec.js';
import {heatmapPoints} from './heatmap-data.js';

const view=document.querySelector('#view'),nav=document.querySelector('#areas'),signout=document.querySelector('#signout');
const labels={sessions:'Sessions',tracks:'Tracks',event:'Events',leaderboard:'Leaderboards',community:'Community',stats:'Stats',files:'Analyze a file',account:'Account'};
const callback=new URL('./',location.href).href;
const brief='id,title,started_at,distance_m,duration_ms,lap_count,best_lap_ms,max_speed_kmh,track_local_id,is_mine,visibility';
let user=null, draft=null, revision=0, dispose=()=>{};
let recovery=sessionStorage.getItem('pev-password-recovery')==='1';
const route=()=>location.hash.slice(1).split('/');
function go(area,id=''){
  const hash=area+(id?'/'+encodeURIComponent(id):'');
  if(location.hash==='#'+hash)render();else location.hash=hash;
}
function check(result){if(result.error)throw result.error;return result.data;}
function signedOut(host,mode){
  const callbackError=new URLSearchParams(location.hash.slice(1)).get('error_description') || new URLSearchParams(location.search).get('error_description');
  if(callbackError)host.append(el('p','Account link: '+callbackError,'notice'));
  const grid=el('div',null,'auth-grid'),intro=el('section',null,'auth-intro');
  intro.append(el('h1','Rider dashboard'),el('p','Review your rides, enter a track event and compare your laps with other riders.'));
  const image=el('img');image.src='../assets/ride-map.png';image.alt='Session route and speed trace in PEV Racer';intro.append(image);
  const box=el('section',null,'panel');
  const titles={register:'Create an account',reset:'Reset your password',resend:'Resend confirmation'};
  box.append(el('h2',titles[mode]||'Sign in'),el('p',mode==='reset'||mode==='resend'?'Enter the email address on your PEV Racer account.':'Use the same PEV Racer account on Android and the web.'));
  const f=formAt(box);field(f,'Email','email','email',{required:true,autocomplete:'email'});
  if(!['reset','resend'].includes(mode))field(f,'Password','password','password',{required:true,minLength:mode==='register'?8:1,autocomplete:mode==='register'?'new-password':'current-password'});
  submit(f,mode==='reset'?'Send reset link':mode==='resend'?'Send confirmation':titles[mode]||'Sign in',async({email,password},out)=>{
    if(mode==='register'){
      const result=check(await auth.signUp({email,password,options:{emailRedirectTo:callback}}));
      if(!result.session)message(out,'Check your email and open the confirmation link in this browser.');
    }else if(mode==='reset'){
      check(await auth.resetPasswordForEmail(email,{redirectTo:callback}));message(out,'If this account exists, check your email for a reset link. Open it in this browser.');
    }else if(mode==='resend'){
      check(await auth.resend({type:'signup',email,options:{emailRedirectTo:callback}}));message(out,'Check your inbox for a confirmation email.');
    }else check(await auth.signInWithPassword({email,password}));
  });
  const actions=el('div',null,'subnav');box.append(actions);
  for(const [dest,title] of [['login','Sign in'],['register','Create account'],['reset','Forgot password?'],['resend','Resend confirmation']]){
    if(dest!==(mode||'login'))actions.append(link(title,'#'+dest));
  }
  box.append(link('Analyze a local recording','#files'));grid.append(intro,box);host.append(grid);
}
function resetForm(host){
  host.append(el('h1','Choose a new password'));
  const f=formAt(panel(host));field(f,'New password','password','password',{required:true,minLength:8,autocomplete:'new-password'});
  submit(f,'Save password',async({password})=>{check(await auth.updateUser({password}));recovery=false;sessionStorage.removeItem('pev-password-recovery');go('sessions');});
}
function privateFile(host,ctx){
  host.append(el('h1','Analyze a file'));const box=panel(host);
  mountLocalAnalysis(box,{onCreateTrack:(points,name)=>makeDraft(points,name),onSaveSession:ctx?async(data,name,blob,mine)=>{const {saveImported}=await import('./import-session.js');const item=await saveImported(ctx,data,name,blob,mine);go('session',item.id);}:undefined});
  if(!ctx)host.append(link('Sign in to open your cloud library','#login'));
}
function makeDraft(points,name,session){
  if(points.length<10)return;
  draft={owner:user?.id,points,name:name+' track',session};go('newtrack');
}
async function rulesPanel(host,ctx){
  const ok=await ctx.api.rows('community_terms',{select:'version',version:'eq.1'});
  if(ok.length)return true;
  const box=panel(host,'Community rules',rules);
  button(box,'Accept community rules',async()=>{await ctx.api.write('community_terms','POST',{}, {version:1},'resolution=ignore-duplicates');render();},'primary');
  return false;
}
async function createTrack(host,ctx){
  host.append(el('h1','Create a track'));
  const source=draft?.owner===user?.id?draft:null;
  const box=el('section',null,'panel');let clean;
  if(source?.points){
    const f=formAt(panel(host,'Build from this route'));
    field(f,'Course type','mode','select',{choices:[['CIRCUIT','Circuit'],['POINT_TO_POINT','Point to point']]});
    field(f,'Number of sectors','sectorCount','number',{value:3,min:1,max:100,required:true});
    submit(f,'Generate gates',async({mode,sectorCount})=>show(trackFromRoute(source.points,{name:source.name,mode,sectorCount:Number(sectorCount)})));
  }
  host.append(box);
  function show(doc){clean?.();clean=mountTrack(box,{doc,route:source?.points,onSave:async saved=>{
    if(!ctx){const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(saved,null,2)],{type:'application/json'}));
      a.href=url;a.download=saved.name+'.pevtrack';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);return;}
    const [row]=await ctx.api.write('tracks','POST',{select:'id,local_id'},{owner_id:ctx.uid,local_id:saved.id,name:saved.name,doc:saved,visibility:'private'},'return=representation');
    if(source.session){
      try{
        const session=source.session;
        const updated=await ctx.api.write('sessions','PATCH',{
          id:eq(session.id),owner_id:eq(ctx.uid),updated_at:eq(session.updated_at),select:'id'
        },{
          track_id:row.id,track_local_id:row.local_id,laps:[],lap_count:0,best_lap_ms:null,
          meta:{...session.meta,trackId:row.local_id,lapDirection:null}
        },'return=representation');
        if(!updated.length)throw Error('The source session changed. Refresh it and try again.');
      }catch(error){
        await ctx.api.write('tracks','DELETE',{id:eq(row.id),owner_id:eq(ctx.uid)});
        throw error;
      }
    }
    draft=null;go('track',row.id);
  }});}
  if(!source?.points)show(emptyTrack());
  else try{show(trackFromRoute(source.points,{name:source.name}));}catch(e){box.textContent=e.message;}
}
function browse(host,rows,kind){
  const filter=field(host,'Search '+kind+'s','search','search',{placeholder:kind==='session'?'Title, date, vehicle, or track':'Track name'});
  const options=kind==='session'?sessionFilter(host,rows):null;
  const list=el('div',null,'records');host.append(list);
  function draw(){
    list.replaceChildren();const term=filter.value.trim().toLowerCase();
    for(const item of rows){
      if(options&&!options.matches(item))continue;
      const title=item.title||item.name||date(item.started_at);
      const detail=kind==='session'?[date(item.started_at),sessionEquipment(item),item.lap_count+(item.lap_count===1?' lap':' laps')].join(' · '):item.visibility;
      if(!(title+' '+detail).toLowerCase().includes(term))continue;
      if(kind==='session'){
        record(list,title,detail,'#session/'+item.id,sessionBest(item));
      }else record(list,title,detail,'#track/'+item.id);
    }
    if(!list.childElementCount)list.append(el('p',rows.length?'No matching '+kind+'s.':'Your cloud library is empty. On Android, open Social → Account → Back up now to bring your '+kind+'s here.','empty'));
  }
  filter.oninput=draw;if(options)options.box.onchange=draw;draw();
}
async function library(host,ctx,kind){
  const sessions=kind==='session';host.append(el('h1',sessions?'My sessions':'My tracks'));
  if(sessions)host.append(el('p','Rides backed up from Android appear here. To sync a ride from your phone, open Social → Account → Back up now.','quiet'));
  host.append(link(sessions?'Analyze a local recording':'Create or import a track',sessions?'#files':'#newtrack','rbutton'));
  const rows=await ctx.api.all(kind+'s',{select:sessions?brief+',track:tracks(name),meta->>raceboxName,meta->>eucName,meta->>lapDirection':'id,name,visibility',owner_id:eq(ctx.uid),order:sessions?'started_at.desc,id.asc':'name.asc,id.asc'});
  browse(host,rows,kind);
}
async function stats(host,ctx){
  host.append(el('h1','Rider stats'));
  const [sessions,tracks]=await Promise.all([ctx.api.all('sessions',{owner_id:eq(ctx.uid),is_mine:eq(true),select:brief+',meta->endedAtEpochMs,meta->eucName',order:'started_at.desc,id.asc'}),ctx.api.all('tracks',{owner_id:eq(ctx.uid),select:'local_id,name',order:'id'})]);
  const trackNames=new Map(tracks.map(t=>[t.local_id,t.name]));
  const period=field(host,'Period','period','select',{choices:[['0','All time'],['30','Last 30 days'],['365','Last year']]});
  const vehicles=[...new Set(sessions.map(s=>s.eucName).filter(Boolean))];
  const vehicle=field(host,'Vehicle','vehicle','select',{choices:[['','All vehicles'],...vehicles.map(v=>[v,v])]});
  const body=el('div');host.append(body);
  const heat=panel(body,'Rider heatmap','Choose whether to map your own rides or sessions that riders have made public. Private and friends-only sessions are never included in the public heatmap. Locations are sampled at a lower detail level than the original recordings.');
  const heatStatus=el('p','Choose a ride source to load its heatmap.','quiet');
  const heatActions=el('div',null,'actions');
  const heatModes=[['mine','My rides'],['public','Public rides']];
  const modeButtons=new Map();
  let heatMap=null,heatMapHost=null,heatLoad=0;
  for(const [mode,label] of heatModes){
    const choice=el('button',label,'btn');choice.type='button';choice.setAttribute('aria-pressed','false');
    choice.onclick=()=>loadHeatmap(mode);modeButtons.set(mode,choice);heatActions.append(choice);
  }
  heat.append(heatStatus,heatActions);
  async function loadHeatmap(mode){
    const request=++heatLoad;
    for(const [key,choice] of modeButtons){choice.disabled=true;choice.classList.toggle('primary',key===mode);choice.setAttribute('aria-pressed',String(key===mode));}
    clearHeatmap();
    heatStatus.textContent='Finding '+(mode==='mine'?'your':'public')+' ride recordings…';
    try{
      const filters=mode==='mine'
        ?{owner_id:eq(ctx.uid),is_mine:eq(true)}
        :{visibility:eq('public')};
      const recordings=await ctx.api.all('sessions',{...filters,sample_path:'not.is.null',sample_bytes:'lte.52428800',select:'id,sample_path,sample_bytes'});
      if(request!==heatLoad)return;
      if(!recordings.length){heatStatus.textContent=mode==='mine'?'No recordings from your rides are available yet.':'No public recordings are available yet.';clearHeatmap();return;}
      const points=[];let done=0,failures=0;
      for(let start=0;start<recordings.length;start+=4){
        const batch=recordings.slice(start,start+4);
        await Promise.all(batch.map(async session=>{
          try{
            const data=await decodeRecording(await ctx.api.download(session.sample_path));
            points.push(...heatmapPoints(data));
          }catch{failures++;}
          done++;
        }));
        if(request!==heatLoad)return;
        heatStatus.textContent='Reading '+(mode==='mine'?'your':'public')+' rides… '+done+' / '+recordings.length;
      }
      if(request!==heatLoad)return;
      if(!points.length){heatStatus.textContent='No usable location samples were found in these recordings.';clearHeatmap();return;}
      heatStatus.textContent=points.length.toLocaleString()+' map samples from '+(done-failures)+' '+(mode==='mine'?'of your':'public')+' rides'+(failures?' ('+failures+' unavailable or unreadable)':'')+'.';
      showHeatmap(points);
    }catch(error){
      if(request===heatLoad)heatStatus.textContent='Could not load this heatmap: '+error.message;
    }finally{
      if(request===heatLoad)for(const choice of modeButtons.values())choice.disabled=false;
    }
  }
  function clearHeatmap(){
    heatMap?.remove();heatMap=null;
    heatMapHost?.replaceChildren();
  }
  function showHeatmap(points){
    clearHeatmap();
    if(!heatMapHost){heatMapHost=el('div',null,'rider-heatmap');heat.append(heatMapHost);}
    const map=createSatelliteMap(heatMapHost,{center:points[0],zoom:5});heatMap=map;
    const canvas=L.DomUtil.create('canvas','rider-heatmap-canvas',map.getPanes().overlayPane),ctx2=canvas.getContext('2d');
    function draw(){
      if(!heatMapHost.clientWidth||!heatMapHost.clientHeight)return;
      const size=map.getSize(),ratio=window.devicePixelRatio||1,topLeft=map.containerPointToLayerPoint([0,0]);
      canvas.width=Math.round(size.x*ratio);canvas.height=Math.round(size.y*ratio);
      canvas.style.width=size.x+'px';canvas.style.height=size.y+'px';L.DomUtil.setPosition(canvas,topLeft);
      ctx2.setTransform(ratio,0,0,ratio,0,0);ctx2.clearRect(0,0,size.x,size.y);
      for(const p of points){const pos=map.latLngToLayerPoint(p).subtract(topLeft),radius=18;
        const g=ctx2.createRadialGradient(pos.x,pos.y,1,pos.x,pos.y,radius);
        g.addColorStop(0,'rgba(209,44,24,.30)');g.addColorStop(.35,'rgba(255,146,31,.19)');g.addColorStop(1,'rgba(255,215,71,0)');
        ctx2.fillStyle=g;ctx2.fillRect(pos.x-radius,pos.y-radius,radius*2,radius*2);
      }
    }
    map.on('moveend zoomend resize',draw);draw();
    map.fitBounds(L.latLngBounds(points),{padding:[24,24],maxZoom:12});
  }
  function draw(){
    const since=period.value==='0'?-Infinity:Date.now()-Number(period.value)*86400000;
    const rows=sessions.filter(r=>r.endedAtEpochMs!=null && Date.parse(r.started_at)>=since && (!vehicle.value||vehicle.value===r.eucName));
    const sum=k=>rows.reduce((n,r)=>n+(r[k]||0),0);body.replaceChildren();
    metrics(body,[['Sessions',rows.length],['Distance',km(sum('distance_m'))],['Ride time',(sum('duration_ms')/3600000).toFixed(1)+' h'],['Top speed',rows.reduce((n,r)=>Math.max(n,r.max_speed_kmh||0),0).toFixed(1)+' km/h']]);
    const groups=new Map();for(const row of rows){const id=row.track_local_id||'';const group=groups.get(id)||{rides:0,distance:0,best:Infinity};group.rides++;group.distance+=row.distance_m||0;if(row.best_lap_ms)group.best=Math.min(group.best,row.best_lap_ms);groups.set(id,group);}
    const section=panel(body,'By track');
    if(!groups.size)section.append(el('p','No finished rides match these filters.'));
    for(const [id,g] of groups)section.append(el('p',(trackNames.get(id)||'Unlinked track')+' · '+g.rides+(g.rides===1?' ride · ':' rides · ')+km(g.distance)+(g.best<Infinity?' · Best '+duration(g.best):'')));
    body.append(heat);
  }
  period.onchange=vehicle.onchange=draw;draw();
}
async function detail(host,ctx,type,id){
  const {api,uid}=ctx;
  const [row]=await api.rows(type+'s',{id:eq(id),select:type==='session'?'*,owner:profiles(username),linked:tracks(doc)':'*,owner:profiles(username)'});
  if(!row)throw Error('This item is private, unavailable, or has been removed.');
  const mine=row.owner_id===uid;
  host.append(link('All '+type+'s','#'+type+'s'),el('h1',row.title||row.name||date(row.started_at)),el('p',(row.owner?.username||'Rider')+' · '+row.visibility+(row.started_at?' · '+date(row.started_at):'')));
  async function savePatch(patch){
    const updated=await api.write(type+'s','PATCH',{id:eq(id),owner_id:eq(uid),updated_at:eq(row.updated_at),select:'updated_at' },patch,'return=representation');
    if(!updated.length)throw Error('This item changed elsewhere. Refresh before saving.'); Object.assign(row,patch,updated[0]);
  }
  if(type==='track'){
    const box=panel(host,'Track layout');mountTrack(box,{doc:row.doc,onSave:mine?async doc=>{await savePatch({doc,name:doc.name});render();}:undefined});
    const trackSessions=await api.all('sessions',{track_local_id:eq(row.local_id),select:'id,title,started_at,laps,owner:profiles(username)',order:'started_at.desc,id.asc'});
    const lapBox=panel(host,'Laps on this track');
    const rows=trackSessions.flatMap(session=>(session.laps||[]).filter(l=>l.durationMs>0&&!l.hidden&&!l.incomplete&&!l.outLap).map(l=>({...l,session}))).sort((a,b)=>a.durationMs-b.durationMs);
    if(!rows.length)lapBox.append(el('p','No completed laps are visible on this track yet.'));
    else {
      const list=el('div');lapBox.append(list);let shown=50;
      function show(){list.replaceChildren(lapTable(rows,{caption:'Laps on this track',visible:rows.slice(0,shown),
        before:[['Rider',l=>l.session.owner?.username||'Rider']],
        after:[['Session',l=>link(l.session.title||date(l.session.started_at),'#session/'+l.session.id)]]}));}
      show();if(shown<rows.length){const b=button(lapBox,'More laps',async()=>{shown+=50;show();b.hidden=shown>=rows.length;});}
    }
    if(!mine)button(host,'Save a private copy',async()=>{const doc={...row.doc,id:crypto.randomUUID()};const [copy]=await api.write('tracks','POST',{select:'id'},{owner_id:uid,local_id:doc.id,name:doc.name,doc,visibility:'private'},'return=representation');go('track',copy.id);});
  }else{
    metrics(host,[['Distance',km(row.distance_m)],['Top speed',row.max_speed_kmh==null?'—':row.max_speed_kmh.toFixed(1)+' km/h'],['Laps',row.lap_count],['Best lap',duration(row.best_lap_ms)]]);
    if(row.track_id)host.append(link('Open linked track','#track/'+row.track_id));
    mountTelemetry(panel(host),{session:{...row,track_doc:row.linked?.doc},loadRecording:()=>api.download(row.sample_path),onCreateTrack:(points,name)=>makeDraft(points,name,mine?row:null),
      loadTracks:()=>api.all('tracks',{owner_id:eq(uid),select:'id,local_id,name,doc',order:'name.asc,id.asc'}),
      onSaveTiming:mine?async({track,laps,lapDirection,best_lap_ms,lap_count})=>{
        if(row.track_local_id!==track.local_id){
          const entries=await api.rows('event_entries',{session_id:eq(row.id),user_id:eq(uid),select:'event_id',limit:1});
          if(entries.length)throw Error('Withdraw this session from its events and leaderboards before changing tracks.');
        }
        await savePatch({track_id:track.id,track_local_id:track.local_id,laps,lap_count,best_lap_ms,meta:{...row.meta,trackId:track.local_id,lapDirection}});
        render();
      }:undefined,
      loadComparisons:async()=>row.track_local_id?(await api.all('sessions',{id:'neq.'+id,track_local_id:eq(row.track_local_id),sample_path:'not.is.null',select:'id,title,started_at',order:'started_at.desc,id.asc'})).map(other=>({id:other.id,title:other.title||date(other.started_at),load:async()=>{
        const [session]=await api.rows('sessions',{id:eq(other.id),select:'*'});if(!session)throw Error('Session access has changed.');return {session,blob:await api.download(session.sample_path)};
      }})):[]});
    const laps=Array.isArray(row.laps)?row.laps:[];
    if(laps.length){
      const box=panel(host,'Lap times');
      const after=mine?[['Visibility',lap=>{
        const cell=el('div');
        button(cell,lap.hidden?'Show lap':'Hide lap',async()=>{
          const next=laps.map(l=>l===lap?{...l,hidden:!l.hidden}:l),timed=next.filter(l=>!l.hidden&&!l.outLap&&!l.incomplete&&l.durationMs>0);
          await savePatch({laps:next,lap_count:next.filter(l=>!l.hidden).length,best_lap_ms:timed.reduce((n,l)=>n==null?l.durationMs:Math.min(n,l.durationMs),null)});render();
        });
        return cell;
      }]]:[];
      box.append(lapTable(laps,{caption:'Session lap times',after}));
    }
    if(mine){
      const f=formAt(panel(host,'Session details','Changes apply to the cloud copy. A later Android backup of an edited ride can replace them.'));
      field(f,'Title','title','text',{required:true,maxLength:160,value:row.title||''});
      field(f,'Notes','notes','text',{value:row.meta?.notes||'',maxLength:10000});
      field(f,'Ride ownership','ownership','select',{choices:[['mine','I recorded this ride'],['other','Another rider recorded it']],value:row.is_mine?'mine':'other'});
      submit(f,'Save session details',async({title,notes,ownership})=>{
        const isMine=ownership==='mine';
        if(row.is_mine&&!isMine){
          const filter={resource_type:eq('session'),resource_id:eq(row.id),select:'resource_id',limit:1};
          const [entries,grants,links]=await Promise.all([api.rows('event_entries',{session_id:eq(id),user_id:eq(uid),select:'event_id',limit:1}),api.rows('grants',filter),api.rows('share_links',filter)]);
          if(row.visibility!=='private'||entries.length||grants.length||links.length)throw Error('Make this session private, remove grants and invitation links, and withdraw event entries before changing ownership.');
        }
        await savePatch({title,is_mine:isMine,meta:{...row.meta,isMine,displayName:title,notes}});render();
      });
      if(row.track_local_id)button(host,'Unlink track',async()=>{
        if(!confirm('Unlink the track and remove its calculated laps from this session?'))return;
        if((await api.rows('event_entries',{session_id:eq(id),user_id:eq(uid),select:'event_id',limit:1})).length)throw Error('Withdraw your event entries before unlinking this track.');
        await savePatch({track_id:null,track_local_id:null,laps:[],lap_count:0,best_lap_ms:null,meta:{...row.meta,trackId:null,lapDirection:null}});render();
      });
    }
  }
  if(await rulesPanel(host,ctx))await (mine?mountSharing:mountModeration)(host,{...ctx,type,row,go});
  let alreadyDeleted=false;
  if(mine)button(host,'Delete cloud '+type,async()=>{
    if(!alreadyDeleted && !confirm('Delete this cloud '+type+' and its shared access? Phone and exported copies may still exist.'))return;
    // Remove the database reference first so other riders immediately lose access.
    if(!alreadyDeleted){
      const deleted=await api.write(type+'s','DELETE',{id:eq(id),owner_id:eq(uid),updated_at:eq(row.updated_at),select:'id'},undefined,'return=representation');
      if(!deleted.length)throw Error('This item changed. Refresh before deleting.');
      alreadyDeleted=true;
    }
    if(type==='session'&&row.sample_path?.startsWith(uid+'/')){
      try{await api.removeObjects([row.sample_path]);}catch{throw Error('The session was removed. Click Delete cloud session again to finish removing its recording.');}
    }
    go(type+'s');
  },'danger');
}
async function account(host,ctx){
  const {api,uid}=ctx;host.append(el('h1','Account'),el('p',user.email));
  const [profile]=await api.rows('profiles',{id:eq(uid),select:'username'});
  if(await rulesPanel(host,ctx)){
    const f=formAt(panel(host,'Rider profile'));
    field(f,'Username','username','text',{required:true,value:profile?.username||'',pattern:'[A-Za-z0-9._\\-]{3,24}',minLength:3,maxLength:24});
    submit(f,'Update username',async({username},out)=>{await api.write('profiles','PATCH',{id:eq(uid)},{username});message(out,'Username updated.');});
  }
  mountBackup(panel(host),api,uid);
  if(await api.rpc('is_admin')){
    const box=panel(host,'Developer usage');button(box,'Load usage totals',async out=>{
      const data=await api.rpc('admin_stats');message(out,[data.users+' riders',data.sessions+' sessions',data.tracks+' tracks',data.events+' events',data.leaderboards+' leaderboards'].join(' · '));
    });
  }
  const f=formAt(panel(host,'Delete account','This permanently removes your account, cloud recordings and sharing relationships. Download your backup first if you want a copy.'));
  field(f,'Type DELETE to confirm','confirm','text',{required:true,pattern:'DELETE',autocomplete:'off'});
  submit(f,'Permanently delete account',async()=>{await api.purgeAccount();await auth.signOut({scope:'local'});location.replace('./');});
}
async function render(){
  const current=++revision;dispose();dispose=()=>{};
  const host=el('div');view.replaceChildren(host);let [area,id]=route();
  if(area==='workspace')area='sessions';
  const ctx=user?{api:client(user.id),uid:user.id,go}:null;
  nav.hidden=!ctx;signout.hidden=!ctx;nav.replaceChildren();
  if(ctx)for(const [key,label] of Object.entries(labels)){
    const a=link(label,'#'+key);
    if(key===(area||'sessions')||key===area+'s'||key==='tracks'&&area==='newtrack')a.setAttribute('aria-current','page');nav.append(a);
  }
  try{
    if(ctx&&recovery)return resetForm(host);
    if(area==='files')return privateFile(host,ctx);
    if(area==='newtrack')return await createTrack(host,ctx);
    if(!ctx)return signedOut(host,['register','resend','reset'].includes(area)?area:'login');
    if(!area||['login','register','reset','resend'].includes(area))area='sessions';
    if(area==='sessions'||area==='tracks')return await library(host,ctx,area.slice(0,-1));
    if(['event','leaderboard','community'].includes(area)){
      if(!await rulesPanel(host,ctx))return;
      if(area==='community')return await mountCommunity(host,{...ctx,id});
      const cleanup=await mountEvents(host,{...ctx,id,kind:area,
        sharing:(target,type,row)=>mountSharing(target,{...ctx,type,row}),moderate:(target,type,row)=>mountModeration(target,{...ctx,type,row})});
      if(current===revision)dispose=cleanup;else cleanup();return;
    }
    if(['session','track'].includes(area)&&id)return await detail(host,ctx,area,id);
    if(area==='stats')return await stats(host,ctx);
    if(area==='account')return await account(host,ctx);
    go('sessions');
  }catch(e){const box=panel(host,'Could not open this view',e.message);button(box,'Try again',render);box.append(link('My sessions','#sessions'));}
}
signout.onclick=async()=>{signout.disabled=true;try{check(await auth.signOut({scope:'local'}));}catch(e){alert(e.message);}finally{signout.disabled=false;}};
window.addEventListener('hashchange',render);
auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY'){recovery=true;sessionStorage.setItem('pev-password-recovery','1');}
  if(event==='SIGNED_OUT'){draft=null;recovery=false;sessionStorage.removeItem('pev-password-recovery');}
  const changed=user?.id!==session?.user?.id;user=session?.user||null;
  if(changed||['INITIAL_SESSION','SIGNED_OUT','PASSWORD_RECOVERY'].includes(event))setTimeout(render,0);
});
