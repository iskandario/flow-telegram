// Two decoded decks, sample-clock playback, equal-power crossfader and per-deck EQ.
export class DjDeck {
  constructor(ctx, output) {
    this.ctx=ctx; this.rate=1; this.offset=0; this.cue=0; this.bpm=0; this.source=null; this.loop=null
    this.low=ctx.createBiquadFilter();this.low.type='lowshelf';this.low.frequency.value=220
    this.mid=ctx.createBiquadFilter();this.mid.type='peaking';this.mid.frequency.value=1200;this.mid.Q.value=.7
    this.high=ctx.createBiquadFilter();this.high.type='highshelf';this.high.frequency.value=5000
    this.gain=ctx.createGain();this.low.connect(this.mid).connect(this.high).connect(this.gain).connect(output)
  }
  position(){let p=this.offset+(this.source?(this.ctx.currentTime-this.started)*this.rate:0);if(this.loop&&p>=this.loop.end)p=this.loop.start+(p-this.loop.start)%(this.loop.end-this.loop.start);return Math.min(this.buffer?.duration||0,p)}
  pause(){this.offset=this.position();const s=this.source;this.source=null;if(s){s.onended=null;try{s.stop()}catch{}s.disconnect()}}
  setTrack(buffer,bpm){this.pause();this.buffer=buffer;this.bpm=bpm||0;this.offset=0;this.cue=0;this.loop=null;this.rate=1}
  play(){if(!this.buffer||this.source)return;if(this.offset>=this.buffer.duration)this.offset=0;const s=this.ctx.createBufferSource();s.buffer=this.buffer;s.playbackRate.value=this.rate;s.connect(this.low);if(this.loop){s.loop=true;s.loopStart=this.loop.start;s.loopEnd=this.loop.end}s.onended=()=>{if(this.source===s){this.source=null;this.offset=this.buffer.duration;s.disconnect()}};this.started=this.ctx.currentTime;this.source=s;s.start(this.started,this.offset)}
  seek(p){const playing=!!this.source;this.pause();this.offset=Math.max(0,Math.min(this.buffer?.duration||0,p));if(playing)this.play()}
  tempo(rate){this.offset=this.position();this.started=this.ctx.currentTime;this.rate=Math.max(.84,Math.min(1.16,rate));this.source?.playbackRate.setValueAtTime(this.rate,this.ctx.currentTime)}
  setLoop(beats){if(this.loop){this.offset=this.position();this.started=this.ctx.currentTime;this.loop=null;if(this.source)this.source.loop=false;return}if(!this.buffer||!this.bpm)throw Error('Для петли нужен BPM');const start=this.position(),end=start+beats*60/this.bpm;if(end>this.buffer.duration)throw Error('Для петли недостаточно времени до конца трека');this.loop={start,end};if(this.source){this.source.loopStart=start;this.source.loopEnd=end;this.source.loop=true}}
}
export function mountDj({root,context,load,tracks,beforePlay,message}){
  root.innerHTML='<div class="page-heading"><p class="eyebrow">РУЧНОЕ СВЕДЕНИЕ</p><h1>DJ-пульт.</h1><p>Две деки. Твой переход.</p></div><div class="dj-decks"></div><div class="dj-crossfade"><label class="range-label" for="djCrossfade">A · Кроссфейдер · B</label><input id="djCrossfade" type="range" min="0" max="1" step="0.01" value="0.5"></div><p class="dim">Sync BPM выравнивает темп. Совмещение ударов — вручную; темп меняется вместе с высотой тона. В памяти только треки двух дек.</p>'
  let ctx, decks, limiter, crossfade=.5, generation=0
  const ensure=()=>{if(decks)return;ctx=context();limiter=ctx.createDynamicsCompressor();limiter.threshold.value=-3;limiter.ratio.value=12;limiter.connect(ctx.destination);decks=[new DjDeck(ctx,limiter),new DjDeck(ctx,limiter)];fade()}
  function fade(){if(!decks)return;decks[0].gain.gain.setTargetAtTime(Math.cos(crossfade*Math.PI/2),ctx.currentTime,.01);decks[1].gain.gain.setTargetAtTime(Math.sin(crossfade*Math.PI/2),ctx.currentTime,.01)}
  const cards=['A','B'].map((label,index)=>{
    const card=document.createElement('section');card.className='dj-deck';card.dataset.deck=label
    card.innerHTML=`<h2>Дека ${label}</h2><select aria-label="Трек деки ${label}"></select><button class="ghost" data-load>Загрузить в ${label}</button><p data-title>Трек не выбран</p><output data-time>0:00</output><input data-seek type="range" min="0" max="1" step="0.01" value="0" aria-label="Позиция деки ${label}"><div class="row"><button class="play" data-play>▶</button><button class="ghost" data-cue>CUE</button><button class="ghost" data-setcue>SET CUE</button></div><label>BPM <input data-bpm type="number" min="40" max="240" step="0.1" aria-label="BPM деки ${label}"></label><label>Темп <output data-rate>0%</output><input data-rate-slider type="range" min="-16" max="16" step="0.1" value="0" aria-label="Темп деки ${label}"></label><div class="row"><button class="ghost" data-sync>Sync BPM</button><button class="ghost" data-loop aria-pressed="false">Loop 4</button></div><div class="row"><button class="ghost" data-nudge="-0.02" aria-label="Сдвинуть деку ${label} назад на 20 мс">−20 мс</button><button class="ghost" data-nudge="0.02" aria-label="Сдвинуть деку ${label} вперёд на 20 мс">+20 мс</button></div><div class="dj-eq">${['low','mid','high'].map((band,i)=>`<label>${['Низ','Середина','Верх'][i]}<input data-eq="${band}" type="range" min="-24" max="6" step="1" value="0" aria-label="${band} деки ${label}"></label>`).join('')}</div>`
    root.querySelector('.dj-decks').append(card)
    const q=s=>card.querySelector(s);let loading=false
    function controls(){for(const b of card.querySelectorAll('button,input'))b.disabled=loading||(!decks?.[index].buffer&&!b.matches('[data-load]'));q('[data-load]').disabled=loading||!q('select').value}
    q('[data-load]').onclick=async()=>{const track=tracks().find(t=>t.id===q('select').value);if(!track||loading)return;beforePlay();ensure();decks[index].pause();decks[index].buffer=null;loading=true;controls();q('[data-title]').textContent='Подготавливаю трек…';try{const request=generation;const data=await load(track);if(request!==generation){q('[data-title]').textContent='Трек не выбран';return}decks[index].setTrack(data.buffer,data.grid.bpm);q('[data-title]').textContent=track.artist+' — '+track.title;q('[data-bpm]').value=data.grid.bpm?Math.round(data.grid.bpm*10)/10:'';q('[data-rate-slider]').value=0;q('[data-rate]').textContent='0%';q('[data-loop]').setAttribute('aria-pressed','false')}catch(e){q('[data-title]').textContent='Не удалось загрузить';message(e.message)}finally{loading=false;controls()}}
    q('[data-play]').onclick=async()=>{ensure();try{if(decks[index].source)decks[index].pause();else{beforePlay();await ctx.resume();decks[index].play()}}catch(e){message(e.message)}}
    q('[data-cue]').onclick=()=>{decks[index].pause();decks[index].seek(decks[index].cue)}
    q('[data-setcue]').onclick=()=>{decks[index].cue=decks[index].position();message(`Cue ${label}: ${decks[index].cue.toFixed(1)} с`)}
    q('[data-seek]').oninput=()=>decks[index].seek(Number(q('[data-seek]').value)*decks[index].buffer.duration)
    q('[data-bpm]').onchange=()=>{const n=Number(q('[data-bpm]').value);decks[index].bpm=n>=40&&n<=240?n:0}
    function tempo(n){decks[index].tempo(1+n/100);q('[data-rate-slider]').value=n;q('[data-rate]').textContent=(n>0?'+':'')+n.toFixed(1)+'%'}
    q('[data-rate-slider]').oninput=()=>tempo(Number(q('[data-rate-slider]').value))
    q('[data-sync]').onclick=()=>{const a=decks[index],b=decks[1-index];if(!a.bpm||!b.bpm){message('Укажи BPM обеих дек');return}const n=(b.bpm*b.rate/a.bpm-1)*100;if(Math.abs(n)>16){message('Разница темпа больше диапазона ±16%');return}tempo(n)}
    q('[data-loop]').onclick=()=>{try{decks[index].setLoop(4);q('[data-loop]').setAttribute('aria-pressed',String(!!decks[index].loop))}catch(e){message(e.message)}}
    for(const el of card.querySelectorAll('[data-nudge]'))el.onclick=()=>decks[index].seek(decks[index].position()+Number(el.dataset.nudge))
    for(const el of card.querySelectorAll('[data-eq]'))el.oninput=()=>decks[index][el.dataset.eq].gain.setTargetAtTime(Number(el.value),ctx.currentTime,.01)
    card.refreshControls=controls;controls();return card
  })
  root.querySelector('#djCrossfade').oninput=e=>{crossfade=Number(e.target.value);fade()}
  let catalog=''
  function refresh(){const all=tracks(),key=all.map(t=>t.id+'|'+t.title).join('\n');if(key===catalog)return;catalog=key;for(const card of cards){const select=card.querySelector('select'),value=select.value;select.replaceChildren(...all.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.artist+' — '+t.title;return o}));if(all.some(t=>t.id===value))select.value=value;card.refreshControls()}}
  const timer=setInterval(()=>{if(root.hidden||document.hidden||!decks)return;cards.forEach((c,i)=>{const d=decks[i],p=d.position();c.querySelector('[data-time]').textContent=Math.floor(p/60)+':'+String(Math.floor(p%60)).padStart(2,'0');c.querySelector('[data-play]').textContent=d.source?'Ⅱ':'▶';if(document.activeElement!==c.querySelector('[data-seek]'))c.querySelector('[data-seek]').value=d.buffer?p/d.buffer.duration:0})},100)
  return{refresh,stop(release=false){if(release)generation++;decks?.forEach(d=>{d.pause();if(release){d.buffer=null;d.loop=null;d.offset=0}});if(release)for(const card of cards){card.querySelector('[data-title]').textContent='Трек не выбран';card.refreshControls()}},dispose(){clearInterval(timer);decks?.forEach(d=>{d.pause();d.buffer=null})}}
}
