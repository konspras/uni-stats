'use strict';

const $ = id => document.getElementById(id);
const names = {Hochschule: 'University', Fachrichtung: 'Subject (detailed)', Fachbereich: 'Subject (broad)',
  Studienstufe: 'Study level', Examensstufe: 'Qualification level', Geschlecht: 'Gender',
  'Staatsangehörigkeit (Kategorie)': 'Nationality', Bildungsherkunft: 'Educational origin',
  'Wohnkanton vor Studienbeginn': 'Canton before studying', Personalkategorie: 'Staff category',
  Finanzquelle: 'Funding source', Finanzierungstyp: 'Funding type', Aufwandsart: 'Expenditure type',
  Leistung: 'Activity', Kostenart: 'Cost type', Erlöskategorie: 'Revenue category', Indikator: 'Indicator'};
const colors = ['#365bd6', '#db7853', '#278d7a', '#8d5cbe', '#b79b29', '#ca5992', '#3b90b7', '#797564'];
// Presentation names keyed by BFS labels, never by dataset-local numeric codes.
// Sources: BFS university list and finance table footnotes (see docs/FRONTEND.md).
const universityNames = {
  BS:'University of Basel', BE:'University of Bern', FR:'University of Fribourg',
  GE:'University of Geneva', LS:'University of Lausanne', LU:'University of Lucerne',
  NE:'University of Neuchâtel', SG:'University of St. Gallen', UZH:'University of Zurich',
  USI:'Università della Svizzera italiana',
  EPFL:'École polytechnique fédérale de Lausanne',
  ETHZ:'Eidgenössische Technische Hochschule Zürich',
  IHEID:'Institut de hautes études internationales et du développement',
  IUKB:'Institut universitaire Kurt Bösch',
  'FS-CH':'Universitäre Fernstudien Schweiz',
  'PHSG-UI':'Pädagogische Hochschule St. Gallen',
  'TH CHUR':'Theologische Hochschule Chur', 'TH Chur':'Theologische Hochschule Chur',
  'TH-CHUR':'Theologische Hochschule Chur',
  'Andere UI':'Other university institutions'
};
function categoryFullLabel(dimension, text) {
  if (['Fachrichtung', 'Fachbereich'].includes(dimension)) {
    const english = state.subjectTranslations[text];
    return english ? text + ' (' + english + ')' : text;
  }
  const full = dimension === 'Hochschule' ? universityNames[text] : null;
  return full ? text + ' — ' + full : text;
}
function categoryDisplayLabel(dimension, text) {
  const full = categoryFullLabel(dimension, text);
  return dimension === 'Hochschule' && [...full].length > 40 ? [...full].slice(0, 37).join('') + '...' : full;
}
function categoryNode(tag, dimension, text) {
  const node = el(tag, categoryDisplayLabel(dimension, text));
  if (dimension === 'Hochschule') node.title = categoryFullLabel(dimension, text);
  return node;
}
const ALL = '__derived_all__';
const state = {catalog: [], detail: null, filters: {}, compare: '', values: [], data: null, generation: 0, plotSequence: 0,
  universities: [], subjectTranslations: {}, view: SelectionURL.view(location.hash), views: {}};
