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

async function fingerprint() {
  return evaluate(`({selection:captureSelection(),totals:state.data?.series.map(s=>s.points.map(p=>p.value)),stack:state.plotData?.stackDimension,percentage:state.plotData?.percentage})`);
}
async function reloadAndCompare() {
  const before=await fingerprint(),url=await evaluate('location.href'),origin=await evaluate('performance.timeOrigin');
  assert(url.includes('#pyramid?v=1&'));
  await send('Page.reload',{ignoreCache:true});await wait(ready+` && performance.timeOrigin!==${origin}`);
  assert.deepEqual(await fingerprint(),before,'A fresh page restores all controls and the plotted totals');
  assert.equal(await evaluate('location.href'),url,'Shared URL is canonical and stable');
  assert.equal(await evaluate('DataProvider.mode'),'csv');
  return before;
}
try {
  await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1360,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'about:blank'});
  await send('Page.navigate',{url:new URL('#pyramid',base).href});await wait(ready);
  assert.equal(await evaluate(`selectionLabel('Fachrichtung',state.filters.Fachrichtung)`),'Humanmedizin','Landing subject is Human Medicine');
  assert.deepEqual(await evaluate(`state.universities`),await evaluate(`variable('Hochschule').values`),'Landing selects all universities');
  assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1]).get('universities')`),'all');

  await evaluate(`{const node=document.querySelector('#filters select[data-dimension="Fachrichtung"]');node.value=categories(variable('Fachrichtung')).find(c=>c.text==='Psychologie').code;node.dispatchEvent(new Event('change'));}`);await wait(ready);
  await evaluate(`setUniversities(categories(variable('Hochschule')).filter(c=>['ETHZ','LS'].includes(c.text)).map(c=>c.code));renderCategories();updatePlot()`);await wait(ready);
  await evaluate(`$('from').value=timeVariable().valueTexts.indexOf('2007/08');changeRange('from',true)`);await wait(ready);
  await evaluate(`$('to').value=timeVariable().valueTexts.indexOf('2022/23');changeRange('to',true)`);await wait(ready);
  await evaluate(`$('percentage').click();$('stack-universities').click()`);
  assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1]).get('stack')`),'universities');
  const subset=await reloadAndCompare();
  const historyLength=await evaluate('history.length');
  await evaluate(`$('percentage').click();$('percentage').click()`);
  assert.equal(await evaluate('history.length'),historyLength,'Filter changes do not flood history');
  await evaluate(`$('explorer-tab').click()`);await wait(ready+` && state.view==='explorer'`);
  await evaluate(`$('pyramid-tab').click()`);await wait(ready+` && state.view==='pyramid'`);
  assert.deepEqual(await fingerprint(),subset,'Pyramid controls survive tab switches');
  await evaluate('history.back()');await wait(ready+` && state.view==='explorer'`);
  await evaluate('history.back()');await wait(ready+` && state.view==='pyramid'`);
  assert.deepEqual(await fingerprint(),subset,'Back restores the shared pyramid URL');
  await evaluate('history.forward()');await wait(ready+` && state.view==='explorer'`);
  await evaluate(`$('pyramid-tab').click()`);await wait(ready+` && state.view==='pyramid'`);
  await evaluate(`$('stack-universities').click();$('select-all').click()`);await wait(ready);
  await evaluate(`{const node=document.querySelector('#filters select[data-dimension="Fachrichtung"]');node.value=ALL;node.dispatchEvent(new Event('change'));}`);await wait(ready);
  await evaluate(`$('stack-subjects').click()`);await wait(ready+` && state.data.breakdown`);
  await evaluate(`$('split-nationality').click()`);await wait(ready+` && state.compare==='Staatsangehörigkeit (Kategorie)'`);
  assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1]).get('universities')`),'all');
  await reloadAndCompare();
  await evaluate(`loadDataset('px-x-1503040100_101')`);await wait(ready);
  await evaluate(`{const node=document.querySelector('#filters select[data-dimension="Examensstufe"]');node.value=ALL;node.dispatchEvent(new Event('change'));}`);await wait(ready);
  await reloadAndCompare();
  await evaluate(`$('clear-all').click()`);
  await wait(`!state.data && $('chart').getAttribute('aria-busy')==='false'`);
  const emptyHash=await evaluate('location.hash'),origin=await evaluate('performance.timeOrigin');
  await send('Page.reload',{ignoreCache:true});await wait(`typeof state!=='undefined' && state.detail && !state.data && $('chart').getAttribute('aria-busy')==='false' && performance.timeOrigin!==${origin}`);
  assert.equal(await evaluate('state.universities.length'),0,'Empty university selection survives a shared link');
  assert.equal(await evaluate('location.hash'),emptyHash);
  await evaluate(`$('reset').click()`);await wait(ready);
  const goodHash=await evaluate('location.hash');
  await evaluate(`{const p=new URLSearchParams(location.hash.split('?')[1]);p.set('universities','selected');p.delete('u');p.append('u','not-a-university');location.hash='#pyramid?'+p;}`);
  await wait(`!$('error').hidden && $('chart').getAttribute('aria-busy')==='false' && !$('chart svg')`);
  assert.equal(await evaluate(`$('error').textContent.includes('unavailable')`),true,'Unavailable categories produce an explicit error');
  await evaluate(`location.hash=${JSON.stringify(goodHash)}`);await wait(ready);
  await evaluate(`location.hash='#pyramid?v=999'`);await wait(`!$('error').hidden && !$('chart svg')`);
  assert.equal(await evaluate(`$('error').textContent.includes('unsupported version')`),true);
  await evaluate(`$('reset').click()`);await wait(ready);
  assert.equal(await evaluate(`$('error').hidden`),true,'Reset recovers from an invalid shared link');
  assert.equal(await evaluate(`selectionLabel('Fachrichtung',state.filters.Fachrichtung)`),'Humanmedizin','Reset restores the Human Medicine default');
  assert.deepEqual(await evaluate(`state.universities`),await evaluate(`variable('Hochschule').values`),'Reset restores all universities');

  assert.deepEqual(errors,[],'No browser errors');
  console.log('PASS: static public links restore dataset, split, all filters, year range, universities, All/empty selections, percentages, university/subject stacks, tab state, Back/Forward, and reject invalid links.');
} finally {socket.close();}
