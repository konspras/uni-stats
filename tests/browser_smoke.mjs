// Optional browser integration check: Node 22+ and an isolated Chromium CDP port.
// Start Chromium with --headless --remote-debugging-port=9227, then run this file.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

const debug = process.env.BROWSER_DEBUG_URL || 'http://127.0.0.1:9227';
const base = process.env.EXPLORER_URL || 'http://127.0.0.1:8768';
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
async function select(id, value) {await evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);}

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {width: 1360, height: 1100, deviceScaleFactor: 1, mobile: false});
  await send('Page.navigate', {url: base}); await wait(ready);
  assert.equal(await evaluate(`document.querySelectorAll('#dataset option').length`), 28);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>[s.label,s.points.at(-1).raw_value])`), [['EPFL', '930'], ['ETHZ', '1428']]);
  assert.equal(await evaluate(`document.querySelectorAll('#chart .series-line').length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('#values-table tbody tr').length`), 46);
  const desktop = await send('Page.captureScreenshot', {format: 'png'});
  await writeFile('/tmp/uni-stats-desktop.png', Buffer.from(desktop.data, 'base64'));
  await select('from', '41'); await wait(ready);
  assert.equal(await evaluate(`state.data.periods.length`), 5);
  await select('compare', 'Studienstufe'); await wait(ready);
  assert.equal(await evaluate(`state.data.series.length`), 1);
  await evaluate(`document.querySelector('#categories input[value="2"]').click()`); await wait(ready);
  assert.equal(await evaluate(`state.data.series.length`), 2);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.label)`), ['Bachelor', 'Master']);
  await evaluate(`document.getElementById('reset').click()`); await wait(ready);
  await evaluate(`document.getElementById('category-search').value='ETH';document.getElementById('category-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelectorAll('#categories input').length`), 1);
  assert.equal(await evaluate(`state.values.length`), 2);
  const datasets = await evaluate(`state.catalog.map(d=>d.id)`);
  for (const dataset of datasets) {
    await select('dataset', dataset); await wait(ready + ` && state.data.dataset === ${JSON.stringify(dataset)}`);
    assert.equal(await evaluate(`document.getElementById('error').hidden`), true, dataset);
    assert.equal(await evaluate(`state.data.series.length`), 2, dataset);
  }
  await evaluate(`document.getElementById('reset').click()`); await wait(ready);
  await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await wait(`document.documentElement.scrollWidth <= 390`);
  await wait(`document.querySelector('#chart svg').getAttribute('viewBox').startsWith('0 0 520 ')`);
  const metrics = await send('Page.getLayoutMetrics');
  const mobile = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true,
    clip: {x: 0, y: 0, width: 390, height: metrics.cssContentSize.height, scale: 1}});
  await writeFile('/tmp/uni-stats-mobile.png', Buffer.from(mobile.data, 'base64'));
  assert.deepEqual(errors, [], 'Browser console errors');
  console.log('PASS: default values, range, comparison/filter changes, category search, all 28 datasets, mobile layout, no browser errors.');
} finally {socket.close();}
