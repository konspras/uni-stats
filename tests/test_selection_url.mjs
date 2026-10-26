import assert from 'node:assert/strict';
import URLState from '../web/selection-url.js';
const detail={id:'entrants',group:'Bachelor entrants',columns:[{code:'Students',type:'c'}],aggregation_options:{Fachrichtung:{mode:'sum',values:['cs','psy']}},metadata:{variables:[
  {code:'Year',time:true,values:['10','11'],valueTexts:['2024/25','2025/26']},
  {code:'Hochschule',values:['01','02'],valueTexts:['EPFL','ETHZ']},
  {code:'Geschlecht',values:['m','f','unknown'],valueTexts:['Mann','Frau','Unknown']},
  {code:'Fachrichtung',values:['cs','psy'],valueTexts:['Informatik','Psychologie']} ]}};
const selection={dataset:detail.id,snapshot:99,compare:'Geschlecht',values:['m','f','unknown'],filters:{Hochschule:null,Fachrichtung:null},
  universities:['01','02'],measure:'Students',fromLabel:'2024/25',toLabel:'2025/26',percentage:true,stacked:false,subjectStacked:true};
const hash=URLState.write(selection,detail), restored=URLState.restore(URLState.read(hash),detail);
assert(hash.startsWith('#pyramid?v=1&'));
assert(!hash.includes('snapshot'));
assert.equal(URLState.view(hash),'pyramid');assert.equal(URLState.view('#explorer'),'explorer');
assert.equal(URLState.read('#pyramid'),null);assert.equal(URLState.read('#explorer'),null);
for(const key of ['dataset','compare','universities','measure','fromLabel','toLabel','percentage','stacked','subjectStacked']) assert.deepEqual(restored[key],selection[key]);
assert.deepEqual(restored.values,['m','f','unknown']);assert.deepEqual(restored.filters,selection.filters);
for(const universities of [[],['02'],['01','02']]) for(const percentage of [false,true]) for(const stacked of [false,true]) {
  const source={...selection,universities,percentage,stacked,subjectStacked:false,filters:{Hochschule:null,Fachrichtung:'cs'}};
  const result=URLState.restore(URLState.read(URLState.write(source,detail)),detail);
  assert.deepEqual(result.universities,universities);assert.equal(result.percentage,percentage);assert.equal(result.stacked,stacked);
}
const added=structuredClone(detail);added.metadata.variables[1].values.push('03');added.metadata.variables[1].valueTexts.push('New institution');
assert.deepEqual(URLState.restore(URLState.read(hash),added).universities,['01','02','03'],'All retains its meaning after a university is added');
for(const changes of [{dataset:'missing'},{compare:'bad'},{filters:{}},{filters:{Fachrichtung:'missing'}}, {filters:{Fachrichtung:null,extra:'x'}},
  {universities:['missing']},{universities:['01','01']},{measure:'bad'}, {fromLabel:'1999/00'}, {fromLabel:'2025/26',toLabel:'2024/25'},
  {subjectStacked:true,filters:{Fachrichtung:'cs'}}]) assert.throws(()=>URLState.restore({...URLState.read(hash),...changes},detail));
assert.throws(()=>URLState.read(hash.replace('v=1','v=2')),/version/);
for(const filters of ['null','[]','{"Fachrichtung":3}','not-json']) {
  const p=new URLSearchParams(hash.split('?')[1]);p.set('filters',filters);assert.throws(()=>URLState.read('#pyramid?'+p));
}
// Broad subjects and nationality retain original Unicode dimension identifiers.
const nationality=structuredClone(detail);nationality.metadata.variables[2].code='Staatsangehörigkeit (Kategorie)';nationality.metadata.variables[3].code='Fachbereich';nationality.aggregation_options={Fachbereich:{mode:'sum'}};
const source={...selection,compare:'Staatsangehörigkeit (Kategorie)',filters:{Fachbereich:null,Hochschule:null}};
assert.deepEqual(URLState.restore(URLState.read(URLState.write(source,nationality)),nationality).filters,source.filters);
console.log('PASS: pyramid URL round trips, All/empty university selections, toggles, Unicode, latest-data semantics, invalid links and stable year labels.');
