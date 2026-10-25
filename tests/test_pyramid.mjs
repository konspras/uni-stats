import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const {isPyramidDataset, pyramidCounterpart, pyramidSides, pyramidLayout, sumPyramidUniversities, pyramidSegments, rankPyramidUniversities, pyramidColor, pyramidCount, pyramidPeriodLabel} = vm.runInNewContext(
  await readFile(new URL('../web/pyramid.js', import.meta.url), 'utf8') + '\n({isPyramidDataset, pyramidCounterpart, pyramidSides, pyramidLayout, sumPyramidUniversities, pyramidSegments, rankPyramidUniversities, pyramidColor, pyramidCount, pyramidPeriodLabel});');
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
for (const [width,height,narrow] of [[900,884,false],[320,816,true]]) {
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

const uni = (code, values) => ({code,label:code,data:{compare:'Geschlecht',periods:['2024','2025'],filters:{Hochschule:code},
  series:['Mann','Frau','Geschlecht unbekannt'].map((label,i)=>({code:String(i),label,points:values[i].map(value=>({value,raw_value:value===null?'...':String(value)}))}))}});
const a=uni('EPFL',[[10,20],[5,10],[1,0]]), b=uni('ETHZ',[[30,40],[15,null],[0,2]]);
const summed=sumPyramidUniversities([a,b]);
assert.equal(summed.series[0].points[0].value,40);
assert.equal(summed.series[1].points[1].value,null,'Missing university component leaves a gap');
assert.equal(summed.series[1].points[1].missing_components,1);
assert.equal(summed.series[2].points[1].value,2,'Unknown categories retained separately');
assert.equal(summed.filters.Hochschule,null);
assert.equal(summed.derived,true);
assert.equal(a.data.series[0].points[0].value,10,'Source data is unchanged');
const segments=pyramidSegments({...summed.series[0].points[0],value:50},true);
assert.equal(segments[0].value,12.5); assert.equal(segments[1].value,37.5);
assert.equal(pyramidSegments(summed.series[1].points[1],false).length,0);
assert.equal(sumPyramidUniversities([a]).series[0].points[0].raw_value,'10');
assert.throws(()=>sumPyramidUniversities([]),/at least one/);
assert.throws(()=>sumPyramidUniversities([a,{...b,data:{...b.data,periods:['2023']}}]),/same periods/);
console.log('PASS: university sums, missing components, unknown categories, percentage segments and immutable sources.');

const first=uni('A',[[200,5],[100,25],[0,0]]);
const second=uni('B',[[5,10],[50,40],[0,0]]);
const third=uni('C',[[1,25],[60,10],[0,0]]);
const input=[first,second,third], before=JSON.stringify(input);
const ranked=sumPyramidUniversities(input);
assert.equal(ranked.universities.map(u=>u.code).join(','),'B,C,A','Rank by combined latest-year counts, not one side or full-history totals');
for(const series of pyramidSides(ranked).sides) for(const point of series.points) {
  assert.equal(point.segments.map(p=>p.university).join(','),'B,C,A','One ranking applies to every year and side');
}
assert.equal(ranked.series[1].points.at(-1).segments.map(p=>p.value).join(','),'40,10,25','Keep total ranking even when women have a different ranking');
const earlier=sumPyramidUniversities(input.map(u=>({...u,data:{...u.data,periods:['2024'],series:u.data.series.map(s=>({...s,points:s.points.slice(0,1)}))}})));
assert.equal(earlier.universities.map(u=>u.code).join(','),'A,C,B','Ranking follows the selected end year');
for (const data of [ranked,earlier]) data.universities.forEach((u,index)=>assert.equal(u.colorIndex,index,'Shading follows descending population rank'));
for(const side of [0,1]) {
  const lightness=ranked.universities.map(u=>Number(pyramidColor(u.colorIndex,3,side).match(/ ([\d.]+)%\)/)[1]));
  assert(lightness.every((value,i)=>!i||value>lightness[i-1]),'Largest university is darkest; smaller universities are lighter on both sides');
}
const tieA=uni('Alpha',[[1,10],[2,20],[0,9999]]),tieZ=uni('Zulu',[[2,20],[3,10],[0,0]]);
const missing=uni('Missing',[[999,999],[999,null],[0,0]]), zero=uni('Zero',[[0,0],[0,0],[0,0]]);
assert.equal(rankPyramidUniversities([missing,tieZ,zero,tieA]).map(u=>u.code).join(','),'Alpha,Zulu,Zero,Missing','Ties are alphabetical; unknown gender does not affect rank; missing values go last without a fallback year');
assert.equal(JSON.stringify(input),before,'Ranking does not change source data');
console.log('PASS: fixed latest-year combined ranking, ties, missing counts, selected end year and descending-rank shading.');

for(const side of [0,1]) {
  const shades=[0,9].map(index=>Number(pyramidColor(index,10,side).match(/ ([\d.]+)%\)/)[1]));
  assert(shades[1]-shades[0]>=70,'Visible universities use a wide lightness range');
}
const withZeros=rankPyramidUniversities([first,second,third,zero,missing]);
assert.equal(withZeros[0].colorCount,3,'Zero and missing latest-year totals do not compress the visible shade range');
assert.equal(pyramidCount({value:233,raw_value:'233'},false),233);
assert.equal(pyramidCount({value:81.5,raw_value:'233'},true),233,'Tooltip counts are recovered from percentage points');
assert.equal(pyramidCount({value:null,raw_value:'0'},true),0,'Preserve known zero counts even when percentage composition is unavailable');
for(const raw of [null,undefined,'','...']) assert.equal(pyramidCount({value:null,raw_value:raw},true),null);
console.log('PASS: wider palette, zero-count shade allocation and absolute tooltip counts in percentage mode.');

assert.equal(pyramidPeriodLabel('2025',2026),'2025 (1)');
assert.equal(pyramidPeriodLabel('2025/26',2026),'2025/26 (1)','Academic elapsed years use the starting year');
assert.equal(pyramidPeriodLabel('2026',2026),'2026 (0)');
assert.equal(pyramidPeriodLabel('1980/81',2026),'1980/81 (46)');
assert.equal(pyramidPeriodLabel('2025',2027),'2025 (2)','Elapsed years follow the current calendar year');
assert.equal(pyramidPeriodLabel('Unknown',2026),'Unknown');
console.log('PASS: calendar and academic year shorthand, current year and unsupported periods.');
