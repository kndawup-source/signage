#!/usr/bin/env node
'use strict';
// Rebuild only the generated administrator foundation from the shared app.css.
// Run: npm install --prefix scripts && node scripts/build-admin-foundation.js
const fs=require('fs');const postcss=require('postcss');const crypto=require('crypto');
const path=require('node:path');
const root=path.resolve(__dirname,'..');const css=root+'/css/';
const read=n=>fs.readFileSync(css+n,'utf8');
const save=(n,s)=>fs.writeFileSync(css+n,s);
// Preserve genuinely behavioral important declarations; ordinary visual rules use layers.
function functional(d, selector) {
  return ((/\.(?:floor-plan-stage|building-floor-plan-stage|settings-map-stage|floorplan-svg-host)\b/.test(selector)) && ['aspect-ratio','min-height','max-height','height','width','min-width','max-width'].includes(d.prop))
    || /(?:\bplayer-(?:root|video)\b|\.danger-text\b)/.test(selector)
    || (/\[hidden\]|\.hidden\b|\.is-hidden\b/.test(selector) && ['display','visibility'].includes(d.prop))
    || /\.media-target-floor-fallback\b/.test(selector);
}
function split(source) {
  const src=postcss.parse(source);const base=postcss.root();const priority=postcss.root();
  function visit(container,b,p){for(const node of container.nodes||[]){
    if(node.type==='rule'){
      const br=node.clone({nodes:[]}),pr=node.clone({nodes:[]});
      for(const d of node.nodes||[]){if(d.type==='decl'&&d.important&&!functional(d,node.selector)){const copy=d.clone();copy.important=false;delete copy.raws.important;pr.append(copy);}else br.append(d.clone());}
      if(br.nodes.length)b.append(br);if(pr.nodes.length)p.append(pr);
    } else if(node.type==='atrule'&&node.name==='media'){
      const bb=node.clone({nodes:[]}),pp=node.clone({nodes:[]});visit(node,bb,pp);if(bb.nodes.length)b.append(bb);if(pp.nodes.length)p.append(pp);
    } else b.append(node.clone());
  }}
  visit(src,base,priority);
  // Keep original specificity and order within each legacy layer.
  return '@layer signage-base {\n'+base.toString()+'\n}\n\n/* Former legacy visual priorities. New admin design is in a later layer. */\n@layer signage-legacy {\n'+priority.toString()+'\n}\n';
}
const source=read('app.css');const sha=crypto.createHash('sha256').update(source).digest('hex');
save('admin-foundation.css','/* Generated from app.css for admin pages only. Source SHA256: '+sha+' */\n@layer signage-base, signage-legacy, signage-admin;\n'+split(source));
console.log('Admin foundation regenerated: '+sha);
