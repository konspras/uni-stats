import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(await readFile('web/subjects.js','utf8') + await readFile('web/pyramid.js','utf8'),context);
const {sumPyramidUniversities,stackSubjects,subjectStackBounds,pyramidTooltipSubjects} = vm.runInContext('({sumPyramidUniversities,stackSubjects,subjectStackBounds,pyramidTooltipSubjects})',context);
const point=(a,b)=>({value:a+b,raw_value:String(a+b),subject_segments:[{code:'cs',label:'Informatik',value:a},{code:'psy',label:'Psychologie',value:b}]});
const data={breakdown:'Fachrichtung',compare:'Geschlecht',filters:{},periods:['2024','2025'],series:[{code:'m',label:'Mann',points:[point(8,2),point(10,3)]},{code:'f',label:'Frau',points:[point(2,7),point(2,15)]}]};
const summed=sumPyramidUniversities([{code:'a',label:'A',data},{code:'b',label:'B',data}]);
const pyramid=stackSubjects(summed,true);
assert.deepEqual(Array.from(pyramid.stackCategories,c=>c.code),['psy','cs'],'Latest year totals across both sides set a fixed order');
assert.equal(pyramid.series[0].points[0].segments[0].value,4);
assert.equal(pyramid.series[1].points[1].segments[0].value,30);
const explorer=subjectStackBounds(stackSubjects(summed,false));
assert.equal(explorer.series[0].points[1].value,36);
assert.equal(explorer.series[1].points[1].stack_upper,60);
const missing=structuredClone(summed);missing.series[0].points[0].subject_segments[0].value=null;
const gaps=subjectStackBounds(stackSubjects(missing,false));
assert(gaps.series.every(s=>s.points[0].value===null),'Incomplete partitions leave gaps');
assert.equal(summed.series[0].points[0].value,20,'Transforms do not change input totals');
console.log('Subject aggregation and stacking checks passed');

const tooltipData=structuredClone(pyramid);
for (const side of tooltipData.series) for(const [index,p] of side.points.entries()) {
  p.segments.push({subject:'always-zero',value:0},{subject:'missing',value:null},
    {subject:'earlier-only',value:index===0?2:0});
}
tooltipData.series[0].points[0].segments.push({subject:'one-side',value:3});
const visible=pyramidTooltipSubjects(tooltipData);
assert(!visible.has('always-zero'),'Subjects zero throughout are hidden');
assert(visible.has('missing'),'Missing counts are not treated as confirmed zeros');
assert(visible.has('earlier-only'),'A subject stays visible even when the inspected year is zero');
assert(visible.has('one-side'),'Both sides contribute to the shared subject set');
const narrowed=structuredClone(tooltipData);
for(const side of narrowed.series) side.points=side.points.slice(1);
assert(!pyramidTooltipSubjects(narrowed).has('earlier-only'),'Filtering follows the displayed interval');
assert.equal(pyramidTooltipSubjects({...tooltipData,stackDimension:'Hochschule'}),null,'University tooltips are unaffected');
console.log('Interval-wide tooltip subject filtering checks passed');
