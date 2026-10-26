'use strict';

// Build one complete time series per subject; preserve missing/unknown categories.
function subjectGridModel(data, percentage=false) {
  const {sides,other,labels}=pyramidSides(data);
  const subjects=data.series[0]?.points[0]?.subject_segments || [];
  const cards=subjects.map((subject,index)=>{
    const series=data.series.map(s=>({...s,points:s.points.map(p=>({period:p.period,period_code:p.period_code,...p.subject_segments[index]}))}));
    const values=series.map(s=>s.points.at(-1).value);
    const total=values.every(v=>Number.isFinite(v)&&v>=0) ? values.reduce((a,b)=>a+b,0) : null;
    const shares=percentage ? percentageSeries({...data,series}):null;
    return {code:subject.code,label:subject.label,series,total,plotSeries:shares?.series || series,percentageMissing:shares?.percentage_missing || 0};
  }).sort((a,b)=>(b.total ?? -1)-(a.total ?? -1)||a.label.localeCompare(b.label,'de'));
  let maximum=0;
  for(const card of cards) for(const side of sides) for(const point of card.series.find(s=>s.code===side.code).points) {
    if(Number.isFinite(point.value)&&point.value>=0) maximum=Math.max(maximum,point.value);
  }
  const magnitude=maximum ? 10**Math.floor(Math.log10(maximum)) : 1;
  return {cards,percentage,percentageMissing:cards.reduce((sum,c)=>sum+c.percentageMissing,0),maximum:percentage ? 100:maximum ? Math.ceil(maximum/magnitude)*magnitude:1,labels,sideCodes:sides.map(s=>s.code),
    unknown:other.some(s=>s.points.some(p=>p.value===null||p.value!==0)),periods:data.periods};
}

