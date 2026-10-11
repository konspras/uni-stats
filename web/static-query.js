/* Source-shaped CSV query engine, shared by the worker and parity tests. */
(function(root) {
'use strict';
const ALL = '__all_subjects__';
function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {if (quoted && text[i+1] === '"') {cell += '"'; i++;} else quoted = !quoted;}
    else if (c === ',' && !quoted) {row.push(cell); cell = '';}
    else if ((c === '\n' || c === '\r') && !quoted) {if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '';}
    else cell += c;
  }
  if (quoted) throw Error('Unterminated CSV field');
  if (cell || row.length) {row.push(cell); rows.push(row);}
  const header = rows.shift();
  if (!header || rows.some(row => row.length !== header.length)) throw Error('Invalid CSV columns');
  return {header, rows};
}
function numeric(raw) {
  return typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
}
// Integer decimal arithmetic preserves raw source precision (including trailing zeros).
function decimal(raw) {
  let [mantissa, exponent='0'] = raw.toLowerCase().split('e');
  const fractional = (mantissa.split('.')[1] || '').length;
  const scale = fractional - Number(exponent);
  let coefficient = BigInt(mantissa.replace('.', ''));
  if (scale < 0) coefficient *= 10n ** BigInt(-scale);
  return {coefficient, scale:Math.max(0, scale)};
}
function sumDecimal(values) {
  const parts = values.map(decimal), scale = Math.max(0, ...parts.map(p => p.scale));
  const result = parts.reduce((sum,p) => sum + p.coefficient * 10n ** BigInt(scale-p.scale), 0n);
  const negative = result < 0n, digits = (negative ? -result : result).toString().padStart(scale+1, '0');
  return (negative ? '-' : '') + (scale ? digits.slice(0,-scale) + '.' + digits.slice(-scale) : digits);
}
function plan(detail, request) {
  if (request.dataset !== detail.id) throw Error('Select a valid dataset');
  if (request.snapshot != null && request.snapshot !== detail.snapshot_id) throw Error('CSV mode provides only the latest snapshot');
  const time = detail.metadata.variables.find(v => v.time);
  const dims = Object.fromEntries(detail.metadata.variables.filter(v => !v.time).map(v => [v.code,v]));
  const comparison = request.compare, values = request.values, filters = request.filters;
  if (!dims[comparison] || !Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length || values.some(v => !dims[comparison].values.includes(v))) throw Error('Invalid comparison categories');
  if (!filters || Object.keys(filters).length !== Object.keys(dims).length-1 || Object.keys(dims).some(k => k !== comparison && !(k in filters)) || comparison in filters) throw Error('Select every other dimension');
  const selections = {}, aggregation = {};
  for (const [code,value] of Object.entries(filters)) {
    if (value === null) {
      const option = detail.aggregation_options[code];
      if (!option) throw Error('All is not supported for ' + code);
      selections[code] = option.values;
      aggregation[code] = {mode:option.mode, categories:option.values.length};
    } else {if (!dims[code].values.includes(value)) throw Error('Invalid category'); selections[code] = [value];}
  }
  const universities = request.universities;
  if (universities != null) {
    if (!['Bachelor entrants','Degrees'].includes(detail.group) || !['Geschlecht','Staatsangehörigkeit (Kategorie)'].includes(comparison) || !('Hochschule' in filters) || detail.aggregation_options.Hochschule?.mode !== 'sum' || !Array.isArray(universities) || !universities.length || universities.length >100 || new Set(universities).size !== universities.length || universities.some(u => !dims.Hochschule.values.includes(u))) throw Error('Invalid university batching');
    selections.Hochschule = universities; delete aggregation.Hochschule;
  }
  const breakdown = request.breakdown ?? null;
  if (breakdown !== null && (!['Fachrichtung','Fachbereich'].includes(breakdown) || aggregation[breakdown]?.mode !== 'sum')) throw Error('Subject breakdown requires All subjects');
  const measures = detail.columns.filter(c => c.type === 'c'), measure = request.measure ?? measures[0].code;
  if (!measures.some(m => m.code === measure)) throw Error('Invalid measure');
  const first = time.values.indexOf(request.from ?? time.values[0]), last = time.values.indexOf(request.to ?? time.values.at(-1));
  if (first <0 || last<first) throw Error('Invalid period range');
  const periods = time.values.slice(first,last+1), labels = time.valueTexts.slice(first,last+1);
  const subject = detail.precomputed_subject;
  const precomputed = !!(subject && !breakdown && filters[subject] === null && comparison !== subject);
  const universityCodes = dims.Hochschule ? (comparison === 'Hochschule' ? values : selections.Hochschule) : ['*'];
  const expected = Object.values(selections).reduce((count,v) => count*v.length,1) / (universities ? universities.length : 1);
  return {time,dims,comparison,values,filters,selections,aggregation,universities,breakdown,measure,periods,labels,precomputed,subject,universityCodes,expected};
}
function query(detail, request, tables) {
  const p = plan(detail,request), raw = new Map(), subjects = new Map();
  const allowed = Object.fromEntries(Object.entries(p.selections).map(([k,v]) => [k,new Set(v)]));
  allowed[p.time.code] = new Set(p.periods); allowed[p.comparison] = new Set(p.values);
  if (p.precomputed) allowed[p.subject] = new Set([ALL]);
  function collect(map,key,cell,weight,explicitMissing) {
    let bucket = map.get(key); if (!bucket) {bucket={parts:[],seen:0,missing:0,first:null};map.set(key,bucket);}
    if (!bucket.seen) bucket.first = cell;
    bucket.seen += weight;
    bucket.missing += explicitMissing == null ? (numeric(cell) === null ? 1 : 0) : explicitMissing;
    if (numeric(cell) !== null) bucket.parts.push(cell);
  }
  for (const table of tables) {
    const positions = Object.fromEntries(table.header.map((c,i) => [c,i]));
    const constraints = Object.entries(allowed).map(([code,values]) => [positions[code],values]);
    for (const row of table.rows) {
      if (constraints.some(([i,values]) => !values.has(row[i]))) continue;
      const u = p.universities ? row[positions.Hochschule] : null;
      const key = JSON.stringify([u,row[positions[p.time.code]],row[positions[p.comparison]]]);
      const weight = p.precomputed ? Number(row[positions.__weight]) : 1;
      const missing = p.precomputed ? Number(row[positions['__missing_' + p.measure]]) : null;
      collect(raw,key,row[positions[p.measure]],weight,missing);
      if (p.breakdown) collect(subjects,JSON.stringify([u,row[positions[p.time.code]],row[positions[p.comparison]],row[positions[p.breakdown]]]),row[positions[p.measure]],1,null);
    }
  }
  const derived = Object.values(p.aggregation).some(a => a.mode === 'sum');
  function result(bucket, expected, additive) {
    const missing = expected - (bucket?.seen || 0) + (bucket?.missing || 0);
    const raw_value = additive ? (missing ? null : sumDecimal(bucket?.parts || [])) : (bucket?.first ?? null);
    return {raw_value,value:numeric(raw_value), ...(additive ? {missing_components:missing}: {})};
  }
  function partition(u) {
    const series = p.values.map(value => ({code:value,label:p.dims[p.comparison].valueTexts[p.dims[p.comparison].values.indexOf(value)],
      points:p.periods.map((code,i) => {
        const point = {period_code:code,period:p.labels[i],...result(raw.get(JSON.stringify([u,code,value])),p.expected,derived)};
        if (p.breakdown) {
          const dim = p.dims[p.breakdown];
          point.subject_segments = dim.values.map((subject,j) => ({code:subject,label:dim.valueTexts[j],...result(subjects.get(JSON.stringify([u,code,value,subject])),p.expected/p.selections[p.breakdown].length,true)}));
        }
        return point;
      })}));
    return {dataset:detail.id,snapshot_id:detail.snapshot_id,measure:p.measure,compare:p.comparison,
      filters:p.universities ? {...p.filters,Hochschule:u} : p.filters,periods:p.labels,series,derived,aggregation:p.aggregation,breakdown:p.breakdown};
  }
  return p.universities ? {university_series:p.universities.map(u => ({code:u,label:p.dims.Hochschule.valueTexts[p.dims.Hochschule.values.indexOf(u)],data:partition(u)}))} : partition(null);
}
root.StaticQuery = {parseCSV,numeric,sumDecimal,plan,query};
if (typeof module !== 'undefined') module.exports = root.StaticQuery;
})(globalThis);
