// The field order matches Android's CsvExporter and DataOutputStream recording writer.
export const fields = ('elapsed_ns utc_ms lat lon alt_m gps_speed_mps heading_deg h_acc_m ' +
  'vehicle_speed_kmh voltage_v current_a pwm_pct motor_temp_c battery_pct gx gy gz ' +
  'gyro_x gyro_y gyro_z pitch_deg source_flags gap_ms').split(' ');
const column = Object.fromEntries(fields.map((key, i) => [key, i]));
const MiB = 1024 * 1024;
const recordBytes = 176;
// Android uploads recordings up to CloudConfig.MAX_RECORDING_BYTES (50 MB compressed).
export const MAX_RECORDING_BYTES = 50 * MiB;
// A 176-byte record always changes at least its 8-byte elapsed time, so deflate needs about
// 5–6 bytes per record even for a parked wheel with frozen values (measured 31:1). Rides with
// live GPS and sensor noise compress 1.3–2:1. 32× keeps every 50 MB upload openable (1.6 GB).
export const MAX_EXPANDED_BYTES = 32 * MAX_RECORDING_BYTES;
const MAX_TEXT_BYTES = 64 * MiB;
const number = value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const textDecoder = new TextDecoder();

// A ride cut off by a crash has no gzip trailer. SampleFileStore keeps every sample inflated
// before the damage, so keep that output too; binary() then drops a partial last record.
// A stream erroring at close discards output still queued. In a spec TransformStream, an
// empty write completes only once everything inflated so far has been read, so drain first.
async function inflate(blob) {
  if (!globalThis.DecompressionStream) throw Error('Open this recording in a browser that supports gzip decompression.');
  const stream = new DecompressionStream('gzip'), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
  const chunks = [];
  let length = 0, tooLarge = false;
  const output = (async () => {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return;
      length += value.length;
      if (length > MAX_EXPANDED_BYTES) { tooLarge = true; await reader.cancel(); return; }
      chunks.push(value);
    }
  })().catch(() => {});
  try {
    const input = blob.stream().getReader();
    for (;;) {
      const {value, done} = await input.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.write(new Uint8Array(0));
    await writer.close();
  } catch {}
  await output;
  if (tooLarge) throw Error('This recording exceeds the '+MAX_EXPANDED_BYTES/MiB+' MB browser replay limit when expanded.');
  return new Blob(chunks).arrayBuffer();
}

function binary(buffer) {
  const view = new DataView(buffer);
  // Old recordings remain readable after the app rename.
  const magic = buffer.byteLength >= 8 ? view.getUint32(0) : 0;
  if (![0x50455652, 0x45554352].includes(magic) || view.getUint16(4) !== 1) {
    throw Error('Unrecognized PEV Racer recording version.');
  }
  const offsets = [0,8,16,24,32,40,48,56,64,72,80,88,96,104,108,116,124,132,140,148,156,164,168];
  return {
    count: Math.floor((buffer.byteLength - 8) / recordBytes),
    get(index, field) {
      const idx = column[field];
      if (idx == null) return null;
      const offset = 8 + index * recordBytes + offsets[idx];
      if (idx === 0) return view.getBigInt64(offset).toString();
      if (idx === 1 || idx === 22) {
        const value = Number(view.getBigInt64(offset));
        return value >= 0 ? value : null;
      }
      if (idx === 13 || idx === 21) {
        const value = view.getInt32(offset);
        return value === -2147483648 ? null : value;
      }
      const value = view.getFloat64(offset);
      return Number.isFinite(value) ? value : null;
    }
  };
}

function fromRows(rows) {
  return {count: rows.length, get: (index, name) => rows[index][column[name]] ?? null};
}
function csvLine(line) {
  if (!line.includes('"')) return line.split(',');
  return (line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g) ?? []).map(s => s.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'));
}
function spread(timestamps) {
  for (let start = 0; start < timestamps.length;) {
    const base = timestamps[start];
    let end = start + 1;
    while (end < timestamps.length && timestamps[end] === base) end++;
    const count = end - start;
    if (base != null && count > 1) {
      const next = timestamps[end];
      const span = Math.min(next > base ? next - base : count * 40, 1000);
      const step = Math.max(1, span / count);
      for (let k = 1; k < count; k++) timestamps[start + k] = base + Math.round(k * step);
    }
    start = end;
  }
}

