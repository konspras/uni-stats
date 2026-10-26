// Optional browser integration check: Node 22+ and an isolated Chromium CDP port.
// Start Chromium with --headless --remote-debugging-port=9227, then run this file.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

const debug = process.env.BROWSER_DEBUG_URL || 'http://127.0.0.1:9227';
const base = process.env.EXPLORER_URL || 'http://127.0.0.1:8772/uni-stats/';
const targets = await (await fetch(debug + '/json/list')).json();
const target = targets.find(t => t.type === 'page');
assert(target, 'No browser page available');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
let sequence = 0;
const pending = new Map(), errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry);
  if (message.id) {
    const p = pending.get(message.id); pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
  }
};
function send(method, params = {}) {return new Promise((resolve, reject) => {const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params}));});}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50));}
  throw new Error('Timed out: ' + expression);
}
const ready = `typeof state !== 'undefined' && state.data && document.querySelector('#chart').getAttribute('aria-busy') === 'false'`;
async function select(id, value) {await evaluate(`{const node = document.getElementById(${JSON.stringify(id)});
  node.value = node.type === 'range' ? timeVariable().values.indexOf(${JSON.stringify(value)}) : ${JSON.stringify(value)};
  node.dispatchEvent(new Event('change'));}`);}

const requests=[];
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
  const original=socket.onmessage;
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);original(event);};
  await send('Emulation.setDeviceMetricsOverride',{width:1360,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  let start=performance.now();
  await send('Page.navigate',{url:'about:blank'});
  await send('Page.navigate',{url:new URL('#pyramid',base).href}); await wait(ready);
  const initial=performance.now()-start;
  assert.equal(await evaluate(`DataProvider.mode`),'csv');
  assert.equal(await evaluate(`DataProvider.backend`),false);
  assert.equal(await evaluate(`$('data-mode-field').hidden && $('snapshot').disabled`),true);
  assert.equal(await evaluate(`state.catalog.length`),28);
  assert.equal(await evaluate(`state.data.series.length`),2);
  assert.equal(await evaluate(`$('error').hidden`),true);
  await evaluate(`$('select-all').click()`); await wait(ready);
  start=performance.now();
  await evaluate(`{const node=document.querySelector('#filters select[data-dimension="Fachrichtung"]');node.value=ALL;node.dispatchEvent(new Event('change'));}`);await wait(ready);
  const totals=performance.now()-start;
  assert.equal(await evaluate(`state.data.universities.length`),15);
  start=performance.now();await evaluate(`$('stack-subjects').click()`);await wait(ready+` && state.data.breakdown==='Fachrichtung'`);
  const subjects=performance.now()-start;
  assert.equal(await evaluate(`document.querySelectorAll('.pyramid-bar[data-subject]').length>0`),true);
  assert.equal(await evaluate(`state.data.series.every(s=>s.points.every(p=>p.value===null || Math.abs(p.subject_segments.reduce((a,c)=>a+(c.value||0),0)-p.value)<1e-6))`),true);
  await evaluate(`$('percentage').click()`);await wait(ready);
  assert.equal(await evaluate(`state.plotData.percentage`),true);
  await evaluate(`$('explorer-tab').click()`); await wait(ready+` && state.view==='explorer'`);
  for(const dataset of await evaluate(`state.catalog.map(d=>d.id)`)) {
    await evaluate(`loadDataset(${JSON.stringify(dataset)})`);await wait(ready);
    assert.equal(await evaluate(`state.data.dataset`),dataset);
    assert.equal(await evaluate(`$('error').hidden`),true,dataset);
  }
  // A fresh worker ensures this benchmark cannot use parsed-file cache from earlier selections.
  await send('Page.navigate',{url:base+'#explorer'});await wait(ready+` && state.view==='explorer'`);
  await evaluate(`loadDataset('px-x-1503040100_101')`);await wait(ready);
  await evaluate(`{for(const [code,policy] of Object.entries(state.detail.aggregation_options)){if(code===state.compare)continue;state.filters[code]=null;}renderFilters();$('select-all').click();}`);await wait(ready);
  await evaluate(`DataProvider.setMode('csv')`);
  start=performance.now();await evaluate(`$('stack-subjects').click()`);await wait(ready+` && state.data.breakdown`);
  const largest=performance.now()-start;
  const bytes=await evaluate(`DataProvider.lastStats`);
  assert.equal(requests.some(url=>new URL(url).pathname.includes('/api/')),false,'Plain static frontend never calls an API');
  assert.deepEqual(errors,[],'No browser errors');
  console.log(JSON.stringify({initial_ms:initial,all_entrants_subject_totals_ms:totals,all_entrants_subject_stack_ms:subjects,largest_degrees_subject_stack_ms:largest,largest_selection_downloads:bytes},null,2));
} finally {socket.close();}
