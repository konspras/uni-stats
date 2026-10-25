'use strict';

const pyramidSplits = ['Geschlecht', 'Staatsangehörigkeit (Kategorie)'];
function isPyramidDataset(dataset) {
  return Boolean(dataset && ['Bachelor entrants', 'Degrees'].includes(dataset.group) &&
    dataset.dimensions.includes('Hochschule') && dataset.dimensions.some(code => pyramidSplits.includes(code)));
}
function pyramidCounterpart(catalog, dataset, split) {
  const shape = d => JSON.stringify(d.dimensions.filter(code => !pyramidSplits.includes(code)).sort());
  return catalog.find(d => isPyramidDataset(d) && d.group === dataset.group &&
    d.dimensions.includes(split) && shape(d) === shape(dataset));
}
function pyramidSides(data) {
  const labels = data.compare === 'Geschlecht' ? ['Mann', 'Frau'] : ['Schweiz', 'Ausland'];
  const sides = labels.map(name => data.series.find(s => s.label === name));
  if (sides.some(s => !s)) throw new Error('This dataset does not provide the two pyramid sides.');
  return {sides, other: data.series.filter(s => !sides.includes(s)),
    labels: data.compare === 'Geschlecht' ? ['Men', 'Women'] : ['Swiss nationals', 'Foreign nationals']};
}

// Rank once from raw counts in the latest displayed year, shared by both sides.
function rankPyramidUniversities(universities) {
  const ranked = universities.map(university => {
    const values = pyramidSides(university.data).sides.map(s => s.points.at(-1)?.value);
    const total = values.every(v => Number.isFinite(v) && v >= 0) ? values.reduce((sum, v) => sum + v, 0) : null;
    return {...university, rankingTotal:total};
  }).sort((a, b) => {
    if (a.rankingTotal === null && b.rankingTotal !== null) return 1;
    if (b.rankingTotal === null && a.rankingTotal !== null) return -1;
    return (b.rankingTotal ?? 0) - (a.rankingTotal ?? 0) ||
      a.label.localeCompare(b.label, 'en', {sensitivity:'base'}) || a.code.localeCompare(b.code);
  });
  const colorCount = Math.max(1, ranked.filter(u => u.rankingTotal > 0).length);
  return ranked.map((university, colorIndex) => ({...university, colorIndex, colorCount}));
}

// Keep university components alongside totals so display modes share one denominator.
function sumPyramidUniversities(universities) {
  if (!universities.length) throw new Error('Select at least one university.');
  const first = universities[0].data;
  for (const u of universities) {
    if (JSON.stringify(u.data.periods) !== JSON.stringify(first.periods) ||
        JSON.stringify(u.data.series.map(s => s.code)) !== JSON.stringify(first.series.map(s => s.code))) {
      throw new Error('University series do not share the same periods and categories.');
    }
  }
  universities = rankPyramidUniversities(universities);
  const derived = universities.length > 1 || universities.some(u => u.data.derived);
  return {...first, derived, filters:{...first.filters, Hochschule:universities.length > 1 ? null : universities[0].code},
    aggregation:{...first.aggregation, ...(universities.length > 1 ? {Hochschule:{mode:'sum', count:universities.length, values:universities.map(u => u.code)}} : {})}, universities:universities.map(({code,label,colorIndex,colorCount,rankingTotal}) => ({code,label,colorIndex,colorCount,rankingTotal})),
    series:first.series.map((series, i) => ({...series, points:series.points.map((point, j) => {
      const segments = universities.map(u => ({university:u.code, label:u.label, colorIndex:u.colorIndex, colorCount:u.colorCount, ...u.data.series[i].points[j]}));
      if (universities.length === 1) return {...point, segments};
      const valid = segments.every(p => Number.isFinite(p.value));
      const total = valid ? segments.reduce((sum,p) => sum + p.value, 0) : null;
      return {...point, ...(point.subject_segments ? {subject_segments:sumSubjectParts(segments)} : {}), value:total, raw_value:total === null ? null : String(total), segments,
        missing_components:segments.reduce((sum,p) => sum + (p.value === null ? p.missing_components || 1 : 0), 0)};
    })}))};
}
function pyramidColor(index, count, side) {
  const lightness = count < 2 ? index ? 90 : 45 : 18 + Math.min(index, count - 1) / (count - 1) * 72;
  return `hsl(${side ? 19 : 226} 85% ${lightness}%)`;
}
function pyramidSegments(point, percentage) {
  if (!Number.isFinite(point.value) || point.value < 0) return [];
  const segments = point.segments || [];
  if (segments.some(p => !Number.isFinite(p.value) || p.value < 0)) return [];
  const total = segments.reduce((sum,p) => sum + p.value, 0);
  return segments.map(p => ({...p, value:percentage ? total ? p.value / total * point.value : 0 : p.value}));
}

