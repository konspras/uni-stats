import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const {isPyramidDataset, pyramidCounterpart, pyramidSides, pyramidLayout} = vm.runInNewContext(
  await readFile(new URL('../web/pyramid.js', import.meta.url), 'utf8') + '\n({isPyramidDataset, pyramidCounterpart, pyramidSides, pyramidLayout});');
const dataset = (id, group, dimensions) => ({id, group, dimensions});
const catalog = [
  dataset('entrants-gender', 'Bachelor entrants', ['Fachrichtung', 'Geschlecht', 'Hochschule']),
  dataset('entrants-nationality', 'Bachelor entrants', ['Fachrichtung', 'Staatsangehörigkeit (Kategorie)', 'Hochschule']),
  dataset('entrants-broad', 'Bachelor entrants', ['Fachbereich', 'Staatsangehörigkeit (Kategorie)', 'Hochschule']),
  dataset('degrees-gender', 'Degrees', ['Fachrichtung', 'Examensstufe', 'Geschlecht', 'Hochschule']),
  dataset('degrees-nationality', 'Degrees', ['Fachrichtung', 'Examensstufe', 'Staatsangehörigkeit (Kategorie)', 'Hochschule']),
  dataset('enrolled', 'Enrolled students', ['Fachrichtung', 'Geschlecht', 'Hochschule']),
  dataset('staff', 'Staff', ['Geschlecht', 'Hochschule']),
  dataset('degrees-canton', 'Degrees', ['Wohnkanton', 'Hochschule']),
];
assert.deepEqual(catalog.map(isPyramidDataset), [true, true, true, true, true, false, false, false]);
assert.equal(isPyramidDataset(null), false);
assert.equal(pyramidCounterpart(catalog, catalog[0], 'Staatsangehörigkeit (Kategorie)'), catalog[1]);
assert.equal(pyramidCounterpart(catalog, catalog[3], 'Staatsangehörigkeit (Kategorie)'), catalog[4]);
assert.equal(pyramidCounterpart(catalog, catalog[2], 'Geschlecht'), undefined, 'Never substitute a different subject classification');
const data = {compare:'Geschlecht', series:[{code:'0',label:'Geschlecht unbekannt'}, {code:'2',label:'Frau'}, {code:'1',label:'Mann'}]};
const sides = pyramidSides(data);
assert.equal(sides.sides[0], data.series[2], 'Men always left, independent of codes or source order');
assert.equal(sides.sides[1], data.series[1], 'Women always right');
assert.equal(sides.other[0], data.series[0], 'Unknown gender is not silently merged into a side');
assert.equal(pyramidSides({compare:'Staatsangehörigkeit (Kategorie)',series:[{label:'Ausland'}, {label:'Schweiz'}]}).sides[0].label, 'Schweiz');
assert.throws(() => pyramidSides({compare:'Geschlecht',series:[{label:'Mann'}]}), /two pyramid sides/);
for (const [width,height,narrow] of [[900,520,false],[320,480,true]]) {
  let sparse;
  for (const count of [1,2,46,100]) {
    const layout=pyramidLayout(count,width,height,narrow);
    assert(Math.abs(layout.height*layout.scale-height)<1e-9, 'Fixed rendered height for any period count');
    assert(Math.abs((layout.top+count*layout.rowHeight+layout.bottom)*layout.scale-height)<1e-9, 'Every row fits');
    assert(layout.barHeight>0 && layout.barHeight<layout.rowHeight);
    assert(layout.fontSize*layout.scale<=16+1e-9, 'Text has a rendered size cap');
    assert(layout.fontSize*1.3<=layout.rowHeight*layout.labelStride, 'Visible labels do not overlap');
    if(count===2) sparse=layout;
    if(count===100) assert(layout.barHeight<sparse.barHeight/40, 'Dense histories use thinner bars');
  }
}
console.log('PASS: flow-only eligibility, correct counterpart selection, explicit side labels, unknown categories, missing-side rejection.');
