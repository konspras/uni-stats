importScripts('static-query.js');
const cache = new Map(); let cacheBytes = 0;
const jobs = new Map();
async function json(url, signal) {const r=await fetch(url,{signal}); if (!r.ok) throw Error('Data file unavailable: '+r.status); return r.json();}
async function load(url, file, signal, stats) {
  const key = url.href, existing = cache.get(key);
  if (existing) {stats.cache_hits++;cache.delete(key);cache.set(key,existing);return existing.table;}
  const started = performance.now();
  const compressed = typeof DecompressionStream !== 'undefined';
  const response = await fetch(compressed ? key+'.gz' : key,{signal});
  if (!response.ok) throw Error('CSV unavailable: '+response.status);
  const bytes = compressed ? await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : await response.arrayBuffer();
  if (bytes.byteLength !== file.bytes) throw Error('CSV length mismatch; reload the page');
  const hash = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b => b.toString(16).padStart(2,'0')).join('') : file.sha256;
  if (hash !== file.sha256) throw Error('CSV checksum mismatch; reload the page');
  stats.downloads.push({url:key+(compressed ? '.gz':''),bytes:compressed ? file.gzip_bytes:file.bytes,ms:performance.now()-started});
  const table = StaticQuery.parseCSV(new TextDecoder().decode(bytes));
  cache.set(key,{table,bytes:bytes.byteLength});cacheBytes += bytes.byteLength;
  // CSV bytes understate JS object overhead; keep only 8 MiB of source text in the parsed cache.
  while (cacheBytes > 8*1024*1024 && cache.size>1) {const oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).bytes;cache.delete(oldest);}
  return table;
}
onmessage = async ({data}) => {
  if (data.cancel) {jobs.get(data.cancel)?.abort();return;}
  const controller = new AbortController();jobs.set(data.id,controller);
  try {
    const detail = data.detail, plan = StaticQuery.plan(detail,data.request);
    const base = new URL('.',data.metadataURL), stats={downloads:[],cache_hits:0};
    // Limit parallel downloads/decompression to avoid bursts of memory use.
    const tables = [], codes = [...plan.universityCodes];
    const batch = async () => {while(codes.length) {const code=codes.shift(), files=detail.static_files[code];
      if (!files) continue; const file=files[plan.precomputed ? 'subject_totals':'raw'];
      tables.push(await load(new URL(file.path,base),file,controller.signal,stats));}};
    await Promise.all(Array.from({length:Math.min(4,codes.length)},batch));
    if (controller.signal.aborted) throw new DOMException('Aborted','AbortError');
    postMessage({id:data.id,result:StaticQuery.query(detail,data.request,tables),stats});
  } catch(error) {postMessage({id:data.id,error:error.message,name:error.name});}
  finally {jobs.delete(data.id);}
};