// Use one interval-wide subject set for both populations and every inspected year.
function pyramidTooltipSubjects(data) {
  if (!data.stacked || !['Fachrichtung', 'Fachbereich'].includes(data.stackDimension)) return null;
  const subjects = new Set();
  for (const series of pyramidSides(data).sides) {
    for (const point of series.points) {
      for (const segment of point.segments || []) {
        // Missing counts do not prove that a subject was zero throughout.
        if (segment.value !== 0) subjects.add(segment.subject);
      }
    }
  }
  return subjects;
}

function pyramidCount(point, percentage) {
  const value = percentage ? point.raw_value === null || point.raw_value === undefined || point.raw_value === '' ? null : Number(point.raw_value) : point.value;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function pyramidPeriodLabel(period, currentYear = new Date().getFullYear()) {
  const match = /^(\d{4})(?:\/\d{2,4})?$/.exec(period);
  return match ? period + ' (' + (currentYear - Number(match[1])) + ')' : period;
}

function pyramidLayout(count, containerWidth, containerHeight, narrow) {
  const width = narrow ? 520 : 860, scale = containerWidth / width;
  const height = containerHeight / scale, top = 62 / scale, bottom = 40 / scale;
  const rowHeight = (height - top - bottom) / Math.max(1, count);
  const fontSize = Math.min(16, Math.max(10, rowHeight * scale * 0.6)) / scale;
  const labelStride = Math.max(1, Math.ceil(fontSize * 1.3 / rowHeight));
  return {width, height, top, bottom, rowHeight, fontSize, labelStride,
    barHeight:rowHeight * 0.85, barInset:rowHeight * 0.075, scale};
}

function drawPyramid(data) {
  const root = $('chart'); root.replaceChildren(); root.onkeydown = null; root.onblur = null;
  root.removeAttribute('tabindex'); root.removeAttribute('aria-label');
  const {sides, labels} = pyramidSides(data);
  const narrow = window.matchMedia('(max-width:720px)').matches;
  const {width, height, top, bottom, rowHeight, fontSize, labelStride, barHeight, barInset, scale} =
    pyramidLayout(data.periods.length, root.clientWidth, root.clientHeight, narrow);
  const periodLabels = data.periods.map(p => pyramidPeriodLabel(p));
  const longestLabel = Math.max(...periodLabels.map(p => p.length));
  const totalFontSize = Math.min((narrow ? 10 : 12) / scale, rowHeight * 0.72);
  const valueLabel = point => number(point.value) + (data.percentage && Number.isFinite(point.value) ? '%' : '');
  const countTexts = sides.flatMap(s => s.points.map(valueLabel));
  const labelSpace = Math.max(...countTexts.map(t => t.length)) * totalFontSize * 0.65 + 12 / scale;
  const center = width / 2, gap = Math.max(narrow ? 48 : 44, longestLabel * fontSize * 0.65 / 2 + 8 / scale), edge = Math.max(30, labelSpace);
  const half = center - gap - edge;
  const values = sides.flatMap(s => s.points.map(p => p.value)).filter(v => Number.isFinite(v) && v >= 0);
  const largest = Math.max(0, ...values);
  const max = data.percentage ? 100 : largest ? Math.ceil(largest / Math.pow(10, Math.floor(Math.log10(largest)))) * Math.pow(10, Math.floor(Math.log10(largest))) : 1;
  const barWidth = value => value / max * half;
  const svg = svgNode('svg', {viewBox: `0 0 ${width} ${height}`, role:'img',
    'aria-label': labels[0] + ' on the left; ' + labels[1] + ' on the right. Oldest years at the top, newest at the bottom.'});
  svg.append(svgNode('title', {}, data.measure + ' by year and ' + label(data.compare).toLowerCase()));
  for (const side of [0, 1]) {
    const base = center + (side ? gap : -gap), direction = side ? 1 : -1;
    svg.append(svgNode('text', {x:base + direction * half / 2,y:18/scale,'text-anchor':'middle',class:'pyramid-side-title'}, labels[side]));
    for (let tick = 0; tick <= 4; tick++) {
      const value = max * tick / 4, x = base + direction * barWidth(value);
      svg.append(svgNode('line', {x1:x,x2:x,y1:top,y2:height-bottom,class:'grid-line'}));
      svg.append(svgNode('text', {x,y:42/scale,'text-anchor':'middle'}, number(value) + (data.percentage ? '%' : '')));
    }
  }
  const tooltipSubjects = pyramidTooltipSubjects(data);
  const tip = el('div', undefined, 'tooltip pyramid-tooltip'); tip.hidden = true;
  tip.setAttribute('role', 'region'); tip.setAttribute('aria-label', 'Year breakdown');
  let hideTimer, dismissed = false;
  const cancelHide = () => {clearTimeout(hideTimer);};
  const hide = () => {cancelHide(); tip.hidden = true;};
  const scheduleHide = () => {cancelHide(); hideTimer = setTimeout(hide, 180);};
  tip.addEventListener('pointerenter', cancelHide);
  tip.addEventListener('pointerleave', scheduleHide);
  function inspect(index) {
    cancelHide();
    tip.replaceChildren(el('strong', data.periods[index]));
    const populations = el('div', undefined, 'pyramid-tooltip-populations');
    tip.append(populations);
    for (const [i, s] of sides.entries()) {
      const population = el('section', undefined, 'pyramid-tooltip-population');
      population.setAttribute('aria-label', labels[i]);
      const point = s.points[index], row = el('div', undefined, 'tooltip-row pyramid-tooltip-total');
      row.append(el('span', labels[i] + ' total'), el('b', number(pyramidCount(point, data.percentage))));
      row.title = (data.derived ? 'Derived sum: ' : 'Source value: ') + (point.raw_value ?? 'unavailable'); population.append(row);
      const components = el('div', undefined, 'pyramid-tooltip-components');
      if (data.stacked) {
        components.tabIndex = 0;
        components.setAttribute('role', 'region');
        components.setAttribute('aria-label', labels[i] + ' breakdown');
      }
      if (data.stacked) for (const segment of point.segments || []) {
        if (tooltipSubjects && !tooltipSubjects.has(segment.subject)) continue;
        const part = el('div', undefined, 'tooltip-row pyramid-tooltip-component');
        if (segment.subject) part.dataset.subject = segment.subject; else part.dataset.university = segment.university;
        part.append(categoryNode('span', data.stackDimension || 'Hochschule', segment.label), el('b', number(segment.value))); components.append(part);
      }
      population.append(components); populations.append(population);
    }
    tip.hidden = false;
    const bounds = root.getBoundingClientRect();
    const topLimit = Math.max(5, 8 - bounds.top);
    const bottomLimit = Math.min(root.clientHeight - 5, window.innerHeight - 8 - bounds.top);
    tip.style.maxHeight = Math.max(0, Math.min(560, bottomLimit - topLimit)) + 'px';
    tip.style.width = Math.max(0, Math.min(data.stacked ? 640 : 440, root.clientWidth - 10)) + 'px';
    tip.style.left = Math.max(5, Math.min(root.clientWidth - tip.offsetWidth - 5, root.clientWidth / 2 + 12)) + 'px';
    const rowY = (top + (index + 0.5) * rowHeight) * scale;
    tip.style.top = Math.max(topLimit, Math.min(bottomLimit - tip.offsetHeight, rowY - tip.offsetHeight)) + 'px';
  }
  let inspected = data.periods.length - 1;
  for (let j = 0; j < data.periods.length; j++) {
    const y = top + j * rowHeight;
    const row = svgNode('g', {'data-period':data.periods[j],class:'pyramid-row'});
    const showLabel = j === 0 || j === data.periods.length - 1 || (j % labelStride === 0 && data.periods.length - 1 - j >= labelStride);
    row.append(svgNode('rect', {x:edge,y,width:width-2*edge,height:rowHeight,class:'pyramid-row-hit'}));
    if (showLabel) {
      const year = svgNode('text', {x:center,y:y+rowHeight/2,'text-anchor':'middle','dominant-baseline':'middle',class:'pyramid-year'}, periodLabels[j]);
      year.style.fontSize = fontSize + 'px'; row.append(year);
    }
    for (const [i, s] of sides.entries()) {
      const point = s.points[j], base = center + (i ? gap : -gap);
      const valid = Number.isFinite(point.value) && point.value >= 0;
      if (valid) {
        const segments = data.stacked ? pyramidSegments(point, data.percentage) : [{value:point.value}];
        let offset = 0;
        for (const [index, segment] of segments.entries()) {
          const w = barWidth(segment.value);
          const bar = svgNode('rect', {x:i ? base+offset : base-offset-w,y:y+barInset,width:w,height:barHeight,
            fill:data.stacked ? pyramidColor(segment.colorIndex ?? index, segment.colorCount ?? (data.stackCategories || data.universities).length, i) : colors[i],class:'pyramid-bar',
            'data-side':i ? 'right' : 'left','data-value':segment.value,
            ...(data.stacked ? {[segment.subject ? 'data-subject' : 'data-university']:segment.subject || segment.university} : {})});
          bar.append(svgNode('title', {}, (segment.label ? categoryFullLabel(data.stackDimension || 'Hochschule', segment.label) + ', ' : '') + labels[i] + ', ' + data.periods[j] + ': ' + number(pyramidCount(data.stacked ? segment : point, data.percentage))));
          row.append(bar); offset += w;
        }
      }
      const count = pyramidCount(point, data.percentage), outside = valid ? barWidth(point.value) : 0;
      if (count === 0) continue;
      const total = svgNode('text', {x:base+(i ? 1 : -1)*(outside+6/scale),y:y+rowHeight/2,
        'text-anchor':i ? 'start' : 'end','dominant-baseline':'middle',class:'pyramid-total',
        'data-side':i ? 'right' : 'left','data-count':count ?? ''}, valueLabel(point));
      total.style.fontSize = totalFontSize + 'px';
      total.append(svgNode('title', {}, labels[i] + ', ' + data.periods[j] + ': ' + (count === null ? 'Count unavailable' : number(count))));
      row.append(total);
    }
    row.addEventListener('pointerenter', () => {if (!dismissed) {inspected = j; inspect(j);}});
    row.addEventListener('pointermove', () => {if (dismissed) {dismissed = false; inspected = j; inspect(j);}});
    svg.append(row);
  }
  svg.append(svgNode('text', {x:center,y:height-12/scale,'text-anchor':'middle',class:'axis-title'}, data.percentage ? 'Share of each year’s total (%)' : data.derived ? 'Derived count' : 'Count'));
  root.append(svg, tip); root.tabIndex = 0;
  root.setAttribute('aria-label', 'Pyramid. Oldest year at top, newest at bottom. Use arrow keys to inspect years.');
  svg.addEventListener('pointerleave', scheduleHide);
  root.onpointerleave = hide;
  root.onfocusout = event => {if (!root.contains(event.relatedTarget)) hide();};
  root.onkeydown = event => {
    if (event.key === 'Escape') {dismissed = true; hide(); if (event.target !== root) root.focus({preventScroll:true}); return;}
    // Arrow keys inside a breakdown scroll its list rather than selecting another year.
    if (event.target !== root) return;
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault(); dismissed = false;
    inspected = event.key === 'Home' ? 0 : event.key === 'End' ? data.periods.length-1 : Math.max(0,Math.min(data.periods.length-1,inspected+(event.key==='ArrowDown' ? 1 : -1)));
    inspect(inspected);
  };
}
