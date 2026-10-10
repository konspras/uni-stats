'use strict';

const $ = id => document.getElementById(id);
const names = {Hochschule: 'University', Fachrichtung: 'Subject (detailed)', Fachbereich: 'Subject (broad)',
  Studienstufe: 'Study level', Examensstufe: 'Qualification level', Geschlecht: 'Gender',
  'Staatsangehörigkeit (Kategorie)': 'Nationality', Bildungsherkunft: 'Educational origin',
  'Wohnkanton vor Studienbeginn': 'Canton before studying', Personalkategorie: 'Staff category',
  Finanzquelle: 'Funding source', Finanzierungstyp: 'Funding type', Aufwandsart: 'Expenditure type',
  Leistung: 'Activity', Kostenart: 'Cost type', Erlöskategorie: 'Revenue category', Indikator: 'Indicator'};
const colors = ['#365bd6', '#db7853', '#278d7a', '#8d5cbe', '#b79b29', '#ca5992', '#3b90b7', '#797564'];
const ALL = '__derived_all__';
const state = {catalog: [], detail: null, filters: {}, compare: '', values: [], data: null, generation: 0, plotSequence: 0};
const date = value => value ? new Date(value).toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'}) : 'Not supplied';
const label = code => names[code] || code;
const number = value => value === null ? '—' : new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(value);
function el(tag, text, className) {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;}
function option(select, value, text) {const node = el('option', text); node.value = value; select.append(node);}
function error(message) {$('error').textContent = message; $('error').hidden = !message;}
async function api(path, signal) {const response = await fetch(path, {signal}); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load data'); return result;}
function variable(code) {return state.detail.metadata.variables.find(v => v.code === code);}
function categories(v) {return v.values.map((code, i) => ({code, text: v.valueTexts[i]}));}
function selectionLabel(code, value) {
  if (value === null) return state.detail.aggregation_options[code].mode === 'sum' ? 'All (derived sum)' : 'All (published total)';
  const v = variable(code); return v.valueTexts[v.values.indexOf(value)];
}
function preferred(v) {
  const preferences = v.code === 'Fachrichtung' ? ['Informatik'] : v.code === 'Fachbereich' ? ['4.1 Exakte Wissenschaften'] :
    v.code === 'Studienstufe' || v.code === 'Examensstufe' ? ['Bachelor'] : v.code === 'Hochschule' ? ['EPFL', 'ETHZ'] : [];
  return categories(v).find(c => preferences.includes(c.text))?.code || v.values[0];
}
function titleFor(dataset) {
  const qualifier = dataset.title.includes('VZÄ') ? ' · FTE' : dataset.title.includes('in Personen') ? ' · Headcount' : '';
  return dataset.group + qualifier + ' — ' + dataset.dimensions.filter(c => c !== 'Hochschule').map(label).join(', ');
}
function summary() {
  return Object.entries(state.filters).map(([code, value]) => {
    return label(code) + ': ' + selectionLabel(code, value);
  }).join(' · ');
}
function renderCategories() {
  if (!state.detail) return;
  const query = $('category-search').value.trim().toLocaleLowerCase();
  const root = $('categories'); root.replaceChildren();
  const choices = categories(variable(state.compare)).sort((a, b) => Number(state.values.includes(b.code)) - Number(state.values.includes(a.code)));
  for (const c of choices) {
    if (query && !c.text.toLocaleLowerCase().includes(query)) continue;
    const item = el('label', undefined, 'category');
    const input = el('input'); input.type = 'checkbox'; input.value = c.code; input.checked = state.values.includes(c.code);
    input.addEventListener('change', () => {
      if (!input.checked && state.values.length === 1) {input.checked = true; return;}
      state.values = input.checked ? [...state.values, c.code] : state.values.filter(v => v !== c.code);
      $('selected-count').textContent = state.values.length + ' selected'; updatePlot();
    });
    item.append(input, el('span', c.text)); root.append(item);
  }
  if (!root.children.length) root.append(el('p', 'No matching categories.', 'helper'));
  $('selected-count').textContent = state.values.length + ' selected';
}
function renderFilters() {
  const root = $('filters'); root.replaceChildren();
  for (const v of state.detail.metadata.variables.filter(v => !v.time && v.code !== state.compare)) {
    const field = el('label', label(v.code), 'field'); const select = el('select'); select.dataset.dimension = v.code;
    for (const c of categories(v)) option(select, c.code, c.text);
    const aggregation = state.detail.aggregation_options[v.code];
    if (aggregation) option(select, ALL, aggregation.mode === 'sum' ? 'All (derived sum)' : 'All (published total)');
    select.value = state.filters[v.code] === null ? ALL : state.filters[v.code];
    select.addEventListener('change', () => {state.filters[v.code] = select.value === ALL ? null : select.value; updatePlot();});
    field.append(select); root.append(field);
    if (!aggregation) field.append(el('span', 'All is unavailable for this dimension.', 'helper'));
  }
}
function renderSource() {
  const detail = state.detail; $('source-name').textContent = detail.title; $('source-link').href = detail.source_url;
  const root = $('provenance'); root.replaceChildren();
  for (const [title, value] of [['Source', 'BFS / OFS / FSO'], ['Snapshot collected', date(detail.fetched_at)],
    ['BFS catalog updated', date(detail.source.catalog?.updated)], ['Table ID', detail.id],
    ['Full dataset', new Intl.NumberFormat().format(detail.rows) + ' source rows'], ['Values', 'As published; see source definitions']]) {
    const block = el('div'); block.append(el('dt', title), el('dd', value)); root.append(block);
  }
  const definitions = $('definitions'); definitions.replaceChildren();
  definitions.append(el('p', 'All (derived sum) adds the source categories within this table. All (published total) selects the existing source total. Missing components leave a gap. Ratios and mixed indicators are not summed. No cross-table mapping is applied. Staff headcount sums count category assignments and may count a person more than once; use FTE for additive staffing comparisons.'));
  for (const column of detail.columns) if (column.comment) {
    definitions.append(el('strong', column.text || column.code), el('p', column.comment.replaceAll('\\r\\n', '\n')));
  }
  for (const comment of detail.comments) definitions.append(el('p', typeof comment === 'string' ? comment : JSON.stringify(comment)));
  const raw = el('details'); raw.append(el('summary', 'Original source metadata'));
  raw.append(el('pre', JSON.stringify({metadata: detail.metadata, columns: detail.columns,
    source: detail.source, response_metadata: detail.source_metadata}, null, 2))); definitions.append(raw);
}
async function loadDataset(id, snapshotId) {
  const generation = ++state.generation; ++state.plotSequence; state.plotController?.abort();
  state.datasetController?.abort(); state.datasetController = new AbortController();
  state.detail = null; state.data = null;
  $('categories').replaceChildren(); $('filters').replaceChildren();
  for (const control of ['compare', 'measure', 'from', 'to', 'snapshot', 'select-all', 'category-search']) $(control).disabled = true;
  error(''); $('chart').setAttribute('aria-busy', 'true'); $('chart').replaceChildren(el('div', 'Loading dataset…', 'chart-message'));
  $('legend').replaceChildren(); $('values-table').querySelector('tbody').replaceChildren();
  try {
    const detail = await api('/api/dataset?id=' + encodeURIComponent(id) + (snapshotId ? '&snapshot=' + snapshotId : ''), state.datasetController.signal);
    if (generation !== state.generation) return;
    state.detail = detail; state.filters = {};
    const dims = detail.metadata.variables.filter(v => !v.time);
    for (const v of dims) state.filters[v.code] = preferred(v);
    state.compare = dims.find(v => v.code === 'Hochschule')?.code || dims[0].code;
    const cv = variable(state.compare); state.values = categories(cv).filter(c => ['EPFL', 'ETHZ'].includes(c.text)).map(c => c.code);
    if (!state.values.length) state.values = [preferred(cv)]; delete state.filters[state.compare];
    $('dataset-description').textContent = detail.id + ' · ' + detail.metadata.variables.find(v => v.time).valueTexts.at(-1);
    $('measure').replaceChildren(); for (const m of detail.columns.filter(c => c.type === 'c')) option($('measure'), m.code, m.text || m.code);
    $('compare').replaceChildren(); for (const v of dims) option($('compare'), v.code, label(v.code)); $('compare').value = state.compare;
    const time = detail.metadata.variables.find(v => v.time);
    for (const id of ['from', 'to']) {$(id).replaceChildren(); for (const c of categories(time)) option($(id), c.code, c.text);}
    $('from').value = time.values[0]; $('to').value = time.values.at(-1);
    $('snapshot').replaceChildren(); for (const [i, s] of detail.snapshots.entries()) option($('snapshot'), s.id, (i === 0 ? 'Latest · ' : '') + date(s.fetched_at) + ' · #' + s.id);
    $('snapshot').value = detail.snapshot_id; $('category-search').value = '';
    for (const control of ['compare', 'measure', 'from', 'to', 'snapshot', 'select-all', 'category-search']) $(control).disabled = false;
    renderCategories(); renderFilters(); renderSource(); await updatePlot();
  } catch (e) {if (e.name !== 'AbortError' && generation === state.generation) {error(e.message); $('chart').replaceChildren(el('div', 'This dataset could not be loaded.', 'chart-message'));}}
  finally {if (generation === state.generation) $('chart').setAttribute('aria-busy', 'false');}
}
async function updatePlot() {
  if (!state.detail) return;
  const sequence = ++state.plotSequence; state.plotController?.abort(); state.plotController = new AbortController();
  $('chart').setAttribute('aria-busy', 'true'); error('');
  const request = {dataset: state.detail.id, snapshot: state.detail.snapshot_id, measure: $('measure').value,
    compare: state.compare, values: state.values, filters: {...state.filters}, from: $('from').value, to: $('to').value};
  try {
    const data = await api('/api/series?query=' + encodeURIComponent(JSON.stringify(request)), state.plotController.signal);
    if (sequence !== state.plotSequence) return;
    state.data = data; renderResults();
  } catch (e) {if (e.name !== 'AbortError' && sequence === state.plotSequence) {
    error(e.message); state.data = null; $('chart').replaceChildren(el('div', 'Adjust your selection to display a series.', 'chart-message'));
    $('legend').replaceChildren(); $('values-table').querySelector('thead').replaceChildren(); $('values-table').querySelector('tbody').replaceChildren();
  }} finally {if (sequence === state.plotSequence) $('chart').setAttribute('aria-busy', 'false');}
}
function renderResults() {
  const detail = state.detail;
  const data = $('normalize').checked ? normalizeSeries(state.data) : state.data;
  state.plotData = data;
  $('plot-group').textContent = detail.group.toUpperCase();
  const subject = Object.entries(state.filters).find(([code]) => ['Fachrichtung', 'Fachbereich'].includes(code));
  $('plot-title').textContent = subject ? selectionLabel(...subject) : label(state.compare) + ' comparison';
  $('plot-context').textContent = summary();
  $('period-badge').textContent = data.periods[0] + ' — ' + data.periods.at(-1);
  $('legend').replaceChildren(); for (const [i, s] of data.series.entries()) {
    const item = el('span', undefined, 'legend-item'); item.append(el('span', undefined, 'legend-dot c' + i % colors.length), el('span', s.label + (s.normalization_issue ? ' (no baseline)' : ''))); $('legend').append(item);
  }
  const unavailable = data.series.filter(s => s.normalization_issue);
  $('normalization-note').hidden = !unavailable.length;
  $('normalization-note').textContent = unavailable.length ? 'Cannot normalize ' + unavailable.map(s => s.label).join(', ') +
    ': the value in ' + data.periods[0] + ' is zero or missing. Select another start year.' : '';
  $('value-note').textContent = data.normalized ? data.periods[0] + ' = 100 for each series. Missing values remain gaps.' : 'Missing values are gaps; source zeros remain zero.';
  $('aggregation-note').textContent = data.derived ? 'Derived sum across selected All dimensions. Missing components leave gaps.' : 'Values from the selected source categories.';
  const valueKind = data.derived ? 'Derived sum' : 'Source value';
  $('table-description').textContent = data.normalized ? 'Index: ' + data.periods[0] + ' = 100. Hover a value for its ' + valueKind.toLowerCase() + '.' : data.derived ? 'Derived sums of source values.' : 'The values exactly as published.';
  drawChart(data);
  const table = $('values-table'), head = el('tr'); head.append(el('th', 'Period'));
  for (const s of data.series) {const th = el('th', s.label); th.scope = 'col'; head.append(th);} head.firstChild.scope = 'col';
  table.querySelector('thead').replaceChildren(head); const body = table.querySelector('tbody'); body.replaceChildren();
  for (let j = data.periods.length - 1; j >= 0; j--) {
    const row = el('tr'); row.append(el('td', data.periods[j]));
    for (const s of data.series) {const point = s.points[j]; const cell = el('td', data.normalized ? number(point.value) : point.raw_value ?? '—', point.value === null ? 'missing' : '');
      if (data.normalized) cell.title = valueKind + ': ' + (point.raw_value ?? 'unavailable') + (s.normalization_issue ? '; starting value is zero or missing' : '');
      else if (point.value === null) cell.title = data.derived ? 'Incomplete sum: ' + point.missing_components + ' missing components' : point.raw_value === null ? 'No published observation' : 'Source missing-value marker'; row.append(cell);}
    body.append(row);
  }
  $('table-count').textContent = data.periods.length + ' periods · ' + data.series.length + ' lines';
}
function svgNode(tag, attributes = {}, text) {const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; return node;}
function drawChart(data) {
  const root = $('chart'); root.replaceChildren();
  root.onkeydown = null; root.onblur = null; root.removeAttribute('tabindex'); root.removeAttribute('aria-label');
  const numbers = data.series.flatMap(s => s.points.map(p => p.value)).filter(v => v !== null);
  if (!numbers.length) {root.append(el('div', data.normalized ? 'No series has a nonzero starting value in ' + data.periods[0] + '.' : 'No numeric values in this selection. Source markers are shown in the table below.', 'chart-message')); return;}
  const narrow = window.matchMedia('(max-width:720px)').matches;
  const width = narrow ? 520 : 860, height = 360, left = 65, right = 22, top = 25, bottom = 49;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  let min = Math.min(0, ...numbers), max = Math.max(0, ...numbers); if (min === max) max = min + 1;
  const step = Math.pow(10, Math.floor(Math.log10((max - min) / 4)));
  const niceStep = [1, 2, 2.5, 5, 10].map(v => v * step).find(v => v >= (max - min) / 4);
  max = Math.ceil(max / niceStep) * niceStep; min = Math.floor(min / niceStep) * niceStep;
  const x = i => left + (data.periods.length === 1 ? plotWidth / 2 : i / (data.periods.length - 1) * plotWidth);
  const y = value => top + (max - value) / (max - min) * plotHeight;
  const svg = svgNode('svg', {viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': data.measure + ': ' + data.series.map(s => s.label).join(', ')});
  svg.append(svgNode('title', {}, data.measure));
  svg.append(svgNode('text', {x: left, y: 11, class: 'axis-title'}, data.normalized ? 'Index (' + data.periods[0] + ' = 100)' : data.derived ? 'Derived sum' : 'Source value'));
  for (let value = min; value <= max + niceStep / 100; value += niceStep) {
    svg.append(svgNode('line', {x1: left, x2: width - right, y1: y(value), y2: y(value), class: 'grid-line'}));
    svg.append(svgNode('text', {x: left - 12, y: y(value) + 3, 'text-anchor': 'end'}, number(value)));
  }
  const tickCount = Math.min(narrow ? 4 : 6, data.periods.length);
  const ticks = [...new Set(Array.from({length: tickCount}, (_, i) => Math.round(i * (data.periods.length - 1) / Math.max(1, tickCount - 1))))];
  for (const i of ticks) svg.append(svgNode('text', {x: x(i), y: height - 22, 'text-anchor': 'middle'}, data.periods[i]));
  for (const [i, s] of data.series.entries()) {
    let path = '', connected = false;
    for (const [j, point] of s.points.entries()) {
      if (point.value === null) {connected = false; continue;}
      path += (connected ? 'L' : 'M') + x(j) + ',' + y(point.value) + ' '; connected = true;
    }
    svg.append(svgNode('path', {d: path, stroke: colors[i % colors.length], class: 'series-line'}));
    for (const [j, point] of s.points.entries()) if (point.value !== null && (j === s.points.length - 1 ||
        s.points[j - 1]?.value == null && s.points[j + 1]?.value == null)) {
      svg.append(svgNode('circle', {cx: x(j), cy: y(point.value), r: 3.5, fill: colors[i % colors.length], class: 'point'}));
    }
  }
  const hover = svgNode('g', {visibility: 'hidden'}); const guide = svgNode('line', {y1: top, y2: height - bottom, class: 'hover-line'}); hover.append(guide); svg.append(hover);
  const tooltip = el('div', undefined, 'tooltip'); tooltip.hidden = true; root.append(svg, tooltip);
  root.tabIndex = 0; root.setAttribute('aria-label', 'Time series. Use arrow keys to inspect each period.');
  let inspected = data.periods.length - 1;
  function inspect(index) {
    inspected = Math.max(0, Math.min(data.periods.length - 1, index)); hover.setAttribute('visibility', 'visible');
    guide.setAttribute('x1', x(inspected)); guide.setAttribute('x2', x(inspected)); while (hover.children.length > 1) hover.lastChild.remove();
    tooltip.replaceChildren(el('strong', data.periods[inspected]));
    for (const [i, s] of data.series.entries()) {
      const point = s.points[inspected], row = el('div', undefined, 'tooltip-row'), name = el('span');
      name.append(el('span', undefined, 'legend-dot c' + i % colors.length), el('span', s.label)); row.append(name, el('b', point.value === null ? data.normalized ? '—' : point.raw_value ?? '—' : number(point.value)));
      row.title = (data.derived ? 'Derived sum: ' : 'Source value: ') + (point.raw_value ?? 'unavailable'); tooltip.append(row);
      if (point.value !== null) hover.append(svgNode('circle', {cx: x(inspected), cy: y(point.value), r: 4, fill: colors[i % colors.length], class: 'point'}));
    }
    tooltip.hidden = false; const ratio = root.clientWidth / width;
    tooltip.style.left = Math.max(5, Math.min(root.clientWidth - tooltip.offsetWidth - 5, x(inspected) * ratio + 12)) + 'px'; tooltip.style.top = '22px';
  }
  svg.addEventListener('pointermove', event => {const box = svg.getBoundingClientRect(); inspect(Math.round(((event.clientX - box.left) / box.width * width - left) / plotWidth * (data.periods.length - 1)));});
  const hide = () => {hover.setAttribute('visibility', 'hidden'); tooltip.hidden = true;}; svg.addEventListener('pointerleave', hide); root.onblur = hide;
  root.onkeydown = event => {if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {event.preventDefault(); inspect(event.key === 'Home' ? 0 : event.key === 'End' ? data.periods.length - 1 : inspected + (event.key === 'ArrowRight' ? 1 : -1));}};
}
$('dataset').addEventListener('change', () => loadDataset($('dataset').value));
$('snapshot').addEventListener('change', () => loadDataset($('dataset').value, Number($('snapshot').value)));
$('category-search').addEventListener('input', renderCategories);
$('compare').addEventListener('change', () => {
  if (!state.detail) return;
  state.filters[state.compare] = state.values[0]; state.compare = $('compare').value;
  state.values = [state.filters[state.compare] || preferred(variable(state.compare))]; delete state.filters[state.compare];
  $('category-search').value = ''; renderCategories(); renderFilters(); updatePlot();
});
$('select-all').addEventListener('click', () => {if (state.detail) {state.values = [...variable(state.compare).values]; renderCategories(); updatePlot();}});
for (const id of ['measure', 'from', 'to']) $(id).addEventListener('change', updatePlot);
$('normalize').addEventListener('change', () => {if (state.data) renderResults();});
$('reset').addEventListener('click', () => {$('normalize').checked = false; const id = state.catalog.find(d => d.id === 'px-x-1502040100_105')?.id || state.catalog[0]?.id; if (id) {$('dataset').value = id; loadDataset(id);}});
let resizeTimer;
window.addEventListener('resize', () => {clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  if (state.data && $('chart').getAttribute('aria-busy') === 'false') drawChart(state.plotData || state.data);
}, 100);});
async function init() {
  try {
    const result = await api('/api/datasets'); state.catalog = result.datasets; $('dataset-count').textContent = result.datasets.length + ' datasets';
    if (!result.datasets.length) throw new Error('No collected datasets are available yet.');
    $('dataset').replaceChildren();
    for (const group of ['Enrolled students', 'Bachelor entrants', 'Degrees', 'Staff', 'Finances', 'Other datasets']) {
      const datasets = result.datasets.filter(d => d.group === group); if (!datasets.length) continue;
      const optgroup = el('optgroup'); optgroup.label = group; for (const dataset of datasets) option(optgroup, dataset.id, titleFor(dataset)); $('dataset').append(optgroup);
    }
    $('dataset').disabled = false; $('dataset').value = result.datasets.find(d => d.id === result.default_dataset)?.id || result.datasets[0].id; await loadDataset($('dataset').value);
  } catch (e) {error(e.message); $('chart').replaceChildren(el('div', 'Data is currently unavailable.', 'chart-message')); $('chart').setAttribute('aria-busy', 'false');}
}
init();