const aliases = {
  lat:['latitude'], lon:['longitude','long'], alt_m:['wgs altitude','wgs_altitude','altitude','msl altitude'],
  gps_speed_mps:['speed'], heading_deg:['heading'], h_acc_m:['horizontal accuracy'],
  vehicle_speed_kmh:['euc_speed_kmh'], gx:['g-force x','gforcex'], gy:['g-force y','gforcey'],
  gz:['g-force z','gforcez'], gyro_x:['rotation rate x','gyrox'], gyro_y:['rotation rate y','gyroy'],
  gyro_z:['rotation rate z','gyroz']
};
function csv(lines) {
  const names = csvLine(lines.shift()).map(s => s.trim().toLowerCase());
  const positions = fields.map(name => [name,...(aliases[name] || [])].map(s => names.indexOf(s)).find(i => i >= 0) ?? -1);
  if (positions[column.lat] < 0 || positions[column.lon] < 0) throw Error('CSV needs PEV Racer or RaceBox telemetry columns.');
  const dateCols = ['year','month','day','hour','minute','second'].map(name => names.indexOf(name));
  const rows = [];
  const times = [];
  for (const line of lines) {
    const values = csvLine(line);
    const row = positions.map(i => number(values[i]));
    if (!row.some(v => v != null)) continue;
    const ns = values[positions[0]]?.trim();
    row[0] = /^-?\d+$/.test(ns ?? '') ? ns : null;
    if (row[1] == null && dateCols.every(i => i >= 0 && number(values[i]) != null)) {
      const [year, month, day, hour, min, sec] = dateCols.map(i => Number(values[i]));
      row[1] = number(Date.UTC(year, month - 1, day, hour, min, 0, Math.round(sec * 1000)));
    }
    if (!names.includes('gps_speed_mps') && row[column.gps_speed_mps] > 120) row[column.gps_speed_mps] /= 3.6;
    times.push(row[1]);
    rows.push(row);
  }
  spread(times);
  rows.forEach((row, i) => {
    row[1] = times[i];
    row[0] ??= (BigInt(Math.round(times[i] ?? i * 40)) * 1000000n).toString();
    row[column.source_flags] ??= 1;
  });
  return fromRows(rows);
}
function vbo(lines) {
  let keys = ['sats','time','lat','long','velocity','heading','height','vertvel'];
  const columnAliases = {latitude:'lat',lng:'long',lon:'long',longitude:'long',velocitykmh:'velocity',speed:'velocity',
    altitude:'height',longitudeacc:'longacc',latitudeacc:'latacc',xrotationgyroscope:'gyrox',rotationratex:'gyrox',
    yrotationgyroscope:'gyroy',rotationratey:'gyroy',zrotationgyroscope:'gyroz',rotationratez:'gyroz',
    leanangle:'lean',pitch:'lean'};
  let mode = '', day = null, prev = null, wrap = 0, minutes = false;
  const rows = [], times = [];
  for (const line of lines) {
    const created = /^File created.*?(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(line);
    if (created) { day = Date.UTC(+created[3], +created[2] - 1, +created[1]); continue; }
    if (line.startsWith('[')) { mode = line.toLowerCase(); continue; }
    if (mode === '[column names]') keys = line.toLowerCase().split(/\s+/).map(key => {
      const normalized = key.replace(/[-_]/g,'');
      return columnAliases[normalized] ?? normalized;
    });
    if (mode !== '[data]') continue;
    const values = line.split(/\s+/);
    const read = name => number(values[keys.indexOf(name)]);
    const t = read('time'), lat = read('lat'), lon = read('long') ?? read('lon');
    if (t == null || lat == null || lon == null) continue;
    const tod = (Math.floor(t / 10000) * 3600 + Math.floor(t / 100) % 100 * 60) * 1000 + Math.round(t % 100 * 1000);
    if (prev != null && prev - tod > 43200000) wrap += 86400000;
    prev = tod;
    const row = new Array(fields.length).fill(null);
    row[column.lat] = lat;
    row[column.lon] = lon;
    minutes ||= Math.abs(lat) > 90 || Math.abs(lon) > 180;
    const speed = read('velocity');
    row[column.gps_speed_mps] = speed == null ? null : speed / 3.6;
    for (const [field,key] of Object.entries({alt_m:'height',heading_deg:'heading',gx:'longacc',gy:'latacc',gz:'vertacc',gyro_x:'gyrox',gyro_y:'gyroy',gyro_z:'gyroz',pitch_deg:'lean'})) {
      row[column[field]] = read(key);
    }
    row[column.source_flags] = 1;
    times.push((day ?? 0) + wrap + tod);
    rows.push(row);
  }
  spread(times);
  rows.forEach((row, i) => {
    if (minutes) { row[column.lat] /= 60; row[column.lon] /= -60; }
    row[0] = (BigInt(times[i]) * 1000000n).toString();
    row[1] = day == null ? null : times[i];
  });
  return fromRows(rows);
}

export async function decodeRecording(blob) {
  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  let data;
  if (header[0] === 31 && header[1] === 139) {
    if (blob.size > MAX_RECORDING_BYTES) throw Error('Choose a recording smaller than '+MAX_RECORDING_BYTES/MiB+' MB.');
    data = binary(await inflate(blob));
  } else if (header[0] === 80 || header[0] === 69) {
    const magic = textDecoder.decode(header.slice(0,4));
    if (magic === 'PEVR' || magic === String.fromCharCode(69,85,67,82)) {
      if (blob.size > MAX_EXPANDED_BYTES) throw Error('Choose a recording smaller than '+MAX_EXPANDED_BYTES/MiB+' MB.');
      data = binary(await blob.arrayBuffer());
    }
  }
  if (!data) {
    if (blob.size > MAX_TEXT_BYTES) throw Error('Choose a CSV or VBO file smaller than '+MAX_TEXT_BYTES/MiB+' MB.');
    const lines = (await blob.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) throw Error('The recording is empty.');
    data = lines.some(s => s.toLowerCase() === '[data]') ? vbo(lines) : csv(lines);
  }
  if (!data.count) throw Error('No telemetry samples were found.');
  return data;
}

export function speed(data, index) {
  const gps = data.get(index,'gps_speed_mps');
  return gps == null ? data.get(index,'vehicle_speed_kmh') : gps * 3.6;
}
export function coordinate(data, i) {
  const lat = data.get(i,'lat'), lon = data.get(i,'lon');
  return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat,lon] : null;
}
export function elapsedMs(data, i) {
  return Number(data.get(i,'elapsed_ns')) / 1e6;
}
export function gpsDistance(a,b) {
  const rad = Math.PI / 180;
  const dLat = (b[0]-a[0]) * rad, dLon = (b[1]-a[1]) * rad;
  const h = Math.sin(dLat/2)**2 + Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dLon/2)**2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const raceBoxHeaders = 'iTOW,Year,Month,Day,Hour,Minute,Second,Longitude,Latitude,WGS Altitude,Speed,Heading,G-Force X,G-Force Y,G-Force Z,Rotation rate X,Rotation rate Y,Rotation rate Z,Vertical Accuracy,Horizontal Accuracy,MSL Altitude';
