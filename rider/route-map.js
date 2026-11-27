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
// Point `metres` away from lat/lon along `bearing` degrees, in local flat metres.
function offset(lat,lon,bearing,metres){
  const b=bearing*radians;
  return [lat+Math.cos(b)*metres/metersPerDegree,lon+Math.sin(b)*metres/(metersPerDegree*Math.max(.0001,Math.cos(lat*radians)))];
}
/** Shaft from the gate centre along its travel bearing, with an arrowhead: [[tip, base], [left, tip, right]]. */
export function directionArrow(lat,lon,bearing,halfWidth){
  const length=Math.max(6,Math.min(40,halfWidth*.9)),head=length*.4;
  const tip=offset(lat,lon,bearing,length);
  return [[[lat,lon],tip],[offset(tip[0],tip[1],bearing+150,head),tip,offset(tip[0],tip[1],bearing-150,head)]];
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
    // Arrow in the direction a rider must cross the gate (laps ridden the other way round
    // cross every gate reversed and still time).
    const arrow=directionArrow(gate.lat,lon,gate.bearing??0,halfWidth);
    L.polyline(arrow,{color:'#0d211b',weight:6,interactive:false,lineCap:'round',lineJoin:'round'}).addTo(group);
    L.polyline(arrow,{color,weight:2.5,interactive:false,lineCap:'round',lineJoin:'round'}).addTo(group);
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

export function mountGateMap(host,{onPlace,onSelect,route=[]}={}){
  const map=createSatelliteMap(host);
  if(route.length){
    const center=route[Math.floor(route.length/2)].lon;
    const points=route.filter(point=>validPoint(point.lat,point.lon))
      .map(point=>[point.lat,nearLongitude(point.lon,center)]);
    if(points.length>1){
      L.polyline(points,{color:'#f1f4ec',weight:8,opacity:.95,interactive:false}).addTo(map);
      L.polyline(points,{color:'#168bdd',weight:4,opacity:1,interactive:false}).addTo(map);
    }
  }
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

function routeSegments(data,summary,first=0,last=data.count-1) {
  // Combine adjacent segments of similar speed into a small number of vector
  // layers. Keep segment breaks at missing GPS fixes, even when decimating.
  const buckets=Array.from({length:16},()=>[]);
  const routes=[];
  const step=Math.max(1,Math.ceil((last-first+1)/12000));
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
  for(let i=first;i<=last;i++){
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
  const primaryTrail=L.layerGroup().addTo(map),comparisonTrail=L.layerGroup().addTo(map);
  const style={interactive:false,opacity:1,smoothFactor:.5,lineCap:'round',lineJoin:'round'};
  function drawTrail(group,recording,recordingSummary,first,last,ghost=false){
    group.clearLayers();
    const {routes,buckets}=routeSegments(recording,recordingSummary,first,last);
    L.polyline(routes,{...style,weight:6,color:'#16241f',opacity:.9}).addTo(group);
    buckets.forEach((lines,index)=>{
      if(!lines.length)return;
      const hue=ghost ? 34-index*11 : 163-index*93/(buckets.length-1);
      L.polyline(lines,{...style,weight:3.5,color:'hsl('+hue+' 85% 65%)'}).addTo(group);
    });
  }
  if(trackDoc)drawGates(L.layerGroup().addTo(map),trackDoc,{longitude:summary.centerLon});
  const bounds=L.latLngBounds([summary.south,summary.west],[summary.north,summary.east]);
  map.pevSetHome(bounds,homeOptions);
  const primary=L.circleMarker(center,{className:'replay-primary',radius:6,weight:2,color:'#fff',fillColor:'#23569e',fillOpacity:1,interactive:false});
  // A larger ring remains visible around the primary dot when riders overlap.
  const comparison=L.circleMarker(center,{className:'replay-comparison',radius:10,weight:4,color:'#ffb24d',fillColor:'#3a2414',fillOpacity:.7,interactive:false});
  function place(marker,point){
    if(!point){marker.remove();return null;}
    const pos=L.latLng(point[0],nearLongitude(point[1],summary.centerLon));
    marker.setLatLng(pos);
    if(!map.hasLayer(marker))marker.addTo(map);
    return pos;
  }
  const update=(point,other,follow)=>{
    const addingGhost=other && !map.hasLayer(comparison);
    const ghost=place(comparison,other),current=place(primary,point);
    if(addingGhost && current)primary.bringToFront();
    if(!follow || !(current||ghost))return;
    const focus=current||ghost;
    let zoom=map.getZoom();
    if(current && ghost){
      // Keep both riders in frame while centering the camera on the active lap.
      const padding=26, size=map.getSize();
      const delta=map.project(ghost,zoom).subtract(map.project(current,zoom));
      const ratio=Math.max(Math.abs(delta.x)/Math.max(1,size.x/2-padding),Math.abs(delta.y)/Math.max(1,size.y/2-padding));
      if(ratio>1)zoom=Math.max(map.getMinZoom(),zoom-Math.ceil(Math.log2(ratio)));
    }
    if(zoom!==map.getZoom() || map.project(map.getCenter(),zoom).distanceTo(map.project(focus,zoom))>=1){
      map.setView(focus,zoom,{animate:false});
    }
  };
  update.setScope=(first,last,otherData,otherSummary,otherFirst,otherLast)=>{
    drawTrail(primaryTrail,data,summary,first,last);
    if(otherData&&otherSummary)drawTrail(comparisonTrail,otherData,otherSummary,otherFirst,otherLast,true);
    else comparisonTrail.clearLayers();
  };
  update.setScope(0,data.count-1);
  return update;
}
