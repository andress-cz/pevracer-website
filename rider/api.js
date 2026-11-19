import {GoTrueClient} from './vendor/auth.js';

const url = 'https://aodcdlppxanhepryuypf.supabase.co';
const apikey = 'sb_publishable_1fRFiQLFCuhHqKFlXP75sg_iUnMvfH5';
export const auth = new GoTrueClient({
  url:url+'/auth/v1', headers:{apikey}, storageKey:'pev-rider-auth-v1', flowType:'pkce',
  autoRefreshToken:true, persistSession:true, detectSessionInUrl:true
});

export function client(uid) {
  async function request(path,method='GET',body,prefer) {
    const {data,error}=await auth.getSession();
    if(error || data.session?.user.id!==uid) throw Error('Your sign-in has changed. Sign in again.');
    const headers={apikey,Authorization:'Bearer '+data.session.access_token};
    if(prefer) headers.Prefer=prefer;
    const binary=body instanceof Blob;
    if(body!==undefined) headers['Content-Type']=binary?'application/octet-stream':'application/json';
    const response=await fetch(url+path,{method,headers,body:binary?body:JSON.stringify(body),cache:'no-store'});
    if(!response.ok){
      const info=await response.json().catch(()=>({}));
      const failure=Error(info.message||info.error_description||'The service returned '+response.status+'. Try again.');
      failure.code=info.code; failure.status=response.status; throw failure;
    }
    return response;
  }
  const query=(table,params={})=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  function object(path){
    const parts=typeof path==='string'?path.split('/'):[];
    if(parts.length!==2||parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\')))throw Error('Invalid recording path.');
    return parts.map(encodeURIComponent).join('/');
  }
  async function rows(table,params){return (await request(query(table,params))).json();}
  return {
    rows,
    async all(table,params={}){
      const results=[];
      for(let offset=0;;offset+=250){
        const page=await rows(table,{...params,limit:250,offset});
        results.push(...page);
        if(page.length<250)return results;
      }
    },
    async write(table,method,params={},body,prefer){
      const response=await request(query(table,params),method,body,prefer);
      const text=await response.text(); return text?JSON.parse(text):null;
    },
    async rpc(name,args={}){const response=await request('/rest/v1/rpc/'+name,'POST',args);const text=await response.text();return text?JSON.parse(text):null;},
    async download(path){return (await request('/storage/v1/object/authenticated/recordings/'+object(path))).blob();},
    async upload(path,blob){await request('/storage/v1/object/recordings/'+object(path),'POST',blob);},
    async removeObjects(paths){await request('/storage/v1/object/recordings','DELETE',{prefixes:paths});},
    async purgeAccount(){
      for(let page=0;page<100;page++){
        const objects=await (await request('/storage/v1/object/list/recordings','POST',{prefix:uid,limit:500})).json();
        if(!objects.length){await this.rpc('delete_account');return;}
        await this.removeObjects(objects.map(file=>uid+'/'+file.name));
      }
      throw Error('More recordings remain. Try deletion again to continue.');
    }
  };
}
