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
  const derived = universities.length > 1 || universities.some(u => u.data.derived);
  return {...first, derived, filters:{...first.filters, Hochschule:universities.length > 1 ? null : universities[0].code},
    aggregation:{...first.aggregation, ...(universities.length > 1 ? {Hochschule:{mode:'sum', count:universities.length, values:universities.map(u => u.code)}} : {})}, universities:universities.map(({code,label}) => ({code,label})),
    series:first.series.map((series, i) => ({...series, points:series.points.map((point, j) => {
      const segments = universities.map(u => ({university:u.code, label:u.label, ...u.data.series[i].points[j]}));
      if (universities.length === 1) return {...point, segments};
      const valid = segments.every(p => Number.isFinite(p.value));
      const total = valid ? segments.reduce((sum,p) => sum + p.value, 0) : null;
      return {...point, value:total, raw_value:total === null ? null : String(total), segments,
        missing_components:segments.reduce((sum,p) => sum + (p.value === null ? p.missing_components || 1 : 0), 0)};
    })}))};
}
function pyramidColor(index, count, side) {
  return `hsl(${side ? 19 : 226} 65% ${count < 2 ? 52 : 32 + index / (count - 1) * 48}%)`;
}
function pyramidSegments(point, percentage) {
  if (!Number.isFinite(point.value) || point.value < 0) return [];
  const segments = point.segments || [];
  if (segments.some(p => !Number.isFinite(p.value) || p.value < 0)) return [];
  const total = segments.reduce((sum,p) => sum + p.value, 0);
  return segments.map(p => ({...p, value:percentage ? total ? p.value / total * point.value : 0 : p.value}));
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
  const longestLabel = Math.max(...data.periods.map(p => p.length));
  const center = width / 2, gap = Math.max(narrow ? 48 : 44, longestLabel * fontSize * 0.65 / 2 + 8 / scale), edge = 30;
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
  const tip = el('div', undefined, 'tooltip'); tip.hidden = true;
  function inspect(index) {
    tip.replaceChildren(el('strong', data.periods[index]));
    for (const [i, s] of sides.entries()) {
      const point = s.points[index], row = el('div', undefined, 'tooltip-row');
      row.append(el('span', labels[i]), el('b', point.value === null ? '—' : number(point.value) + (data.percentage ? '%' : '')));
      row.title = (data.derived ? 'Derived sum: ' : 'Source value: ') + (point.raw_value ?? 'unavailable'); tip.append(row);
      if (data.stacked) for (const segment of pyramidSegments(point, data.percentage)) {
        const part = el('div', undefined, 'tooltip-row');
        part.append(el('span', segment.label), el('b', number(segment.value) + (data.percentage ? '%' : ''))); tip.append(part);
      }
    }
    tip.hidden = false;
    tip.style.left = Math.max(5, Math.min(root.clientWidth - tip.offsetWidth - 5, root.clientWidth / 2 + 12)) + 'px';
    const rowY = (top + (index + 0.5) * rowHeight) * scale;
    tip.style.top = Math.max(5, Math.min(root.clientHeight - tip.offsetHeight - 5, rowY - tip.offsetHeight)) + 'px';
  }
  let inspected = data.periods.length - 1;
  for (let j = 0; j < data.periods.length; j++) {
    const y = top + j * rowHeight;
    const row = svgNode('g', {'data-period':data.periods[j],class:'pyramid-row'});
    const showLabel = j === 0 || j === data.periods.length - 1 || (j % labelStride === 0 && data.periods.length - 1 - j >= labelStride);
    row.append(svgNode('rect', {x:edge,y,width:width-2*edge,height:rowHeight,class:'pyramid-row-hit'}));
    if (showLabel) {
      const year = svgNode('text', {x:center,y:y+rowHeight/2,'text-anchor':'middle','dominant-baseline':'middle',class:'pyramid-year'}, data.periods[j]);
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
            fill:data.stacked ? pyramidColor(index, data.universities.length, i) : colors[i],class:'pyramid-bar',
            'data-side':i ? 'right' : 'left','data-value':segment.value,
            ...(data.stacked ? {'data-university':segment.university} : {})});
          bar.append(svgNode('title', {}, (segment.label ? segment.label + ', ' : '') + labels[i] + ', ' + data.periods[j] + ': ' + number(segment.value) + (data.percentage ? '%' : '')));
          row.append(bar); offset += w;
        }
      } else if (showLabel) {
        const marker = svgNode('text', {x:base+(i ? 12 : -12),y:y+rowHeight/2,'text-anchor':'middle','dominant-baseline':'middle'}, '—');
        marker.style.fontSize = fontSize + 'px'; row.append(marker);
      }
    }
    row.addEventListener('pointerenter', () => {inspected = j; inspect(j);});
    svg.append(row);
  }
  svg.append(svgNode('text', {x:center,y:height-12/scale,'text-anchor':'middle',class:'axis-title'}, data.percentage ? 'Share of each year’s total (%)' : data.derived ? 'Derived count' : 'Count'));
  root.append(svg, tip); root.tabIndex = 0;
  root.setAttribute('aria-label', 'Pyramid. Oldest year at top, newest at bottom. Use arrow keys to inspect years.');
  const hide = () => {tip.hidden = true;}; svg.addEventListener('pointerleave', hide); root.onblur = hide;
  root.onkeydown = event => {
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    inspected = event.key === 'Home' ? 0 : event.key === 'End' ? data.periods.length-1 : Math.max(0,Math.min(data.periods.length-1,inspected+(event.key==='ArrowDown' ? 1 : -1)));
    inspect(inspected);
  };
}
