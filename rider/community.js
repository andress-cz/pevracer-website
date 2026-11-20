import {el,eq,panel,formAt,field,submit,message,button,link,record,sessionEquipment,sessionBest,date} from './ui.js';

export const rules='Share rides and tracks you have the right to publish. Do not post threats, harassment, hate, sexual or illegal content, spam, or someone else’s private information. Reports are reviewed by PEV Racer support. Content can be removed and riders can lose sharing access.';
async function rider(api,login){
  const [user]=await api.rpc('find_user',{p_login:login.trim()});
  if(!user)throw Error('No matching rider found. Enter their exact username or email.');
  return user;
}
export async function mountSharing(host,{api,uid,type,row,go}){
  if(row.owner_id!==uid || (type==='session'&&!row.is_mine))return;
  const box=el('details',null,'panel');box.append(el('summary','Sharing and access'));host.append(box);
  const body=el('div');box.append(body);
  const filters={resource_type:eq(type),resource_id:eq(row.id)};
  async function draw(){
    const [links,grants]=await Promise.all([
      api.rows('share_links',{...filters,owner_id:eq(uid),select:'token'}),
      api.all('grants',{...filters,granted_by:eq(uid),select:'user_id,user:profiles!grants_user_id_fkey(username)',order:'user_id.asc'})
    ]);
    body.replaceChildren();
    body.append(el('p',type==='session'?'People with access can download the full route, recording, and lap results.':type==='event'?'Choose who can discover and join this competition.':'People with access can see and download all track gates.'));
    const f=formAt(body);
    const values=type==='event'?[['invite','Invite only'],['friends','Friends'],['public','All signed-in riders']]:[['private','Private'],['friends','Friends'],['public','All signed-in riders']];
    field(f,'Visibility','visibility','select',{choices:values,value:row.visibility});
    submit(f,'Save visibility',async({visibility},out)=>{
      const updated=await api.write(type+'s','PATCH',{id:eq(row.id),owner_id:eq(uid),select:'id'},{visibility},'return=representation');
      if(!updated.length)throw Error('This item is no longer available.');
      row.visibility=visibility;message(out,'Visibility saved.');
    });
    if(links.length){
      const url=new URL('./',location.href);url.hash='community/'+links[0].token;
      const l=el('input');l.value=url.href;l.readOnly=true;l.setAttribute('aria-label','Invitation link');body.append(l);
      button(body,'Copy link',async out=>{await navigator.clipboard.writeText(url.href);message(out,'Copied.');});
      button(body,'Disable link',async()=>{await api.write('share_links','DELETE',{...filters,owner_id:eq(uid)});await draw();});
      body.append(el('p','Disabling the link stops new redemptions. Remove existing grants below.'));
    }else button(body,'Create invitation link',async()=>{
      await api.write('share_links','POST',{on_conflict:'owner_id,resource_type,resource_id'},{owner_id:uid,resource_type:type,resource_id:row.id},'resolution=ignore-duplicates');await draw();
    });
    const grant=formAt(body);field(grant,'Grant access by exact username or email','login','text',{required:true});
    submit(grant,'Grant access',async({login})=>{const user=await rider(api,login);if(user.id===uid)throw Error('You already own this item.');
      await api.write('grants','POST',{on_conflict:'resource_type,resource_id,user_id'},{resource_type:type,resource_id:row.id,user_id:user.id,granted_by:uid},'resolution=ignore-duplicates');await draw();});
    for(const g of grants){button(body,'Revoke grant for '+(g.user?.username||'rider'),async()=>{await api.write('grants','DELETE',{...filters,granted_by:eq(uid),user_id:eq(g.user_id)});await draw();});}
  }
  box.addEventListener('toggle',async()=>{if(!box.open)return;try{await draw();}catch(e){body.textContent=e.message;}});
}
export function mountModeration(host,{api,uid,type,row,go}){
  if(uid===row.owner_id)return;
  const box=el('details',null,'panel');box.append(el('summary','Report or block'));host.append(box);
  const f=formAt(box);
  field(f,'Report','kind','select',{choices:[[type,'This '+type],['rider','This rider']].filter((v,i,a)=>a.findIndex(x=>x[0]===v[0])===i)});
  field(f,'Reason','reason','text',{required:true,maxLength:1000});
  submit(f,'Send report',async({kind,reason},out)=>{await api.write('community_reports','POST',{}, {kind,target:kind==='rider'?row.owner_id:row.id,reason:reason.trim()});f.reset();message(out,'Report submitted to PEV Racer support.');});
  button(box,'Block rider',async()=>{if(!confirm('Block this rider? Your shared content will be hidden from each other.'))return;
    await api.write('rider_blocks','POST',{on_conflict:'rider,blocked'},{blocked:row.owner_id},'resolution=ignore-duplicates');go('community');});
}
export async function mountCommunity(host,{api,uid,go,id}){
  host.append(el('h1','Community'));
  const join=panel(host,'Open an invitation'),f=formAt(join);
  field(f,'Invitation code or link','code','text',{required:true,value:id||''});
  submit(f,'Open invitation',async({code})=>{
    const token=code.trim().match(/^(?:pevracer:\/\/join\/|https?:\/\/[^\s#]+#community\/)?([a-f0-9]{16})$/i)?.[1];
    if(!token)throw Error('Paste a PEV Racer invitation link or its 16-character code.');
    const [item]=await api.rpc('redeem_link',{p_token:token.toLowerCase()});
    let type=item.resource_type;if(type==='event'){const [event]=await api.rows('events',{id:eq(item.resource_id),select:'kind'});type=event?.kind||type;}
    go(type,item.resource_id);
  });
  const friendsBox=panel(host,'Riders','Adding a friend gives them access to items you mark Friends. They can add you back to share theirs.');
  const find=formAt(friendsBox);field(find,'Exact username or email','login','text',{required:true});
  const found=el('div');friendsBox.append(found);
  submit(find,'Find rider',async({login})=>{found.replaceChildren();const user=await rider(api,login);found.append(el('b','@'+user.username));
    if(user.id===uid){found.append(el('p','This is your account.'));return;}
    button(found,'Add friend',async()=>{await api.write('friends','POST',{on_conflict:'user_id,friend_id'},{user_id:uid,friend_id:user.id},'resolution=ignore-duplicates');go('community');});
    mountModeration(found,{api,uid,type:'rider',row:{id:user.id,owner_id:user.id},go});
  });
  const [friends,followers,blocked]=await Promise.all([
    api.all('friends',{user_id:eq(uid),select:'friend_id,friend:profiles!friends_friend_id_fkey(username)',order:'friend_id.asc'}),
    api.all('friends',{friend_id:eq(uid),select:'user_id,user:profiles!friends_user_id_fkey(username)',order:'user_id.asc'}),
    api.rpc('blocked_riders')
  ]);
  for(const person of friends)button(friendsBox,'Remove friend · '+(person.friend?.username||'Rider'),async()=>{await api.write('friends','DELETE',{user_id:eq(uid),friend_id:eq(person.friend_id)});go('community');});
  if(followers.length)friendsBox.append(el('p','Riders who added you: '+followers.map(f=>f.user?.username||'Rider').join(', ')));
  for(const user of blocked)button(friendsBox,'Unblock '+user.username,async()=>{await api.write('rider_blocks','DELETE',{blocked:eq(user.id)});go('community');});
  const box=panel(host,'Shared with you');
  const filter=field(box,'Show','filter','select',{choices:[['all','All accessible'],['public','Public'],['friends','From riders who added me'],['direct','Direct invitations']]});
  const list=el('div',null,'records');box.append(list);
  const [sessions,tracks,grants]=await Promise.all([
    api.all('sessions',{owner_id:'neq.'+uid,select:'id,title,started_at,owner_id,visibility,best_lap_ms,track_local_id,track:tracks(name),meta->>eucName,owner:profiles(username)',order:'started_at.desc,id.asc'}),
    api.all('tracks',{owner_id:'neq.'+uid,select:'id,name,owner_id,visibility,owner:profiles(username)',order:'name.asc,id.asc'}),
    api.all('grants',{user_id:eq(uid),select:'resource_type,resource_id',order:'resource_type.asc,resource_id.asc'})
  ]);
  // Grants also apply to competitions. Resolve their kind so a leaderboard invitation
  // opens the correct screen, subject to the same row access as the native app.
  const eventIds=grants.filter(g=>g.resource_type==='event').map(g=>g.resource_id);
  const events=[];
  for(let i=0;i<eventIds.length;i+=50){
    events.push(...await api.all('events',{id:'in.('+eventIds.slice(i,i+50).join(',')+')',owner_id:'neq.'+uid,
      select:'id,kind,name,owner_id,visibility,owner:profiles!events_owner_id_fkey(username)',order:'name.asc,id.asc'}));
  }
  const follows=new Set(followers.map(f=>f.user_id)),direct=new Set(grants.map(g=>g.resource_type+'/'+g.resource_id));
  function redraw(){
    list.replaceChildren();
    for(const [type,rows] of [['session',sessions],['track',tracks],['event',events]])for(const row of rows){
      if(filter.value==='public'&&row.visibility!=='public'||filter.value==='friends'&&!follows.has(row.owner_id)||filter.value==='direct'&&!direct.has(type+'/'+row.id))continue;
      const route=type==='event'?row.kind:type;
      const owner=route+' · '+(row.owner?.username||'Rider');
      record(list,row.title||row.name||date(row.started_at),type==='session'?owner+' · '+sessionEquipment(row):owner,
        '#'+route+'/'+row.id,type==='session'?sessionBest(row):'');
    }
    if(!list.childElementCount)list.append(el('p','No matching shared items.'));
  }
  filter.onchange=redraw;redraw();
}