const vboKeys = 'sats time lat long velocity heading height vertvel longacc latacc';
export function exportRecording(data, format, fallbackDate) {
  const firstTime = elapsedMs(data,0);
  const known = data.get(0,'utc_ms') ?? (Number.isFinite(fallbackDate) ? fallbackDate : null);
  const utc0 = known ?? 0;
  const rowUtc = i => data.get(i,'utc_ms') ?? (utc0 + elapsedMs(data,i) - firstTime);
  const pad = x => String(x).padStart(2,'0');
  const parts = [];
  // VBO rows hold only UTC time of day. Android's VboCodec takes the ride date (and start time)
  // from this header, so date it from the first exported row, or now as Android's writer does.
  let firstRow = 0;
  while (format === 'vbo' && firstRow < data.count - 1 && !coordinate(data,firstRow)) firstRow++;
  const d = new Date(known == null && data.get(firstRow,'utc_ms') == null ? Date.now() : rowUtc(firstRow));
  let batch = format === 'csv' ? fields.join(',') + '\n' : format === 'racebox' ? raceBoxHeaders + '\n' :
    'File created on ' + pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth()+1) + '/' + d.getUTCFullYear() +
    ' @ ' + d.toISOString().slice(11,19) + '\n[header]\nsatellites\ntime\nlatitude\nlongitude\nvelocity kmh\nheading\nheight\nvertical velocity kmh\nlong acc g\nlat acc g\n[column names]\n'+vboKeys+'\n[data]\n';
  for (let i = 0; i < data.count; i++) {
    const val = k => data.get(i,k);
    if (format === 'csv') batch += fields.map(val).join(',') + '\n';
    else if (format === 'racebox') {
      const utc = val('utc_ms'), date = utc == null ? null : new Date(utc);
      const dateFields = date ? [date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds()+date.getUTCMilliseconds()/1000] : [null,null,null,null,null,null];
      batch += [null,...dateFields,...['lon','lat','alt_m','gps_speed_mps','heading_deg','gx','gy','gz','gyro_x','gyro_y','gyro_z'].map(val),null,val('h_acc_m'),val('alt_m')].join(',') + '\n';
    } else {
      const point = coordinate(data,i);
      if (!point) continue;
      const time = new Date(rowUtc(i)).toISOString().slice(11,23).replaceAll(':','');
      batch += [0,time,(point[0]*60).toFixed(8),(-point[1]*60).toFixed(8),
        ((val('gps_speed_mps') ?? 0)*3.6).toFixed(4),val('heading_deg') ?? 0,val('alt_m') ?? 0,0,val('gx') ?? 0,val('gy') ?? 0].join(' ') + '\n';
    }
    if (batch.length > MiB) { parts.push(batch); batch = ''; }
  }
  parts.push(batch);
  return new Blob(parts, {type: format === 'vbo' ? 'text/plain' : 'text/csv;charset=utf-8'});
}
