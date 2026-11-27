// Android's TrackCodec reads a missing, zero or invalid half-width as the 15 m default.
export const DEFAULT_HALF_WIDTH_M = 15;
export const halfWidth = (value, fallback = DEFAULT_HALF_WIDTH_M) => Number.isFinite(value) && value > 0 ? value : fallback;

// The first native sector shares the start gate. Later sectors have their own timing lines.
export function gatesOf(doc) {
  const gates = [{
    name: doc.mode === 'CIRCUIT' ? 'Start / finish' : 'Start',
    lat: doc.startFinishLat, lon: doc.startFinishLon, bearing: doc.startFinishBearingDeg,
    width: halfWidth(doc.gateHalfWidthM), key: 'start',
  }];
  for (const s of [...(doc.sectors ?? [])].sort((a,b) => a.index - b.index)) {
    if (s.index === 0) continue;
    gates.push({name:s.name, lat:s.entryLat, lon:s.entryLon, bearing:s.bearingDeg ?? doc.startFinishBearingDeg,
      width:halfWidth(s.halfWidthM), key:'sector-' + s.index});
  }
  if (doc.mode === 'POINT_TO_POINT') gates.push({
    name:'Finish', lat:doc.finishLat, lon:doc.finishLon, bearing:doc.finishBearingDeg ?? doc.startFinishBearingDeg,
    width:halfWidth(doc.finishHalfWidthM, halfWidth(doc.gateHalfWidthM)), key:'finish',
  });
  return gates;
}
