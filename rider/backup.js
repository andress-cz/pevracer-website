import {openZip, writeZip} from './backup-zip.js';
import {coordinate, decodeRecording, elapsedMs, gpsDistance, speed, MAX_RECORDING_BYTES as recordingLimit} from './telemetry-codec.js';
import {sessionTitle} from './ui.js';

const MiB = 1024 * 1024;
const manifestLimit = 16 * MiB;
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const noProgress = () => {};
function requireValue(condition, message) {
  if (!condition) throw Error(message);
}
function group(items, key) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item[key])) map.set(item[key], []);
    map.get(item[key]).push(item);
  }
  return map;
}
function uniqueIds(rows, type) {
  const ids = new Set();
  for (const row of rows) {
    requireValue(typeof row?.id === 'string' && safeId.test(row.id) && !ids.has(row.id), 'Invalid or duplicate '+type+' identifier.');
    ids.add(row.id);
  }
  return ids;
}
const fields = (object, names) => Object.fromEntries(names.split(' ').filter(k => object[k] != null).map(k => [k, object[k]]));
const trackFields = 'id name mode startFinishLat startFinishLon startFinishBearingDeg finishLat finishLon finishBearingDeg gateHalfWidthM finishHalfWidthM minLat maxLat minLon maxLon createdAtEpochMs';
const sectorFields = 'index name entryLat entryLon bearingDeg halfWidthM';
const sessionFields = 'id startedAtEpochMs endedAtEpochMs raceboxName eucName eucKind usedPhoneGps sampleCount minLat maxLat minLon maxLon notes sampleFileName integrityJson trackId displayName videoSyncOffsetMs isMine videoOverlayLayoutJson videoOverlayLayoutId lapDirection ownerUserId';
const lapFields = 'id sessionId trackId lapNumber startNanos endNanos durationMs startSampleIndex endSampleIndex sectorTimesJson incomplete outLap hidden direction';
function validate(manifest) {
  requireValue(manifest?.version === 1 && /^(pev|euc)racer-backup$/.test(manifest.format),'Unsupported Android backup.');
  for (const k of ['tracks','sessions','sectors','laps','overlayLayouts']) requireValue(Array.isArray(manifest[k]),'Missing '+k+' in backup.');
  const sessions = uniqueIds(manifest.sessions, 'session'), tracks = uniqueIds(manifest.tracks, 'track');
  uniqueIds(manifest.laps, 'lap'); uniqueIds(manifest.overlayLayouts, 'layout');
  for (const session of manifest.sessions) {
    const validFile = ['.pevr.gz','.eucr.gz'].some(ext => session.sampleFileName === session.id+ext);
    requireValue(validFile && Number.isSafeInteger(session.startedAtEpochMs) && Number.isFinite(new Date(session.startedAtEpochMs).getTime()) &&
      (session.trackId == null || tracks.has(session.trackId)),'Invalid session metadata or missing track.');
  }
  for (const track of manifest.tracks) {
    const geometry = ['startFinishLat','startFinishLon','startFinishBearingDeg','minLat','minLon','maxLat','maxLon','createdAtEpochMs'];
    requireValue(typeof track.name === 'string' && ['CIRCUIT','POINT_TO_POINT'].includes(track.mode) &&
      geometry.every(k => Number.isFinite(track[k])),'Invalid track in backup.');
  }
  const keys = new Set();
  for (const sector of manifest.sectors) {
    const key = sector.trackId+'#'+sector.index;
    requireValue(tracks.has(sector.trackId) && Number.isInteger(sector.index) && typeof sector.name === 'string' &&
      Number.isFinite(sector.entryLat) && Number.isFinite(sector.entryLon) && !keys.has(key),'Invalid or duplicate sector in backup.');
    keys.add(key);
  }
  for (const lap of manifest.laps) {
    requireValue(sessions.has(lap.sessionId) && tracks.has(lap.trackId) && Number.isInteger(lap.lapNumber) &&
      Number.isInteger(lap.startSampleIndex) && Number.isInteger(lap.startNanos),'Invalid lap in backup.');
  }
}
async function owned(api, uid, table, select) {
  // Supabase can cap each request. A small stable page also bounds each metadata fetch.
  const result = [];
  for (let offset=0;;offset+=100) {
    const rows = await api.rows(table,{select,owner_id:'eq.'+uid,order:'id.asc',limit:100,offset});
    for (const row of rows) requireValue(row.owner_id===uid,'Your account changed. Open backup again.');
    result.push(...rows);
    if (rows.length<100) break;
  }
  return result;
}
async function digest(blob) {
  const hash = await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function exportBackup(api, uid, progress = noProgress) {
  requireValue(uid,'Sign in to export your library.');
  progress('Reading your tracks and sessions…');
  const [tracks,sessions] = await Promise.all([
    owned(api,uid,'tracks','id,owner_id,local_id,name,doc'),
    owned(api,uid,'sessions','id,owner_id,local_id,track_local_id,title,is_mine,meta,laps,sample_path,sample_bytes,sample_sha256')
  ]);
  const manifest = {format:'pevracer-backup',version:1,createdAtEpochMs:Date.now(),sessions:[],tracks:[],sectors:[],laps:[],overlayLayouts:[]};
  const ownedTrackIds = new Set(tracks.map(t=>t.local_id));
  for (const track of tracks) {
    requireValue(track.doc,'Track definition missing from cloud backup.');
    manifest.tracks.push({...fields(track.doc,trackFields),id:track.local_id,name:track.name});
    for (const sector of track.doc.sectors ?? []) manifest.sectors.push({...fields(sector,sectorFields),trackId:track.local_id});
  }
  let unlinked=0;
  for (const row of sessions) {
    requireValue(row.meta && row.sample_path?.startsWith(uid+'/'),'Session metadata or recording missing from your cloud library.');
    const meta=fields(row.meta,sessionFields), trackId=ownedTrackIds.has(row.track_local_id) ? row.track_local_id : null;
    // The title column always holds a name; only meta.displayName says whether the rider chose it.
    manifest.sessions.push({...meta,id:row.local_id,sampleFileName:row.local_id+'.pevr.gz',trackId,isMine:row.is_mine,
      ownerUserId:uid,displayName:meta.displayName ?? null});
    if (trackId) {
      for (const lap of row.laps ?? []) manifest.laps.push({...fields(lap,lapFields),sessionId:row.local_id,trackId});
    } else if (row.track_local_id || row.laps?.length) unlinked++;
  }
  validate(manifest);
  const metadata = new Blob([JSON.stringify(manifest)]);
  requireValue(metadata.size<=manifestLimit,'Android backups support up to 16 MB of metadata.');
  async function* files() {
    yield {name:'backup.json',blob:metadata};
    for (const [i,row] of sessions.entries()) {
      progress('Downloading recording '+(i+1)+' of '+sessions.length+'…');
      const blob = await api.download(row.sample_path);
      requireValue((row.sample_bytes==null || blob.size===row.sample_bytes) && (!row.sample_sha256 || await digest(blob)===row.sample_sha256),
        'Recording changed during download. Try exporting again.');
      yield {name:'sessions/'+row.local_id+'.pevr.gz',blob};
    }
  }
  return {blob:await writeZip(files()), sessions:sessions.length,tracks:tracks.length,unlinked};
}
async function recordingStats(blob) {
  const header=new Uint8Array(await blob.slice(0,2).arrayBuffer());
  requireValue(header[0]===31 && header[1]===139,'Backup contains an invalid recording.');
  const data=await decodeRecording(blob);
  let distance=0,peak=null,previous=null;
  for (let i=0;i<data.count;i++) {
    const point=coordinate(data,i), kmh=speed(data,i);
    if (point && previous) distance+=gpsDistance(previous,point);
    if (point) previous=point;
    if (kmh!=null) peak=peak==null ? kmh : Math.max(peak,kmh);
  }
  return {duration_ms:Math.max(0,Math.trunc(elapsedMs(data,data.count-1)-elapsedMs(data,0))),distance_m:distance,max_speed_kmh:peak};
}
async function lookup(api,table,uid,localId) {
  return (await api.rows(table,{select:'*',owner_id:'eq.'+uid,local_id:'eq.'+localId,limit:1}))[0];
}
export async function restoreBackup(file,api,uid,progress=noProgress) {
  requireValue(uid,'Sign in to restore your library.');
  progress('Validating the backup…');
  const zip=await openZip(file);
  const manifest=JSON.parse(await (await zip.read('backup.json',manifestLimit)).text());
  validate(manifest);
  requireValue(zip.entries.size===manifest.sessions.length+1,'Backup has unexpected files.');
  const [tracks,sessions]=await Promise.all([owned(api,uid,'tracks','id,local_id,owner_id'),owned(api,uid,'sessions','id,local_id,owner_id')]);
  const knownTracks=new Map(tracks.map(r=>[r.local_id,r])), knownSessions=new Set(sessions.map(r=>r.local_id));
  const sectors=group(manifest.sectors,'trackId'), laps=group(manifest.laps,'sessionId');
  const additions=[], stats=new Map();
  let skipped=0, otherRider=0;
  for (const session of manifest.sessions) {
    const name='sessions/'+session.sampleFileName;
    requireValue(zip.entries.has(name),'Backup is missing '+name+'.');
    if (session.ownerUserId && session.ownerUserId!==uid) { otherRider++; continue; }
    if (knownSessions.has(session.id)) { skipped++; continue; }
    requireValue(zip.entries.get(name).expanded<=recordingLimit,'A recording exceeds the cloud limit of 50 MB. Restore this ZIP on Android.');
    additions.push(session);
  }
  // Verify all new samples before starting writes. Re-read one recording at a time on upload.
  for (const [i,session] of additions.entries()) {
    progress('Checking recording '+(i+1)+' of '+additions.length+'…');
    stats.set(session.id,await recordingStats(await zip.read('sessions/'+session.sampleFileName,recordingLimit)));
  }
  let addedTracks=0,addedSessions=0;
  for (const track of manifest.tracks) {
    if (knownTracks.has(track.id)) continue;
    progress('Restoring track '+track.name+'…');
    const doc={format:'pevracer-track',version:1,...fields(track,trackFields),sectors:(sectors.get(track.id)??[]).map(s=>fields(s,sectorFields))};
    const payload={owner_id:uid,local_id:track.id,name:track.name,doc,visibility:'private'};
    let row;
    try {
      [row]=await api.write('tracks','POST',{},payload,'return=representation');
      addedTracks++;
    } catch (error) {
      row=await lookup(api,'tracks',uid,track.id);
      if (!row) throw error;
    }
    knownTracks.set(track.id,row);
  }
  for (const [i,session] of additions.entries()) {
    progress('Uploading recording '+(i+1)+' of '+additions.length+'…');
    const blob=await zip.read('sessions/'+session.sampleFileName,recordingLimit);
    const track=knownTracks.get(session.trackId), sessionLaps=(laps.get(session.id)??[]).map(l=>fields(l,lapFields));
    const bestLap=sessionLaps.reduce((best,lap)=>!lap.hidden && !lap.incomplete && !lap.outLap && lap.durationMs!=null
      ? Math.min(best,lap.durationMs) : best,Infinity);
    const fileName=session.id+'.pevr.gz', path=uid+'/'+crypto.randomUUID()+'.pevr.gz';
    const meta={...fields(session,sessionFields),id:session.id,ownerUserId:uid,sampleFileName:fileName};
    const payload={owner_id:uid,local_id:session.id,track_id:track?.id ?? null,track_local_id:session.trackId ?? null,
      title:sessionTitle(session.displayName,session.startedAtEpochMs),started_at:new Date(session.startedAtEpochMs).toISOString(),
      meta,laps:sessionLaps,lap_count:sessionLaps.filter(l=>!l.hidden).length,best_lap_ms:Number.isFinite(bestLap)?bestLap:null,
      is_mine:session.isMine ?? true,visibility:'private',sample_path:path,sample_bytes:blob.size,sample_sha256:await digest(blob),...stats.get(session.id)};
    await api.upload(path,blob);
    try {
      await api.write('sessions','POST',{},payload,'return=minimal');
      addedSessions++;
    } catch (error) {
      // If the insert acknowledgement was lost, keep the referenced blob. A unique path
      // lets us clean up only this attempt following an authoritative read.
      const stored=await lookup(api,'sessions',uid,session.id);
      if (stored?.sample_path===path) { addedSessions++; continue; }
      await api.removeObjects([path]);
      if (!stored) throw error;
      skipped++;
    }
  }
  return {addedSessions,addedTracks,skipped,otherRider,layouts:manifest.overlayLayouts.length};
}
export function mountBackup(container,api,uid) {
  const heading=document.createElement('h2'); heading.textContent='Android backup';
  const copy=document.createElement('p');
  copy.textContent='Download your cloud sessions and tracks as an Android backup ZIP, or restore missing items from a ZIP as private copies. Videos, device addresses and the phone’s overlay layout library stay on your device.';
  const download=document.createElement('button'); download.type='button'; download.textContent='Download backup ZIP';
  const input=document.createElement('input'); input.type='file'; input.accept='.zip,application/zip'; input.setAttribute('aria-label','Android backup ZIP');
  const restore=document.createElement('button'); restore.type='button'; restore.textContent='Restore selected ZIP'; restore.disabled=true;
  const status=document.createElement('p'); status.setAttribute('role','status');
  const progress=message=>{ status.textContent=message; };
  const row=document.createElement('div'); row.className='actions'; row.append(input,restore);
  const refresh=busy=>{ download.disabled=busy; input.disabled=busy; restore.disabled=busy || !input.files?.length; };
  input.onchange=()=>refresh(false);
  async function run(action) {
    refresh(true);
    try { await action(); }
    catch (error) { progress((error.message || 'Backup failed.')+' You can retry safely. Completed items are kept.'); }
    finally { refresh(false); }
  }
  download.onclick=()=>run(async()=>{
    const result=await exportBackup(api,uid,progress), url=URL.createObjectURL(result.blob);
    const a=document.createElement('a'); a.download='pevracer-backup-'+new Date().toISOString().slice(0,10)+'.zip'; a.href=url;
    a.click(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    progress('Backup ready with '+result.sessions+' sessions and '+result.tracks+' tracks.'+(result.unlinked ? ' '+result.unlinked+' sessions had an unavailable track and were exported without lap results.' : ''));
  });
  restore.onclick=()=>run(async()=>{
    const result=await restoreBackup(input.files[0],api,uid,progress);
    progress('Restored '+result.addedSessions+' sessions and '+result.addedTracks+' tracks. Kept '+result.skipped+' existing sessions.'+
      (result.otherRider ? ' Skipped '+result.otherRider+' sessions belonging to another account.' : '')+
      (result.layouts ? ' '+result.layouts+' overlay layouts remain in the Android ZIP.' : ''));
  });
  container.append(heading,copy,download,row,status);
}
