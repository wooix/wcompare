(function(){
  'use strict';
  const Core=window.ReadingCore;
  const $=s=>document.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const TERM_STORE='paper-reader-terminology-v1', NOTE_STORE='paper-reader-highlights-v1';
  let ctx,terms=[],aliases={},readingIndex={},excluded=new Set(),annotations=[],ready=false;
  let termQuery='',termTab='active',termLetter='',termPage=0,activePanel='',currentLocation='';
  let pendingSelection=null,selectionTimer=null,navManualUntil=0;
  const collapsed=new Set();
  const esc=s=>ctx.escape(String(s??''));
  function readStore(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
  function writeStore(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch{ctx.toast('브라우저에 저장할 수 없어 변경을 반영하지 못했습니다.');return false}}
  function ownNotes(){return annotations.filter(n=>n.book===ctx.book.version).sort((a,b)=>Core.compareAnnotations(a,b,readingIndex))}
  function canonical(key){return aliases[key]||key}
  function formatText(text){return Core.suppressTerms(text,excluded,aliases)}
  function blockText(root,forTerms=false){
    const nodes=[];let text='';const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;while((node=walker.nextNode())){
      if(node.parentElement.closest('math,svg,script,style,.original-inline,.original-card,[lang="en"],.highlight-action')||(!forTerms&&node.parentElement.closest('button')))continue;
      nodes.push({node,start:text.length,end:text.length+node.data.length});text+=node.data;
    }
    return {nodes,text};
  }
  function wrapTextSpan(map,start,end,className,key){
    for(const entry of [...map.nodes].reverse()){
      const a=Math.max(start,entry.start)-entry.start,b=Math.min(end,entry.end)-entry.start;
      if(a>=b)continue;
      let middle=entry.node;
      if(b<middle.length)middle.splitText(b);
      if(a>0)middle=middle.splitText(a);
      const span=document.createElement('span');span.className=className;span.dataset.termKey=key;
      middle.before(span);span.append(middle);span.hidden=excluded.has(canonical(key));
    }
  }
  function decorate(root){
    if(!ready||!root)return;
    const selectors='[data-read-id],[data-trid],p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,.toc-label,.chapter-subtitle,.context-item button';
    const blocks=$$(selectors,root);if(root.matches?.(selectors))blocks.unshift(root);
    for(const node of blocks){
      if(node.dataset.termsPrepared||node.closest('[data-no-terms],.original-inline,.original-card,[lang="en"],.term-gloss')||node.querySelector(selectors))continue;
      const map=blockText(node,true);
      for(const term of Core.findTerms(map.text).reverse())wrapTextSpan(map,term.hideStart,term.hideEnd,'term-gloss',canonical(term.key));
      node.dataset.termsPrepared='true';
    }
  }
  function applyTerms(){for(const node of $$('.term-gloss'))node.hidden=excluded.has(canonical(node.dataset.termKey));paintHighlights();}
  function locationInfo(id){
    const c=ctx.book.chapters.find(c=>c.id===id||id.startsWith(c.id+'.'));
    if(!c)return {chapter:id,title:id};
    return {chapter:c.id,title:c.toc.find(t=>t.id===id)?.title||`${c.id.startsWith('S')?c.id.slice(1)+'장 · ':''}${c.label}`};
  }
  function tocTree(chapter){
    const root={id:chapter.id,title:chapter.label,depth:-1,children:[],chapter:true};const stack=[root];
    for(const entry of chapter.toc){const node={...entry,children:[]};while(stack.length>1&&stack[stack.length-1].depth>=entry.depth)stack.pop();stack[stack.length-1].children.push(node);stack.push(node)}
    return root;
  }
  function treeNode(node){
    const isChapter=node.chapter;
    const state=ctx.getState();const done=isChapter&&state.read.includes(node.id);
    const number=isChapter?node.id.replace(/^S/,'').padStart(2,'0'):'';
    const label=`<a href="#${node.id}" class="tree-link ${isChapter?'tree-chapter':''}" data-section="${node.id}" ${isChapter?'data-chapter="'+node.id+'"':''}><span class="tree-number">${done?'✓':number}</span><span class="toc-label">${esc(node.title)}</span></a>`;
    return `<li>${node.children.length?`<details data-tree-id="${node.id}" ${collapsed.has(node.id)?'':'open'}><summary>${label}</summary><ul>${node.children.map(treeNode).join('')}</ul></details>`:`<div class="tree-leaf">${label}</div>`}</li>`;
  }
  function renderToc(){
    if(!ready)return false;
    const previousScroll=$('#toc').scrollTop;
    let output='<a class="toc-link toc-start" href="#start" data-section="start"><span class="num">↗</span><span>이 자료를 읽는 방법</span></a>';
    for(const [i,g] of ctx.book.groups.entries()){
      output+=`<div class="toc-group"><span>0${i+1}</span>${esc(g.title)}</div><ul class="toc-tree">${g.chapters.map(id=>treeNode(tocTree(ctx.book.chapters.find(c=>c.id===id)))).join('')}</ul>`;
    }
    output+='<div class="toc-group">읽는 자리의 참고 자료</div><ul class="toc-tree supplement-tree">'+ctx.book.chapters.filter(c=>/^A\d+$/.test(c.id)).map(c=>treeNode(tocTree(c))).join('')+'</ul>';
    output+='<a class="toc-link" href="#terminology">Terminology (용어집)</a><a class="toc-link" href="#highlights">Highlights (하이라이트) <span data-highlight-count></span></a><a class="toc-link" href="#glossary">개념 풀이 노트</a><a class="toc-link" href="#map">전체 연구 지도</a><a class="toc-link" href="#about">자료 정보 · 참고문헌</a>';
    $('#toc').innerHTML=output;$('#toc').scrollTop=previousScroll;
    for(const details of $$('details[data-tree-id]',$('#toc')))details.addEventListener('toggle',()=>{if(details.open)collapsed.delete(details.dataset.treeId);else collapsed.add(details.dataset.treeId)});
    const state = ctx.getState();
    const mainIds = ctx.book.chapters.filter(item => item.kind === 'main').map(item => item.id);
    const completed = state.read.filter(id => mainIds.includes(id)).length;
    $('#read-count').textContent = `읽은 장 ${completed} / ${mainIds.length}`;
    $('#book-progress').style.width = `${completed / mainIds.length * 100}%`;
    $('#resume').hidden = !state.last;
    decorate($('#toc'));setCurrent(currentLocation||ctx.getChapter(),false);updateCounts();return true;
  }
  function setCurrent(id,autoScroll=true){
    if(!ready)return;
    currentLocation=id;
    let active;
    for(const link of $$('#toc [data-section]')){
      const matches=link.dataset.section===id;link.classList.toggle('active',matches);if(link.classList.contains('toc-start'))link.classList.toggle('current',matches);
      const inChapter=link.dataset.chapter===ctx.getChapter();link.classList.toggle('current-chapter',inChapter);
      if(matches){link.setAttribute('aria-current','location');active=link}else link.removeAttribute('aria-current');
    }
    const label=id==='start'?'읽기 안내':formatText(locationInfo(id).title);
    $('#current-location-label').textContent=label;$('#current-location-label').title=label;
    if(active){let parent=active.parentElement;while(parent&&parent!==$('#toc')){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
      if(autoScroll&&Date.now()>navManualUntil)keepNavVisible(active);
    }
  }
  function keepNavVisible(link){const nav=$('#toc'),a=link.getBoundingClientRect(),b=nav.getBoundingClientRect();if(a.top<b.top+12||a.bottom>b.bottom-12)nav.scrollTop+=a.top-b.top-nav.clientHeight*.35;}
  function updateCounts(){for(const node of $$('[data-highlight-count]'))node.textContent=ownNotes().length||'0';}
  function panelShell(id,title,label,markup){
    activePanel=id;$('#side-panel').dataset.toolsPanel=id;
    $('#panel-title').textContent=title;$('#panel-label').textContent=label;$('#panel-content').innerHTML=markup;
    ctx.showPanel();
  }
  function termPanel(){
    panelShell('terminology','Terminology (용어집)','자료 전체에 공통으로 적용',`<div data-no-terms><p class="panel-help">영어와 한글이 함께 표기된 용어를 알파벳순으로 모았습니다. <strong>제거</strong>하면 이 용어는 모든 본문·목차·보충 설명에서 영어로만 표시됩니다. 제거한 항목은 다시 추가할 수 있습니다.</p><div class="tool-controls"><label for="term-search">용어 찾기</label><input id="term-search" type="search" placeholder="영어 또는 한국어로 검색" value="${esc(termQuery)}"><div class="term-tabs" role="group" aria-label="용어 목록"><button data-term-tab="active">사용 중 <span id="term-active-count"></span></button><button data-term-tab="removed">제거함 <span id="term-removed-count"></span></button></div><div class="alphabet-filter" aria-label="알파벳 필터"><button data-term-letter="">전체</button>${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l=>`<button data-term-letter="${l}">${l}</button>`).join('')}</div></div><p id="term-list-status" class="list-status" role="status"></p><div id="term-list"></div><div id="term-pagination" class="term-pagination"></div></div>`);
    $('#term-search').addEventListener('input',e=>{termQuery=e.target.value;termPage=0;renderTerms()});renderTerms();
  }
  function renderTerms(){
    if(activePanel!=='terminology'||!$('#term-list'))return;
    const q=termQuery.trim().toLocaleLowerCase();
    const active=terms.filter(t=>!excluded.has(t.key)).length;
    $('#term-active-count').textContent=active;$('#term-removed-count').textContent=terms.length-active;
    for(const b of $$('[data-term-tab]'))b.setAttribute('aria-pressed',b.dataset.termTab===termTab);
    for(const b of $$('[data-term-letter]'))b.setAttribute('aria-pressed',b.dataset.termLetter===termLetter);
    const filtered=terms.filter(t=>(termTab==='removed')===excluded.has(t.key)&&(!termLetter||t.english[0].toUpperCase()===termLetter)&&(!q||[t.english,...t.koreans,...t.aliases.map(a=>a.english)].join(' ').toLocaleLowerCase().includes(q)));
    const size=80,pages=Math.max(1,Math.ceil(filtered.length/size));termPage=Math.min(termPage,pages-1);
    $('#term-list-status').textContent=`${filtered.length.toLocaleString()}개 · 알파벳순${pages>1?' · '+(termPage+1)+' / '+pages+'쪽':''}`;
    $('#term-list').innerHTML=filtered.slice(termPage*size,(termPage+1)*size).map(t=>`<div class="term-row" data-term-row="${esc(t.key)}"><div><p class="term-name"><strong>${esc(t.english)}</strong> <span>(${esc(t.koreans.join(' / '))})</span></p>${t.aliases.length?`<p class="term-alias">함께 적용: ${esc(t.aliases.map(a=>a.english).join(', '))}</p>`:''}<p class="term-occurrences">${t.count.toLocaleString()}회 병기${t.locations[0]?` · <button data-term-location="${esc(t.locations[0].id)}">본문에서 보기 ↗</button>`:''}</p></div><button class="term-toggle" data-term-toggle="${esc(t.key)}">${excluded.has(t.key)?'다시 추가':'제거'}</button></div>`).join('')||'<p class="empty-list">해당하는 용어가 없습니다.</p>';
    $('#term-pagination').innerHTML=pages>1?`<button data-term-page="-1" ${termPage===0?'disabled':''}>← 이전</button><span>${termPage+1} / ${pages}</span><button data-term-page="1" ${termPage===pages-1?'disabled':''}>다음 →</button>`:'';
  }
  function toggleTerm(key){
    const next=new Set(excluded);next.has(key)?next.delete(key):next.add(key);
    if(!writeStore(TERM_STORE,{excluded:[...next]}))return;
    excluded=next;applyTerms();renderTerms();
    const term=terms.find(t=>t.key===key);ctx.toast(excluded.has(key)?`${term?.english||key}: 영어로만 표시합니다.`:`${term?.english||key}: 한글 병기를 다시 표시합니다.`);
    if(activePanel==='highlights')highlightPanel();setCurrent(currentLocation,false);
  }
  function prepareBlocks(root){
    for(const node of $$('[data-read-id],[data-trid]',root)){
      if(!node.dataset.readId)node.dataset.readId=node.dataset.trid;
      if(node.querySelector('[data-read-id],[data-trid]'))continue;
      if(readingIndex[node.dataset.readId])node.classList.add('reading-block');
    }
  }
  async function enhance(root){if(!ready)return;prepareBlocks(root);decorate(root);paintHighlights();}
  function getBlock(id){return $$('.reading-block').find(e=>e.dataset.readId===id&&!e.closest('.original-inline,.original-card'));}
  function point(map,offset,forEnd=false){
    for(const e of map.nodes)if(offset>=e.start&&(offset<e.end||(forEnd&&offset===e.end)))return {node:e.node,offset:offset-e.start};
    const last=map.nodes[map.nodes.length-1];return last?{node:last.node,offset:last.node.length}:null;
  }
  function rangeFor(map,start,end){const a=point(map,start),b=point(map,end,true);if(!a||!b)return null;const range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);return range;}
  const mathTags=new Set('math semantics mi mn mo mtext mspace ms mrow mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mlabeledtr mtr mtd maligngroup malignmark'.split(' '));
  const mathAttrs=new Set('display alttext mathvariant stretchy fence separator accent accentunder lspace rspace notation linethickness columnalign rowalign columnspacing rowspacing columnspan rowspan scriptlevel displaystyle width height depth voffset'.split(' '));
  // Store only inert inline content so an excerpt keeps its equations and emphasis.
  function excerptHTML(node){
    if(node.nodeType===Node.TEXT_NODE)return esc(node.data);
    if(node.nodeType!==Node.ELEMENT_NODE&&node.nodeType!==Node.DOCUMENT_FRAGMENT_NODE)return '';
    if(node.nodeType===Node.ELEMENT_NODE&&node.matches('button,script,style,svg,iframe,object,annotation,annotation-xml,.original-inline,.original-card,[lang="en"]'))return '';
    const children=[...node.childNodes].map(excerptHTML).join('');
    if(node.nodeType!==Node.ELEMENT_NODE)return children;
    const tag=node.localName.toLowerCase();
    if(mathTags.has(tag)){const attrs=[...node.attributes].filter(a=>mathAttrs.has(a.name)).map(a=>' '+a.name+'="'+esc(a.value)+'"').join('');return '<'+tag+attrs+'>'+children+'</'+tag+'>'}
    if(['em','strong','i','b','sub','sup'].includes(tag))return '<'+tag+'>'+children+'</'+tag+'>';
    if(tag==='br')return '<br>';
    return children;
  }
  function renderExcerpt(segment){if(!segment.excerpt)return esc(segment.quote);const template=document.createElement('template');template.innerHTML=segment.excerpt;return excerptHTML(template.content);}
  function resolveSegment(segment,map){
    if(map.text.slice(segment.start,segment.end)===segment.quote)return {start:segment.start,end:segment.end};
    const first=map.text.indexOf(segment.quote);if(first>=0&&map.text.indexOf(segment.quote,first+1)<0)return {start:first,end:first+segment.quote.length};
    return null;
  }
  function clearFallback(){for(const mark of $$('.user-highlight')){const parent=mark.parentNode;mark.replaceWith(...mark.childNodes);parent.normalize()}}
  function paintHighlights(){
    if(!ready)return;
    clearFallback();const ranges=[],fallback=[];
    for(const note of ownNotes())for(const segment of note.segments){const node=getBlock(segment.block);if(!node)continue;const map=blockText(node),position=resolveSegment(segment,map);if(!position)continue;const range=rangeFor(map,position.start,position.end);if(range)ranges.push(range);fallback.push({map,...position})}
    if(window.CSS?.highlights&&window.Highlight){CSS.highlights.set('paper-saved',new Highlight(...ranges));}
    else{
      const byNode=new Map();for(const item of fallback)for(const e of item.map.nodes){const start=Math.max(item.start,e.start)-e.start,end=Math.min(item.end,e.end)-e.start;if(start<end){if(!byNode.has(e.node))byNode.set(e.node,[]);byNode.get(e.node).push({start,end})}}
      for(const [node,spans] of byNode){spans.sort((a,b)=>a.start-b.start);const merged=[];for(const span of spans){const last=merged[merged.length-1];if(last&&span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span})}for(const span of merged.reverse()){let selected=node;if(span.end<selected.length)selected.splitText(span.end);if(span.start)selected=selected.splitText(span.start);const mark=document.createElement('mark');mark.className='user-highlight';selected.before(mark);mark.append(selected)}}
    }
    updateCounts();
  }
  function selectionSegments(range,root){
    const segments=[];
    for(const node of $$('.reading-block',root)){
      if(node.querySelector('.reading-block')||!node.getClientRects().length||!range.intersectsNode(node))continue;
      const map=blockText(node);let start=Infinity,end=-1;
      for(const entry of map.nodes){
        if(!range.intersectsNode(entry.node))continue;
        const a=range.startContainer===entry.node?range.startOffset:0;
        const b=range.endContainer===entry.node?range.endOffset:entry.node.length;
        if(a>=b)continue;start=Math.min(start,entry.start+a);end=Math.max(end,entry.start+b);
      }
      if(end<=start)continue;
      const quote=map.text.slice(start,end);if(!quote.trim())continue;
      const excerpt=excerptHTML(rangeFor(map,start,end).cloneContents());
      segments.push({block:node.dataset.readId,start,end,quote,excerpt});
    }
    return segments;
  }
  function clearSelection(){pendingSelection=null;$('#selection-tools').hidden=true;}
  function captureSelection(){
    if(!ready)return;
    const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed){if(!$('#selection-tools').contains(document.activeElement))clearSelection();return;}
    const range=selection.getRangeAt(0);const start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
    const root=start.closest('#reader,#panel-content');if(!root||!root.contains(range.endContainer)){clearSelection();return;}
    const segments=selectionSegments(range,root);if(!segments.length){clearSelection();return;}
    pendingSelection={segments};
    const tools=$('#selection-tools');const host=root.closest('dialog')||document.body;if(tools.parentElement!==host)host.append(tools);
    tools.hidden=false;const rect=range.getBoundingClientRect();
    tools.style.left=Math.max(8,Math.min(innerWidth-tools.offsetWidth-8,rect.left))+'px';
    tools.style.top=Math.max(8,Math.min(innerHeight-tools.offsetHeight-8,rect.top-tools.offsetHeight-8<8?rect.bottom+8:rect.top-tools.offsetHeight-8))+'px';
  }
  function addHighlight(){
    if(!pendingSelection)return;
    const segments=pendingSelection.segments;
    if(ownNotes().some(n=>n.segments.length===segments.length&&n.segments.every((s,i)=>s.block===segments[i].block&&s.start===segments[i].start&&s.end===segments[i].end))){ctx.toast('이미 저장된 하이라이트입니다.');clearSelection();return;}
    const note={id:crypto.randomUUID?crypto.randomUUID():'h-'+Date.now()+'-'+Math.random().toString(36).slice(2),book:ctx.book.version,createdAt:new Date().toISOString(),segments};
    const next=[...annotations,note];if(!writeStore(NOTE_STORE,next))return;annotations=next;
    window.getSelection()?.removeAllRanges();clearSelection();paintHighlights();ctx.toast('하이라이트를 저장했습니다. 목차 순서로 모아볼 수 있습니다.');
  }
  function removeHighlight(id){const next=annotations.filter(n=>n.id!==id);if(!writeStore(NOTE_STORE,next))return;annotations=next;paintHighlights();highlightPanel();ctx.toast('하이라이트를 제거했습니다.');}
  function highlightPanel(){
    const notes=ownNotes();let content='<div><p class="panel-help">중요한 문장을 선택한 뒤 <strong>하이라이트</strong>를 누르세요. 저장한 문장은 논문의 장·절·본문 순서로 모입니다.</p>';
    if(!notes.length)content+='<div class="empty-highlights"><span aria-hidden="true">▱</span><h3>아직 저장한 문장이 없습니다.</h3><p>읽다가 다시 보고 싶은 문장에 표시해 보세요.</p></div>';
    let previousSection='';
    for(const note of notes){const info=readingIndex[note.segments[0].block];const section=info?.section||info?.chapter||'';
      if(section!==previousSection){content+=`<h3 class="highlight-section">${esc(formatText(locationInfo(section).title))}</h3>`;previousSection=section;}
      const sourceLabel=info?.kind==='ai'?'AI 보조 설명':'원문 번역';
      content+=`<article class="highlight-card" data-highlight-id="${esc(note.id)}"><span class="highlight-source">${sourceLabel}</span><blockquote>${note.segments.map(renderExcerpt).join('<br><br>')}</blockquote><div class="highlight-card-actions"><button data-highlight-goto="${esc(note.id)}">본문 위치로 ↗</button><button data-highlight-remove="${esc(note.id)}" aria-label="하이라이트 제거">제거</button></div></article>`;
    }
    content+='</div>';panelShell('highlights',`Highlights (하이라이트) · ${notes.length}`,'목차 순서로 모은 나의 문장',content);
  }
  async function jumpToBlock(id,segment){
    const info=readingIndex[id];if(!info)return;
    ctx.closePanel();await ctx.goto(info.chapter.startsWith('A')?info.section:(id.startsWith('guide-')||id.startsWith('recap-')?info.section:id));
    const node=getBlock(id);if(node){node.scrollIntoView({block:'center',behavior:'instant'});node.classList.add('highlight-arrival');setTimeout(()=>node.classList.remove('highlight-arrival'),2200);node.setAttribute('tabindex','-1');node.focus({preventScroll:true});}
    if(info.chapter.startsWith('A'))setCurrent(info.section,false);paintHighlights();
  }
  function libraryPanel() {
    const entries = [
      {id: 'terminology', label: 'Terminology (용어집)', description: '알파벳순 용어 · 한글 병기 조절'},
      {id: 'highlights', label: 'Highlights (하이라이트)', description: `목차 순서로 모은 나의 문장 · ${ownNotes().length}개`},
      ...ctx.book.resources,
      {id: 'map', label: '전체 연구 지도', description: '논문의 주제와 연결'},
      {id: 'about', label: '자료 정보 · 번역 범위', description: '출처와 참고문헌'}
    ];
    const markup = entries.map(entry => `<button data-panel="${esc(entry.id)}"><strong>${esc(entry.label)}</strong><span>${esc(entry.description)}</span></button>`).join('');
    panelShell('library', '곁에 두는 자료', '읽던 자리에서 펼치는 자료', `<div class="library-list">${markup}</div>`);
  }
  function ownsPanel(id){return ['terminology','highlights','library'].includes(id)}
  async function openPanel(id){clearSelection();if(id==='terminology')termPanel();else if(id==='highlights')highlightPanel();else if(id==='library')libraryPanel();}
  function onPanelChange(id){activePanel=id;$('#side-panel').dataset.toolsPanel=id;clearSelection();}
  function events(){
    document.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.matches('[data-term-toggle]'))toggleTerm(button.dataset.termToggle);
      else if(button.matches('[data-term-tab]')){termTab=button.dataset.termTab;termPage=0;renderTerms()}
      else if(button.matches('[data-term-letter]')){termLetter=button.dataset.termLetter;termPage=0;renderTerms()}
      else if(button.matches('[data-term-page]')){termPage+=Number(button.dataset.termPage);renderTerms();$('#term-list-status').scrollIntoView({block:'start'})}
      else if(button.matches('[data-term-location]'))await jumpToBlock(button.dataset.termLocation);
      else if(button.matches('[data-highlight-goto]')){const note=ownNotes().find(n=>n.id===button.dataset.highlightGoto);if(note)await jumpToBlock(note.segments[0].block,note.segments[0])}
      else if(button.matches('[data-highlight-remove]'))removeHighlight(button.dataset.highlightRemove);
      else if(button.id==='save-highlight')addHighlight();
      else if(button.id==='dismiss-selection')clearSelection();
      else if(button.id==='toc-expand'){collapsed.clear();for(const d of $$('#toc details'))d.open=true;}
      else if(button.id==='toc-collapse'){for(const d of $$('#toc details')){d.open=false;collapsed.add(d.dataset.treeId)}}
      else if(button.id==='toc-locate'){setCurrent(currentLocation,false);const active=$('#toc .tree-link.active');if(active)keepNavVisible(active);}
    });
    $('#selection-tools').addEventListener('pointerdown',e=>e.preventDefault());
    document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(captureSelection,140)});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')clearSelection();if(e.altKey&&e.shiftKey&&e.key.toLowerCase()==='h'){captureSelection();addHighlight();e.preventDefault()}});
    window.addEventListener('scroll',()=>{if(pendingSelection)clearSelection()},{passive:true});
    $('#toc').addEventListener('wheel',()=>navManualUntil=Date.now()+2000,{passive:true});
    $('#toc').addEventListener('touchmove',()=>navManualUntil=Date.now()+2000,{passive:true});
    window.addEventListener('storage',event=>{if(event.key===TERM_STORE){excluded=new Set(readStore(TERM_STORE,{excluded:[]}).excluded||[]);applyTerms();renderTerms()}if(event.key===NOTE_STORE){annotations=readStore(NOTE_STORE,[]);paintHighlights();if(activePanel==='highlights'&&$('#side-panel').open)highlightPanel()}});
  }
  async function init(options){
    ctx=options;const [catalog,index]=await Promise.all([ctx.data('terminology.json'),ctx.data('reading-index.json')]);terms=catalog;readingIndex=index;
    const supplemental=Core.collectTerms((ctx.extraTerms||[]).map(text=>({text})));
    for(const term of supplemental)if(!terms.some(t=>t.key===term.key||t.aliases.some(a=>a.key===term.key)))terms.push(term);
    terms.sort((a,b)=>a.english.localeCompare(b.english,'en',{sensitivity:'base',numeric:true}));
    aliases=Object.fromEntries(terms.flatMap(t=>t.aliases.map(a=>[a.key,t.key])));
    excluded=new Set((readStore(TERM_STORE,{excluded:[]}).excluded||[]).map(canonical));
    const saved=readStore(NOTE_STORE,[]);annotations=Array.isArray(saved)?saved.filter(n=>n&&typeof n.id==='string'&&Array.isArray(n.segments)&&n.segments.length&&n.segments.every(s=>typeof s.block==='string'&&typeof s.quote==='string'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start)):[];
    ready=true;events();updateCounts();decorate($('.margin-notes'));
  }
  window.ReadingTools={init,enhance,decorate,renderToc,setCurrent,ownsPanel,openPanel,onPanelChange,clearSelection,formatText};
})();
