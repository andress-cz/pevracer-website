import {createPainter} from './video-layout.js';
import {mountLayoutEditor} from './video-layout-editor.js';

function node(tag,text,cls) {
  const el=document.createElement(tag);
  if(text!=null)el.textContent=text;
  if(cls)el.className=cls;
  return el;
}
function button(label,handler){
  const b=node('button',label);b.type='button';b.addEventListener('click',handler);return b;
}
function supportedMime() {
  if(!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream)return null;
  return ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']
    .find(type=>MediaRecorder.isTypeSupported(type))||null;
}
export function mountVideo(host,context){
  if(!document.querySelector('link[data-video-layout]')){
    const css=node('link');css.rel='stylesheet';css.href=new URL('telemetry-video.css',import.meta.url).href;
    css.dataset.videoLayout='';document.head.append(css);
  }
  const paint=createPainter(context);
  const outer=node('details',null,'tel-video');outer.append(node('summary','Video overlay'));
  const input=node('input');input.type='file';input.accept='video/*';
  const picker=node('label','Choose a local ride video','tel-field');picker.append(input);
  const area=node('div'),status=node('p');status.setAttribute('role','status');
  outer.append(picker,area,status);host.replaceChildren(outer);
  let url=null, video=null, cleanupClip=()=>{}, audioCtx=null;
  function release() {
    cleanupClip();cleanupClip=()=>{};
    if(video){video.pause();video.removeAttribute('src');video.load();video=null;}
    if(url)URL.revokeObjectURL(url);
    if(audioCtx){audioCtx.close().catch(()=>{});audioCtx=null;}
    url=null;
  }
  input.onchange=()=>{
    release();area.replaceChildren();status.textContent='';
    const file=input.files[0];
    if(!file)return;
    url=URL.createObjectURL(file);video=node('video');video.controls=true;video.preload='metadata';video.playsInline=true;
    video.src=url;
    const box=node('div',null,'tel-video-stage'),hud=node('output',null,'tel-hud');
    const overlay=node('canvas',null,'pev-video-layer');
    overlay.setAttribute('aria-hidden','true');
    box.append(video,overlay,hud);
    const align=button('Align selected moments',()=>{
      if(!Number.isFinite(video.duration))return;
      offset=context.current()-video.currentTime*1000;
      offsetField.value=String(Math.round(offset)/1000);
      preview();
    });
    const offsetField=node('input');
    offsetField.type='number';offsetField.step='0.001';offsetField.value='0';
    const offsetLabel=node('label','Ride time at video start (s)','tel-field');offsetLabel.append(offsetField);
    const controls=node('div',null,'pev-video-controls'), alignment=node('div',null,'tel-controls');
    alignment.append(offsetLabel,align);controls.append(alignment);
    let layout={version:1,widgets:[]};
    let offset=0,recorder=null,frame=null,previewFrame=null,destroyed=false,playSync=false,preparing=false;
    // Following is optional so the rider can select matching moments independently.
    const follow=node('input');follow.type='checkbox';
    const followLabel=node('label',null,'tel-check');followLabel.append(follow,document.createTextNode('Follow video on the route'));
    function preview(){
      if(destroyed)return;
      const t=video.currentTime*1000+offset;
      if(!video.videoWidth || !video.videoHeight) return;
      const size=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));
      const width=Math.max(2,Math.round(video.videoWidth*size/2)*2),height=Math.max(2,Math.round(video.videoHeight*size/2)*2);
      if(overlay.width!==width || overlay.height!==height){overlay.width=width;overlay.height=height;}
      const ratio=Math.min(video.clientWidth/video.videoWidth,video.clientHeight/video.videoHeight);
      overlay.style.width=video.videoWidth*ratio+'px';overlay.style.height=video.videoHeight*ratio+'px';
      const ctx=overlay.getContext('2d');ctx.clearRect(0,0,width,height);
      const description=paint(ctx,width,height,layout,t);
      if(hud.textContent!==description)hud.textContent=description;
      if(playSync)context.seek(t);
    }
    follow.onchange=()=>{playSync=follow.checked;preview();};
    offsetField.oninput=()=>{offset=Number(offsetField.value)||0;preview();};
    mountLayoutEditor(controls,{initial:context.layoutJson,onChange:value=>{layout=value;preview();}});
    const resize=new ResizeObserver(preview);resize.observe(video);
    function playPreview(){
      cancelAnimationFrame(previewFrame);
      function tick(){
        if(destroyed||video.paused||video.ended)return;
        if(!recorder||recorder.state==='inactive')preview();
        previewFrame=requestAnimationFrame(tick);
      }
      tick();
    }
    video.addEventListener('play',playPreview);
    video.addEventListener('timeupdate',preview);video.addEventListener('loadedmetadata',preview);
    video.addEventListener('error',()=>{if(!destroyed)status.textContent='This browser could not play the selected video.';});
    const mime=supportedMime();
    let audioSource=null,audioOut=null;
    const exportButton=button('Export overlay video',async()=>{
      if(preparing || !mime||!Number.isFinite(video.duration))return;
      if(recorder && recorder.state!=='inactive'){recorder.stop();return;}
      const last=context.times[context.times.length-1];
      const from=Math.max(0,-offset/1000),to=Math.min(video.duration,(last-offset)/1000);
      if(to<=from){status.textContent='Align the video with a time inside the recording before exporting.';return;}
      const clip=video;
      const canvas=node('canvas'),scale=Math.min(1,1280/Math.max(clip.videoWidth,clip.videoHeight));
      canvas.width=Math.max(2,Math.round(clip.videoWidth*scale/2)*2);
      canvas.height=Math.max(2,Math.round(clip.videoHeight*scale/2)*2);
      const ctx=canvas.getContext('2d'),chunks=[];
      let stream=null;
      try{
        preparing=true; controls.inert=true;input.disabled=true;exportButton.disabled=true;
        clip.pause();clip.currentTime=from;
        if(clip.seeking)await new Promise((resolve,reject)=>{
          const done=()=>{clearTimeout(timer);resolve();};
          const timer=setTimeout(()=>{clip.removeEventListener('seeked',done);reject(Error('Video seek timed out.'));},5000);
          clip.addEventListener('seeked',done,{once:true});
        });
        if(destroyed)return;
        stream=canvas.captureStream(30);
        if(globalThis.AudioContext) {
          if(!audioCtx) {
            audioCtx=new AudioContext();audioSource=audioCtx.createMediaElementSource(clip);
            audioOut=audioCtx.createMediaStreamDestination();audioSource.connect(audioOut);
            audioSource.connect(audioCtx.destination);
          }
          await audioCtx.resume();
          audioOut.stream.getAudioTracks().forEach(track=>stream.addTrack(track.clone()));
        }
        if(destroyed){stream.getTracks().forEach(track=>track.stop());return;}
        recorder=new MediaRecorder(stream,{mimeType:mime});
        const exportLayout=structuredClone(layout);
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recorder.onstop=()=>{
          cancelAnimationFrame(frame);
          stream.getTracks().forEach(track=>track.stop());
          if(destroyed)return;
          clip.pause();clip.controls=true;controls.inert=false;input.disabled=false;exportButton.textContent='Export overlay video';
          if(!chunks.length){status.textContent='The browser could not export the clip.';return;}
          const outURL=URL.createObjectURL(new Blob(chunks,{type:mime}));
          const link=node('a');link.href=outURL;link.download=context.name+'-overlay.'+(mime.includes('webm')?'webm':'mp4');
          document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(outURL),45000);
          status.textContent='Overlay video exported.';
        };
        function draw(){
          if(destroyed || recorder.state==='inactive')return;
          ctx.drawImage(clip,0,0,canvas.width,canvas.height);
          paint(ctx,canvas.width,canvas.height,exportLayout,clip.currentTime*1000+offset);
          if(clip.ended || clip.currentTime>=to){recorder.stop();return;}
          frame=requestAnimationFrame(draw);
        }
        controls.inert=true;input.disabled=true;clip.controls=false;
        exportButton.textContent='Finish export here';status.textContent='Exporting in real time. Keep this tab visible.';
        recorder.start(1000);draw();preparing=false;exportButton.disabled=false;await clip.play();
      }catch(error){
        if(recorder && recorder.state!=='inactive')recorder.stop();
        if(stream)stream.getTracks().forEach(track=>track.stop());
        if(!destroyed){preparing=false;exportButton.disabled=false;clip.controls=true;controls.inert=false;input.disabled=false;exportButton.textContent='Export overlay video';status.textContent=error.message||'Video export failed.';}
      }
    });
    area.append(box,node('p','Pause the video and the ride replay at the same moment, then align them.'),controls,followLabel);
    if(mime)area.append(exportButton);else area.append(node('p','Video export requires a browser with canvas capture and MediaRecorder.'));
    cleanupClip=()=>{destroyed=true;resize.disconnect();cancelAnimationFrame(previewFrame);cancelAnimationFrame(frame);if(recorder && recorder.state!=='inactive')recorder.stop();};
  };
  const observer=new MutationObserver(()=>{if(!host.isConnected){observer.disconnect();release();}});
  observer.observe(document.body,{childList:true,subtree:true});
}
