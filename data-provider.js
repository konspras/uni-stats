(function() {
'use strict';
const base = new URL('.',document.baseURI), pending = new Map(); let worker, sequence=0, manifest, index, mode='csv', backend=false, lastStats=null;
async function fetchJSON(path,signal) {const response=await fetch(new URL(path.replace(/^\//,''),base),{signal,cache:'no-cache'});const value=await response.json();if(!response.ok)throw Error(value.error||'Data unavailable ('+response.status+')');return value;}
const ready = fetchJSON('backend.json').then(value => {backend=value.available===true;return backend;}).catch(() => false);
async function catalog() {
  index = await fetchJSON('data/index.json');
  if (index.format !== 1) throw Error('Unsupported export format');
  manifest = await fetchJSON('data/'+index.manifest);
  return manifest.catalog;
}
async function detail(id,signal) {
  if (!manifest) await catalog();
  const path=manifest.datasets[id];if(!path)throw Error('Dataset unavailable');
  const result=await fetchJSON('data/'+path,signal);details.set(manifest.generation+':'+id,result);return result;
}
const details = new Map();
async function staticSeries(request,signal) {
  const detailKey=manifest?.generation+':'+request.dataset;
  let d=details.get(detailKey);if(!d) {d=await detail(request.dataset,signal);details.set(detailKey,d);}
  if (signal?.aborted) throw new DOMException('Aborted','AbortError');
  if (!worker) {
    worker=new Worker(new URL('static-worker.js',base));
    worker.onmessage=({data})=>{const job=pending.get(data.id);if(!job)return;pending.delete(data.id);job.cleanup();if(data.error) {const error=Error(data.error);error.name=data.name;job.reject(error);}else {lastStats=data.stats;job.resolve(data.result);}};
    worker.onerror=event=>{for(const job of pending.values()){job.cleanup();job.reject(Error(event.message||'Data worker failed'));}pending.clear();worker.terminate();worker=null;};
  }
  return new Promise((resolve,reject)=>{
    const id=++sequence,abort=()=>{worker?.postMessage({cancel:id});pending.delete(id);reject(new DOMException('Aborted','AbortError'));};
    signal?.addEventListener('abort',abort,{once:true});pending.set(id,{resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)});
    worker.postMessage({id,request,detail:d,metadataURL:new URL('data/'+manifest.datasets[request.dataset],base).href});
  });
}
window.DataProvider={
  ready,get lastStats(){return lastStats;},get mode(){return mode;},get backend(){return backend;},
  async setMode(value) {await ready;if(!['csv','database'].includes(value)||value==='database'&&!backend)throw Error('Local database unavailable');if(worker){worker.terminate();worker=null;}for(const job of pending.values()){job.cleanup();job.reject(new DOMException('Aborted','AbortError'));}pending.clear();
    mode=value;sessionStorage.setItem('uni-stats-data-mode',value);details.clear();manifest=null;},
  async api(path,signal) {
    await ready;
    // Local health is live even when plotting exported CSVs.
    if(path==='/api/update-status') {
      if(backend)return fetchJSON('api/update-status',signal);
      const current=await fetchJSON('data/index.json',signal);return current.status;
    }
    if(!path.startsWith('/api/'))return fetchJSON(path,signal);
    if(mode==='database')return fetchJSON(path,signal);
    const url=new URL(path,'https://query.invalid');
    if(url.pathname==='/api/datasets')return catalog();
    if(url.pathname==='/api/dataset')return detail(url.searchParams.get('id'),signal);
    if(url.pathname==='/api/series')return staticSeries(JSON.parse(url.searchParams.get('query')),signal);
    throw Error('Unknown data request');
  }
};
})();
