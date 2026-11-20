import {coordinate} from './telemetry-codec.js';

export function heatmapPoints(data,limit=500){
  const points=[],step=Math.max(1,Math.ceil(data.count/limit));
  for(let i=0;i<data.count;i+=step){const point=coordinate(data,i);if(point)points.push(point);}
  return points;
}
