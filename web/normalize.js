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

// The denominator is the selected series, independently for each period.
// Incomplete, negative or all-zero totals cannot form a 100% composition.
function percentageSeries(data) {
  const shares = data.periods.map((_, index) => {
    const values = data.series.map(s => s.points[index]?.value);
    if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) return null;
    const scale = Math.max(...values);
    if (scale === 0) return null;
    const total = values.reduce((sum, value) => sum + value / scale, 0);
    let cumulative = 0;
    return values.map((value, i) => {
      const share = value / scale / total * 100;
      const lower = cumulative;
      cumulative += share;
      return {value: share, stack_lower: lower, stack_upper: i === values.length - 1 ? 100 : cumulative};
    });
  });
  return {...data, percentage: true, percentage_missing: shares.filter(v => v === null).length,
    series: data.series.map((series, i) => ({...series,
      points: series.points.map((point, j) => ({...point,
        ...(shares[j]?.[i] || {value: null, stack_lower: null, stack_upper: null})}))}))};
}
