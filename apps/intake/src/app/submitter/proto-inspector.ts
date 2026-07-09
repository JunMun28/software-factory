/** The point-to-edit inspector, injected into the prototype iframe (redesigned after Cursor / v0 /
 *  Lovable). Armed via postMessage; while armed it outlines the hovered element with a floating
 *  label, and on click selects it (persistent outline), reporting the full selection back. Cmd/Ctrl-
 *  click multi-selects. The parent can re-sync the selection (chip removed) via `sf-sync`.
 *
 *  This is a self-contained `<script>` string embedded verbatim into the sandboxed iframe's srcdoc
 *  (see `prototypeSrcdoc` in @sf/shared). It runs with no framework and no same-origin access; it
 *  talks to the parent only through the `sf-annot` postMessage it emits. */
export const INSPECTOR = `<script>(function(){
  var armed=false, box=null, lbl=null, cur=null, sel={};
  function mkBox(){ if(!box){ box=document.createElement('div');
    box.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #8b5cf6;background:rgba(139,92,246,.10);border-radius:4px'; document.body.appendChild(box);} return box; }
  function mkLbl(){ if(!lbl){ lbl=document.createElement('div');
    lbl.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#8b5cf6;color:#fff;font:600 11px/1.5 ui-sans-serif,system-ui,sans-serif;padding:2px 7px;border-radius:6px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px rgba(0,0,0,.25)'; document.body.appendChild(lbl);} return lbl; }
  function hideHover(){ if(box) box.style.display='none'; if(lbl) lbl.style.display='none'; }
  function pidOf(el){ var p=el.getAttribute('data-pid'); if(!p){ p='sf-'+Math.random().toString(36).slice(2,8); el.setAttribute('data-pid',p);} return p; }
  function nameOf(el){ var t=(el.textContent||'').trim().replace(/\\s+/g,' '); return t ? t.slice(0,44) : '<'+el.tagName.toLowerCase()+'>'; }
  function selOf(el){
    if(el.getAttribute('data-pid')) return '[data-pid="'+el.getAttribute('data-pid')+'"]';
    var parts=[], e=el;
    while(e && e.nodeType===1 && e!==document.body && parts.length<4){
      var t=e.tagName.toLowerCase(), p=e.parentNode, i=1, n=0;
      if(p){ for(var k=0;k<p.children.length;k++){ if(p.children[k].tagName===e.tagName){ n++; if(p.children[k]===e) i=n; } } if(n>1) t+=':nth-of-type('+i+')'; }
      parts.unshift(t); e=e.parentNode;
    }
    return parts.join(' > ');
  }
  function descr(el){ var r=el.getBoundingClientRect();
    return { pid:el.getAttribute('data-pid'), selector:selOf(el), tag:el.tagName.toLowerCase(),
      textSnippet:(el.textContent||'').trim().slice(0,120), outerHTML:(el.outerHTML||'').slice(0,600),
      rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)} }; }
  function mark(el,on){ el.style.outline=on?'2px solid #8b5cf6':''; el.style.outlineOffset=on?'1px':''; }
  function emit(){ var items=[]; for(var pid in sel){ items.push(descr(sel[pid])); } parent.postMessage({type:'sf-annot',items:items},'*'); }
  function syncTo(pids){ var keep={}; (pids||[]).forEach(function(p){keep[p]=1;});
    for(var pid in sel){ if(!keep[pid]){ mark(sel[pid],false); delete sel[pid]; } }
    (pids||[]).forEach(function(p){ if(!sel[p]){ var el=document.querySelector('[data-pid="'+p+'"]'); if(el){ sel[p]=el; mark(el,true);} } }); }
  window.addEventListener('message', function(ev){ var d=ev.data||{};
    if(d.type==='sf-inspect'){ armed=!!d.on; document.documentElement.style.cursor=armed?'crosshair':''; if(!armed) hideHover(); }
    else if(d.type==='sf-sync'){ syncTo(d.pids); } });
  document.addEventListener('pointermove', function(e){ if(!armed) return; var el=e.target;
    if(!el||el===document.documentElement||el===document.body){ hideHover(); return; }
    cur=el; var r=el.getBoundingClientRect(), b=mkBox(); b.style.display='block';
    b.style.left=r.left+'px'; b.style.top=r.top+'px'; b.style.width=r.width+'px'; b.style.height=r.height+'px';
    var L=mkLbl(); L.style.display='block'; L.textContent=nameOf(el);
    var ty=r.top-23; L.style.left=r.left+'px'; L.style.top=(ty<2?r.top+4:ty)+'px'; }, true);
  document.addEventListener('click', function(e){ if(!armed) return; e.preventDefault(); e.stopPropagation();
    var el=cur||e.target; if(!el||el===document.body||el===document.documentElement) return;
    var pid=pidOf(el);
    if(!(e.metaKey||e.ctrlKey)){ for(var p in sel){ mark(sel[p],false); } sel={}; }
    if(sel[pid]){ mark(el,false); delete sel[pid]; } else { sel[pid]=el; mark(el,true); }
    emit(); }, true);
})();</script>`;
