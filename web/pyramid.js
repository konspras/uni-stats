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

function drawPyramid(data) {
  const root = $('chart'); root.replaceChildren(); root.onkeydown = null; root.onblur = null;
  root.removeAttribute('tabindex'); root.removeAttribute('aria-label');
  const {sides, labels} = pyramidSides(data);
  const narrow = window.matchMedia('(max-width:720px)').matches;
  const width = narrow ? 520 : 860, rowHeight = narrow ? 26 : 21, top = 62;
  const height = top + data.periods.length * rowHeight + 48;
  const center = width / 2, gap = narrow ? 48 : 44, edge = 30;
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
    svg.append(svgNode('text', {x:base + direction * half / 2,y:15,'text-anchor':'middle',class:'pyramid-side-title'}, labels[side]));
    for (let tick = 0; tick <= 4; tick++) {
      const value = max * tick / 4, x = base + direction * barWidth(value);
      svg.append(svgNode('line', {x1:x,x2:x,y1:top-7,y2:height-39,class:'grid-line'}));
      svg.append(svgNode('text', {x,y:40,'text-anchor':'middle'}, number(value) + (data.percentage ? '%' : '')));
    }
  }
  const tip = el('div', undefined, 'tooltip'); tip.hidden = true;
  function inspect(index) {
    tip.replaceChildren(el('strong', data.periods[index]));
    for (const [i, s] of sides.entries()) {
      const point = s.points[index], row = el('div', undefined, 'tooltip-row');
      row.append(el('span', labels[i]), el('b', point.value === null ? '—' : number(point.value) + (data.percentage ? '%' : '')));
      row.title = (data.derived ? 'Derived sum: ' : 'Source value: ') + (point.raw_value ?? 'unavailable'); tip.append(row);
    }
    tip.hidden = false;
    tip.style.left = Math.max(5, Math.min(root.clientWidth - tip.offsetWidth - 5, root.clientWidth / 2 + 12)) + 'px';
    const rowY = (top + index * rowHeight) * root.clientWidth / width;
    tip.style.top = Math.max(root.scrollTop + 5, rowY - tip.offsetHeight) + 'px';
  }
  let inspected = data.periods.length - 1;
  for (let j = 0; j < data.periods.length; j++) {
    const y = top + j * rowHeight;
    const row = svgNode('g', {'data-period':data.periods[j],class:'pyramid-row'});
    row.append(svgNode('rect', {x:edge,y:y-4,width:width-2*edge,height:rowHeight,class:'pyramid-row-hit'}));
    row.append(svgNode('text', {x:center,y:y+rowHeight/2-1,'text-anchor':'middle',class:'pyramid-year'}, data.periods[j]));
    for (const [i, s] of sides.entries()) {
      const point = s.points[j], base = center + (i ? gap : -gap);
      const valid = Number.isFinite(point.value) && point.value >= 0;
      if (valid) {
        const w = barWidth(point.value);
        const bar = svgNode('rect', {x:i ? base : base-w,y,width:w,height:rowHeight-5,
          fill:colors[i],class:'pyramid-bar','data-side':i ? 'right' : 'left','data-value':point.value});
        bar.append(svgNode('title', {}, labels[i] + ', ' + data.periods[j] + ': ' + number(point.value) + (data.percentage ? '%' : '')));
        row.append(bar);
      } else row.append(svgNode('text', {x:base+(i ? 12 : -12),y:y+rowHeight/2-1,'text-anchor':'middle'}, '—'));
    }
    row.addEventListener('pointerenter', () => {inspected = j; inspect(j);});
    svg.append(row);
  }
  svg.append(svgNode('text', {x:center,y:height-10,'text-anchor':'middle',class:'axis-title'}, data.percentage ? 'Share of each year’s total (%)' : data.derived ? 'Derived count' : 'Count'));
  root.append(svg, tip); root.tabIndex = 0;
  root.setAttribute('aria-label', 'Pyramid. Oldest year at top, newest at bottom. Use arrow keys to inspect years.');
  const hide = () => {tip.hidden = true;}; svg.addEventListener('pointerleave', hide); root.onblur = hide;
  root.onkeydown = event => {
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    inspected = event.key === 'Home' ? 0 : event.key === 'End' ? data.periods.length-1 : Math.max(0,Math.min(data.periods.length-1,inspected+(event.key==='ArrowDown' ? 1 : -1)));
    const y = (top + inspected * rowHeight) * root.clientWidth / width;
    if (y < root.scrollTop || y > root.scrollTop + root.clientHeight - 30) root.scrollTop = Math.max(0,y-root.clientHeight/2);
    inspect(inspected);
  };
}
