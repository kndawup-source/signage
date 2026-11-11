(async () => {
  'use strict';
  const {db, qs, esc, getPinSession, formatBytes} = window.Signage;
  await window.Signage.requireAuth('admin');
  const fileInput = qs('#videoSource');
  const existingVideoInput = qs('#existingVideo');
  const existingVideoStatus = qs('#existingVideoStatus');
  let existingVideos = [];
  let currentVideo = null;
  const qualitySelect = qs('#videoQuality');
  const button = qs('#convertUpload');
  const bulkButton = qs('#convertMissing');
  const cancelButton = qs('#cancelBatch');
  let cancelRequested = false;
  const progress = qs('#convertProgress');
  const message = qs('#convertMessage');
  const result = qs('#convertResults');
  const preview = qs('#convertPreview');
  let busy = false;
  const formats = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4'];
  const supportedMime = () => typeof MediaRecorder !== 'undefined' && formats.find(type => MediaRecorder.isTypeSupported(type));
  function status(text, fraction) {
    message.textContent = text;
    if (Number.isFinite(fraction)) progress.value = Math.max(0, Math.min(100, fraction));
  }
  function inspectFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      const timer = setTimeout(() => finish(new Error('영상 정보를 읽는 데 시간이 초과됐습니다.')), 15000);
      let done = false;
      function finish(error, value) {
        if (done) return;
        done = true; clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      }
      video.onloadedmetadata = () => finish(null, {duration:video.duration,width:video.videoWidth,height:video.videoHeight});
      video.onerror = () => finish(new Error('브라우저에서 원본 MP4를 읽을 수 없습니다.'));
      video.src = url;
    });
  }
  async function transcode(file, quality, onProgress) {
    // MediaRecorder encodes in realtime. No FFmpeg, server, or extra cloud provider.
    const mimeType = supportedMime();
    if (!mimeType) throw new Error('이 브라우저는 MP4(H.264) 변환을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용하세요.');
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.volume = 1;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', {alpha:false,desynchronized:true});
    if (!ctx) { URL.revokeObjectURL(url); throw new Error('영상 변환용 캔버스를 만들지 못했습니다.'); }
    let recorder, audioCtx, renderTimer, endedListener, errorListener, sourceNode;
    try {
      await new Promise((resolve,reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('원본 영상 디코딩에 실패했습니다.'));
        if (video.readyState >= 1) resolve();
      });
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error('30분 이하의 정상적인 MP4 영상만 변환할 수 있습니다.');
      const target = Number(quality);
      const scale = Math.min(1, target / Math.max(video.videoHeight,1));
      // Encoder expects even dimensions for H.264.
      canvas.width = Math.max(2, Math.floor((video.videoWidth * scale)/2)*2);
      canvas.height = Math.max(2, Math.floor((video.videoHeight * scale)/2)*2);
      ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
      const stream = canvas.captureStream(24);
      // Route source audio into the recorded stream, without playing it through speakers.
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('이 브라우저는 오디오 보존을 지원하지 않습니다.');
      audioCtx = new AudioContextCtor();
      sourceNode = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      sourceNode.connect(dest);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      await audioCtx.resume();
      const chunks = [];
      const bitrate = target <= 480 ? 850_000 : 1_800_000;
      recorder = new MediaRecorder(stream, {mimeType,videoBitsPerSecond:bitrate,audioBitsPerSecond:96_000});
      recorder.ondataavailable = event => { if(event.data && event.data.size) chunks.push(event.data); };
      const finished = new Promise((resolve, reject) => {
        recorder.onerror = e => reject(new Error(e.error?.message || 'MP4 인코딩 오류'));
        recorder.onstop = () => resolve(new Blob(chunks, {type:'video/mp4'}));
      });
      const paint = () => { if (video.readyState>=2 && !video.paused) {ctx.drawImage(video,0,0,canvas.width,canvas.height);onProgress?.(Math.min(98,video.currentTime/duration*100));} };
      recorder.start(1000);
      renderTimer = setInterval(paint, 1000/24);
      // Playback can fail because of codecs even after metadata loads.
      await video.play();
      await new Promise((resolve,reject) => {
        endedListener = () => resolve();
        errorListener = () => reject(new Error('재생 도중 원본 영상 오류가 발생했습니다.'));
        video.addEventListener('ended',endedListener,{once:true});
        video.addEventListener('error',errorListener,{once:true});
        if (video.ended) resolve();
      });
      paint();
      recorder.stop();
      const blob = await finished;
      const head = new Uint8Array(await blob.slice(0,16).arrayBuffer());
      const box = String.fromCharCode(...head.slice(4,8));
      if (blob.size < 1024 || box !== 'ftyp') throw new Error('변환 결과가 정상적인 MP4가 아닙니다. 업로드하지 않았습니다.');
      onProgress?.(100);
      return {blob,width:canvas.width,height:canvas.height,duration};
    } finally {
      if (renderTimer) clearInterval(renderTimer);
      if (endedListener) video.removeEventListener('ended',endedListener);
      if (errorListener) video.removeEventListener('error',errorListener);
      video.pause(); video.removeAttribute('src'); video.load();
      if(recorder && recorder.state !== 'inactive') {try{recorder.stop();}catch{}}
      if(audioCtx) await audioCtx.close().catch(()=>{});
      URL.revokeObjectURL(url);
    }
  }
  async function uploadToR2(blob, filename, onProgress) {
    const token = getPinSession()?.token;
    if (!token) throw new Error('관리자 세션이 만료됐습니다. 다시 로그인하세요.');
    const response = await fetch('/api/r2-presign', {
      method:'POST',headers:{'content-type':'application/json','x-signage-session':token},
      body:JSON.stringify({filename,contentType:'video/mp4',size:blob.size})
    });
    const signed = await response.json();
    if(!response.ok) throw new Error(signed.error || `업로드 URL 발급 실패 (HTTP ${response.status})`);
    await new Promise((resolve,reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT',signed.uploadUrl,true);
      xhr.setRequestHeader('Content-Type','video/mp4');
      xhr.upload.onprogress = e => {if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
      xhr.onload = () => xhr.status>=200 && xhr.status<300 ? resolve() : reject(new Error(`R2 저장 실패 (${xhr.status})`));
      xhr.onerror = () => reject(new Error('R2 업로드 네트워크 오류 또는 CORS 설정을 확인하세요.'));
      xhr.send(blob);
    });
    return signed;
  }
  function acceptedOriginal(video) {
    if (!video || !/^https:\/\//i.test(video.url || '')) return false;
    try { const u = new URL(video.url); return !u.username && !u.password; } catch { return false; }
  }
  async function loadExistingVideos() {
    const {data,error} = await db.from('videos').select('id,title,url,source,variants,active').order('created_at',{ascending:false});
    if(error) throw new Error(`영상 목록을 불러오지 못했습니다: ${error.message}. Supabase SQL 적용 여부를 확인하세요.`);
    existingVideos=(data||[]).filter(acceptedOriginal);
    existingVideoInput.replaceChildren(new Option('기존 영상 선택', ''));
    existingVideos.forEach(v=>existingVideoInput.add(new Option(v.title || v.id, v.id)));
    if(!existingVideos.length) existingVideoStatus.textContent='변환 가능한 R2/HTTPS 원본 영상이 없습니다.';
  }
  async function resolveOriginal(video=currentVideo, allowManual=true) {
    const manual=allowManual ? fileInput.files?.[0] : null;
    if(manual) return manual;
    if(!video?.url) throw new Error('기존 영상을 선택하세요.');
    status('등록된 원본 영상 다운로드 중…',0);
    try {
      const r=await fetch(video.url,{mode:'cors',credentials:'omit'});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const max=512*1024*1024;
      const announced=Number(r.headers.get('content-length')||0);
      if(announced>max) {await r.body?.cancel?.();throw new Error('원본이 512MB보다 큽니다.');}
      if(!r.body) throw new Error('원본 다운로드 스트림을 사용할 수 없습니다.');
      const reader=r.body.getReader();const parts=[];let total=0;
      try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw new Error('원본이 512MB보다 큽니다.');parts.push(value);}}
      catch(e){await reader.cancel().catch(()=>{});throw e;}
      return new File(parts, `${video.id}.mp4`, {type:'video/mp4'});
    } catch(e) {
      throw new Error('원본 영상 자동 읽기 실패(CORS 또는 접근 제한). 아래 파일 선택에서 동일한 원본 MP4를 선택하세요. '+e.message);
    }
  }
  async function updateVariants(video, newVariants) {
    // Only update this video's rendition metadata; never insert a new video row.
    const {data,error} = await db.from('videos').update({variants:newVariants}).eq('id',video.id).select('id,variants').single();
    if(error || data?.id!==video.id) throw new Error(`화질 연결 정보 저장 실패: ${error?.message||'권한 확인 필요'}`);
    video.variants=data.variants;
  }
  function showExisting() {
    currentVideo=existingVideos.find(v=>v.id===existingVideoInput.value)||null;
    fileInput.value='';
    const qualities=currentVideo?.variants||{};
    existingVideoStatus.textContent=currentVideo
      ? `원본 유지 · 480p ${qualities['480p']?'연결됨':'없음'} / 720p ${qualities['720p']?'연결됨':'없음'} · 기존 재생목록 유지`
      : '기존 영상 하나를 선택하세요. 새 영상 항목은 생성하지 않습니다.';
  }
  existingVideoInput.addEventListener('change', showExisting);
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if(!f) return;
    try {
      const meta = await inspectFile(f);
      status(`선택된 원본 ${meta.width}×${meta.height} · ${Math.round(meta.duration)}초 · ${formatBytes(f.size)}`,0);
    } catch(e) {status(e.message,0);}
  });
  await loadExistingVideos().catch(e=>status(e.message,0));
  async function convertOne(video, qualities, file, single=false) {
    if(!/\.mp4$/i.test(file.name)||file.size>512*1024*1024) throw new Error('512MB 이하의 MP4 파일만 변환할 수 있습니다.');
    const variants={...(video.variants && typeof video.variants==='object'?video.variants:{})};
    for(const q of qualities) {
      if(cancelRequested) throw new Error('사용자 요청으로 일괄 처리를 중단했습니다.');
      if(typeof variants[`${q}p`]==='string' ? variants[`${q}p`] : variants[`${q}p`]?.url) continue;
      status(`${video.title || video.id}: ${q}p 영상 변환 중 · 탭을 닫지 마세요.`,0);
      const encoded=await transcode(file,q,p=>status(`${video.title || video.id}: ${q}p 변환 중 ${Math.round(p)}%`,p));
      const filename=`${video.id}-${q}p-${Date.now()}.mp4`;
      status(`${video.title || video.id}: ${q}p R2 업로드 중`,0);
      const signed=await uploadToR2(encoded.blob,filename,p=>status(`${q}p R2 업로드 중 ${p}%`,p));
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',await encoded.blob.arrayBuffer()));
      const sha256=[...hash].map(b=>b.toString(16).padStart(2,'0')).join('');
      const next={...variants,[`${q}p`]:{url:signed.publicUrl,bytes:encoded.blob.size,quality:`${q}p`,width:encoded.width,height:encoded.height,sha256}};
      await updateVariants(video,next);
      Object.assign(variants,next);
      if(single){
        const line=document.createElement('div');
        const a=document.createElement('a');a.href=signed.publicUrl;a.target='_blank';a.rel='noopener noreferrer';
        a.textContent=`${q}p 연결됨 · ${encoded.width}×${encoded.height} · ${formatBytes(encoded.blob.size)} · 파일 확인`;
        line.append(a);result.append(line);
      }
    }
  }
  function setBusy(value){busy=value;button.disabled=value;bulkButton.disabled=value;cancelButton.hidden=!value;}
  cancelButton.addEventListener('click',()=>{cancelRequested=true;cancelButton.disabled=true;status('현재 진행 중인 영상 변환이 끝난 뒤 일괄 처리를 중단합니다.');});
  button.addEventListener('click',async () => {
    if(busy)return;
    const video=currentVideo;
    if(!video){status('기존 영상부터 선택하세요.');return;}
    if(!supportedMime()){status('이 브라우저에서 MP4(H.264) 변환을 지원하지 않습니다.');return;}
    cancelRequested=false;cancelButton.disabled=false;setBusy(true);result.textContent='';
    try {
      const file=await resolveOriginal(video,true);
      const qualities=qualitySelect.value==='both'?[480,720]:[Number(qualitySelect.value)];
      await convertOne(video,qualities,file,true);
      showExisting();status('기존 영상에 화질 파일을 연결했습니다. 재생목록은 그대로입니다.',100);
    }catch(e){status(`실패: ${e.message}`);}
    finally{setBusy(false);}
  });
  bulkButton.addEventListener('click',async()=>{
    if(busy)return;
    if(!supportedMime()){status('이 브라우저에서 MP4(H.264) 변환을 지원하지 않습니다.');return;}
    const targets=existingVideos.filter(v=>{const x=v.variants?.['480p'];return !(typeof x==='string' ? x : x?.url);});
    if(!targets.length){status('480p 변환이 필요한 영상이 없습니다.',100);return;}
    cancelRequested=false;cancelButton.disabled=false;setBusy(true);result.textContent='';
    let done=0,failed=0;
    try {
      for(let i=0;i<targets.length;i++){
        if(cancelRequested)break;
        const video=targets[i];
        status(`일괄 변환 ${i+1}/${targets.length} · ${video.title||video.id} 원본 다운로드`,0);
        try{
          const file=await resolveOriginal(video,false);
          await convertOne(video,[480],file,false);
          done++;
        }catch(e){
          failed++;
          const line=document.createElement('p');line.textContent=`${video.title||video.id}: ${e.message}`;
          result.append(line);
        }
      }
      showExisting();
      status(`일괄 처리 종료 · 연결 ${done}개 · 실패 ${failed}개${cancelRequested?' · 사용자 중단':''}. 실패한 영상은 별도 원본 파일을 선택해 처리하세요.`,100);
    }finally{setBusy(false);}
  });
  preview.textContent='변환 중에는 이 페이지를 유지하세요. 이미 송출 중인 원본 영상과 재생목록은 변경하지 않습니다. 새 화질 선택은 해당 화질을 지원하는 플레이어에서 적용됩니다.';
})();
