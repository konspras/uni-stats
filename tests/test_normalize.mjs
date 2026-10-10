import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const normalize = vm.runInNewContext(await readFile(new URL('../web/normalize.js', import.meta.url), 'utf8') + '\nnormalizeSeries;');
function series(label, values) {return {label, points: values.map((value, i) => ({period: String(2007 + i), value, raw_value: value === null ? '..' : String(value)}))};}
const data = {periods: ['2007', '2008', '2009', '2010', '2011'], series: [series('EPFL', [200, 400, null, 0, 50]), series('ETHZ', [50, 25, null, 100, 0])]};
const original = structuredClone(data);
const indexed = normalize(data);
assert.deepEqual(indexed.series[0].points.map(p => p.value), [100, 200, null, 0, 25]);
assert.deepEqual(indexed.series[1].points.map(p => p.value), [100, 50, null, 200, 0]);
assert.deepEqual(data, original, 'Never mutate source observations');
assert.equal(indexed.series[0].points[1].raw_value, '400');
const shortened = normalize({...data, periods: data.periods.slice(1), series: data.series.map(s => ({...s, points: s.points.slice(1)}))});
assert.equal(shortened.series[0].points[0].value, 100);
assert.equal(shortened.series[1].points[0].value, 100);
assert.equal(shortened.series[1].points[2].value, 400);
for (const baseline of [0, null]) {
  const result = normalize({periods: ['2007', '2008'], series: [series('Invalid', [baseline, 50]), series('Valid', [25, 50])]});
  assert.deepEqual(result.series[0].points.map(p => p.value), [null, null], 'Never choose a later baseline');
  assert.equal(result.series[0].normalization_issue, baseline === 0 ? 'zero' : 'missing');
  assert.deepEqual(result.series[1].points.map(p => p.value), [100, 200]);
}
assert.equal(normalize({series: [series('Single year', [10])]}).series[0].points[0].value, 100);
assert.deepEqual(normalize({series: [series('Signed', [-50, -25])]}).series[0].points.map(p => p.value), [100, 50]);
assert.equal(normalize({series: [series('Overflow', [1e-300, 1e300])]}).series[0].points[1].value, null);
console.log('PASS: per-series baselines, interval changes, zero/missing baselines, gaps, later zeros, immutable source values, finite results.');
