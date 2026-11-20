import {createSatelliteMap, L} from './satellite-map.js';
import {coordinate, speed} from './telemetry-codec.js';
import {gatesOf} from './track-gates.js';

const radians=Math.PI/180;
const metersPerDegree=6371000*radians;
const homeOptions={padding:[30,30],maxZoom:19,animate:false};

// Place coordinates on the same copy of the world, including routes that cross 180°.
function nearLongitude(lon,reference) {
  return reference + ((lon-reference+540)%360+360)%360-180;
}
function validPoint(lat,lon){
  return Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lon)&&Math.abs(lon)<=180;
}
function drawGates(group,doc,{selected,longitude,onSelect}={}){
  group.clearLayers();
  const bounds=L.latLngBounds([]);
  for(const gate of gatesOf(doc)){
    if(!validPoint(gate.lat,gate.lon))continue;
    longitude??=gate.lon;
    const lon=nearLongitude(gate.lon,longitude);
    const center=[gate.lat,lon];
    const halfWidth=Number.isFinite(gate.width)?Math.max(0,gate.width):15;
    // A timing line runs perpendicular to travel. Longitude degrees get
    // shorter toward the poles, so use local metres for the gate width.
    const travel=(gate.bearing??0)*radians;
    const latOffset=Math.sin(travel)*halfWidth/metersPerDegree;
    const lonOffset=Math.cos(travel)*halfWidth/(metersPerDegree*Math.max(.0001,Math.cos(gate.lat*radians)));
    const ends=[[gate.lat+latOffset,lon-lonOffset],[gate.lat-latOffset,lon+lonOffset]];
    const color=gate.key===selected?'#feee64':gate.key==='start'?'#c1fa42':'#62eaff';
    const opt={interactive:!!onSelect,bubblingMouseEvents:false,opacity:1};
    L.polyline(ends,{color:'#0d211b',weight:7,interactive:false}).addTo(group);
    const gateLine=L.polyline(ends,{...opt,color,weight:3}).addTo(group);
    const dot=L.circleMarker(center,{...opt,radius:gate.key===selected?6:4,color:'#10201b',
      weight:2,fillColor:color,fillOpacity:1}).addTo(group);
    const label=document.createElement('span');
    label.textContent=gate.name||(gate.key==='finish'?'Finish':'Sector');
    dot.bindTooltip(label,{permanent:true,direction:'right',offset:[7,-3],className:'pev-gate-label'});
    if(onSelect){
      const activate=()=>onSelect(gate.key);
      gateLine.on('click',activate);dot.on('click',activate);
    }
    bounds.extend(ends[0]).extend(ends[1]);
  }
  if(validPoint(doc.minLat,doc.minLon)&&validPoint(doc.maxLat,doc.maxLon)){
    longitude??=doc.minLon;
    bounds.extend([doc.minLat,nearLongitude(doc.minLon,longitude)]);
    bounds.extend([doc.maxLat,nearLongitude(doc.maxLon,longitude)]);
  }
  return bounds;
}

export function mountGateMap(host,{onPlace,onSelect}={}){
  const map=createSatelliteMap(host);
  const gates=L.layerGroup().addTo(map);
  let hasBounds=false;
  if(onPlace)map.on('click',event=>onPlace(event.latlng.wrap()));
  return {
    draw(doc,selected,placing,refit=false){
      const bounds=drawGates(gates,doc,{selected,onSelect:placing?null:onSelect});
      if(!bounds.isValid()){hasBounds=false;return;}
      map.pevSetHome(bounds,homeOptions,refit||!hasBounds);
      hasBounds=true;
    },
    reveal(lat,lon){
      if(!validPoint(lat,lon))return;
      const point=[lat,nearLongitude(lon,map.getCenter().lng)];
      if(!map.getBounds().contains(point))map.panTo(point,{animate:false});
    },
    remove(){map.remove();}
  };
}

function routeSegments(data,summary) {
  // Combine adjacent segments of similar speed into a small number of vector
  // layers. Keep segment breaks at missing GPS fixes, even when decimating.
  const buckets=Array.from({length:16},()=>[]);
  const routes=[];
  const step=Math.max(1,Math.ceil(summary.points/12000));
  let section=null,previous=null,previousBucket=-1,lastFix=null,since=0;
  function add(point,i){
    if(!previous){section=[point];routes.push(section);}
    else{
      section.push(point);
      const kmh=speed(data,i),ratio=Math.min(1,Math.max(0,summary.peak>0?(kmh??0)/summary.peak:0));
      const bucket=Math.round(ratio*(buckets.length-1));
      if(previousBucket!==bucket)buckets[bucket].push([previous]);
      buckets[bucket].at(-1).push(point);
      previousBucket=bucket;
    }
    previous=point;since=0;
  }
  function finish(){
    if(lastFix&&since)add(lastFix.point,lastFix.i);
    section=null;previous=null;previousBucket=-1;lastFix=null;
  }
  for(let i=0;i<data.count;i++){
    const pos=coordinate(data,i);
    if(!pos){finish();continue;}
    const point=[pos[0],nearLongitude(pos[1],summary.centerLon)];
    lastFix={point,i};
    if(!previous||++since>=step)add(point,i);
  }
  finish();
  return {routes,buckets};
}

export function mountReplayMap(host,data,summary,trackDoc){
  const center=[(summary.south+summary.north)/2,(summary.west+summary.east)/2];
  const map=createSatelliteMap(host,{center,zoom:16});
  const {routes,buckets}=routeSegments(data,summary);
  const style={interactive:false,opacity:1,smoothFactor:.5,lineCap:'round',lineJoin:'round'};
  L.polyline(routes,{...style,weight:6,color:'#16241f',opacity:.9}).addTo(map);
  buckets.forEach((lines,index)=>{
    if(!lines.length)return;
    const hue=163-index*93/(buckets.length-1);
    L.polyline(lines,{...style,weight:3.5,color:'hsl('+hue+' 85% 65%)'}).addTo(map);
  });
  if(trackDoc)drawGates(L.layerGroup().addTo(map),trackDoc,{longitude:summary.centerLon});
  const bounds=L.latLngBounds([summary.south,summary.west],[summary.north,summary.east]);
  map.pevSetHome(bounds,homeOptions);
  const marker=L.circleMarker(center,{radius:6,weight:3,color:'white',fillColor:'#2f4561',fillOpacity:1,interactive:false});
  return index=>{
    const point=coordinate(data,index);
    if(!point){marker.remove();return;}
    marker.setLatLng([point[0],nearLongitude(point[1],summary.centerLon)]);
    if(!map.hasLayer(marker))marker.addTo(map);
  };
}
