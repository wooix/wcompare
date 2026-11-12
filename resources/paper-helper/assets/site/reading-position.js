(function(){
  'use strict';
  let ctx, routing=true, routeNumber=0, saveTimer, activeRestore=null;
  const reader=()=>document.getElementById('reader');
  const readingLine=()=>Math.max(0,document.querySelector('.toolbar')?.getBoundingClientRect().bottom||0)+20;
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  function valid(saved){
    return saved&&ctx.book.chapters.some(c=>c.id===saved.chapter&&/^S\d+$/.test(c.id))&&
      Number.isFinite(saved.scroll)&&saved.scroll>=0&&(!saved.book||saved.book===ctx.book.version);
  }
  function currentSection(){
    let section=ctx.getChapter();
    for(const heading of reader().querySelectorAll('h3,h4,h5,h6')){
      if(heading.getBoundingClientRect().top<170&&heading.parentElement.id)section=heading.parentElement.id;
    }
    return section;
  }
  function capture(){
    clearTimeout(saveTimer);
    const chapter=ctx.getChapter();
    if(routing||activeRestore||!/^S\d+$/.test(chapter)||!reader()?.querySelector('[id="'+chapter+'"]'))return;
    const line=readingLine();let anchor=null;
    for(const node of reader().querySelectorAll('.reading-block')){
      if(!node.getClientRects().length)continue;
      const rect=node.getBoundingClientRect();
      if(rect.bottom>line){anchor={id:node.dataset.readId,offset:line-rect.top,height:rect.height};break;}
    }
    ctx.getState().last={book:ctx.book.version,chapter,section:currentSection(),scroll:scrollY,anchor,
      route:location.hash.slice(1),width:innerWidth,savedAt:Date.now()};
    ctx.save();
    const button=document.getElementById('resume');if(button)button.hidden=false;
  }
  function schedule(){clearTimeout(saveTimer);if(!routing&&!activeRestore)saveTimer=setTimeout(capture,120);}
  function beginRoute(){clearTimeout(saveTimer);routing=true;return ++routeNumber;}
  function endRoute(number){if(number===routeNumber){routing=false;schedule();}}
  function cancelRestore(){if(activeRestore)activeRestore.controller.abort();}
  function scrollToSaved(saved){
    let top=saved.scroll;
    if(saved.anchor&&typeof saved.anchor.id==='string'){
      const node=[...reader().querySelectorAll('.reading-block')].find(n=>n.dataset.readId===saved.anchor.id);
      if(node?.getClientRects().length&&Number.isFinite(saved.anchor.offset)){
        const rect=node.getBoundingClientRect();let offset=saved.anchor.offset;
        // Reflow can move the paragraph or change its height. Keep the same part in view.
        if(offset>0&&saved.anchor.height>0&&Math.abs(rect.height-saved.anchor.height)>2)offset=offset/saved.anchor.height*rect.height;
        top=scrollY+rect.top+offset-readingLine();
      }
    }
    window.scrollTo({top:Math.max(0,top),behavior:'instant'});
  }
  async function settleLayout(signal){
    const cleanups=[];
    // Load images above the reading point; images much later in the chapter stay lazy.
    const precedingImages=[...reader().querySelectorAll('img')].filter(img=>img.getBoundingClientRect().top<=innerHeight*2);
    for(const img of precedingImages)img.loading='eager';
    const images=precedingImages.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{
      img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});
      cleanups.push(()=>{img.removeEventListener('load',resolve);img.removeEventListener('error',resolve)});
    }));
    let timer,abort;
    try{
      await Promise.race([
        Promise.all([document.fonts?.ready,...images]),
        new Promise(resolve=>{timer=setTimeout(resolve,5000);abort=resolve;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)resolve();})
      ]);
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);cleanups.forEach(fn=>fn());}
  }
  async function restore(saved){
    if(!valid(saved))return false;
    cancelRestore();clearTimeout(saveTimer);
    saved=JSON.parse(JSON.stringify(saved));
    const job={controller:new AbortController()};activeRestore=job;
    document.body.dataset.positionState='restoring';
    let observer,completed=false;
    try{
      await ctx.navigate(saved.chapter);
      const expectedHash=location.hash;
      const canRestore=()=>activeRestore===job&&!job.controller.signal.aborted&&ctx.getChapter()===saved.chapter&&location.hash===expectedHash;
      const apply=()=>{if(canRestore())scrollToSaved(saved)};
      if(!canRestore())return false;
      apply();
      if(window.ResizeObserver){observer=new ResizeObserver(apply);observer.observe(reader());}
      await settleLayout(job.controller.signal);
      if(!canRestore())return false;
      await frame();apply();await frame();apply();
      completed=canRestore();
      return completed;
    }finally{
      observer?.disconnect();
      if(activeRestore===job){activeRestore=null;document.body.dataset.positionState='ready';capture();ctx.onPositionChanged();}
      if(completed)ctx.toast('마지막으로 읽던 위치를 열었습니다.');
    }
  }
  async function start(){
    const saved=ctx.getState().last;
    const hash=location.hash.slice(1);
    const navigation=performance.getEntriesByType('navigation')[0]?.type;
    const reloading=['reload','back_forward'].includes(navigation)&&valid(saved)&&
      (hash===saved.route||hash.match(/^(S\d+)(?:[.-]|$)/)?.[1]===saved.chapter);
    if(valid(saved)&&(!hash||hash===saved.chapter||reloading))await restore(saved);
    else await ctx.route();
    document.body.dataset.positionState='ready';
  }
  function init(options){
    ctx=options;
    if('scrollRestoration' in history)history.scrollRestoration='manual';
    window.addEventListener('pagehide',capture);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')capture();});
    window.addEventListener('resize',schedule,{passive:true});
    // A deliberate user action always wins over late image or font corrections.
    for(const name of ['wheel','touchstart','pointerdown'])window.addEventListener(name,()=>{cancelRestore();capture();},{capture:true,passive:true});
    document.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' ','Enter'].includes(event.key)){cancelRestore();capture();}},{capture:true});
  }
  window.ReadingPosition={init,start,restore:()=>restore(ctx.getState().last),schedule,capture,beginRoute,endRoute};
})();
