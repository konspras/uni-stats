import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const percentage = vm.runInNewContext(await readFile(new URL('../web/normalize.js', import.meta.url), 'utf8') + '\npercentageSeries;');
function data(values) {
  return {derived: true, periods: values[0].map((_, i) => String(2000 + i)),
    series: values.map((v, i) => ({label: String(i), points: v.map(value => ({value, raw_value: String(value)}))}))};
}
const original = data([[250, 100, 0, null, -1, 0], [140, 100, 0, 50, 1, 10]]);
const copy = structuredClone(original), result = percentage(original);
assert.equal(result.series[0].points[0].value, 250 / 390 * 100);
assert.equal(result.series[1].points[0].value, 140 / 390 * 100);
assert.equal(result.series[0].points[1].value, 50);
assert.equal(result.series[1].points[1].stack_lower, 50);
assert.equal(result.series[1].points[1].stack_upper, 100);
assert.equal(result.percentage_missing, 3);
for (const index of [2, 3, 4]) assert(result.series.every(s => s.points[index].value === null));
assert.equal(result.series[0].points[5].value, 0);
assert.equal(result.series[1].points[5].value, 100);
assert.equal(result.series[0].points[0].raw_value, '250');
assert.deepEqual(original, copy, 'Source data remains unchanged');
assert.equal(result.derived, true, 'Derived aggregation provenance remains available');
for (const input of [data([[1e308], [1e308]]), data([[1e-300], [1e-300]])]) {
  const output = percentage(input);
  assert.equal(output.series[0].points[0].value, 50);
  assert.equal(output.series[1].points[0].value, 50);
}
assert.equal(percentage(data([[25]])).series[0].points[0].value, 100);
console.log('PASS: selected-series shares, per-period totals, stacks, missing/zero/negative totals, numerical stability, immutable source values.');
