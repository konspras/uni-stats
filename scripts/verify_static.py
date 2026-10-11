#!/usr/bin/env python3
"""Validate every exported source cell and compare static queries with SQLite."""
import argparse
import csv
import hashlib
import io
import itertools
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from explorer import Explorer
from scripts.bfs_store import identifier


def verify(database,output):
    output=Path(output);explorer=Explorer(database)
    index=json.loads((output/'index.json').read_text());manifest=json.loads((output/index['manifest']).read_text())
    cases=[];count=0;files=0;sizes=[];selection_sizes=[]
    for dataset,path in manifest['datasets'].items():
        metadata_path=output/path;detail=json.loads(metadata_path.read_text());headers=[c['code'] for c in detail['columns']]
        variables=detail['metadata']['variables'];dims=[v for v in variables if not v.get('time')]
        with explorer.connection() as c:
            snapshot=explorer.snapshot(c,dataset,detail['snapshot_id']);sql='SELECT '+','.join(identifier(h) for h in headers)+' FROM '+identifier(snapshot['table_name'])+' WHERE snapshot_id=?'
            order=' ORDER BY '+','.join(identifier(v['code']) for v in variables)
            for university,versions in detail['static_files'].items():
                source=versions['raw'];body=(metadata_path.parent/source['path']).read_bytes()
                if hashlib.sha256(body).hexdigest()!=source['sha256']:raise ValueError('CSV checksum: '+path)
                reader=csv.reader(io.StringIO(body.decode(),newline=''));assert next(reader)==headers
                arguments=[detail['snapshot_id']];where=''
                if 'Hochschule' in headers:where=' AND '+identifier('Hochschule')+'=?';arguments.append(university)
                n=0
                for exported,original in itertools.zip_longest(reader,c.execute(sql+where+order,arguments)):
                    if exported is None or original is None or exported!=list(original):raise ValueError('Source cell mismatch: '+path)
                    n+=1
                assert n==source['rows'];count+=n;files+=1
                for version,file in versions.items():sizes.append({'dataset':dataset,'university':university,'kind':version,**file})
        for comparison in dims:
            values=comparison['values'] if len(comparison['values'])<=100 else comparison['values'][:99]+comparison['values'][-1:]
            for pattern in range(3):
                filters={v['code']: (None if v['code'] in detail['aggregation_options'] and (pattern==1 or pattern==2 and i%2) else v['values'][0]) for i,v in enumerate(dims) if v is not comparison}
                for measure in [col['code'] for col in detail['columns'] if col['type']=='c']:
                    request={'dataset':dataset,'snapshot':detail['snapshot_id'],'compare':comparison['code'],'values':values,'filters':filters,'measure':measure}
                    cases.append({'request':request,'expected':explorer.series(request)})
                    if detail.get('precomputed_subject') in filters and filters[detail['precomputed_subject']] is None:
                        request={**request,'breakdown':detail['precomputed_subject']}
                        cases.append({'request':request,'expected':explorer.series(request)})
                        if detail['group'] in ('Bachelor entrants','Degrees') and comparison['code'] in ('Geschlecht','Staatsangehörigkeit (Kategorie)'):
                            request={**request,'universities':next(v['values'] for v in dims if v['code']=='Hochschule')}
                            cases.append({'request':request,'expected':explorer.series(request)})
        for kind in ['raw','subject_totals']:
            group=[v[kind] for v in detail['static_files'].values() if kind in v]
            selection_sizes.append({'dataset':dataset,'kind':kind,'files':len(group),'bytes':sum(v['bytes'] for v in group),'gzip_bytes':sum(v['gzip_bytes'] for v in group)})
    with tempfile.TemporaryDirectory() as name:
        fixture=Path(name)/'fixture.json';fixture.write_text(json.dumps({'output':str(output.resolve()),'cases':cases}))
        result=subprocess.run(['node',str(ROOT/'tests/static_parity.mjs'),str(fixture)],capture_output=True,text=True)
        if result.returncode:raise ValueError(result.stderr)
        parity=json.loads(result.stdout)
    return {'source_rows_verified':count,'source_files_verified':files,'parity':parity,
            'raw_total_bytes':sum(s['bytes'] for s in sizes),'gzip_total_bytes':sum(s['gzip_bytes'] for s in sizes),
            'largest_file':max(sizes,key=lambda s:s['gzip_bytes']),
            'largest_selection':max(selection_sizes,key=lambda s:s['gzip_bytes']),
            'entrants': [s for s in selection_sizes if s['dataset']=='px-x-1502040100_123']}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,default=ROOT/'data/university_stats.sqlite3')
    parser.add_argument('--output',type=Path,default=ROOT/'web/data')
    args=parser.parse_args();start=time.monotonic();result=verify(args.database,args.output);result['seconds']=time.monotonic()-start
    print(json.dumps(result,indent=2))
