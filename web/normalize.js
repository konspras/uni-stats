'use strict';

// Derive indices without changing source observations or choosing a later baseline.
function normalizeSeries(data) {
  return {...data, normalized: true, series: data.series.map(series => {
    const baseline = series.points[0]?.value;
    const valid = Number.isFinite(baseline) && baseline !== 0;
    return {...series, baseline, normalization_issue: valid ? null : baseline === 0 ? 'zero' : 'missing',
      points: series.points.map((point, index) => {
        const value = valid && Number.isFinite(point.value) ? (index === 0 ? 100 : point.value / baseline * 100) : null;
        return {...point, value: Number.isFinite(value) ? value : null};
      })};
  })};
}
