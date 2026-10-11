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
async function select(id, value) {await evaluate(`{const node = document.getElementById(${JSON.stringify(id)});
  node.value = node.type === 'range' ? timeVariable().values.indexOf(${JSON.stringify(value)}) : ${JSON.stringify(value)};
  node.dispatchEvent(new Event('change'));}`);}

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {width: 1360, height: 1100, deviceScaleFactor: 1, mobile: false});
  await send('Page.navigate', {url: base}); await wait(ready);
  assert.equal(await evaluate(`state.view`), 'pyramid', 'Root URL defaults to Pyramid');
  assert.equal(await evaluate(`document.getElementById('pyramid-tab').getAttribute('aria-current')`), 'page');
  assert.equal(await evaluate(`document.getElementById('chart').clientHeight`), 884, 'Desktop pyramid is 70% taller');
  assert.equal(await evaluate(`document.querySelector('#filters select[data-dimension="Fachrichtung"] option:checked').textContent`),'Informatik (Computer Science)');
  assert.equal(await evaluate(`document.getElementById('plot-title').textContent`),'Informatik (Computer Science)');
  assert.equal(await evaluate(`(()=>{const labels=[...document.querySelector('#filters select[data-dimension="Fachrichtung"]').options].filter(o=>o.value!=='__derived_all__').map(o=>variable('Fachrichtung').valueTexts[variable('Fachrichtung').values.indexOf(o.value)]);return labels.every((text,i)=>!i||labels[i-1].localeCompare(text,'de',{sensitivity:'base'})<=0);})()`),true,'Detailed subjects still sort by German names');
  assert.equal(await evaluate(`categoryFullLabel('Fachrichtung','New German subject')`),'New German subject','Unknown subjects retain German alone');

  assert.equal(await evaluate(`(()=>{const c=categories(variable('Hochschule')).find(c=>c.text==='LS');return document.querySelector('#categories input[value="'+c.code+'"]').nextElementSibling.textContent;})()`),'LS — University of Lausanne');
  assert.equal(await evaluate(`(()=>{const c=categories(variable('Hochschule')).find(c=>c.text==='EPFL');const node=document.querySelector('#categories input[value="'+c.code+'"]').nextElementSibling;return node.textContent.length===40 && node.textContent.endsWith('...') && node.title==='EPFL — École polytechnique fédérale de Lausanne';})()`),true,'Long university labels are capped and keep the full name on hover');
  await evaluate(`document.getElementById('category-search').value='Lausanne';document.getElementById('category-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelectorAll('#categories input').length`),2,'Full names are searchable, including the truncated portion');
  await evaluate(`document.getElementById('category-search').value='';document.getElementById('category-search').dispatchEvent(new Event('input'))`);

  async function clearAndCheck() {
    const requestCount=await evaluate(`(()=>{window.emptyRequests=0;window.originalApi=api;api=(...args)=>{window.emptyRequests++;return window.originalApi(...args);};document.getElementById('clear-all').click();return window.emptyRequests;})()`);
    assert.equal(requestCount,0,'Clear all does not request series data');
    assert.equal(await evaluate(`state.data===null && state.plotData===null && !document.querySelector('#chart svg') && document.querySelectorAll('#values-table tbody tr').length===0 && document.querySelectorAll('#categories input:checked').length===0 && document.getElementById('error').hidden && document.getElementById('chart').getAttribute('aria-busy')==='false'`),true,'Empty selection clears stale chart and values without an error');
    await evaluate(`api=window.originalApi`);
  }
  await clearAndCheck();
  await evaluate(`document.getElementById('explorer-tab').click()`); await wait(ready + ` && state.view==='explorer'`);
  await clearAndCheck();
  await evaluate(`document.getElementById('pyramid-tab').click()`);
  await wait(`state.view==='pyramid' && state.detail && !state.data && document.querySelector('#chart .chart-message')`);
  assert.equal(await evaluate(`state.universities.length`),0,'Empty Pyramid selection survives tab switches');
  await evaluate(`document.querySelector('#categories input[value="'+preferred(variable('Hochschule'))+'"]').click()`); await wait(ready);
  // The last checkbox may also be deselected without being forced back on.
  await evaluate(`document.querySelector('#categories input:checked').click()`);
  assert.equal(await evaluate(`state.universities.length===0 && state.data===null`),true);
  await evaluate(`document.querySelector('#categories input[value="'+preferred(variable('Hochschule'))+'"]').click()`); await wait(ready);
  await evaluate(`document.getElementById('explorer-tab').click()`);
  await wait(`state.view==='explorer' && state.detail && !state.data && document.querySelector('#chart .chart-message')`);
  assert.equal(await evaluate(`state.values.length`),0,'Empty Explorer selection survives tab switches');
  await evaluate(`for(const c of categories(variable('Hochschule')).filter(c=>['EPFL','ETHZ'].includes(c.text))) document.querySelector('#categories input[value="'+c.code+'"]').click()`); await wait(ready);

  assert.equal(await evaluate(`document.querySelectorAll('#dataset option').length`), 28);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>[s.label,s.points.at(-1).raw_value])`), [['EPFL', '930'], ['ETHZ', '1428']]);
  assert.equal(await evaluate(`[...document.querySelectorAll('#legend .legend-item span[title]')].every(node=>node.textContent.length<=40 && node.title.length>node.textContent.length)`),true,'Explorer legends use capped full university names');

  assert.equal(await evaluate(`document.querySelectorAll('#chart .series-line').length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('#values-table tbody tr').length`), 46);
  assert.equal(await evaluate(`document.querySelectorAll('.controls #from, .controls #to, .controls #normalize').length`), 0);
  assert.equal(await evaluate(`document.querySelector('.plot-panel').nextElementSibling.classList.contains('chart-controls')`), true);
  assert.equal(await evaluate(`document.querySelector('.chart-controls h2')`), null);
  assert.equal(await evaluate(`document.querySelector('.chart-controls').getBoundingClientRect().width === document.querySelector('.plot-panel').getBoundingClientRect().width`), true);
  assert.equal(await evaluate(`document.getElementById('from').type`), 'range');
  await evaluate(`document.getElementById('percentage').click()`);
  assert.equal(await evaluate(`document.getElementById('normalize').disabled`), true);
  await evaluate(`document.getElementById('normalize').click()`);
  assert.equal(await evaluate(`document.getElementById('normalize').checked`), false);
  assert.equal(await evaluate(`document.querySelectorAll('#chart .series-area').length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('#chart .series-line').length`), 0);
  assert.equal(await evaluate(`Math.abs(state.plotData.series[0].points.at(-1).value - 930 / (930 + 1428) * 100) < 1e-10`), true);
  assert.equal(await evaluate(`state.plotData.series.at(-1).points.at(-1).stack_upper`), 100);
  assert.equal(await evaluate(`document.querySelector('#values-table tbody td:nth-child(2)').textContent.endsWith('%')`), true);
  await evaluate(`document.getElementById('chart').focus(); document.getElementById('chart').dispatchEvent(new KeyboardEvent('keydown', {key:'End'}))`);
  assert.equal(await evaluate(`document.querySelector('#chart .tooltip-row b').textContent.endsWith('%')`), true);
  await evaluate(`{const code=categories(variable(state.compare)).find(c=>c.text==='ETHZ').code;
    [...document.querySelectorAll('#categories input')].find(input=>input.value===code).click();}`); await wait(ready);
  assert.equal(await evaluate(`state.plotData.series.length`), 1);
  assert.equal(await evaluate(`state.plotData.series[0].points.at(-1).value`), 100);
  await evaluate(`{const code=categories(variable(state.compare)).find(c=>c.text==='ETHZ').code;
    [...document.querySelectorAll('#categories input')].find(input=>input.value===code).click();}`); await wait(ready);
  assert.equal(await evaluate(`Math.abs(state.plotData.series.reduce((n,s)=>n+s.points.at(-1).value,0)-100)<1e-10`), true);
  const shareScreenshot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/uni-stats-percentage.png', Buffer.from(shareScreenshot.data, 'base64'));
  await evaluate(`document.getElementById('percentage').click()`);
  assert.equal(await evaluate(`document.getElementById('normalize').disabled`), false);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.points.at(-1).raw_value)`), ['930', '1428']);
  assert.equal(await evaluate(`document.body.textContent.includes('Explore the source. Understand the differences.')`), false);
  assert.equal(await evaluate(`document.body.textContent.includes('Choose a dataset, select its categories')`), false);
  await evaluate(`document.getElementById('normalize').click()`);
  assert.equal(await evaluate(`document.getElementById('percentage').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('normalization-note').hidden`), false);
  assert.equal(await evaluate(`state.plotData.series.every(s => s.points.every(p => p.value === null))`), true);
  await select('from', '27'); await wait(ready);
  assert.equal(await evaluate(`document.getElementById('from-label').textContent`), '2007/08');
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
  assert.equal(await evaluate(`document.getElementById('percentage').disabled`), false);
  const desktop = await send('Page.captureScreenshot', {format: 'png'});
  await writeFile('/tmp/uni-stats-desktop.png', Buffer.from(desktop.data, 'base64'));
  await select('from', '41'); await wait(ready);
  assert.equal(await evaluate(`state.data.periods.length`), 5);
  // Actual keyboard navigation changes the end handle and updates the API range.
  await evaluate(`document.getElementById('to').focus()`);
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowLeft', code:'ArrowLeft'});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowLeft', code:'ArrowLeft'});
  await wait(ready + ` && state.data.periods.length === 4`);
  // Drag both actual thumbs; crossing collapses the interval to one period.
  const sliderBox = await evaluate(`{const b=document.getElementById('period-slider').getBoundingClientRect(); ({x:b.left+9,y:b.top+16,w:b.width-18,max:Number(document.getElementById('to').max)})}`);
  async function dragHandle(fromIndex, toIndex) {
    const x1 = sliderBox.x + fromIndex / sliderBox.max * sliderBox.w, x2 = sliderBox.x + toIndex / sliderBox.max * sliderBox.w;
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:x1,y:sliderBox.y});
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x:x1,y:sliderBox.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:x2,y:sliderBox.y,button:'left',buttons:1});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:x2,y:sliderBox.y,button:'left',clickCount:1});
  }
  await dragHandle(41, 40); await wait(ready + ` && state.data.periods.length === 5`);
  await dragHandle(44, 39); await wait(ready + ` && state.data.periods.length === 1`);
  // Overlapping thumbs can separate in either direction.
  await dragHandle(40, 44); await wait(ready + ` && state.data.periods.length === 5`);
  await select('from', '41'); await select('to', '45'); await wait(ready + ` && state.data.periods.length === 5`);
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
    await evaluate(`document.getElementById('percentage').click()`);
    assert.equal(await evaluate(`Math.abs(state.plotData.series.find(s=>s.label==='EPFL').points.at(-1).value - 286/(286+369)*100)<1e-10`), true);
    await evaluate(`document.getElementById('percentage').click()`);
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
  await evaluate(`document.getElementById('normalize').click(); document.getElementById('percentage').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#chart .series-area').length`), 2);
  assert.equal(await evaluate(`document.getElementById('normalize').disabled`), true);
  const metrics = await send('Page.getLayoutMetrics');
  const mobile = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true,
    clip: {x: 0, y: 0, width: 390, height: metrics.cssContentSize.height, scale: 1}});
  await writeFile('/tmp/uni-stats-mobile.png', Buffer.from(mobile.data, 'base64'));
  // Pyramid is a separate tab, with its own selection state and a flow-only catalog.
  await send('Emulation.setDeviceMetricsOverride', {width:1360,height:1100,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.getElementById('pyramid-tab').click()`); await wait(ready + ` && state.view==='pyramid' && state.data.dataset==='px-x-1502040100_123'`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.tabs a')].map(a=>a.textContent)`), ['Pyramid','Data explorer']);
  assert.equal(await evaluate(`document.getElementById('pyramid-tab').getAttribute('aria-current')`), 'page');
  assert.equal(await evaluate(`document.querySelectorAll('#dataset option').length`), 6);
  assert.equal(await evaluate(`viewDatasets().every(d=>['Bachelor entrants','Degrees'].includes(d.group))`), true);
  assert.equal(await evaluate(`document.querySelector('#dataset option[value="px-x-1502040100_105"]')`), null);
  assert.equal(await evaluate(`document.getElementById('compare-field').hidden && !document.getElementById('compare-categories').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('normalize').closest('label').hidden`), true);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>[s.label,s.points.at(-1).raw_value])`), [['Mann','233'],['Frau','53']]);
  assert.equal(await evaluate(`document.querySelectorAll('#filters select[data-dimension="Hochschule"]').length`), 0);
  assert.deepEqual(await evaluate(`['left','right'].map(side=>document.querySelector('.pyramid-row:last-of-type .pyramid-bar[data-side="'+side+'"]').getAttribute('data-value'))`), ['233','53']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-total')].map(node=>node.firstChild.nodeValue)`),['233','53'],'Unstacked labels show each population count');
  assert.equal(await evaluate(`document.querySelector('.pyramid-row:last-of-type .pyramid-year').textContent`),'2025/26 ('+(new Date().getFullYear()-2025)+')');
  assert.equal(await evaluate(`document.querySelector('.pyramid-total[data-count="0"]')`),null,'Zero count labels are hidden');
  assert.equal(await evaluate(`(()=>{const source=state.plotData,modified=structuredClone(source);modified.series[0].points.at(-1).value=0;modified.series[0].points.at(-1).raw_value='0';drawPyramid(modified);const row=document.querySelector('.pyramid-row:last-of-type');const valid=!row.querySelector('.pyramid-total[data-side="left"]') && row.querySelector('.pyramid-total[data-side="right"]').dataset.count==='53';drawPyramid(source);return valid;})()`),true,'A zero total hides only its own label');


  assert.deepEqual(await evaluate(`['.pyramid-row:first-of-type','.pyramid-row:last-of-type'].map(s=>document.querySelector(s).getAttribute('data-period'))`), ['1980/81','2025/26']);
  async function checkPyramidFit() {
    assert.equal(await evaluate(`(()=>{const root=document.getElementById('chart'),box=root.getBoundingClientRect(),labels=[...document.querySelectorAll('.pyramid-total')];return labels.length===pyramidSides(state.plotData).sides.flatMap(s=>s.points).filter(p=>pyramidCount(p,state.plotData.percentage)!==0).length && labels.every(node=>{const b=node.getBoundingClientRect();return b.left>=box.left && b.right<=box.right && b.top>=box.top && b.bottom<=box.bottom;});})()`),true,'Nonzero totals and missing-count labels fit the fixed chart');

    assert.equal(await evaluate(`(()=>{const r=document.getElementById('chart'),b=r.getBoundingClientRect();
      return r.scrollHeight<=r.clientHeight && [...document.querySelectorAll('.pyramid-bar')].every(bar=>{
        const x=bar.getBoundingClientRect();return x.top>=b.top && x.bottom<=b.bottom;
      });})()`), true, 'All bars fit the fixed container without scrolling');
    assert.equal(await evaluate(`(()=>{const labels=[...document.querySelectorAll('.pyramid-year')].map(t=>t.getBoundingClientRect());
      return labels.every((b,i)=>!i || b.top>=labels[i-1].bottom);})()`), true, 'Visible year labels do not overlap');
  }
  await checkPyramidFit();
  const fullHeight=await evaluate(`document.getElementById('chart').clientHeight`);
  async function checkSyntheticPyramid() {
    const measurements=await evaluate(`(()=>{const source=state.plotData,stats=[];
      for(const count of [2,100]) {
        const periods=Array.from({length:count},(_,i)=>String(1900+i));
        const data={...source,periods,series:source.series.map(s=>({...s,points:periods.map(period=>({...s.points.at(-1),period}))}))};
        drawPyramid(data);
        const root=document.getElementById('chart');
        const years=[...document.querySelectorAll('.pyramid-year')].map(t=>t.getBoundingClientRect());
        const bars=[...document.querySelectorAll('.pyramid-bar')].map(t=>t.getBoundingClientRect());
        stats.push({height:root.clientHeight,noScroll:root.scrollHeight<=root.clientHeight,
          rows:document.querySelectorAll('.pyramid-row').length,barHeight:bars[0].height,
          labelsFit:years.every((b,i)=>!i || b.top>=years[i-1].bottom),
          barsFit:bars.every(b=>b.top>=root.getBoundingClientRect().top && b.bottom<=root.getBoundingClientRect().bottom),
          totalLabelsFit:[...document.querySelectorAll('.pyramid-total')].length===count*2 && [...document.querySelectorAll('.pyramid-total')].every(t=>{const b=t.getBoundingClientRect(),r=root.getBoundingClientRect();return b.top>=r.top && b.bottom<=r.bottom && b.left>=r.left && b.right<=r.right;})});
      }
      document.getElementById('chart').focus();document.getElementById('chart').dispatchEvent(new KeyboardEvent('keydown',{key:'End'}));
      const inspected=document.querySelector('#chart .tooltip strong').textContent;
      drawPyramid(source);return {stats,inspected};})()`);
    assert.deepEqual(measurements.stats.map(s=>s.rows),[2,100]);
    assert.equal(measurements.stats[0].height,measurements.stats[1].height);
    assert(measurements.stats.every(s=>s.noScroll && s.labelsFit && s.barsFit && s.totalLabelsFit));
    assert(measurements.stats[0].barHeight>measurements.stats[1].barHeight*40);
    assert.equal(measurements.inspected,'1999','Dense unlabeled years remain keyboard-inspectable');
  }
  await checkSyntheticPyramid();
  await evaluate(`document.getElementById('split-nationality').click()`); await wait(ready + ` && state.compare==='Staatsangehörigkeit (Kategorie)'`);
  assert.equal(await evaluate(`state.data.dataset`), 'px-x-1502040100_124');
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.points.at(-1).raw_value)`), ['134','152']);
  assert.equal(await evaluate(`selectionLabel('Hochschule',state.filters.Hochschule)`), 'EPFL');
  // A selected subset sums per year; stacked geometry uses exactly those same totals.
  await evaluate(`{const code=categories(variable('Hochschule')).find(c=>c.text==='ETHZ').code;
    [...document.querySelectorAll('#categories input')].find(input=>input.value===code).click();}`); await wait(ready);
  assert.equal(await evaluate(`state.universities.length`), 2);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.points.at(-1).value)`),
    await evaluate(`state.data.series.map(s=>s.points.at(-1).segments.reduce((sum,p)=>sum+p.value,0))`));
  const subsetTotals=await evaluate(`state.data.series.map(s=>s.points.at(-1).value)`);
  await evaluate(`document.getElementById('stack-universities').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar').length`), 4);
  assert.equal(await evaluate(`document.querySelectorAll('#legend .legend-item').length`), 2);
  assert.deepEqual(await evaluate(`state.data.universities.map(u=>u.label)`),['ETHZ','EPFL'],'Latest-year combined population determines one university ranking');
  assert.equal(await evaluate(`(()=>{const order=state.data.universities.map(u=>u.code).join(',');return [...document.querySelectorAll('.pyramid-row')].every(row=>['left','right'].every(side=>[...row.querySelectorAll('.pyramid-bar[data-side="'+side+'"]')].map(b=>b.dataset.university).join(',')===order));})()`),true,'Every year and both sides use the same ranking');
  await evaluate(`document.getElementById('chart').focus();document.getElementById('chart').dispatchEvent(new KeyboardEvent('keydown',{key:'Home'}))`);
  assert.equal(await evaluate(`(()=>{const groups=[...document.querySelectorAll('#chart .pyramid-tooltip-population')];const order=state.data.universities.map(u=>u.code).join(',');return groups.length===2 && groups.every(group=>group.firstChild.classList.contains('pyramid-tooltip-total') && group.firstChild.textContent.includes('total') && [...group.querySelectorAll('.pyramid-tooltip-component')].map(row=>row.dataset.university).join(',')===order) && parseFloat(getComputedStyle(groups[1]).borderTopWidth)>0;})()`),true,'Tooltip populations have totals, consistent ranked breakdowns and a divider');
  assert.equal(await evaluate(`(()=>{const bars=[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar[data-side="left"]')];const dots=[...document.querySelectorAll('#legend .legend-item')].map(item=>item.firstChild);return bars.every((bar,i)=>bar.getAttribute('fill')===dots[i].style.background || getComputedStyle(bar).fill===getComputedStyle(dots[i]).backgroundColor);})()`),true,'Legend colors match ranked segments');

  assert.equal(await evaluate(`(()=>{const bars=[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar')];
    return ['left','right'].every((side,i)=>Math.abs(bars.filter(b=>b.dataset.side===side).reduce((sum,b)=>sum+Number(b.dataset.value),0)-pyramidSides(state.plotData).sides[i].points.at(-1).value)<1e-9);})()`), true);
  await evaluate(`document.getElementById('percentage').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-total')].map(node=>Number(node.dataset.count))`),subsetTotals,'Stacked percentage bars retain original count labels');
  assert.equal(await evaluate(`(()=>{const bars=[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar')];
    return Math.abs(bars.reduce((sum,b)=>sum+Number(b.dataset.value),0)-100)<1e-9;})()`), true);
  assert.deepEqual(await evaluate(`state.data.series.map(s=>s.points.at(-1).value)`), subsetTotals, 'Display transforms preserve source counts');
  const stackedScreenshot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/uni-stats-pyramid-stacked.png',Buffer.from(stackedScreenshot.data,'base64'));
  await evaluate(`document.getElementById('explorer-tab').click()`); await wait(ready + ` && state.view==='explorer'`);
  assert.equal(await evaluate(`document.getElementById('stack-universities').closest('label').hidden`),true);
  await evaluate(`document.getElementById('pyramid-tab').click()`); await wait(ready + ` && state.view==='pyramid'`);
  assert.equal(await evaluate(`state.universities.length===2 && state.plotData.stacked && state.plotData.percentage`),true,'Pyramid selection and stacking survive switching tabs');
  await evaluate(`document.getElementById('percentage').click();document.getElementById('stack-universities').click()`);
  // All universities is one derived pyramid, equal to summing each source university.
  await evaluate(`document.getElementById('select-all').click()`); await wait(ready);
  assert.equal(await evaluate(`state.data.derived && state.data.filters.Hochschule===null`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#chart svg').length`), 1);
  const directSum = await evaluate(`(async()=>{const v=variable('Hochschule');const query={dataset:state.detail.id,snapshot:state.detail.snapshot_id,
    compare:'Hochschule',values:v.values,filters:{...state.filters,'Staatsangehörigkeit (Kategorie)':'0'}};
    delete query.filters.Hochschule;
    const result=await api('/api/series?query='+encodeURIComponent(JSON.stringify(query)));
    return result.series.reduce((total,s)=>total+s.points.at(-1).value,0);})()`);
  assert.equal(await evaluate(`state.data.series[0].points.at(-1).value`), directSum);
  await evaluate(`document.getElementById('stack-universities').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar').length`), await evaluate(`state.universities.length*2`));
  assert.equal(await evaluate(`[...document.querySelectorAll('.pyramid-bar')].every(bar=>getComputedStyle(bar).fillOpacity==='1')`),true,'All stacked segments are fully opaque');
  assert.equal(await evaluate(`state.data.universities[0].colorCount===state.data.universities.filter(u=>u.rankingTotal>0).length`),true,'Nonzero universities get the complete shade range');

  assert.equal(await evaluate(`(()=>{const bars=[...document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar')];
    return ['left','right'].every(side=>{const parts=bars.filter(b=>b.dataset.side===side);
      return parts.every((bar,i)=>!i || Math.abs(side==='right' ? Number(bar.getAttribute('x'))-Number(parts[i-1].getAttribute('x'))-Number(parts[i-1].getAttribute('width')) : Number(bar.getAttribute('x'))+Number(bar.getAttribute('width'))-Number(parts[i-1].getAttribute('x')))<1e-8);});})()`),true,'Segments are contiguous on both mirrored sides');
  await evaluate(`document.getElementById('stack-universities').click()`);
  await select('from',await evaluate(`timeVariable().values.at(-5)`)); await wait(ready + ` && state.data.periods.length===5`);
  await evaluate(`document.getElementById('split-gender').click()`); await wait(ready + ` && state.compare==='Geschlecht'`);
  assert.equal(await evaluate(`state.filters.Hochschule`), null);
  assert.equal(await evaluate(`state.data.periods.length`), 5);
  assert.equal(await evaluate(`state.data.periods[0]`), '2021/22', 'Match periods by labels across source code renumbering');
  await evaluate(`document.getElementById('percentage').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.pyramid-bar').length`), 10);
  assert.equal(await evaluate(`Math.abs(state.plotData.series.reduce((n,s)=>n+s.points.at(-1).value,0)-100)<1e-10`), true);
  assert.equal(await evaluate(`document.querySelector('#values-table tbody td:nth-child(2)').textContent.endsWith('%')`), true);
  await select('dataset','px-x-1503040100_101'); await wait(ready + ` && state.data.dataset==='px-x-1503040100_101'`);
  assert.equal(await evaluate(`state.data.series.length`), 3);
  assert.deepEqual(await evaluate(`pyramidSides(state.data).sides.map(s=>s.points.at(-1).raw_value)`), ['172','35']);
  assert.equal(await evaluate(`document.getElementById('pyramid-period-note').textContent.includes('graduation year')`), true);
  assert.equal(await evaluate(`document.querySelector('.pyramid-row:last-of-type .pyramid-year').textContent`),'2025 ('+(new Date().getFullYear()-2025)+')','Graduation rows show elapsed calendar years');

  assert.equal(await evaluate(`document.querySelectorAll('#values-table thead th').length`), 4);
  assert.equal(await evaluate(`(()=>{const source=state.data, modified=structuredClone(source);
    const unknown=pyramidSides(modified).other[0];unknown.points.at(-1).value=10;unknown.points.at(-1).raw_value='10';
    state.data=modified;renderResults();
    const correct=!document.getElementById('pyramid-note').hidden &&
      Math.abs(pyramidSides(state.plotData).sides[0].points.at(-1).value-172/(172+35+10)*100)<1e-10 &&
      document.querySelectorAll('.pyramid-row:last-of-type .pyramid-bar').length===2;
    state.data=source;renderResults();return correct;})()`), true, 'Unknown gender stays in totals without being assigned to a side');
  // Preserve qualification, subject, university, and range when changing source split.
  await evaluate(`{const s=document.querySelector('#filters select[data-dimension="Examensstufe"]');s.value=categories(variable('Examensstufe')).find(c=>c.text==='Master').code;s.dispatchEvent(new Event('change'));}`); await wait(ready);
  await evaluate(`document.getElementById('split-nationality').click()`); await wait(ready + ` && state.data.dataset==='px-x-1503040100_102'`);
  assert.equal(await evaluate(`selectionLabel('Examensstufe',state.filters.Examensstufe)`), 'Master');
  for (const dataset of await evaluate(`viewDatasets().map(d=>d.id)`)) {
    await select('dataset',dataset); await wait(ready + ` && state.data.dataset===${JSON.stringify(dataset)}`);
    assert.equal(await evaluate(`document.getElementById('error').hidden`), true, 'pyramid '+dataset);
    assert.equal(await evaluate(`document.querySelectorAll('.pyramid-row').length===state.data.periods.length`), true);
  }
  await evaluate(`document.getElementById('reset').click()`); await wait(ready + ` && state.data.dataset==='px-x-1502040100_123'`);
  assert.equal(await evaluate(`document.getElementById('percentage').checked`), false);
  await select('from','41'); await wait(ready + ` && state.data.periods.length===5`);
  assert.equal(await evaluate(`document.getElementById('chart').clientHeight`), fullHeight);
  await checkPyramidFit();
  await evaluate(`document.getElementById('chart').focus();document.getElementById('chart').dispatchEvent(new KeyboardEvent('keydown',{key:'End'}))`);
  assert.equal(await evaluate(`document.querySelector('#chart .tooltip strong').textContent`), '2025/26');
  const pyramidDesktop = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/uni-stats-pyramid-desktop.png',Buffer.from(pyramidDesktop.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await wait(`document.documentElement.scrollWidth<=390 && document.querySelector('#chart svg').getAttribute('viewBox').startsWith('0 0 520 ')`);
  assert.equal(await evaluate(`document.getElementById('chart').clientHeight`), 816, 'Mobile pyramid is 70% taller');
  await checkPyramidFit(); await checkSyntheticPyramid();
  const pyramidMetrics=await send('Page.getLayoutMetrics');
  const pyramidMobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:pyramidMetrics.cssContentSize.height,scale:1}});
  await writeFile('/tmp/uni-stats-pyramid-mobile.png',Buffer.from(pyramidMobile.data,'base64'));
  await evaluate(`document.getElementById('explorer-tab').click()`); await wait(ready + ` && state.view==='explorer' && state.data.dataset==='px-x-1502040100_105'`);
  assert.equal(await evaluate(`document.querySelectorAll('#dataset option').length`), 28);
  assert.equal(await evaluate(`document.getElementById('percentage').checked`), true);
  assert.equal(await evaluate(`document.getElementById('from-label').textContent`), '2007/08');
  await evaluate(`document.getElementById('pyramid-tab').click()`); await wait(ready + ` && state.view==='pyramid'`);
  assert.equal(await evaluate(`state.data.periods.length`), 5);
  assert.equal(await evaluate(`document.getElementById('percentage').checked`), false);
  await evaluate(`loadDataset('px-x-1502040100_105')`);
  assert.equal(await evaluate(`state.detail.group`), 'Bachelor entrants', 'Explicitly reject enrolled datasets');
  await send('Page.navigate',{url:base+'/#pyramid'}); await wait(ready + ` && state.view==='pyramid'`);
  assert.equal(await evaluate(`state.detail.group`), 'Bachelor entrants', 'Direct pyramid URL has flow-only defaults');
  await send('Page.navigate',{url:base+'/#explorer'}); await wait(ready + ` && state.view==='explorer'`);
  assert.equal(await evaluate(`state.detail.group`), 'Enrolled students', 'Explicit explorer URL retains its own default');
  await select('compare','Fachrichtung'); await wait(ready + ` && state.compare==='Fachrichtung'`);
  await evaluate(`document.getElementById('category-search').value='Computer Science';document.getElementById('category-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelectorAll('#categories input').length`),1,'Subjects are searchable in English');
  assert.equal(await evaluate(`document.querySelector('#categories input').nextElementSibling.textContent`),'Informatik (Computer Science)');
  assert.equal(await evaluate(`document.querySelector('#legend .legend-item').textContent`),'Informatik (Computer Science)');
  assert.equal(await evaluate(`document.querySelector('#values-table thead th:nth-child(2)').textContent`),'Informatik (Computer Science)');
  assert.equal(await evaluate(`state.data.series[0].label`),'Informatik','Original BFS labels stay intact');

  for (const view of ['pyramid','explorer']) {
    await send('Page.navigate',{url:base+'/#'+view}); await wait(ready + ` && state.view==='${view}'`);
    if (view==='explorer') {await evaluate(`$('reset').click()`);await wait(ready + ` && state.compare==='Hochschule'`);}
    assert.equal(await evaluate(`$('stack-subjects').disabled`),true,'Requires All subjects');
    await evaluate(`{const node=document.querySelector('#filters select[data-dimension="Fachrichtung"]');node.value=ALL;node.dispatchEvent(new Event('change'));}`); await wait(ready);
    assert.equal(await evaluate(`$('stack-subjects').disabled`),false);
    if (view==='pyramid') {
      await evaluate(`window.batchRequests=0;window.batchOriginalApi=api;api=(url,...args)=>{if(url.startsWith('/api/series?')) window.batchRequests++;return window.batchOriginalApi(url,...args);};$('select-all').click()`);
      await wait(ready);
      assert.equal(await evaluate(`window.batchRequests`),1,'All universities use one API request');
      assert.equal(await evaluate(`state.data.universities.length`),await evaluate(`variable('Hochschule').values.length`));
      await evaluate(`window.batchRequests=0`);
    }
    await evaluate(`$('stack-subjects').click()`); await wait(ready + ` && state.data.breakdown==='Fachrichtung'`);
    if(view==='pyramid') {assert.equal(await evaluate(`window.batchRequests`),1,'Subject breakdown also uses one request');await evaluate(`api=window.batchOriginalApi`);}
    assert.equal(await evaluate(`$('stack-universities').disabled && $('normalize').disabled`),true);
    assert.equal(await evaluate(view==='pyramid' ? `document.querySelectorAll('.pyramid-bar[data-subject]').length>0` : `document.querySelectorAll('.series-area').length>0 && state.plotData.subjectStacked`),true,'Subjects are rendered as stacks');
    assert.equal(await evaluate(`state.plotData.series.every(s=>s.points.every((p,j)=>p.value===null || ${view==='pyramid' ? 'Math.abs(p.segments.reduce((n,c)=>n+c.value,0)-p.value)<1e-6' : 'p.stack_upper>=p.stack_lower'}))`),true,'Stack bounds preserve totals');
    await evaluate(`$('percentage').click()`); await wait(ready);
    assert.equal(await evaluate(`state.plotData.percentage`),true,'Subject stacks support percentages');
    await evaluate(`$('stack-subjects').click()`); await wait(ready + ` && !state.data.breakdown`);
    assert.equal(await evaluate(`$('stack-subjects').checked`),false);
  }

  assert.deepEqual(errors, [], 'Browser console errors');
  console.log('PASS: explorer regression checks, flow-only Pyramid tab, both splits, source-period mapping, all-university sums, degrees and unknown gender, percentage mode, tab state restoration, direct URLs, keyboard inspection and mobile layout.');
} finally {socket.close();}
