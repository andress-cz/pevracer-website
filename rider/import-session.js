import {coordinate, elapsedMs, fields, gpsDistance, speed} from './telemetry-codec.js';

const recordBytes = 176;
const maxRecording = 50 * 1024 * 1024;
async function sha256(blob) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
// Android writes header and records with DataOutputStream, in network byte order.
export async function androidRecording(data) {
  if (!globalThis.CompressionStream) throw Error('This browser cannot create an Android recording file.');
  const rowsPerChunk=512;
  let index=0;
  const bytes=new ReadableStream({
    start(controller){ controller.enqueue(new Uint8Array([80,69,86,82,0,1,0,0])); },
    pull(controller){
      if(index>=data.count){controller.close();return;}
      const end=Math.min(data.count,index+rowsPerChunk);
      const chunk=new Uint8Array((end-index)*recordBytes), view=new DataView(chunk.buffer);
      let offset=0;
      for(;index<end;index++){
        for(const field of fields){
          const value=data.get(index,field);
          if (field==='elapsed_ns' || field==='utc_ms' || field==='gap_ms') {
            const n=BigInt(value??-1);
            if(BigInt.asIntN(64,n)!==n)throw Error('A timestamp exceeds the Android recording format.');
            view.setBigInt64(offset,n);offset+=8;
          } else if(field==='battery_pct' || field==='source_flags') {
            view.setInt32(offset,value??(field==='battery_pct'?-2147483648:0));offset+=4;
          } else {view.setFloat64(offset,value??NaN);offset+=8;}
        }
      }
      controller.enqueue(chunk);
    }
  }).pipeThrough(new CompressionStream('gzip'));
  return new Response(bytes).blob();
}
export async function saveImported(ctx,data,name,file,mine=false) {
  const {uid,api}=ctx;
  if(!uid || !data.count)throw Error('Sign in and choose a recording to import.');
  const sourceHash=await sha256(file);
  const id='web-'+sourceHash;
  const lookup=async()=>(await api.rows('sessions',{select:'id,sample_path',owner_id:'eq.'+uid,local_id:'eq.'+id,limit:1}))[0];
  const current=await lookup();
  if(current)return current;
  const head=new Uint8Array(await file.slice(0,2).arrayBuffer());
  const original=head[0]===31 && head[1]===139;
  const blob=original?file:await androidRecording(data);
  if(blob.size>maxRecording)throw Error('The compressed recording exceeds the 50 MB cloud limit.');
  const hash=original?sourceHash:await sha256(blob),path=uid+'/'+crypto.randomUUID()+'.pevr.gz';
  let previous=null,distance=0,peak=null;
  const bounds={minLat:null,maxLat:null,minLon:null,maxLon:null};
  for(let i=0;i<data.count;i++){
    const p=coordinate(data,i), velocity=speed(data,i);
    if(p){
      if(previous)distance+=gpsDistance(previous,p);
      previous=p;
      bounds.minLat=Math.min(bounds.minLat??p[0],p[0]);bounds.maxLat=Math.max(bounds.maxLat??p[0],p[0]);
      bounds.minLon=Math.min(bounds.minLon??p[1],p[1]);bounds.maxLon=Math.max(bounds.maxLon??p[1],p[1]);
    }
    if(velocity!=null)peak=Math.max(peak??velocity,velocity);
  }
  const duration=Math.max(0,Math.round(elapsedMs(data,data.count-1)-elapsedMs(data,0)));
  const started=data.get(0,'utc_ms') ?? file.lastModified ?? Date.now();
  const ended=data.get(data.count-1,'utc_ms') ?? started+duration;
  const title=name.slice(0,160)||'Imported session';
  const row={owner_id:uid,local_id:id,title,started_at:new Date(started).toISOString(),duration_ms:duration,
    distance_m:distance,max_speed_kmh:peak,is_mine:mine===true,visibility:'private',laps:[],lap_count:0,
    sample_path:path,sample_bytes:blob.size,sample_sha256:hash,
    meta:{id,ownerUserId:uid,sampleFileName:id+'.pevr.gz',displayName:title,notes:'imported',isMine:mine===true,
      sampleCount:data.count,startedAtEpochMs:started,endedAtEpochMs:ended,...bounds}};
  await api.upload(path,blob);
  try{
    const [inserted]=await api.write('sessions','POST',{select:'id,sample_path'},row,'return=representation');
    return inserted;
  }catch(error){
    // A lost response can follow a successful insert. Check before removing our object.
    const saved=await lookup();
    if(saved?.sample_path===path)return saved;
    await api.removeObjects([path]);
    if(saved)return saved;
    throw error;
  }
}