class SubjectGrid {
  constructor({api,catalog,onError,translate}) {
    this.api=api;this.catalog=catalog;this.onError=onError;this.translate=translate;
    this.active=false;this.needsLoad=true;this.sequence=0;
    this.node=id=>document.getElementById('subjects-'+id);
    for(const id of ['metric','split','qualification']) this.node(id).addEventListener('change',()=>this.load());
    for(const id of ['from','to']) {
      this.node(id).addEventListener('input',()=>this.rangeChanged(id));
      this.node(id).addEventListener('change',()=>this.rangeChanged(id,true));
    }
    this.node('percentage').addEventListener('change',()=>this.render());
    this.node('slider').addEventListener('pointerdown',event=>this.dragRange(event));
  }
  async show() {this.active=true;if(this.needsLoad) await this.load();else this.render();}
  hide() {this.active=false;if(this.loading)this.needsLoad=true;this.sequence++;this.controller?.abort();this.observer?.disconnect();clearTimeout(this.rangeTimer);}
  async reload() {this.active=true;this.needsLoad=true;await this.load();}
  async reset() {this.node('percentage').checked=false;this.node('metric').value='Bachelor entrants';this.node('split').value='Geschlecht';this.detail=null;this.qualification='Bachelor';await this.load();}
  async load() {
    const sequence=++this.sequence;this.controller?.abort();this.controller=new AbortController();
    this.loading=true;this.needsLoad=true;this.data=null;this.model=null;this.onError('');this.observer?.disconnect();
    clearTimeout(this.rangeTimer);this.node('grid').setAttribute('aria-busy','true');
    this.node('grid').replaceChildren(this.element('p','Loading subjects…','subjects-message'));
    const previousTime=this.detail?.metadata.variables.find(v=>v.time);
    const from=Number(this.node('from').value),to=Number(this.node('to').value);
    const range=previousTime ? {first:previousTime.valueTexts[from],last:previousTime.valueTexts[to],full:from===0&&to===previousTime.values.length-1}:null;
    const group=this.node('metric').value,split=this.node('split').value;
    const degree=group==='Degrees';this.node('qualification-field').hidden=!degree;
    const oldQualification=this.detail?.metadata.variables.find(v=>v.code==='Examensstufe');
    if(oldQualification) {
      const selected=this.node('qualification').value;
      this.qualification=selected==='__all__' ? null:oldQualification.valueTexts[oldQualification.values.indexOf(selected)];
    }
    this.node('qualification').disabled=true;
    for(const id of ['from','to'])this.node(id).disabled=true;
    try {
      const allowed=new Set(['Hochschule','Fachrichtung','Examensstufe',split]);
      const dataset=this.catalog().find(d=>d.group===group&&d.dimensions.includes('Fachrichtung')&&d.dimensions.includes(split)&&d.dimensions.every(code=>allowed.has(code)));
      if(!dataset)throw Error('No detailed-subject dataset is available for this selection.');
      const detail=await this.api('/api/dataset?id='+encodeURIComponent(dataset.id),this.controller.signal);
      if(sequence!==this.sequence||!this.active)return;
      this.detail=detail;
      const time=detail.metadata.variables.find(v=>v.time),level=detail.metadata.variables.find(v=>v.code==='Examensstufe');
      this.node('qualification').replaceChildren();
      if(level) {
        for(let i=0;i<level.values.length;i++)this.option(this.node('qualification'),level.values[i],level.valueTexts[i]==='Doktorat'?'Doktorat (Doctorate)':level.valueTexts[i]);
        this.option(this.node('qualification'),'__all__','All qualifications (derived sum)');
        const preferred=this.qualification===null ? '__all__':level.values[level.valueTexts.indexOf(this.qualification || 'Bachelor')];
        this.node('qualification').value=preferred || level.values[0];this.node('qualification').disabled=false;
      }
      const match=label=>time.valueTexts.findIndex(t=>t===label||t.slice(0,4)===label?.slice(0,4));
      const first=range&&!range.full ? Math.max(0,match(range.first)):0;
      const last=range&&!range.full ? match(range.last):-1;
      for(const id of ['from','to']){this.node(id).max=time.values.length-1;this.node(id).disabled=time.values.length===1;}
      this.node('from').value=first;this.node('to').value=last>=first ? last:time.values.length-1;this.renderRange();
      const filters={Fachrichtung:null,Hochschule:null};
      if(level)filters.Examensstufe=this.node('qualification').value==='__all__' ? null:this.node('qualification').value;
      this.filters=filters;this.measure=detail.columns.find(c=>c.type==='c').code;
      const comparison=detail.metadata.variables.find(v=>v.code===split);
      const request={dataset:detail.id,snapshot:detail.snapshot_id,compare:split,values:comparison.values,filters,measure:this.measure,breakdown:'Fachrichtung'};
      const data=await this.api('/api/series?query='+encodeURIComponent(JSON.stringify(request)),this.controller.signal);
      if(sequence!==this.sequence||!this.active)return;
      this.data=data;this.needsLoad=false;this.render();
    } catch(error) {
      if(error.name!=='AbortError'&&sequence===this.sequence&&this.active) {
        this.onError(error.message);this.node('grid').replaceChildren(this.element('p','Subjects could not be loaded. Change a selection or use Reset view.','subjects-message'));
      }
    } finally {
      if(sequence===this.sequence){this.loading=false;this.node('grid').setAttribute('aria-busy','false');}
    }
  }
  element(tag,text,className) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
  option(select,value,text) {const n=this.element('option',text);n.value=value;select.append(n);}
  number(value) {return value===null?'—':new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(value);}
  renderRange() {
    const time=this.detail.metadata.variables.find(v=>v.time),last=time.values.length-1;
    for(const id of ['from','to']){const text=time.valueTexts[Number(this.node(id).value)];this.node(id+'-label').textContent=text;this.node(id).setAttribute('aria-valuetext',text);}
    this.node('from').setAttribute('aria-valuemax',this.node('to').value);this.node('to').setAttribute('aria-valuemin',this.node('from').value);
    const first=last?Number(this.node('from').value)/last*100:0,end=last?Number(this.node('to').value)/last*100:100;
    this.node('range-fill').style.left=first+'%';this.node('range-fill').style.width=end-first+'%';
  }
  rangeChanged(id,immediate=false) {
    if(!this.detail||this.loading)return;
    if(id==='from')this.node(id).value=Math.min(Number(this.node(id).value),Number(this.node('to').value));
    else this.node(id).value=Math.max(Number(this.node(id).value),Number(this.node('from').value));
    this.renderRange();clearTimeout(this.rangeTimer);
    if(immediate)this.render();else this.rangeTimer=setTimeout(()=>this.render(),120);
  }
  dragRange(event) {
    if(!this.detail||this.node('from').disabled||event.button!==0)return;
    event.preventDefault();const slider=this.node('slider'),box=slider.getBoundingClientRect();
    const index=e=>Math.round(Math.max(0,Math.min(1,(e.clientX-box.left-9)/(box.width-18)))*Number(this.node('to').max));
    const first=Number(this.node('from').value);let overlapping=first===Number(this.node('to').value);
    let target=event.target.tagName==='INPUT'?event.target.id.replace('subjects-',''):Math.abs(index(event)-first)<Math.abs(index(event)-Number(this.node('to').value))?'from':'to';
    this.node(target).focus();slider.setPointerCapture(event.pointerId);
    const move=e=>{if(overlapping&&index(e)!==first){target=index(e)<first?'from':'to';overlapping=false;}this.node(target).value=index(e);this.rangeChanged(target);};
    const finish=e=>{move(e);this.rangeChanged(target,true);for(const name of ['pointerup','pointercancel'])slider.removeEventListener(name,finish);slider.removeEventListener('pointermove',move);};
    move(event);slider.addEventListener('pointermove',move);slider.addEventListener('pointerup',finish);slider.addEventListener('pointercancel',finish);
  }
  render() {
    if(!this.data||!this.active)return;
    const first=Number(this.node('from').value),last=Number(this.node('to').value);
    const selected={...this.data,periods:this.data.periods.slice(first,last+1),series:this.data.series.map(s=>({...s,points:s.points.slice(first,last+1)}))};
    const model=subjectGridModel(selected,this.node('percentage').checked);this.model=model;
    this.node('count').textContent=model.cards.length+' subjects · all universities · ranked by '+model.periods.at(-1)+' total';
    this.node('left-label').textContent=model.labels[0];this.node('right-label').textContent=model.labels[1];
    this.node('scale').textContent='Shared scale: 0–'+this.number(model.maximum)+(model.percentage?'%':'')+' per side';
    this.node('unknown').hidden=!model.unknown;
    this.observer?.disconnect();const root=this.node('grid');root.replaceChildren();
    if(typeof IntersectionObserver!=='undefined')this.observer=new IntersectionObserver(entries=>{if(!this.active)return;for(const entry of entries)if(entry.isIntersecting){entry.target.mountChart();this.observer.unobserve(entry.target);}},{rootMargin:'400px'});
    for(const card of model.cards) {
      const link=this.card(card,model);root.append(link);
      if(this.observer)this.observer.observe(link);else link.mountChart();
    }
  }
  card(card,model) {
    const link=this.element('a',undefined,'subject-card');link.dataset.subject=card.code;link.dataset.total=card.total ?? '';
    const universities=this.detail.metadata.variables.find(v=>v.code==='Hochschule').values;
    const selection={dataset:this.detail.id,compare:this.data.compare,universities,filters:{...this.filters,Fachrichtung:card.code},measure:this.measure,
      fromLabel:model.periods[0],toLabel:model.periods.at(-1),percentage:model.percentage,stacked:false,subjectStacked:false};
    link.href=SelectionURL.write(selection,this.detail);
    link.addEventListener('click',event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey)requestAnimationFrame(()=>{if(location.hash.startsWith('#pyramid?'))window.scrollTo({top:0,left:0,behavior:'instant'});});});
    const english=this.translate(card.label),full=card.label+(english?' ('+english+')':'');
    link.setAttribute('aria-label',full+'. '+model.periods.at(-1)+' total: '+this.number(card.total)+'. Open detailed pyramid.');
    const heading=this.element('div',undefined,'subject-card-heading'),title=this.element('div',undefined,'subject-card-title');
    const german=this.element('h2',card.label);german.title=full;title.append(german);
    if(english)title.append(this.element('p',english));
    const total=this.element('div',undefined,'subject-card-total');total.append(this.element('strong',this.number(card.total)),this.element('span',model.periods.at(-1)));
    heading.append(title,total);link.append(heading);
    const chart=this.element('div',undefined,'subject-mini-chart');link.append(chart);
    let mounted=false;
    link.mountChart=()=>{if(mounted)return;mounted=true;this.draw(chart,card,model,link);};
    link.addEventListener('focus',()=>{link.mountChart();link.inspectYear?.(model.periods.length-1);});
    link.addEventListener('keydown',event=>{
      if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();link.mountChart();const current=link.inspectedYear ?? model.periods.length-1;
        link.inspectYear(event.key==='Home'?0:event.key==='End'?model.periods.length-1:Math.max(0,Math.min(model.periods.length-1,current+(event.key==='ArrowDown'?1:-1))));}
      if(event.key==='Escape')link.hideTooltip?.();
    });
    return link;
  }
  draw(root,card,model,link) {
    const svg=(tag,attributes,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attributes))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
    const width=300,height=270,top=26,bottom=14,center=150,gap=23,half=115,row=(height-top-bottom)/model.periods.length;
    const chart=svg('svg',{viewBox:`0 0 ${width} ${height}`,'aria-hidden':'true'});
    for(const [i,code]of model.sideCodes.entries()) {
      const base=center+(i?gap:-gap),direction=i?1:-1;
      for(const fraction of [0,.5,1]){const x=base+direction*half*fraction;chart.append(svg('line',{x1:x,x2:x,y1:top,y2:height-bottom,class:'subject-grid-line'}));}
      chart.append(svg('text',{x:base+direction*half,y:12,'text-anchor':i?'end':'start',class:'subject-mini-axis'},this.number(model.maximum)+(model.percentage?'%':'')));
      const points=card.plotSeries.find(s=>s.code===code).points;
      for(let j=0;j<points.length;j++)if(Number.isFinite(points[j].value)&&points[j].value>0){const w=points[j].value/model.maximum*half;
        chart.append(svg('rect',{x:i?base:base-w,y:top+j*row+row*.08,width:w,height:row*.84,fill:i?'#db7853':'#365bd6','data-side':i?'right':'left','data-value':points[j].value,class:'subject-mini-bar'}));}
    }
    const stride=Math.max(1,Math.ceil(model.periods.length/5));
    for(let j=0;j<model.periods.length;j++)if(j===0||j===model.periods.length-1||j%stride===0&&model.periods.length-1-j>=stride)
      chart.append(svg('text',{x:center,y:top+(j+.5)*row,'text-anchor':'middle','dominant-baseline':'middle',class:'subject-mini-year'},model.periods[j]));
    root.append(chart);
    const tooltip=this.element('div',undefined,'subject-tooltip');tooltip.hidden=true;tooltip.setAttribute('role','tooltip');link.append(tooltip);
    link.inspectYear=index=>{
      link.inspectedYear=index;tooltip.replaceChildren(this.element('strong',model.periods[index]));
      for(const [i,code]of model.sideCodes.entries()){const line=this.element('div',undefined,'subject-tooltip-row');line.append(this.element('span',model.labels[i]),this.element('b',this.number(card.series.find(s=>s.code===code).points[index].value)));tooltip.append(line);}
      for(const s of card.series.filter(s=>!model.sideCodes.includes(s.code)))if(s.points[index].value!==0){const line=this.element('div',undefined,'subject-tooltip-row');line.append(this.element('span',s.label),this.element('b',this.number(s.points[index].value)));tooltip.append(line);}
      tooltip.hidden=false;tooltip.style.left='12px';tooltip.style.top=Math.max(headingHeight(),Math.min(link.clientHeight-tooltip.offsetHeight-12,root.offsetTop+(top+(index+.5)*row)/height*root.clientHeight+8))+'px';
    };
    const headingHeight=()=>root.offsetTop;
    link.hideTooltip=()=>{tooltip.hidden=true;};
    chart.addEventListener('pointermove',event=>{const box=chart.getBoundingClientRect();link.inspectYear(Math.max(0,Math.min(model.periods.length-1,Math.floor(((event.clientY-box.top)/box.height*height-top)/row))));});
    link.addEventListener('pointerleave',link.hideTooltip);link.addEventListener('blur',link.hideTooltip);
  }
}
