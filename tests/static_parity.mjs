// Compare the browser query engine to independently generated Python/SQLite results.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import queryEngine from '../web/static-query.js';
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const index=JSON.parse(fs.readFileSync(path.join(fixture.output,'index.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(fixture.output,index.manifest),'utf8'));
const metadata=new Map(),files=new Map();let elapsed=0,maxTime=0,maxRequest;
for(const {request,expected} of fixture.cases) {
  let detail=metadata.get(request.dataset);
  const metadataPath=path.join(fixture.output,manifest.datasets[request.dataset]);
  if(!detail) {detail=JSON.parse(fs.readFileSync(metadataPath,'utf8'));metadata.set(request.dataset,detail);}
  const plan=queryEngine.plan(detail,request),tables=[];
  for(const code of plan.universityCodes) {
    const file=detail.static_files[code]?.[plan.precomputed?'subject_totals':'raw'];if(!file)continue;
    const filename=path.join(path.dirname(metadataPath),file.path);
    if(!files.has(filename))files.set(filename,queryEngine.parseCSV(fs.readFileSync(filename,'utf8')));
    tables.push(files.get(filename));
  }
  const start=performance.now(),actual=queryEngine.query(detail,request,tables),duration=performance.now()-start;
  elapsed+=duration;if(duration>maxTime){maxTime=duration;maxRequest=request;}
  assert.deepEqual(actual,expected,'Parity: '+JSON.stringify(request));
}
console.log(JSON.stringify({cases:fixture.cases.length,files:files.size,query_ms:elapsed,max_query_ms:maxTime,max_request:maxRequest}));
assert.deepEqual(queryEngine.parseCSV('a,b\r\n"hello,\"\"world\"\"","line\n2"\r\n').rows,[['hello,"world"','line\n2']]);
assert.equal(queryEngine.sumDecimal(['0.1','0.2']),'0.3');
assert.equal(queryEngine.sumDecimal(['1e-3','0.0020']),'0.0030');
