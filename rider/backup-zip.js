// Android writes deflated ZIP32 entries with a trailing data descriptor. Use the
// central directory for sizes, then verify headers, bounds and CRC before restore.
const utf8 = new TextEncoder();
const decode = new TextDecoder('utf-8', {fatal:true});
const maxUint32 = 0xffffffff;
const crcTable = Uint32Array.from({length:256}, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  return n >>> 0;
});
function updateCrc(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc;
}
function check(valid, message = 'Invalid or incomplete Android backup ZIP.') {
  if (!valid) throw Error(message);
}
const view = async blob => new DataView(await blob.arrayBuffer());
const u16 = (v, p) => v.getUint16(p, true);
const u32 = (v, p) => v.getUint32(p, true);
const bytesOf = (v,p,len) => new Uint8Array(v.buffer, v.byteOffset+p,len);
export async function openZip(file) {
  const tail = await view(file.slice(Math.max(file.size-65557,0)));
  let end = tail.byteLength-22;
  for (; end >= 0; end--) {
    if (u32(tail,end) === 0x06054b50 && end+22+u16(tail,end+20) === tail.byteLength) break;
  }
  check(end>=0 && u16(tail,end+4)===0 && u16(tail,end+6)===0 && u16(tail,end+8)===u16(tail,end+10));
  const count = u16(tail,end+10), size = u32(tail,end+12), start = u32(tail,end+16);
  check(count !== 65535 && size <= 32*1024*1024 && start + size === file.size-tail.byteLength+end,
    'Use an Android backup smaller than 4 GB with fewer than 65,535 files.');
  const directory = await view(file.slice(start,start+size)), entries = new Map();
  let pos = 0;
  for (let i=0; i<count; i++) {
    check(pos+46<=size && u32(directory,pos)===0x02014b50);
    const flags=u16(directory,pos+8), method=u16(directory,pos+10), nameSize=u16(directory,pos+28);
    const crc=u32(directory,pos+16), compressed=u32(directory,pos+20), expanded=u32(directory,pos+24);
    const offset=u32(directory,pos+42), next=pos+46+nameSize+u16(directory,pos+30)+u16(directory,pos+32);
    check(next<=size && !(flags&1) && (method===0 || method===8) && offset+30<=start);
    const name=decode.decode(bytesOf(directory,pos+46,nameSize));
    check(!entries.has(name), 'Duplicate file in backup.');
    entries.set(name,{name,offset,crc,compressed,expanded,method});
    pos=next;
  }
  check(pos===size && entries.get('backup.json')?.offset===0);
  return {
    entries,
    async read(name,limit) {
      const entry=entries.get(name);
      check(entry && entry.expanded<=limit, 'Missing or oversized file in backup: '+name);
      const header=await view(file.slice(entry.offset,entry.offset+30));
      check(u32(header,0)===0x04034b50 && u16(header,8)===entry.method && !(u16(header,6)&1));
      const nameStart=entry.offset+30, dataStart=nameStart+u16(header,26)+u16(header,28);
      check(dataStart+entry.compressed<=start && await file.slice(nameStart,nameStart+u16(header,26)).text()===name);
      const blob=file.slice(dataStart,dataStart+entry.compressed);
      const stream=entry.method===0 ? blob.stream() : blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader=stream.getReader(), chunks=[];
      let amount=0, crc=0xffffffff;
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        amount+=value.length;
        if (amount>entry.expanded) { await reader.cancel(); throw Error('Backup file exceeds its declared size.'); }
        chunks.push(value);
        crc=updateCrc(crc,value);
      }
      check(amount===entry.expanded && (crc^0xffffffff)>>>0 === entry.crc,'Backup checksum failed for '+name);
      return new Blob(chunks);
    }
  };
}
export async function writeZip(files) {
  const parts=[], directory=[];
  let offset=0, directorySize=0;
  for await (const {name,blob} of files) {
    const path=utf8.encode(name), reader=blob.stream().getReader();
    let crc=0xffffffff;
    for (;;) { const {done,value}=await reader.read(); if (done) break; crc=updateCrc(crc,value); }
    crc=(crc^0xffffffff)>>>0;
    const local=new DataView(new ArrayBuffer(30)), central=new DataView(new ArrayBuffer(46));
    local.setUint32(0,0x04034b50,true); central.setUint32(0,0x02014b50,true);
    central.setUint16(4,20,true);
    for (const [v,shift] of [[local,0],[central,2]]) {
      v.setUint16(4+shift,20,true);
      v.setUint16(6+shift,0x0800,true);
      v.setUint16(12+shift,0x0021,true);
      v.setUint32(14+shift,crc,true);
      v.setUint32(18+shift,blob.size,true); v.setUint32(22+shift,blob.size,true);
      v.setUint16(26+shift,path.length,true);
    }
    central.setUint32(42,offset,true);
    offset+=local.byteLength+path.length+blob.size;
    directorySize+=central.byteLength+path.length;
    check(offset+directorySize+22<maxUint32 && directory.length/2+1<65535,'This library exceeds the browser ZIP32 limit (4 GB or 65,535 files).');
    parts.push(local.buffer,path,blob); directory.push(central.buffer,path);
  }
  const end=new DataView(new ArrayBuffer(22)), count=directory.length/2;
  end.setUint32(0,0x06054b50,true); end.setUint16(8,count,true); end.setUint16(10,count,true);
  end.setUint32(12,directorySize,true); end.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end.buffer],{type:'application/zip'});
}
