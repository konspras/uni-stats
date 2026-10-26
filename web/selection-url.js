/* Share pyramid selections in the fragment so links work on static hosting. */
(function(root) {
'use strict';
const splits = {gender:'Geschlecht', nationality:'Staatsangehörigkeit (Kategorie)'};
function view(hash) {const tab=hash.split('?')[0];return tab==='#subjects' ? 'subjects':tab==='#explorer' ? 'explorer':'pyramid';}
function read(hash) {
  if (!hash.startsWith('#pyramid?') || !hash.slice(9)) return null;
  const p = new URLSearchParams(hash.slice(hash.indexOf('?')+1));
  if (p.get('v') !== '1') throw Error('This shared pyramid link has an unsupported version. Use Reset view to start again.');
  let filters;
  try {filters=JSON.parse(p.get('filters'));} catch {throw Error('This shared pyramid link has invalid filters.');}
  const universities=p.get('universities'), stack=p.get('stack') || '';
  if (!p.get('dataset') || !Object.hasOwn(splits,p.get('split')) || !filters || typeof filters !== 'object' || Array.isArray(filters)
      || Object.values(filters).some(v=>v!==null && typeof v!=='string') || !['all','selected'].includes(universities)
      || !['','universities','subjects'].includes(stack) || !['0','1',null].includes(p.get('percentage'))
      || !p.get('measure') || !p.get('from') || !p.get('to')) throw Error('This shared pyramid link is incomplete or invalid.');
  return {dataset:p.get('dataset'),compare:splits[p.get('split')],filters,
    universities:universities==='all' ? null : p.getAll('u'),measure:p.get('measure'),
    fromLabel:p.get('from'),toLabel:p.get('to'),percentage:p.get('percentage')==='1',
    stacked:stack==='universities',subjectStacked:stack==='subjects'};
}
function write(selection, detail) {
  const p = new URLSearchParams({v:'1',dataset:selection.dataset,
    split:selection.compare===splits.gender ? 'gender':'nationality'});
  const codes=detail.metadata.variables.find(v=>v.code==='Hochschule').values;
  const all=selection.universities.length===codes.length && codes.every(code=>selection.universities.includes(code));
  p.set('universities',all ? 'all':'selected');
  if (!all) for (const code of selection.universities) p.append('u',code);
  p.set('filters',JSON.stringify(Object.fromEntries(Object.entries(selection.filters).filter(([code])=>code!=='Hochschule').sort(([a],[b])=>a.localeCompare(b)))));
  p.set('measure',selection.measure);p.set('from',selection.fromLabel);p.set('to',selection.toLabel);
  if (selection.percentage) p.set('percentage','1');
  if (selection.subjectStacked) p.set('stack','subjects');else if(selection.stacked) p.set('stack','universities');
  return '#pyramid?'+p;
}
function restore(shared,detail) {
  const fail=()=>{throw Error('This shared pyramid uses a dataset, category, measure, or year unavailable in the latest report. Use Reset view to start again.');};
  if(shared.dataset!==detail.id) fail();
  const dims=detail.metadata.variables.filter(v=>!v.time),time=detail.metadata.variables.find(v=>v.time);
  const comparison=dims.find(v=>v.code===shared.compare),university=dims.find(v=>v.code==='Hochschule');
  if(!comparison || !university || !['Bachelor entrants','Degrees'].includes(detail.group)) fail();
  const filters=Object.fromEntries(dims.filter(v=>v.code!==shared.compare && v.code!=='Hochschule').map(v=>[v.code,v]));
  if(Object.keys(filters).length!==Object.keys(shared.filters).length || Object.entries(shared.filters).some(([code,value])=>
      !Object.hasOwn(filters,code) || (value===null ? !detail.aggregation_options[code] : !filters[code].values.includes(value)))) fail();
  const universities=shared.universities===null ? [...university.values] : shared.universities;
  if(new Set(universities).size!==universities.length || universities.some(code=>!university.values.includes(code))) fail();
  if(!detail.columns.some(c=>c.type==='c' && c.code===shared.measure)) fail();
  const first=time.valueTexts.indexOf(shared.fromLabel),last=time.valueTexts.indexOf(shared.toLabel);
  if(first<0 || last<first) fail();
  if(shared.subjectStacked && !['Fachrichtung','Fachbereich'].some(code=>shared.filters[code]===null && detail.aggregation_options[code]?.mode==='sum')) fail();
  return {...shared,filters:{...shared.filters,Hochschule:universities.length===1 ? universities[0]:null},
    universities,values:[...comparison.values],normalized:false};
}
root.SelectionURL={view,read,write,restore};
if(typeof module!=='undefined') module.exports=root.SelectionURL;
})(globalThis);