const date = value => value ? new Date(value).toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'}) : 'Not supplied';
const label = code => names[code] || code;
const number = value => value === null ? '—' : new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(value);
function el(tag, text, className) {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;}
function option(select, value, text) {const node = el('option', text); node.value = value; select.append(node);}
function error(message) {$('error').textContent = message; $('error').hidden = !message;}
async function api(path, signal) {return DataProvider.api(path, signal);}
function variable(code) {return state.detail.metadata.variables.find(v => v.code === code);}
function categories(v) {return v.values.map((code, i) => ({code, text: v.valueTexts[i]}));}
function timeVariable() {return state.detail.metadata.variables.find(v => v.time);}
function renderRange() {
  const time = timeVariable(), last = time.values.length - 1;
  for (const id of ['from', 'to']) {
    const text = time.valueTexts[Number($(id).value)];
    $(id + '-label').textContent = text; $(id).setAttribute('aria-valuetext', text);
  }
  $('from').setAttribute('aria-valuemax', $('to').value);
  $('to').setAttribute('aria-valuemin', $('from').value);
  const start = last ? Number($('from').value) / last * 100 : 0;
  const end = last ? Number($('to').value) / last * 100 : 100;
  $('range-fill').style.left = start + '%'; $('range-fill').style.width = end - start + '%';
}
function subjectDimension() {
  return ['Fachrichtung','Fachbereich'].find(code => state.detail?.aggregation_options[code]?.mode === 'sum' && state.filters[code] === null);
}
function syncSubjectMode() {
  const available = Boolean(subjectDimension());
  if (!available) $('stack-subjects').checked = false;
  $('stack-subjects').disabled = !available || $('stack-universities').checked || $('normalize').checked;
  $('stack-subjects').closest('label').title = available ? 'Sum selected categories and universities, grouped by subject.' : 'Select All subjects in an additive dataset.';
  $('stack-universities').disabled = $('stack-subjects').checked || state.universities.length < 2;
  syncModes();
}
function syncModes() {
  $('normalize').disabled = state.view === 'pyramid' || $('percentage').checked || $('stack-subjects').checked;
  $('percentage').disabled = $('normalize').checked;
}
function viewDatasets() {return state.catalog.filter(d => state.view !== 'pyramid' || isPyramidDataset(d));}
function renderView() {
  const pyramid = state.view === 'pyramid';
  $('view-title').textContent = pyramid ? 'Pyramid' : 'Data explorer';
  document.title = 'UniStats · ' + $('view-title').textContent;
  for (const view of ['pyramid', 'explorer']) {
    const active = view === state.view, tab = $(view + '-tab');
    tab.classList.toggle('active-tab', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  $('university-heading').hidden = !pyramid;
  $('category-search').placeholder = pyramid ? 'Find a university…' : 'Find a category…';
  $('compare-field').hidden = pyramid; $('compare-categories').hidden = false; $('pyramid-split').hidden = !pyramid;
  $('stack-universities').closest('label').hidden = !pyramid;
  $('normalize').closest('label').hidden = pyramid; $('pyramid-period-note').hidden = !pyramid;
  $('dataset').replaceChildren();
  const available = viewDatasets(); $('dataset-count').textContent = available.length + ' datasets';
  for (const group of ['Enrolled students', 'Bachelor entrants', 'Degrees', 'Staff', 'Finances', 'Other datasets']) {
    const datasets = available.filter(d => d.group === group); if (!datasets.length) continue;
    const optgroup = el('optgroup'); optgroup.label = group;
    for (const dataset of datasets) option(optgroup, dataset.id, titleFor(dataset)); $('dataset').append(optgroup);
  }
  syncModes();
}
function captureSelection() {
  if (!state.detail) return null;
  return {dataset:state.detail.id, snapshot:state.detail.snapshot_id, filters:{...state.filters}, compare:state.compare,
    values:[...state.values], from:timeVariable().values[Number($('from').value)], to:timeVariable().values[Number($('to').value)],
    fromLabel:timeVariable().valueTexts[Number($('from').value)], toLabel:timeVariable().valueTexts[Number($('to').value)],
    universities:[...state.universities], stacked:$('stack-universities').checked, subjectStacked:$('stack-subjects').checked, measure:$('measure').value, normalized:$('normalize').checked, percentage:$('percentage').checked};
}
function defaultDataset() {
  const desired = state.view === 'pyramid' ? 'px-x-1502040100_123' : 'px-x-1502040100_105';
  return viewDatasets().find(d => d.id === desired)?.id || viewDatasets()[0]?.id;
}
function updateSelectionURL() {
  if (state.view !== 'pyramid' || !state.detail) return;
  const hash = SelectionURL.write(captureSelection(),state.detail);
  if (location.hash !== hash) history.replaceState(null,'',location.pathname+location.search+hash);
}
function selectionError(message) {
  ++state.generation; ++state.plotSequence;
  state.datasetController?.abort(); state.plotController?.abort();
  state.detail = null; state.data = null; state.plotData = null;
  $('categories').replaceChildren(); $('filters').replaceChildren();
  for (const id of ['compare','measure','from','to','snapshot','select-all','clear-all','category-search','split-gender','split-nationality']) $(id).disabled = true;
  error(message); $('chart').replaceChildren(el('div','This shared pyramid could not be loaded. Use Reset view to start again.','chart-message'));
  $('chart').setAttribute('aria-busy','false'); $('legend').replaceChildren();
  for (const tag of ['thead','tbody']) $('values-table').querySelector(tag).replaceChildren();
}
async function loadView(saved) {
  try {
    const shared = state.view === 'pyramid' ? SelectionURL.read(location.hash) : null;
    if (shared && !viewDatasets().some(d=>d.id===shared.dataset)) throw Error('The dataset in this shared pyramid is unavailable. Use Reset view to start again.');
    const restore = shared ? null : saved;
    $('normalize').checked = state.view === 'explorer' && Boolean(restore?.normalized);
    $('percentage').checked = Boolean(restore?.percentage);
    $('stack-universities').checked = Boolean(restore?.stacked); $('stack-subjects').checked = Boolean(restore?.subjectStacked);
    await loadDataset(shared?.dataset || restore?.dataset || defaultDataset(),shared ? undefined : restore?.snapshot,{restore,shared});
  } catch(e) {selectionError(e.message);}
}
async function switchView() {
  if (!state.catalog.length) return;
  const view = SelectionURL.view(location.hash);
  if (view === state.view && !location.hash.startsWith('#pyramid?')) {updateSelectionURL();return;}
  if (view !== state.view) {state.views[state.view] = captureSelection(); state.view = view;}
  renderView(); await loadView(state.views[view]);
}
function renderSplit() {
  if (state.view !== 'pyramid' || !state.detail) return;
  const dataset = state.catalog.find(d => d.id === state.detail.id);
  for (const [id, code] of [['split-gender','Geschlecht'], ['split-nationality','Staatsangehörigkeit (Kategorie)']]) {
    $(id).disabled = !pyramidCounterpart(state.catalog, dataset, code);
    $(id).setAttribute('aria-pressed', String(state.compare === code));
  }
}
async function changeSplit(code) {
  if (state.view !== 'pyramid' || !state.detail || state.compare === code) return;
  const dataset = state.catalog.find(d => d.id === state.detail.id);
  const target = pyramidCounterpart(state.catalog, dataset, code);
  if (target) await loadDataset(target.id, undefined, {preserve:true});
}
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
  return Object.entries(state.filters).filter(([code]) => state.view !== 'pyramid' || code !== 'Hochschule').map(([code, value]) => {
    return label(code) + ': ' + categoryDisplayLabel(code, selectionLabel(code, value));
  }).concat(state.view === 'pyramid' ? ['University: ' + categories(variable('Hochschule')).filter(c => state.universities.includes(c.code)).map(c => categoryDisplayLabel('Hochschule', c.text)).join(', ')] : []).join(' · ');
}
function renderCategories() {
  if (!state.detail) return;
  if (state.view === 'pyramid') renderSplit();
  const pyramid = state.view === 'pyramid', selected = pyramid ? state.universities : state.values;
  const query = $('category-search').value.trim().toLocaleLowerCase();
  const root = $('categories'); root.replaceChildren();
  const choices = categories(variable(pyramid ? 'Hochschule' : state.compare)).sort((a, b) => Number(selected.includes(b.code)) - Number(selected.includes(a.code)));
  for (const c of choices) {
    const dimension = pyramid ? 'Hochschule' : state.compare;
    if (query && !categoryFullLabel(dimension, c.text).toLocaleLowerCase().includes(query)) continue;
    const item = el('label', undefined, 'category');
    const input = el('input'); input.type = 'checkbox'; input.value = c.code; input.checked = selected.includes(c.code);
    input.addEventListener('change', () => {
      const current = pyramid ? state.universities : state.values;
      const next = input.checked ? [...current, c.code] : current.filter(v => v !== c.code);
      if (pyramid) setUniversities(next); else state.values = next;
      $('selected-count').textContent = next.length + ' selected'; updatePlot();
    });
    item.append(input, categoryNode('span', dimension, c.text)); root.append(item);
  }
  if (!root.children.length) root.append(el('p', 'No matching categories.', 'helper'));
  $('selected-count').textContent = selected.length + (pyramid ? ' universities selected' : ' selected');
}
function renderFilters() {
  const root = $('filters'); root.replaceChildren();
  for (const v of state.detail.metadata.variables.filter(v => !v.time && v.code !== state.compare && (state.view !== 'pyramid' || v.code !== 'Hochschule'))) {
    const field = el('label', label(v.code), 'field'); const select = el('select'); select.dataset.dimension = v.code;
    const choices = categories(v);
    if (v.code === 'Fachrichtung') choices.sort((a, b) => a.text.localeCompare(b.text, 'de', {sensitivity:'base'}));
    for (const c of choices) {
      option(select, c.code, categoryDisplayLabel(v.code, c.text));
      if (v.code === 'Hochschule') select.lastChild.title = categoryFullLabel(v.code, c.text);
    }
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
async function loadDataset(id, snapshotId, options = {}) {
  if (state.view === 'pyramid' && !isPyramidDataset(state.catalog.find(d => d.id === id))) {
    error('The pyramid supports entrants and degrees with a gender or nationality split.'); return;
  }
  const previous = options.preserve ? {selection:captureSelection(), variables:state.detail.metadata.variables} : null;
  clearTimeout(rangeTimer);
  const generation = ++state.generation; ++state.plotSequence; state.plotController?.abort();
  state.datasetController?.abort(); state.datasetController = new AbortController();
  state.detail = null; state.data = null;
  $('categories').replaceChildren(); $('filters').replaceChildren();
  for (const control of ['compare', 'measure', 'from', 'to', 'snapshot', 'select-all', 'clear-all', 'category-search']) $(control).disabled = true;
  $('split-gender').disabled = true; $('split-nationality').disabled = true;
  error(''); $('chart').setAttribute('aria-busy', 'true'); $('chart').replaceChildren(el('div', 'Loading dataset…', 'chart-message'));
  $('legend').replaceChildren(); $('values-table').querySelector('tbody').replaceChildren();
  try {
    const detail = await api('/api/dataset?id=' + encodeURIComponent(id) + (snapshotId ? '&snapshot=' + snapshotId : ''), state.datasetController.signal);
    if (generation !== state.generation) return;
    if (options.shared) {
      const restored = SelectionURL.restore(options.shared,detail);
      options = {...options,restore:restored};
      $('normalize').checked = false; $('percentage').checked = restored.percentage;
      $('stack-universities').checked = restored.stacked; $('stack-subjects').checked = restored.subjectStacked;
    }
    state.detail = detail; state.filters = {};
    const untranslated = [...new Set(detail.metadata.variables.filter(v => ['Fachrichtung','Fachbereich'].includes(v.code))
      .flatMap(v => v.valueTexts).filter(text => !state.subjectTranslations[text]))];
    if (untranslated.length) console.warn('BFS subject labels need English translations:', untranslated);
    const dims = detail.metadata.variables.filter(v => !v.time);
    for (const v of dims) state.filters[v.code] = preferred(v);
    state.compare = state.view === 'pyramid' ? dims.find(v => pyramidSplits.includes(v.code)).code : dims.find(v => v.code === 'Hochschule')?.code || dims[0].code;
    const cv = variable(state.compare); state.values = state.view === 'pyramid' ? [...cv.values] : categories(cv).filter(c => ['EPFL', 'ETHZ'].includes(c.text)).map(c => c.code);
    if (!state.values.length) state.values = [preferred(cv)]; delete state.filters[state.compare];
    if (previous) for (const v of dims.filter(v => v.code !== state.compare)) {
      const oldValue = previous.selection.filters[v.code];
      if (oldValue === null && detail.aggregation_options[v.code]) state.filters[v.code] = null;
      else {
        const old = previous.variables.find(old => old.code === v.code);
        const oldLabel = old?.valueTexts[old.values.indexOf(oldValue)];
        const match = categories(v).find(c => c.text === oldLabel);
        if (match) state.filters[v.code] = match.code;
      }
    }
    if (options.restore) {
      const restored = options.restore;
      const mapCode = (code, value) => {
        const current = dims.find(v => v.code === code), old = options.restoreVariables?.find(v => v.code === code);
        if (value === null && detail.aggregation_options[code]) return null;
        if (!current) return undefined;
        const text = old?.valueTexts[old.values.indexOf(value)];
        return (text ? categories(current).find(c => c.text === text)?.code : undefined) ?? (current.values.includes(value) ? value : preferred(current));
      };
      if (dims.some(v => v.code === restored.compare)) state.compare = restored.compare;
      state.values = [...new Set(restored.values.map(value => mapCode(state.compare,value)).filter(value => value != null))];
      if (!state.values.length && restored.values.length) state.values = [preferred(dims.find(v => v.code === state.compare))];
      state.filters = Object.fromEntries(dims.filter(v => v.code !== state.compare).map(v => [v.code,mapCode(v.code,restored.filters[v.code])]));
    }
    if (state.view === 'pyramid') {
      const savedUniversities = (options.restore || previous?.selection)?.universities;
      const codes = variable('Hochschule').values;
      const oldUniversity = (previous?.variables || options.restoreVariables)?.find(v => v.code === 'Hochschule');
      const chosen = savedUniversities?.map(code => oldUniversity ?
        categories(variable('Hochschule')).find(c => c.text === oldUniversity.valueTexts[oldUniversity.values.indexOf(code)])?.code : code).filter(code => codes.includes(code));
      setUniversities(savedUniversities?.length === 0 ? [] : chosen?.length ? chosen : [state.filters.Hochschule || preferred(variable('Hochschule'))]);
    }
    $('dataset').value = id;
    $('dataset-description').textContent = detail.id + ' · ' + detail.metadata.variables.find(v => v.time).valueTexts.at(-1);
    $('measure').replaceChildren(); for (const m of detail.columns.filter(c => c.type === 'c')) option($('measure'), m.code, m.text || m.code);
    $('compare').replaceChildren(); for (const v of dims) option($('compare'), v.code, label(v.code)); $('compare').value = state.compare;
    const time = detail.metadata.variables.find(v => v.time);
    for (const id of ['from', 'to']) {$(id).max = time.values.length - 1;}
    $('from').value = 0; $('to').value = time.values.length - 1; renderRange();
    const saved = options.restore || previous?.selection;
    if (saved) {
      // Paired tables can start in different years and renumber period codes.
      const first = Math.max(0, time.valueTexts.indexOf(saved.fromLabel));
      const end = time.valueTexts.indexOf(saved.toLabel), last = end < 0 ? time.values.length - 1 : end;
      if (last >= first) {$('from').value = first; $('to').value = last; renderRange();}
      if (detail.columns.some(c => c.type === 'c' && c.code === saved.measure)) $('measure').value = saved.measure;
    }
    $('snapshot').replaceChildren(); for (const [i, s] of detail.snapshots.entries()) option($('snapshot'), s.id, (i === 0 ? 'Latest · ' : '') + date(s.fetched_at) + ' · #' + s.id);
    $('snapshot').value = detail.snapshot_id; $('category-search').value = '';
    for (const control of ['compare', 'measure', 'from', 'to', 'snapshot', 'select-all', 'clear-all', 'category-search']) $(control).disabled = false;
    $('snapshot').disabled = DataProvider.mode === 'csv';
    if (time.values.length === 1) {$('from').disabled = true; $('to').disabled = true;}
    renderCategories(); renderFilters(); renderSource(); await updatePlot();
  } catch (e) {if (e.name !== 'AbortError' && generation === state.generation) {error(e.message); $('chart').replaceChildren(el('div', 'This dataset could not be loaded.', 'chart-message'));}}
  finally {if (generation === state.generation) $('chart').setAttribute('aria-busy', 'false');}
}
async function updatePlot() {
  if (!state.detail) return;
  syncSubjectMode(); updateSelectionURL();
  const sequence = ++state.plotSequence; state.plotController?.abort(); state.plotController = new AbortController();
  $('chart').setAttribute('aria-busy', 'true'); error('');
  if (!(state.view === 'pyramid' ? state.universities : state.values).length) {
    renderEmptySelection(); return;
  }
  const request = {dataset: state.detail.id, snapshot: state.detail.snapshot_id, measure: $('measure').value,
    compare: state.compare, values: state.values, filters: {...state.filters},
    ...($('stack-subjects').checked ? {breakdown:subjectDimension()} : {}),
    from: timeVariable().values[Number($('from').value)], to: timeVariable().values[Number($('to').value)]};
  try {
    const signal = state.plotController.signal;
    const get = query => api('/api/series?query=' + encodeURIComponent(JSON.stringify(query)), signal);
    const data = state.view === 'pyramid' ? sumPyramidUniversities(
      (await get({...request, universities:state.universities})).university_series) : await get(request);
    if (sequence !== state.plotSequence) return;
    state.data = data; renderResults();
  } catch (e) {if (e.name !== 'AbortError' && sequence === state.plotSequence) {
    error(e.message); state.data = null; $('chart').replaceChildren(el('div', 'Adjust your selection to display a series.', 'chart-message'));
    $('legend').replaceChildren(); $('values-table').querySelector('thead').replaceChildren(); $('values-table').querySelector('tbody').replaceChildren();
  }} finally {if (sequence === state.plotSequence) $('chart').setAttribute('aria-busy', 'false');}
}
function renderEmptySelection() {
  state.data = null; state.plotData = null;
  const chart = $('chart'); chart.classList.toggle('pyramid-chart', state.view === 'pyramid');
  chart.onkeydown = null; chart.onblur = null; chart.onpointerleave = null; chart.onfocusout = null; chart.removeAttribute('tabindex'); chart.removeAttribute('aria-label');
  chart.replaceChildren(el('div', state.view === 'pyramid' ? 'Select a university to display the pyramid.' : 'Select a category to display a series.', 'chart-message'));
  chart.setAttribute('aria-busy', 'false');
  $('plot-context').textContent = summary(); $('period-badge').textContent = '';
  $('legend').replaceChildren(); $('table-count').textContent = '0 selected';
  for (const tag of ['thead', 'tbody']) $('values-table').querySelector(tag).replaceChildren();
  $('table-description').textContent = 'No categories selected.';
  for (const id of ['normalization-note','percentage-note','pyramid-note']) $(id).hidden = true;
  $('aggregation-note').textContent = 'No categories selected.'; $('value-note').textContent = '';
  $('stack-universities').disabled = true;
}
function renderResults() {
  if ($('stack-subjects').checked && state.data.breakdown !== subjectDimension()) return;
  const detail = state.detail;
  const base = $('stack-subjects').checked ? stackSubjects(state.data, state.view === 'pyramid') : state.data;
  let data = $('percentage').checked ? percentageSeries(base) : $('normalize').checked ? normalizeSeries(base) : base;
  if (data.subjectStacked && !data.percentage) data = subjectStackBounds(data);
  if (state.view === 'pyramid') {
    data.stacked = $('stack-subjects').checked || $('stack-universities').checked && data.universities.length > 1;
    syncSubjectMode();
  }
  updateSelectionURL();
  state.plotData = data;
  $('plot-group').textContent = detail.group.toUpperCase();
  const subject = Object.entries(state.filters).find(([code]) => ['Fachrichtung', 'Fachbereich'].includes(code));
  $('plot-title').textContent = subject ? categoryDisplayLabel(subject[0], selectionLabel(...subject)) : label(state.compare) + ' comparison';
  $('plot-context').textContent = summary();
  $('period-badge').textContent = data.periods[0] + ' — ' + data.periods.at(-1);
  $('legend').replaceChildren(); for (const [i, s] of data.series.entries()) {
    if (state.view === 'pyramid' && !pyramidSides(data).sides.includes(s)) continue;
    const index = state.view === 'pyramid' ? pyramidSides(data).sides.indexOf(s) : i;
    const item = el('span', undefined, 'legend-item'); item.append(el('span', undefined, 'legend-dot c' + index % colors.length), categoryNode('span', data.compare, s.label)); if (s.normalization_issue) item.append(el('span', ' (no baseline)')); $('legend').append(item);
  }
  if (data.stacked) {
    $('legend').replaceChildren();
    for (const [index, university] of (data.stackCategories || data.universities).entries()) {
      const item = el('span', undefined, 'legend-item');
      for (const side of [0,1]) {const dot = el('span', undefined, 'legend-dot'); dot.style.background = pyramidColor(university.colorIndex ?? index, university.colorCount ?? data.universities.length, side); item.append(dot);}
      item.append(categoryNode('span', data.stackDimension || 'Hochschule', university.label)); $('legend').append(item);
    }
  }
  const others = state.view === 'pyramid' ? pyramidSides(data).other : [];
  $('pyramid-note').hidden = !others.some(s => s.points.some(p => p.value === null || p.value !== 0));
  $('pyramid-note').textContent = 'Unknown categories are kept in the values table and percentage totals, but are not assigned to either side.';
  $('pyramid-period-note').textContent = detail.group === 'Degrees' ? 'Rows: graduation year (calendar year), not entry year.' : 'Rows: entry year (academic year), not the number still enrolled.';
  const unavailable = data.series.filter(s => s.normalization_issue);
  $('normalization-note').hidden = !unavailable.length;
  $('normalization-note').textContent = unavailable.length ? 'Cannot normalize ' + unavailable.map(s => categoryDisplayLabel(data.compare, s.label)).join(', ') +
    ': the value in ' + data.periods[0] + ' is zero or missing. Select another start year.' : '';
  $('percentage-note').hidden = !data.percentage_missing;
  $('percentage-note').textContent = data.percentage_missing ? 'Percentage gaps: ' + data.percentage_missing + ' periods have missing or negative values, or a zero total.' : '';
  $('value-note').textContent = data.percentage ? (state.view === 'pyramid' ? 'Bar labels show percentages; tooltips show counts. ' : '') + '100% = the sum of the selected series in each period.' : data.normalized ? data.periods[0] + ' = 100 for each series. Missing values remain gaps.' : 'Missing values are gaps; source zeros remain zero.';
  $('aggregation-note').textContent = data.derived ? 'Derived sum across selected categories and universities. Missing components leave gaps.' : 'Values from the selected source categories.';
  const valueKind = data.derived ? 'Derived sum' : 'Source value';
  $('table-description').textContent = data.percentage ? 'Share of the selected series total in each period. Hover for the original value.' : data.normalized ? 'Index: ' + data.periods[0] + ' = 100. Hover a value for its ' + valueKind.toLowerCase() + '.' : data.derived ? 'Derived sums of source values.' : 'The values exactly as published.';
  drawChart(data);
  const table = $('values-table'), head = el('tr'); head.append(el('th', 'Period'));
  for (const s of data.series) {const th = categoryNode('th', data.compare, s.label); th.scope = 'col'; head.append(th);} head.firstChild.scope = 'col';
  table.querySelector('thead').replaceChildren(head); const body = table.querySelector('tbody'); body.replaceChildren();
  for (let j = data.periods.length - 1; j >= 0; j--) {
    const row = el('tr'); row.append(el('td', data.periods[j]));
    for (const s of data.series) {const point = s.points[j]; const cell = el('td', data.percentage ? point.value === null ? '—' : number(point.value) + '%' : data.normalized ? number(point.value) : point.raw_value ?? '—', point.value === null ? 'missing' : '');
      if (data.normalized || data.percentage) cell.title = valueKind + ': ' + (point.raw_value ?? 'unavailable') + (s.normalization_issue ? '; starting value is zero or missing' : '');
      else if (point.value === null) cell.title = data.derived ? 'Incomplete sum: ' + point.missing_components + ' missing components' : point.raw_value === null ? 'No published observation' : 'Source missing-value marker'; row.append(cell);}
    body.append(row);
  }
  $('table-count').textContent = data.periods.length + ' periods · ' + data.series.length + (state.view === 'pyramid' ? ' categories' : ' lines');
}
function svgNode(tag, attributes = {}, text) {const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; return node;}
function drawChart(data) {
  $('chart').classList.toggle('pyramid-chart', state.view === 'pyramid');
  if (state.view === 'pyramid') {drawPyramid(data); return;}
  const root = $('chart'); root.replaceChildren();
  root.onkeydown = null; root.onblur = null; root.onpointerleave = null; root.onfocusout = null; root.removeAttribute('tabindex'); root.removeAttribute('aria-label');
  const numbers = data.series.flatMap(s => s.points.map(p => data.subjectStacked ? p.stack_upper : p.value)).filter(v => v !== null);
  if (!numbers.length) {root.append(el('div', data.percentage ? 'No periods have a complete, nonnegative selection with a positive total.' : data.normalized ? 'No series has a nonzero starting value in ' + data.periods[0] + '.' : 'No numeric values in this selection. Source markers are shown in the table below.', 'chart-message')); return;}
  const narrow = window.matchMedia('(max-width:720px)').matches;
  const width = narrow ? 520 : 860, height = 360, left = 65, right = 22, top = 25, bottom = 49;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  let min = data.percentage ? 0 : Math.min(0, ...numbers), max = data.percentage ? 100 : Math.max(0, ...numbers); if (min === max) max = min + 1;
  const step = Math.pow(10, Math.floor(Math.log10((max - min) / 4)));
  const niceStep = [1, 2, 2.5, 5, 10].map(v => v * step).find(v => v >= (max - min) / 4);
  max = Math.ceil(max / niceStep) * niceStep; min = Math.floor(min / niceStep) * niceStep;
  const x = i => left + (data.periods.length === 1 ? plotWidth / 2 : i / (data.periods.length - 1) * plotWidth);
  const y = value => top + (max - value) / (max - min) * plotHeight;
  const svg = svgNode('svg', {viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': data.measure + ': ' + data.series.map(s => s.label).join(', ')});
  svg.append(svgNode('title', {}, data.measure));
  svg.append(svgNode('text', {x: left, y: 11, class: 'axis-title'}, data.percentage ? 'Share of selected total (%)' : data.normalized ? 'Index (' + data.periods[0] + ' = 100)' : data.derived ? 'Derived sum' : 'Source value'));
  for (let value = min; value <= max + niceStep / 100; value += niceStep) {
    svg.append(svgNode('line', {x1: left, x2: width - right, y1: y(value), y2: y(value), class: 'grid-line'}));
    svg.append(svgNode('text', {x: left - 12, y: y(value) + 3, 'text-anchor': 'end'}, number(value) + (data.percentage ? '%' : '')));
  }
  const tickCount = Math.min(narrow ? 4 : 6, data.periods.length);
  const ticks = [...new Set(Array.from({length: tickCount}, (_, i) => Math.round(i * (data.periods.length - 1) / Math.max(1, tickCount - 1))))];
  for (const i of ticks) svg.append(svgNode('text', {x: x(i), y: height - 22, 'text-anchor': 'middle'}, data.periods[i]));
  for (const [i, s] of data.series.entries()) {
    if (data.percentage || data.subjectStacked) {
      let path = '', segment = [];
      function finishArea() {
        if (!segment.length) return;
        let topPoints = segment.map(j => [x(j), y(s.points[j].stack_upper)]);
        let bottomPoints = segment.map(j => [x(j), y(s.points[j].stack_lower)]);
        if (segment.length === 1) {
          const j = segment[0], half = data.periods.length === 1 ? plotWidth / 2 : 4;
          const x1 = Math.max(left, x(j) - half), x2 = Math.min(width - right, x(j) + half);
          topPoints = [[x1, y(s.points[j].stack_upper)], [x2, y(s.points[j].stack_upper)]];
          bottomPoints = [[x1, y(s.points[j].stack_lower)], [x2, y(s.points[j].stack_lower)]];
        }
        path += 'M' + topPoints.map(p => p.join(',')).join('L') + 'L' + bottomPoints.reverse().map(p => p.join(',')).join('L') + 'Z';
        segment = [];
      }
      for (const [j, point] of s.points.entries()) {
        if (point.value === null) finishArea(); else segment.push(j);
      }
      finishArea();
      svg.append(svgNode('path', {d: path, fill: colors[i % colors.length], class: 'series-area'}));
      continue;
    }
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
      name.append(el('span', undefined, 'legend-dot c' + i % colors.length), categoryNode('span', data.compare, s.label)); row.append(name, el('b', point.value === null ? data.normalized || data.percentage ? '—' : point.raw_value ?? '—' : number(point.value) + (data.percentage ? '%' : '')));
      row.title = (data.derived ? 'Derived sum: ' : 'Source value: ') + (point.raw_value ?? 'unavailable'); tooltip.append(row);
      if (point.value !== null) hover.append(svgNode('circle', {cx: x(inspected), cy: y(data.percentage || data.subjectStacked ? point.stack_upper : point.value), r: 4, fill: colors[i % colors.length], class: 'point'}));
    }
    tooltip.hidden = false; const ratio = root.clientWidth / width;
    tooltip.style.left = Math.max(5, Math.min(root.clientWidth - tooltip.offsetWidth - 5, x(inspected) * ratio + 12)) + 'px'; tooltip.style.top = '22px';
  }
  svg.addEventListener('pointermove', event => {const box = svg.getBoundingClientRect(); inspect(Math.round(((event.clientX - box.left) / box.width * width - left) / plotWidth * (data.periods.length - 1)));});
  const hide = () => {hover.setAttribute('visibility', 'hidden'); tooltip.hidden = true;}; svg.addEventListener('pointerleave', hide); root.onblur = hide;
  root.onkeydown = event => {if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {event.preventDefault(); inspect(event.key === 'Home' ? 0 : event.key === 'End' ? data.periods.length - 1 : inspected + (event.key === 'ArrowRight' ? 1 : -1));}};
}
$('dataset').addEventListener('change', () => loadDataset($('dataset').value));
window.addEventListener('hashchange', switchView);
$('split-gender').addEventListener('click', () => changeSplit('Geschlecht'));
$('split-nationality').addEventListener('click', () => changeSplit('Staatsangehörigkeit (Kategorie)'));
$('snapshot').addEventListener('change', () => loadDataset($('dataset').value, Number($('snapshot').value), {preserve:true}));
$('category-search').addEventListener('input', renderCategories);
$('compare').addEventListener('change', () => {
  if (!state.detail) return;
  state.filters[state.compare] = state.values[0] || preferred(variable(state.compare)); state.compare = $('compare').value;
  state.values = [state.filters[state.compare] || preferred(variable(state.compare))]; delete state.filters[state.compare];
  $('category-search').value = ''; renderCategories(); renderFilters(); updatePlot();
});
function setUniversities(codes) {
  state.universities = [...codes];
  state.filters.Hochschule = !codes.length || codes.length === variable('Hochschule').values.length ? null : codes[0];
}
$('select-all').addEventListener('click', () => {if (state.detail) {
  if (state.view === 'pyramid') setUniversities(variable('Hochschule').values); else state.values = [...variable(state.compare).values];
  renderCategories(); updatePlot();
}});
$('clear-all').addEventListener('click', () => {if (state.detail) {
  if (state.view === 'pyramid') setUniversities([]); else state.values = [];
  renderCategories(); updatePlot();
}});
$('stack-universities').addEventListener('change', () => {syncSubjectMode(); if (state.data) renderResults();});
$('stack-subjects').addEventListener('change', () => {syncSubjectMode(); updatePlot();});
$('measure').addEventListener('change', updatePlot);
let rangeTimer;
function changeRange(id, immediately = false) {
  if (!state.detail) return;
  if (id === 'from') $('from').value = Math.min(Number($('from').value), Number($('to').value));
  else $('to').value = Math.max(Number($('to').value), Number($('from').value));
  renderRange(); updateSelectionURL(); clearTimeout(rangeTimer);
  if (immediately) updatePlot(); else rangeTimer = setTimeout(updatePlot, 150);
}
for (const id of ['from', 'to']) {
  $(id).addEventListener('input', () => changeRange(id));
  $(id).addEventListener('change', () => changeRange(id, true));
}
// Track clicks/drags move the closest thumb; native thumbs also support keyboard input.
$('period-slider').addEventListener('pointerdown', event => {
  if (!state.detail || $('from').disabled || event.button !== 0) return;
  event.preventDefault();
  const slider = $('period-slider'), box = slider.getBoundingClientRect();
  const index = e => Math.round(Math.max(0, Math.min(1, (e.clientX - box.left - 9) / (box.width - 18))) * Number($('to').max));
  const initial = Number($('from').value);
  let overlapping = initial === Number($('to').value);
  let target = event.target.tagName === 'INPUT' ? event.target.id : Math.abs(index(event) - initial) < Math.abs(index(event) - Number($('to').value)) ? 'from' : 'to';
  $(target).focus(); slider.setPointerCapture(event.pointerId);
  const move = e => {
    if (overlapping && index(e) !== initial) {target = index(e) < initial ? 'from' : 'to'; overlapping = false; $(target).focus();}
    $(target).value = index(e); changeRange(target);
  };
  const finish = e => {move(e); changeRange(target, true); slider.removeEventListener('pointermove', move); slider.removeEventListener('pointerup', finish); slider.removeEventListener('pointercancel', finish);};
  move(event); slider.addEventListener('pointermove', move); slider.addEventListener('pointerup', finish); slider.addEventListener('pointercancel', finish);
});
for (const id of ['normalize', 'percentage']) $(id).addEventListener('change', () => {syncSubjectMode(); if (state.data) renderResults();});
$('reset').addEventListener('click', () => {$('stack-universities').checked = false; $('stack-subjects').checked = false; $('normalize').checked = false; $('percentage').checked = false; syncModes(); const id = defaultDataset(); if (id) {$('dataset').value = id; loadDataset(id);}});
let resizeTimer;
window.addEventListener('resize', () => {clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  if (state.data && $('chart').getAttribute('aria-busy') === 'false') drawChart(state.plotData || state.data);
}, 100);});
async function init() {
  try {
    await DataProvider.ready;
    $('data-mode-field').hidden = !DataProvider.backend;
    if (DataProvider.backend && sessionStorage.getItem('uni-stats-data-mode') === 'database') await DataProvider.setMode('database');
    $('data-mode').value = DataProvider.mode;
    const [result, translations] = await Promise.all([api('/api/datasets'), api('/subject-translations.json')]);
    state.subjectTranslations = translations.translations; state.catalog = result.datasets; $('dataset-count').textContent = result.datasets.length + ' datasets';
    if (!result.datasets.length) throw new Error('No collected datasets are available yet.');
    renderView(); $('dataset').disabled = false; await loadView();
  } catch (e) {error(e.message); $('chart').replaceChildren(el('div', 'Data is currently unavailable.', 'chart-message')); $('chart').setAttribute('aria-busy', 'false');}
}
init();

function renderUpdateStatus(status) {
  const publicationError = status.publication?.last_error;
  const warning = Boolean(status.last_error || publicationError || status.kind !== 'published' && status.enabled && !status.worker_active);
  const root = $('update-status'); root.classList.toggle('update-warning', warning);
  $('update-status-label').textContent = warning ? (publicationError ? 'Publication failing' : 'Data updates failing') : status.kind === 'published' ? 'Last report: ' + date(status.reported_at) : status.running ? 'Checking for new data…' : !status.enabled ? 'Automatic checks off' : status.last_success ? 'Last checked: ' + new Intl.DateTimeFormat(undefined, {day:'numeric', month:'short',timeZone:'Europe/Zurich'}).format(new Date(status.last_success)) : 'Weekly checks active';
  const timestamp = value => value ? new Intl.DateTimeFormat(undefined, {dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Zurich'}).format(new Date(value)) + ' (Zurich)' : 'Not yet';
  const rows = [[status.kind === 'published' ? 'Public report' : 'Worker',status.kind === 'published' ? timestamp(status.reported_at) : status.worker_active ? 'Active' : 'Inactive'],['Last attempt',timestamp(status.last_check)],
    ['Last successful check',timestamp(status.last_success)],['Latest snapshot',timestamp(status.latest_snapshot)],
    ['Next scheduled check',timestamp(status.next_scheduled_check)],['Next retry',status.next_retry ? timestamp(status.next_retry) : 'None'],
    ['Last result',({skipped:'No new data; download skipped',complete:'Check completed',failed:'Failed',interrupted:'Interrupted',running:'Checking for new data'})[status.last_result] || 'Not yet']];
  if (status.publication) rows.push(['Last successful push',timestamp(status.publication.last_success)],['Export / push',status.publication.running ? 'Publishing…' : status.publication.pending ? 'Pending / retrying' : 'Up to date'],['Publication retry',status.publication.next_retry ? timestamp(status.publication.next_retry) : 'None']);
  const details = $('update-status-details');details.replaceChildren();
  for (const [name,value] of rows) details.append(el('dt',name),el('dd',value));
  const errorNode=$('update-status-error');errorNode.hidden=!warning;
  errorNode.textContent=[status.last_error,publicationError].filter(Boolean).join(' · ') || (warning ? 'The automatic update worker is not active.' : '');
}
async function refreshUpdateStatus() {
  try {renderUpdateStatus(await api('/api/update-status'));}
  catch (e) {
    $('update-status').classList.add('update-warning');$('update-status-label').textContent='Update status unavailable';
    $('update-status-error').hidden=false;$('update-status-error').textContent='Could not read update status: '+e.message;
  }
}
refreshUpdateStatus();
setInterval(refreshUpdateStatus,60_000);

$('data-mode').addEventListener('change', async () => {
  const selection = state.detail ? captureSelection() : null;
  const restoreVariables = state.detail?.metadata.variables;
  state.plotController?.abort(); state.datasetController?.abort();
  $('chart').setAttribute('aria-busy', 'true');
  try {
    await DataProvider.setMode($('data-mode').value);
    state.views = {};
    const result = await api('/api/datasets'); state.catalog = result.datasets;
    renderView();
    // CSV mode always resets historical snapshot IDs to the latest export.
    if (selection && state.catalog.some(d => d.id === selection.dataset)) {delete selection.snapshot; await loadDataset(selection.dataset, undefined, {restore:selection,restoreVariables});}
    else await loadDataset(defaultDataset());
    await refreshUpdateStatus();
  } catch(e) {error(e.message); $('chart').setAttribute('aria-busy', 'false');}
});
