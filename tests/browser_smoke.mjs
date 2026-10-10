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
  assert.equal(await evaluate(`document.body.textContent.includes('Explore the source. Understand the differences.')`), false);
  assert.equal(await evaluate(`document.body.textContent.includes('Choose a dataset, select its categories')`), false);
  await evaluate(`document.getElementById('normalize').click()`);
  assert.equal(await evaluate(`document.getElementById('normalization-note').hidden`), false);
  assert.equal(await evaluate(`state.plotData.series.every(s => s.points.every(p => p.value === null))`), true);
  await select('from', '27'); await wait(ready);
  assert.deepEqual(await evaluate(`state.plotData.series.map(s => s.points[0].value)`), [100, 100]);
  assert.equal(await evaluate(`document.getElementById('normalization-note').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#chart .axis-title').textContent`), 'Index (2007/08 = 100)');
  assert.equal(await evaluate(`document.querySelector('#values-table tbody tr:last-child td:nth-child(2)').textContent`), '100');
  assert.equal(await evaluate(`state.plotData.series[0].points.at(-1).value === state.data.series[0].points.at(-1).value / state.data.series[0].points[0].value * 100`), true);
  await select('from', '28'); await wait(ready);
  assert.deepEqual(await evaluate(`state.plotData.series.map(s => s.points[0].value)`), [100, 100]);
  await evaluate(`document.getElementById('normalize').click()`);
  assert.equal(await evaluate(`document.querySelector('#chart .axis-title').textContent`), 'Source value');
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.points.at(-1).raw_value)`), ['930', '1428']);
  await evaluate(`document.getElementById('reset').click()`); await wait(ready);
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
    // Exercise every eligible fixed dimension's All option together.
    await evaluate(`for (const s of document.querySelectorAll('#filters select')) {
      if ([...s.options].some(o => o.value === '__derived_all__')) {
        s.value = '__derived_all__'; s.dispatchEvent(new Event('change'));
      }
    }`);
    await wait(ready);
    assert.equal(await evaluate(`document.getElementById('error').hidden`), true, dataset + ' All');
    assert.equal(await evaluate(`state.data.series.length`), 2, dataset + ' All');
  }
  for (const [dataset, dimension] of [['px-x-1502040100_123', 'Geschlecht'],
                                    ['px-x-1502040100_124', 'Staatsangehörigkeit (Kategorie)']]) {
    await select('dataset', dataset); await wait(ready + ` && state.data.dataset === ${JSON.stringify(dataset)}`);
    await evaluate(`{const s = [...document.querySelectorAll('#filters select')].find(s => s.dataset.dimension === ${JSON.stringify(dimension)});
      s.value = '__derived_all__'; s.dispatchEvent(new Event('change'));}`);
    await wait(ready);
    assert.deepEqual(await evaluate(`state.data.series.map(s=>[s.label,s.points.at(-1).raw_value])`), [['EPFL', '286'], ['ETHZ', '369']]);
    assert.equal(await evaluate(`state.data.derived`), true);
    assert.equal(await evaluate(`document.querySelector('#chart .axis-title').textContent`), 'Derived sum');
    const start = await evaluate(`state.detail.metadata.variables.find(v=>v.time).values.at(-5)`);
    await select('from', start); await wait(ready);
    await evaluate(`document.getElementById('normalize').click()`);
    assert.deepEqual(await evaluate(`state.plotData.series.map(s=>s.points[0].value)`), [100, 100]);
    assert.equal(await evaluate(`state.plotData.series[0].points.at(-1).value === state.data.series[0].points.at(-1).value / state.data.series[0].points[0].value * 100`), true);
    await evaluate(`document.getElementById('normalize').click()`);
    // Changing the comparison dimension from All must select a real category.
    await select('compare', dimension); await wait(ready);
    assert.equal(await evaluate(`document.getElementById('error').hidden`), true);
    assert.equal(await evaluate(`state.values.every(v=>variable(state.compare).values.includes(v))`), true);
  }
  await select('dataset', 'px-x-1506030100_211'); await wait(ready + ` && state.data.dataset === 'px-x-1506030100_211'`);
  assert.equal(await evaluate(`document.querySelectorAll('#filters option[value="__derived_all__"]').length`), 0);
  await select('compare', 'Indikator'); await wait(ready);
  await evaluate(`{const s = [...document.querySelectorAll('#filters select')].find(s=>s.dataset.dimension === 'Hochschule');
    s.value='__derived_all__'; s.dispatchEvent(new Event('change'));}`);
  await wait(ready);
  assert.equal(await evaluate(`state.data.aggregation.Hochschule.mode`), 'published_total');
  assert.equal(await evaluate(`state.data.derived`), false);
  await evaluate(`document.getElementById('reset').click()`); await wait(ready);
  await select('from', '27'); await wait(ready);
  await evaluate(`document.getElementById('normalize').click()`);
  await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await wait(`document.documentElement.scrollWidth <= 390`);
  await wait(`document.querySelector('#chart svg').getAttribute('viewBox').startsWith('0 0 520 ')`);
  assert.deepEqual(await evaluate(`state.plotData.series.map(s => s.points[0].value)`), [100, 100]);
  assert.equal(await evaluate(`document.querySelector('#chart .axis-title').textContent`), 'Index (2007/08 = 100)');
  const metrics = await send('Page.getLayoutMetrics');
  const mobile = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true,
    clip: {x: 0, y: 0, width: 390, height: metrics.cssContentSize.height, scale: 1}});
  await writeFile('/tmp/uni-stats-mobile.png', Buffer.from(mobile.data, 'base64'));
  assert.deepEqual(errors, [], 'Browser console errors');
  console.log('PASS: default values, normalization, All across 28 datasets, CS Bachelor entrant totals from gender and nationality, normalized sums, comparison changes from All, published totals and nonadditive restrictions, mobile layout, no browser errors.');
} finally {socket.close();}
