'use strict';

// Sum complete subject partitions across selected universities/categories.
function sumSubjectParts(points) {
  return points[0].subject_segments.map((part, index) => {
    const parts = points.map(p => p.subject_segments[index]);
    if (parts.some(p => p.code !== part.code)) throw new Error('Subject categories do not match.');
    const valid = parts.every(p => Number.isFinite(p.value));
    const value = valid ? parts.reduce((sum, p) => sum + p.value, 0) : null;
    return {...part, value, raw_value:value === null ? null : String(value),
      missing_components:parts.reduce((sum,p) => sum + (p.value === null ? p.missing_components || 1 : 0), 0)};
  });
}
function stackSubjects(data, pyramid) {
  if (!data.breakdown) throw new Error('Subject breakdown is unavailable.');
  const points = data.periods.map((_,j) => sumSubjectParts(data.series.map(s => s.points[j])));
  const latest = pyramid ? sumSubjectParts(pyramidSides(data).sides.map(s => s.points.at(-1))) : points.at(-1);
  const categories = latest.map(p => ({code:p.code,label:p.label,rankingTotal:p.value})).sort((a,b) =>
    (b.rankingTotal ?? -1) - (a.rankingTotal ?? -1) || a.label.localeCompare(b.label, 'de'));
  const count = Math.max(1, categories.filter(c => c.rankingTotal > 0).length);
  const ranked = categories.map((c,i) => ({...c,colorIndex:i,colorCount:count}));
  if (pyramid) return {...data, stacked:true, stackDimension:data.breakdown, stackCategories:ranked,
    series:data.series.map(s => ({...s,points:s.points.map(p => ({...p,segments:ranked.map(c =>
      ({...p.subject_segments.find(part => part.code === c.code), ...c, subject:c.code}))}))}))};
  return {...data, compare:data.breakdown, subjectStacked:true, derived:true,
    series:ranked.map(c => ({code:c.code,label:c.label,points:points.map((parts,j) =>
      ({...parts.find(p => p.code === c.code),period:data.periods[j],period_code:data.series[0].points[j].period_code}))}))};
}
function subjectStackBounds(data) {
  const series = data.series.map(s => ({...s,points:s.points.map(p => ({...p}))}));
  for (let j=0;j<data.periods.length;j++) {
    const complete = series.every(s => Number.isFinite(s.points[j].value) && s.points[j].value >= 0);
    let lower=0;
    for (const s of series) {
      const p=s.points[j];
      if (!complete) {p.value=null;p.stack_lower=null;p.stack_upper=null;continue;}
      p.stack_lower=lower; lower+=p.value;p.stack_upper=lower;
    }
  }
  return {...data,series};
}
