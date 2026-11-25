/* Tenant-specific catalog helpers. Stable codes are distinct from display labels. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SignageCatalog=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DEFAULT={"revision":1,"treatments":[{"code":"general","label":"일반 진료","active":true},{"code":"checkup","label":"검진","active":true},{"code":"aftercare","label":"치료 후 관리","active":true}],"floor_types":[{"code":"general","label":"일반진료","active":true},{"code":"common","label":"공용","active":true},{"code":"support","label":"지원","active":true},{"code":"other","label":"기타","active":true}],"space_types":[{"code":"treatment","label":"진료실","active":true},{"code":"consultation","label":"상담실","active":true},{"code":"waiting","label":"대기","active":true},{"code":"lounge","label":"라운지","active":true},{"code":"reception","label":"접수/안내","active":true},{"code":"lobby","label":"로비","active":true},{"code":"staff","label":"스탭","active":true},{"code":"support","label":"지원","active":true},{"code":"public","label":"공용","active":true},{"code":"other","label":"기타","active":true}],"logo":null};
  const categories=['treatments','floor_types','space_types'];
  const copy=x=>JSON.parse(JSON.stringify(x));
  const profile=x=>x&&categories.every(k=>Array.isArray(x[k]))?copy(x):copy(DEFAULT);
  const entries=(cfg,k,selected)=>{const out=profile(cfg)[k].filter(e=>e.active===true||e.code===selected).map(e=>[String(e.code),String(e.label)]);if(selected&&!out.some(e=>e[0]===selected))out.push([String(selected),String(selected)]);return out;};
  const label=(cfg,k,code,fallback='미설정')=>profile(cfg)[k].find(e=>e.code===code)?.label||code||fallback;
  const validLogo=s=>typeof s==='string'&&s.length<=70000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
  const validCode=s=>/^[a-z][a-z0-9_-]{0,47}$/.test(s)&&s!=='veneer';
  function validate(cfg){
    if(!cfg||!categories.every(k=>Array.isArray(cfg[k])))return '설정 형식이 올바르지 않습니다.';
    for(const k of categories){const a=cfg[k],seen=new Set();if(a.length>150||!a.some(e=>e.active))return '분류마다 사용 중인 항목이 하나 이상 있어야 하며 최대 150개입니다.';
      for(const e of a){if(!e.code||seen.has(e.code)||!String(e.label||'').trim()||String(e.label).trim().length>80||typeof e.active!=='boolean')return '중복 코드 또는 빈 항목명이 있습니다.';seen.add(e.code);}
      if(k!=='treatments'&&!a.some(e=>e.code==='other'&&e.active))return '기타 유형은 사용 중지할 수 없습니다.';
    }
    if(cfg.logo&&!validLogo(cfg.logo))return '로고 이미지 형식 또는 크기가 올바르지 않습니다.';
    return '';
  }
  return {profile,entries,label,validLogo,validCode,validate,copy};
});
