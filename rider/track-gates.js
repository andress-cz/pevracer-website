// The first native sector shares the start gate. Later sectors have their own timing lines.
export function gatesOf(doc) {
  const gates = [{
    name: doc.mode === 'CIRCUIT' ? 'Start / finish' : 'Start',
    lat: doc.startFinishLat, lon: doc.startFinishLon, bearing: doc.startFinishBearingDeg,
    width: doc.gateHalfWidthM ?? 15, key: 'start',
  }];
  for (const s of [...(doc.sectors ?? [])].sort((a,b) => a.index - b.index)) {
    if (s.index === 0) continue;
    gates.push({name:s.name, lat:s.entryLat, lon:s.entryLon, bearing:s.bearingDeg ?? doc.startFinishBearingDeg,
      width:s.halfWidthM ?? 15, key:'sector-' + s.index});
  }
  if (doc.mode === 'POINT_TO_POINT') gates.push({
    name:'Finish', lat:doc.finishLat, lon:doc.finishLon, bearing:doc.finishBearingDeg ?? doc.startFinishBearingDeg,
    width:doc.finishHalfWidthM ?? doc.gateHalfWidthM ?? 15, key:'finish',
  });
  return gates;
}
