(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ReadingCore=api})(globalThis,function(){
  'use strict';
  const keyOf=text=>text.normalize('NFKC').replace(/[‐‑–—]/g,'-').replace(/\s+/g,' ').trim().toLowerCase();
  function findTerms(text){
    const found=[];
    const pattern=/([A-Za-z][A-Za-z0-9'’/‐‑–—-]*(?:[ \t]+[A-Za-z][A-Za-z0-9'’/‐‑–—-]*)*)[ \t]*\(/g;
    let match;
    while((match=pattern.exec(text))){
      const open=pattern.lastIndex-1;let end=open+1,depth=1;
      for(;end<text.length&&depth;end++){if(text[end]==='(')depth++;else if(text[end]===')')depth--;}
      if(depth)continue;
      const inner=text.slice(open+1,end-1);
      if(!/[가-힣]/.test(inner)||inner.includes('\n')||inner.length>250)continue;
      const english=match[1].trim();
      // Keep figures, references, acronym expansions and explanatory qualifiers.
      const divider=inner.search(/[;:]|,(?=\s*(?:[A-Z][A-Z0-9-]{1,}\b|그림|표\s*\d|부록|⟦|\d))/);
      const korean=(divider<0?inner:inner.slice(0,divider)).trim();
      if(!/[가-힣]/.test(korean))continue;
      const suffix=divider<0?'':inner.slice(divider+1).trim();
      let hideStart=match.index+match[1].length,hideEnd=end;
      if(suffix){hideStart=open+1;hideEnd=open+1+divider+1;while(/\s/.test(text[hideEnd]||'')&&hideEnd<end)hideEnd++;}
      found.push({key:keyOf(english),english,korean,inner,suffix,start:match.index,end,hideStart,hideEnd});
      pattern.lastIndex=end;
    }
    return found;
  }
  function collectTerms(blocks){
    const terms=new Map();
    for(const block of blocks)for(const found of findTerms(block.text||'')){
      let term=terms.get(found.key);
      if(!term){term={key:found.key,english:found.english,koreans:[],aliases:[],count:0,locations:[]};terms.set(found.key,term)}
      if(!term.koreans.includes(found.korean))term.koreans.push(found.korean);
      term.count++;
      if(block.id&&!term.locations.some(x=>x.id===block.id))term.locations.push({id:block.id,chapter:block.chapter,section:block.section,order:block.order});
    }
    // Merge only attested regular plurals with exactly matching Korean glosses.
    // Never guess an acronym's expansion or combine different technical phrases.
    for(const [key,term] of [...terms]){
      if(!key.endsWith('s'))continue;
      const base=terms.get(key.slice(0,-1));
      if(!base||term.koreans.length!==base.koreans.length||!term.koreans.every(k=>base.koreans.includes(k)))continue;
      base.aliases.push({key,english:term.english});base.count+=term.count;
      for(const loc of term.locations)if(!base.locations.some(x=>x.id===loc.id))base.locations.push(loc);
      terms.delete(key);
    }
    return [...terms.values()].sort((a,b)=>a.english.localeCompare(b.english,'en',{sensitivity:'base',numeric:true}));
  }
  function suppressTerms(text,excluded,aliases={}){
    for(const term of findTerms(text).reverse())if(excluded.has(aliases[term.key]||term.key))text=text.slice(0,term.hideStart)+text.slice(term.hideEnd);
    return text;
  }
  function compareAnnotations(a,b,index){
    const sa=a.segments[0],sb=b.segments[0];
    return ((index[sa.block]?.order??Number.MAX_SAFE_INTEGER)-(index[sb.block]?.order??Number.MAX_SAFE_INTEGER))||sa.start-sb.start||String(a.id).localeCompare(String(b.id));
  }
  return {keyOf,findTerms,collectTerms,suppressTerms,compareAnnotations};
});
