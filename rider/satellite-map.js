import * as L from './vendor/leaflet/leaflet.js';
export {L};

const overviewUrl = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
const worldCoverUrl = 'https://wmts.terrascope.be/?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=esa-worldcover-s2rgbnir-10m-2021-v2_tcc&STYLE=default&FORMAT=image/png&TILEMATRIXSET=EPSG:3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&TIME=2021-01-01';
const czechUrl = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}';
const czechBounds = L.latLngBounds([48.55,12.09],[51.06,18.87]);
const maps = new Map();
const removalObserver = new MutationObserver(() => {
  for (const [host,map] of maps) if (!host.isConnected) map.remove();
});

export function createSatelliteMap(host,{center=[25,0],zoom=2}={}) {
  const map = L.map(host,{center,zoom,minZoom:1,maxZoom:22,zoomAnimation:false});
  const overview = L.tileLayer(overviewUrl,{maxNativeZoom:8,maxZoom:22,zIndex:1,attribution:'<a href="https://earthdata.nasa.gov/gibs">NASA Blue Marble</a>'});
  const world = L.tileLayer(worldCoverUrl,{minZoom:8,maxNativeZoom:14,maxZoom:22,zIndex:2,attribution:'© <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover project 2021</a> · Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>'});
  const czech = L.tileLayer(czechUrl,{bounds:czechBounds,minZoom:14,maxNativeZoom:20,maxZoom:22,zIndex:3,attribution:'© <a href="https://geoportal.cuzk.gov.cz/">ČÚZK</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>'});
  const layers = [overview,world,czech];
  function refreshImagery() {
    if (!host.clientWidth || !host.clientHeight) return;
    const level = map.getZoom(), view = map.getBounds();
    const active = [level <= 8 || view.getSouth() < -60 || view.getNorth() > 83,
      level >= 8 && view.getNorth() >= -60 && view.getSouth() <= 83,
      level >= 14 && view.intersects(czechBounds)];
    layers.forEach((layer,index) => {
      if (active[index] && !map.hasLayer(layer)) layer.addTo(map);
      else if (!active[index] && map.hasLayer(layer)) layer.remove();
    });
  }
  let home, pendingFit = false;
  function fit() {
    if (!home || !host.clientWidth || !host.clientHeight) return;
    pendingFit = false;
    map.fitBounds(home.bounds,home.options);
  }
  const fitControl = L.control({position:'topleft'});
  fitControl.onAdd = () => {
    const bar = L.DomUtil.create('div','leaflet-bar pev-map-fit');
    const button = L.DomUtil.create('button','',bar);
    button.type='button'; button.textContent='Fit'; button.title='Fit map to route or gates';
    button.setAttribute('aria-label',button.title);
    button.addEventListener('click',fit);
    L.DomEvent.disableClickPropagation(bar);
    return bar;
  };
  map.pevSetHome = (bounds,options={},refit=true) => {
    home={bounds,options};
    if (!fitControl.getContainer()) fitControl.addTo(map);
    if (refit) { pendingFit=true; fit(); }
  };
  map.on('moveend',refreshImagery);
  const resize = new ResizeObserver(() => {
    if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
    maps.set(host,map);
    removalObserver.observe(document.body,{childList:true,subtree:true});
    map.invalidateSize({pan:false});
    if (pendingFit) fit();
    refreshImagery();
  });
  resize.observe(host);
  map.on('unload',() => {
    resize.disconnect(); maps.delete(host);
    if (!maps.size) removalObserver.disconnect();
  });
  return map;
}
