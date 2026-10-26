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

const gridReady=`typeof subjectGrid!=='undefined' && subjectGrid?.active && subjectGrid.model && !subjectGrid.loading && $('subjects-grid').getAttribute('aria-busy')==='false'`;
try {
  await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  let start=performance.now();await send('Page.navigate',{url:base+'#subjects'});await wait(gridReady);
  const initial=performance.now()-start;
  if (await evaluate('DataProvider.backend')) {
    await select('data-mode','csv');await wait(gridReady+` && DataProvider.mode==='csv'`);
    const csvTotals=await evaluate(`subjectGrid.model.cards.map(c=>[c.code,c.total])`);
    await select('data-mode','database');await wait(gridReady+` && DataProvider.mode==='database'`);
    assert.deepEqual(await evaluate(`subjectGrid.model.cards.map(c=>[c.code,c.total])`),csvTotals,'Local database and static grid totals agree');
    await select('data-mode','csv');await wait(gridReady+` && DataProvider.mode==='csv'`);
  }

  assert.equal(await evaluate('state.view'),'subjects');
  assert.equal(await evaluate(`$('subjects-tab').getAttribute('aria-current')`),'page');
  assert.equal(await evaluate(`document.querySelector('.explorer-layout').hidden`),true,'Grid has no sidebar');
  assert.equal(await evaluate(`document.querySelectorAll('.subject-card').length`),77,'Every detailed subject has a card');
  assert.equal(await evaluate(`subjectGrid.model.cards.every((c,i,a)=>!i||(a[i-1].total??-1)>=(c.total??-1))`),true,'Latest total determines descending order');
  assert.equal(await evaluate(`document.querySelectorAll('.subject-card svg').length<77`),true,'Offscreen charts are drawn lazily');
  assert.equal(await evaluate(`subjectGrid.model.cards.every(c=>c.series.filter(s=>subjectGrid.model.sideCodes.includes(s.code)).every(s=>s.points.every(p=>p.value===null||p.value<=subjectGrid.model.maximum)))`),true,'Every pyramid uses a shared scale covering the full interval');
  const top=await evaluate(`(()=>{const c=subjectGrid.model.cards[0];return {code:c.code,total:c.total,left:c.series.find(s=>s.code===subjectGrid.model.sideCodes[0]).points.at(-1).value};})()`);
  // Independent scalar query cross-check for the largest subject.
  const direct=await evaluate(`api('/api/series?query='+encodeURIComponent(JSON.stringify({dataset:subjectGrid.detail.id,compare:subjectGrid.data.compare,values:subjectGrid.data.series.map(s=>s.code),measure:subjectGrid.measure,filters:{...subjectGrid.filters,Fachrichtung:${JSON.stringify(top.code)}}})))`);
  assert.equal(direct.series[0].points.at(-1).value,top.left);
  assert.equal(direct.series.reduce((sum,s)=>sum+s.points.at(-1).value,0),top.total);
  await evaluate(`document.querySelector('.subject-card').focus();document.querySelector('.subject-card').dispatchEvent(new KeyboardEvent('keydown',{key:'End'}))`);
  assert.equal(await evaluate(`document.querySelector('.subject-tooltip').hidden`),false);
  const firstLink=await evaluate(`document.querySelector('.subject-card').href`);
  assert(firstLink.includes('#pyramid?v=1&'));
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/uni-stats-subject-grid-desktop.png',Buffer.from(shot.data,'base64'));
  await evaluate(`document.querySelector('.subject-card').click()`);await wait(ready+` && state.view==='pyramid'`);
  assert.equal(await evaluate(`state.filters.Fachrichtung`),top.code,'Card opens the matching subject');
  assert.equal(await evaluate(`state.universities.length`),15);
  await evaluate(`history.back()`);await wait(gridReady+` && state.view==='subjects'`);
  await select('subjects-metric','Degrees');await wait(gridReady+` && subjectGrid.detail.group==='Degrees'`);
  assert.equal(await evaluate(`$('subjects-qualification-field').hidden`),false);
  assert.equal(await evaluate(`$('subjects-qualification').options.length`),5);
  assert.equal(await evaluate(`$('subjects-qualification').selectedOptions[0].textContent`),'Bachelor');
  const doctorate=await evaluate(`subjectGrid.detail.metadata.variables.find(v=>v.code==='Examensstufe').values[3]`);
  await select('subjects-qualification',doctorate);await wait(gridReady+` && subjectGrid.filters.Examensstufe===${JSON.stringify(doctorate)}`);
  await select('subjects-split','Staatsangehörigkeit (Kategorie)');await wait(gridReady+` && subjectGrid.data.compare==='Staatsangehörigkeit (Kategorie)'`);
  assert.equal(await evaluate(`subjectGrid.filters.Examensstufe`),doctorate,'Qualification survives a split change');
  assert.equal(await evaluate(`subjectGrid.model.labels.join(',')`),'Swiss nationals,Foreign nationals');
  const requestCount=await evaluate(`window.gridApiCount=0;window.gridOriginalApi=subjectGrid.api;subjectGrid.api=(...args)=>{window.gridApiCount++;return window.gridOriginalApi(...args);};$('subjects-from').value=20;$('subjects-from').dispatchEvent(new Event('change'));window.gridApiCount`);
  assert.equal(requestCount,0,'Time range slices the fetched subject data without another request');
  assert.equal(await evaluate(`subjectGrid.model.periods.length`),16);
  const expectedLink=await evaluate(`SelectionURL.read(document.querySelector('.subject-card').hash)`);
  await evaluate(`document.querySelector('.subject-card').click()`);await wait(ready+` && state.view==='pyramid'`);
  assert.equal(await evaluate(`state.filters.Examensstufe`),doctorate);
  assert.equal(await evaluate(`$('from-label').textContent`),expectedLink.fromLabel);
  await evaluate(`$('subjects-tab').click()`);await wait(gridReady+` && state.view==='subjects'`);
  assert.equal(await evaluate(`$('subjects-qualification').value`),doctorate,'Grid controls survive tab switches');
  await select('subjects-qualification','__all__');await wait(gridReady+` && subjectGrid.filters.Examensstufe===null`);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await wait(`document.documentElement.scrollWidth<=390`);
  assert.equal(await evaluate(`getComputedStyle($('subjects-grid')).gridTemplateColumns.split(' ').length`),1,'Mobile cards remain readable');
  const mobile=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/uni-stats-subject-grid-mobile.png',Buffer.from(mobile.data,'base64'));
  await evaluate(`document.querySelector('.subject-card:last-child').scrollIntoView({block:'center'})`);
  await wait(`document.querySelector('.subject-card:last-child svg')`);
  await evaluate(`document.querySelector('.subject-card:last-child').click()`);await wait(ready+` && state.view==='pyramid'`);
  await wait(`scrollY<10`);
  await evaluate(`history.back()`);await wait(gridReady+` && state.view==='subjects'`);
  await evaluate(`$('reset').click()`);await wait(gridReady+` && subjectGrid.detail.group==='Bachelor entrants'`);
  assert.equal(await evaluate(`subjectGrid.model.periods.length`),46);
  assert.equal(await evaluate(`$('subjects-qualification-field').hidden`),true);
  assert.deepEqual(errors,[],'No browser console errors');
  console.log('PASS: subject grid, all 77 subjects, sorting/common scale, independent source totals, lazy rendering, card links, flow/split/qualification controls, range caching, navigation and mobile layout. Initial static load: '+initial.toFixed(0)+' ms');
} finally {socket.close();}
