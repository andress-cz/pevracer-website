import {createSatelliteMap,L} from './rider/satellite-map.js';
import {practiceRide} from './assets/practice.js';

const seek = document.querySelector('#seek');
const play = document.querySelector('#play');
const points = practiceRide;
const last = points.length - 1;
const duration = points[last][3];
const speedMin = Math.min(...points.map(p => p[2]));
const speedMax = Math.max(...points.map(p => p[2]));
let cursor = 0, animation = null, startedAt = 0, startTime = 0;

function color(speed) {
  const f = (speed - speedMin) / (speedMax - speedMin);
  const palette = [[88,201,173],[191,243,71],[255,197,97]];
  const k = f < 0.5 ? 0 : 1;
  return 'rgb(' + palette[k].map((c,i) => Math.round(c + (palette[k+1][i]-c)*(f*2-k))).join(',') + ')';
}
const route = points.slice(0,151).map(p => [p[0],p[1]]);
const map = createSatelliteMap(document.querySelector('#track'),{center:route[0],zoom:16});
L.polyline(route,{weight:7,color:'#182822',interactive:false}).addTo(map);
for (let i=1;i<route.length;i++) {
  L.polyline([route[i-1],route[i]],{weight:4,color:color(points[i][2]),interactive:false}).addTo(map);
}
map.pevSetHome(L.latLngBounds(route),{padding:[32,32],maxZoom:19,animate:false});
const marker = L.circleMarker(route[0],{radius:6,color:'#fff',weight:2,fillColor:'#a9e542',fillOpacity:1,interactive:false}).addTo(map);
function render(index) {
  cursor = Math.min(last,Math.max(0,index));seek.value=cursor;
  const p=points[cursor], seconds=Math.floor(p[3]);
  const elapsed=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  document.querySelector('#elapsed').textContent=elapsed;
  document.querySelector('#speed').textContent=p[2].toFixed(1);
  document.querySelector('#distance').textContent=(p[4]/1000).toFixed(2);
  seek.setAttribute('aria-valuetext',elapsed+' elapsed, '+p[2].toFixed(1)+' kilometres per hour');
  marker.setLatLng([p[0],p[1]]);
}
function pause() {
  cancelAnimationFrame(animation); animation=null; play.setAttribute('aria-label','Play simulated ride');
}
function step(now) {
  const t=startTime+(now-startedAt)/1000;
  const index=Math.min(last,Math.floor(t*last/duration));
  if(index!==cursor) render(index);
  if(index===last) pause(); else animation=requestAnimationFrame(step);
}
seek.max=last;
seek.addEventListener('input',() => {pause();render(Number(seek.value));});
play.addEventListener('click',() => {
  if(animation!==null) return pause();
  if(cursor===last) render(0);
  startTime=points[cursor][3];startedAt=performance.now();
  play.setAttribute('aria-label','Pause simulated ride');animation=requestAnimationFrame(step);
});
document.addEventListener('visibilitychange',() => {if(document.hidden) pause();});
render(0);
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click',() => {
  const view=btn.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed',String(b===btn)));
  const img=document.querySelector('#app-shot');
  img.src='assets/ride-'+view+'.png';
  img.alt=view==='map'?'PEV Racer session map with a speed-colored route, playback controls and telemetry chart.':'PEV Racer ride statistics showing duration, distance, maximum speed and sample count.';
}));
