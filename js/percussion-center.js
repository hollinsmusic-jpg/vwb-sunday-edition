// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Percussion Center (Mini MPC)
//  js/percussion-center.js
//
//  The VWB drum machine and loop recorder. Manages:
//    • Three pad banks (Bank A/B/C) with 12 pads each
//    • Layer-based loop recording and playback
//    • Swing and quantize engine
//    • MIDI input triggering from keyboard controller
//    • Sample loading from hmpi_diane_perc/
//    • Loop import/export as MIDI files
//    • Pad mixer with volume, pan, and reverb per pad
//
//  Depends on: audio-engine.js (AC context), state.js,
//              midi-synth.js (mmpcParseMidi via vwb-mpc-import.js)
// ═══════════════════════════════════════════════════════════════

(function() {

// ── PAD DEFINITIONS ──
const MMPC_BANK_A = [
  {note:60,name:'KICK 1',  file:'kick_1',        key:'a', vol:1.0},
  {note:61,name:'KICK 2',  file:'kick_2',        key:'s', vol:1.0},
  {note:62,name:'SNARE',   file:'snare',          key:'d', vol:1.0},
  {note:63,name:'CLAP',    file:'clap',           key:'f', vol:0.9},
  {note:64,name:'HI-HAT',  file:'hi-hat',        key:'g', vol:0.85},
  {note:65,name:'SNAP',    file:'snap',           key:'h', vol:0.9},
  {note:66,name:'SHAKER',  file:'shaker',         key:'j', vol:0.85},
  {note:67,name:'TAMBOR',  file:'tamborine',      key:'k', vol:0.9},
  {note:68,name:'CONGA',   file:'conga',          key:'l', vol:1.0},
  {note:69,name:'CNGA SLP',file:'conga_slap',     key:';', vol:0.95},
  {note:70,name:'TRIANGLE',file:'triangle',       key:"'", vol:0.8},
  {note:71,name:'WOOD BLK',file:'wood_block',     key:'z', vol:0.9},
];
const MMPC_BANK_B_STOCK = [
  {note:72,name:'WINDCHIM',file:'windchimes',      key:'m', vol:0.8},
  {note:73,name:'BONGO HI',file:'bongo_high',      key:'n', vol:1.0},
  {note:74,name:'BONGO LO',file:'bongo_low',       key:'b', vol:1.0},
  {note:75,name:'COW BELL',file:'cow_bell',        key:'v', vol:0.9},
  {note:76,name:'HIGH TAM',file:'high_tam',        key:'c', vol:0.9},
  {note:77,name:'TIMPANI', file:'timpani',          key:'x', vol:1.0},
  {note:78,name:'TRI CLO', file:'triangle_closed', key:'q', vol:0.85},
  {note:79,name:'TRI OPEN',file:'triangle_open',   key:'w', vol:0.85},
];
let mmpcBankB = [
  ...MMPC_BANK_B_STOCK.map(p=>({...p})),
  {note:80,name:'OPEN',file:null,key:'e',custom:true,vol:1.0,pan:0,rev:0},
  {note:81,name:'OPEN',file:null,key:'r',custom:true,vol:1.0,pan:0,rev:0},
  {note:82,name:'OPEN',file:null,key:'t',custom:true,vol:1.0,pan:0,rev:0},
  {note:83,name:'OPEN',file:null,key:'y',custom:true,vol:1.0,pan:0,rev:0},
];
// Bank C — 12 fully open custom pads, keyboard continues in half steps
const MMPC_BANKC_KEYS = ['u','i','o','p','1','2','3','4','5','6','7','8'];
const mmpcBankC = Array.from({length:12},(_,i)=>({
  note:84+i, name:'OPEN', file:null, key:MMPC_BANKC_KEYS[i], custom:true, empty:true, vol:1.0, pan:0, rev:0
}));
function mmpcGetBanks(){ return [MMPC_BANK_A, mmpcBankB, mmpcBankC]; }
function mmpcPadOrder(bi){
  if(bi===0) return [8,9,10,11,4,5,6,7,0,1,2,3];
  if(bi===1) return [12,13,14,15,8,9,10,11,4,5,6,7,0,1,2,3];
  return [8,9,10,11,4,5,6,7,0,1,2,3]; // Bank C: 12 pads
}

// ── STATE ──
let mmpcBank=0, mmpcBpmVal=90, mmpcBars=2, mmpcBPB=4;
let mmpcIsPlaying=false, mmpcIsRecording=false;
let mmpcStartTime=null, mmpcLoopTimer=null, mmpcTickTimer=null;
let mmpcLoops=[], mmpcActiveLoop=-1;
let mmpcBuffers={};
const MMPC_TPQN=480;
function mmpcLoopTicks(){ return mmpcBars*mmpcBPB*MMPC_TPQN; }
let mmpcMetroOn=false, mmpcMetroTimer=null, mmpcMetroBeat=0, mmpcMetroNext=0;

// ── LAYER SYSTEM ──
function mmpcMkLayer(name){ return {name, events:[], muted:false, volume:0.85, pan:0}; }
let mmpcLayers = [
  mmpcMkLayer('Layer 1'),
  mmpcMkLayer('Layer 2'),
  mmpcMkLayer('Layer 3'),
];
let mmpcActiveLayer = -1; // which layer is armed for recording

window.mmpcAddLayer=function(){
  mmpcLayers.push(mmpcMkLayer('Layer '+(mmpcLayers.length+1)));
  mmpcRenderLayers();
};

window.mmpcArmLayer=function(i){
  if(mmpcActiveLayer===i){
    // Clicking the already-armed layer disarms it
    mmpcActiveLayer=-1;
    mmpcIsRecording=false;
  } else {
    // Switching to a different layer — exit record mode, keep playing
    mmpcActiveLayer=i;
    if(mmpcIsRecording){
      mmpcIsRecording=false;
      // Keep playing — just drop out of record mode silently
    }
  }
  mmpcUpdateUI();
  mmpcRenderLayers();
};

window.mmpcClearLayer=function(i){
  mmpcLayers[i].events=[];
  mmpcRenderLayers();
};

window.mmpcMuteLayer=function(i){
  mmpcLayers[i].muted=!mmpcLayers[i].muted;
  mmpcRenderLayers();
};

window.mmpcClearAll=function(){
  if(!confirm('Clear all layers and start over?')) return;
  mmpcStop();
  mmpcLayers.forEach(ly=>ly.events=[]);
  mmpcActiveLayer=-1;
  mmpcRenderLayers();
  if(typeof showNotification==='function') showNotification('Percussion layers cleared');
};

function mmpcRenderLayers(){
  const el=document.getElementById('mmpcLayers'); if(!el) return;
  el.innerHTML='';
  mmpcLayers.forEach((ly,i)=>{
    const div=document.createElement('div');
    const hasData=ly.events.length>0;
    div.className='mmpc-layer'+(i===mmpcActiveLayer?' armed':'')+(hasData?' has-data':'');
    div.innerHTML=`
      <div class="mmpc-layer-arm ${i===mmpcActiveLayer?'on':''}" data-arm="${i}" title="Arm for recording">
        <div class="mmpc-layer-arm-dot"></div>
      </div>
      <div class="mmpc-layer-name ${i===mmpcActiveLayer?'on':''}">${ly.name}</div>
      <span class="mmpc-ctrl-lbl" style="flex-shrink:0;">Vol</span>
      <input type="range" class="mmpc-layer-vol" min="0" max="1" step="0.01" value="${ly.volume}" data-ly="${i}" data-t="vol">
      <span class="mmpc-ctrl-lbl" style="flex-shrink:0;">Pan</span>
      <input type="range" class="mmpc-layer-pan" min="-1" max="1" step="0.01" value="${ly.pan}" data-ly="${i}" data-t="pan">
      <button class="mmpc-layer-mu ${ly.muted?'on':''}" data-mu="${i}">${ly.muted?'UN':'MU'}</button>
      <button class="mmpc-layer-clr" data-clr="${i}" title="Clear this layer">✕</button>
      <div class="mmpc-layer-cnt">${hasData?ly.events.length+' ev':''}</div>
    `;
    // Wire events via JS (not inline oninput) to avoid scope issues
    div.querySelector('[data-arm]').onclick=()=>mmpcArmLayer(i);
    div.querySelector('[data-t="vol"]').oninput=function(){ mmpcLayers[i].volume=parseFloat(this.value); };
    div.querySelector('[data-t="pan"]').oninput=function(){ mmpcLayers[i].pan=parseFloat(this.value); };
    div.querySelector('[data-mu]').onclick=()=>mmpcMuteLayer(i);
    div.querySelector('[data-clr]').onclick=()=>mmpcClearLayer(i);
    el.appendChild(div);
  });
}

// ── PAD REVERB ──
let mmpcReverbBuffer = null;

async function mmpcGetReverb(){
  if(mmpcReverbBuffer) return mmpcReverbBuffer;
  const ctx=mmpcCtx();
  const len=ctx.sampleRate*2.2;
  const buf=ctx.createBuffer(2,len,ctx.sampleRate);
  for(let c=0;c<2;c++){
    const d=buf.getChannelData(c);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.8);
  }
  mmpcReverbBuffer=buf;
  return buf;
}

// ── VU METER SYSTEM ──
// Each channel has a canvas-less meter — we animate a div height
const mmpcVuLevels = {}; // file -> current level 0-1
const mmpcVuDecay  = {}; // file -> decay timer

function mmpcFlashVu(file, level){
  mmpcVuLevels[file] = Math.min(1, level);
  const bar = document.getElementById('mmpcVu_'+file);
  if(bar) bar.style.height = Math.round(mmpcVuLevels[file]*100)+'%';
  // Decay
  clearTimeout(mmpcVuDecay[file]);
  mmpcVuDecay[file] = setTimeout(()=>mmpcDecayVu(file), 80);
}

function mmpcDecayVu(file){
  mmpcVuLevels[file] = (mmpcVuLevels[file]||0) * 0.6;
  const bar = document.getElementById('mmpcVu_'+file);
  if(bar) bar.style.height = Math.round(mmpcVuLevels[file]*100)+'%';
  if(mmpcVuLevels[file] > 0.01){
    mmpcVuDecay[file] = setTimeout(()=>mmpcDecayVu(file), 60);
  }
}

// ── PAD MIXER STRIP — VWB-style channel strips ──
// ── Mixer toggle ──────────────────────────────────────────────
window.mmpcToggleMixer=function(){
  const body=document.getElementById('mmpcMixerBody');
  const arrow=document.getElementById('mmpcMixerArrow');
  if(!body) return;
  const isOpen=body.classList.toggle('open');
  if(arrow) arrow.classList.toggle('open',isOpen);
};

// ── Reverb knob drag logic ─────────────────────────────────────
function mmpcMakeRevKnob(knobEl, dotEl, initialRev, file){
  let revVal=initialRev; // 0-100
  let dragging=false, dragStartY=0, dragStartVal=0;
  function updateKnob(v){
    revVal=Math.max(0,Math.min(100,v));
    // Map 0-100 to -135deg → +135deg rotation
    const deg=-135+(revVal/100)*270;
    dotEl.style.transform=`translateX(-50%) rotate(${deg}deg)`;
    mmpcSetPadProp(file,'rev',revVal/100);
  }
  updateKnob(revVal); // set initial position
  knobEl.addEventListener('mousedown',e=>{
    dragging=true; dragStartY=e.clientY; dragStartVal=revVal;
    e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const delta=(dragStartY-e.clientY)*1.5; // drag up = more reverb
    updateKnob(dragStartVal+delta);
  });
  window.addEventListener('mouseup',()=>{ dragging=false; });
}

function mmpcRenderMixer(){
  const strip=document.getElementById('mmpcMixerStrip'); if(!strip) return;
  strip.innerHTML='';
  const loaded=[...mmpcGetBanks()[0],...mmpcGetBanks()[1],...mmpcGetBanks()[2]].filter(p=>p.file&&!p.empty);
  loaded.forEach((pad)=>{
    if(pad.rev===undefined) pad.rev=0;
    if(pad.pan===undefined) pad.pan=0;
    const vol  = Math.round((pad.vol||1.0)*100);
    const panV = Math.round((pad.pan||0)*100);
    const rev  = Math.round((pad.rev||0)*100);
    const safeId = pad.file.replace(/[^a-zA-Z0-9_]/g,'_');
    // Fader cap top% — vol 100 = cap near top (8%), vol 0 = cap near bottom (88%)
    const capTop = 88 - (vol/100)*80;

    const ch=document.createElement('div');
    ch.className='mmpc-channel';

    ch.innerHTML=`
      <div style="position:relative;width:36px;height:16px;margin-bottom:2px;">
        <div class="mmpc-pan-line" id="mmpcPanLine_${safeId}">
          <div class="mmpc-pan-dot" id="mmpcPanDot_${safeId}"
            style="left:calc(50% + ${panV*0.12}px - 2.5px)"></div>
        </div>
        <input type="range" class="mmpc-pan-input"
          style="position:absolute;top:0;left:0;opacity:.01;width:36px;height:16px;cursor:pointer;"
          min="-100" max="100" value="${panV}"
          title="${pad.name} Pan"
          data-file="${pad.file}" data-t="pan">
      </div>

      <div class="mmpc-fader-meter">
        <div class="mmpc-fader-cap-wrap">
          <div class="mmpc-fader-rail">
            <div class="mmpc-fader-rail-mark" style="top:25%"></div>
            <div class="mmpc-fader-rail-mark" style="top:50%"></div>
            <div class="mmpc-fader-rail-mark" style="top:75%"></div>
          </div>
          <div class="mmpc-fader-cap" id="mmpcCap_${safeId}" style="top:${capTop}%"></div>
          <input type="range" class="mmpc-fader-input"
            min="0" max="100" value="${vol}"
            title="${pad.name} Volume"
            data-file="${pad.file}" data-t="vol"
            data-safeid="${safeId}">
        </div>
        <div class="mmpc-vu-wrap">
          <div class="mmpc-vu-bar" id="mmpcVu_${safeId}"></div>
        </div>
      </div>

      <div class="mmpc-ch-val" id="mmpcChVal_${safeId}">${vol}%</div>

      <div class="mmpc-ch-rev-wrap">
        <div class="mmpc-rev-knob" id="mmpcRevKnob_${safeId}" title="${pad.name} Reverb">
          <div class="mmpc-rev-knob-dot" id="mmpcRevDot_${safeId}"></div>
        </div>
        <span class="mmpc-ch-rev-lbl">RV</span>
      </div>

      <div class="mmpc-ch-name" title="${pad.name}">${pad.name}</div>
    `;

    // Wire fader input → move cap + update value
    ch.querySelector('[data-t="vol"]').oninput=function(){
      const v=parseInt(this.value);
      mmpcSetPadProp(this.dataset.file,'vol',v/100);
      const lbl=document.getElementById('mmpcChVal_'+this.dataset.safeid);
      if(lbl) lbl.textContent=v+'%';
      const cap=document.getElementById('mmpcCap_'+this.dataset.safeid);
      if(cap) cap.style.top=(88-(v/100)*80)+'%';
    };
    // Wire pan
    ch.querySelector('[data-t="pan"]').oninput=function(){
      mmpcSetPadProp(this.dataset.file,'pan',parseInt(this.value)/100);
      const dot=document.getElementById('mmpcPanDot_'+this.dataset.file.replace(/[^a-zA-Z0-9_]/g,'_'));
      if(dot) dot.style.left='calc(50% + '+Math.round(parseInt(this.value)*0.12)+'px - 2.5px)';
    };
    // Wire reverb knob
    const knobEl=ch.querySelector('#mmpcRevKnob_'+safeId);
    const dotEl=ch.querySelector('#mmpcRevDot_'+safeId);
    if(knobEl&&dotEl) mmpcMakeRevKnob(knobEl,dotEl,rev,pad.file);

    strip.appendChild(ch);
  });
}

function mmpcSetPadProp(file,prop,val){
  [...mmpcGetBanks()[0],...mmpcGetBanks()[1],...mmpcGetBanks()[2]].forEach(p=>{
    if(p.file===file) p[prop]=val;
  });
}

// ── COLLAPSE TOGGLE ──
window.mmpcToggleOpen=function(){
  const body=document.getElementById('mmpcBody');
  const arrow=document.getElementById('mmpcArrow');
  if(!body||!arrow) return;
  const isOpen=body.classList.toggle('open');
  arrow.classList.toggle('open',isOpen);
  if(isOpen){
    if(Object.keys(mmpcBuffers).length===0) mmpcLoadSamples();
    if(!mmpcMidiAccess) mmpcInitMidi();
    mmpcGetReverb(); // pre-build reverb IR
  }
};

// ── AUDIO ──
function mmpcCtx(){
  // Share the global AudioContext from state.js — no separate context needed.
  // If AC isn't ready yet (shouldn't happen), fall back gracefully.
  if(typeof AC !== 'undefined' && AC) return AC;
  console.warn('[PercussionCenter] Global AC not found — check state.js load order');
  return null;
}

// ── LOAD SAMPLES ──
async function mmpcLoadSamples(){
  if(typeof _sampleBlobUrl!=='function'){ setTimeout(mmpcLoadSamples,2000); return; }
  const allPads=[...MMPC_BANK_A,...mmpcBankB,...mmpcBankC];
  let loaded=0;
  for(const pad of allPads){
    if(!pad.file||mmpcBuffers[pad.file]||pad.custom) continue;
    try{
      const url=await _sampleBlobUrl('hmpi_diane_perc',pad.file);
      if(!url) continue;
      const resp=await fetch(url);
      const ab=await resp.arrayBuffer();
      mmpcBuffers[pad.file]=await mmpcCtx().decodeAudioData(ab);
      loaded++;
    }catch(e){ console.warn('[MiniMPC] Could not load:',pad.file,e.message); }
  }
  const el=document.getElementById('mmpcSampleStatus');
  if(el){
    el.textContent=loaded>0?loaded+' samples ready':'samples not found';
    el.style.color=loaded>0?'rgba(64,224,208,.6)':'var(--red)';
  }
  console.log('[MiniMPC] Loaded',loaded,'of',allPads.filter(p=>p.file&&!p.custom).length,'samples');
  mmpcRenderMixer(); // update mixer strip with loaded pads
}

// ── CUSTOM SAMPLE ──
// ── SAMPLE TRIM MODAL ─────────────────────────────────────────
// Shows waveform + draggable start marker so user can trim dead
// space before confirming. Preview plays trimmed version live.

function mmpcDrawWaveform(canvas, buffer, startFrac){
  const ctx=canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const data=buffer.getChannelData(0);
  const step=Math.ceil(data.length/W);
  ctx.strokeStyle='rgba(170,102,255,.7)';
  ctx.lineWidth=1;
  ctx.beginPath();
  for(let x=0;x<W;x++){
    let min=1,max=-1;
    for(let j=0;j<step;j++){
      const s=data[x*step+j]||0;
      if(s<min)min=s; if(s>max)max=s;
    }
    const yMin=((1+min)/2)*H;
    const yMax=((1+max)/2)*H;
    if(x===0) ctx.moveTo(x,H/2); else { ctx.lineTo(x,yMin); ctx.lineTo(x,yMax); }
  }
  ctx.stroke();
  // Center line
  ctx.strokeStyle='rgba(255,255,255,.06)';
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
}

function mmpcApplyTrim(buffer, startFrac){
  const startSample=Math.floor(startFrac*buffer.length);
  if(startSample<=0) return buffer;
  const ctx=mmpcCtx();
  const len=buffer.length-startSample;
  if(len<=0) return buffer;
  const t=ctx.createBuffer(buffer.numberOfChannels,len,buffer.sampleRate);
  for(let c=0;c<buffer.numberOfChannels;c++)
    t.getChannelData(c).set(buffer.getChannelData(c).slice(startSample));
  return t;
}

function mmpcShowTrimModal(buffer, fileName, onConfirm){
  // Remove any existing modal
  const existing=document.getElementById('mmpcTrimOverlay');
  if(existing) existing.remove();

  let startFrac=0; // 0-1, where trimmed start is
  let previewSrc=null;
  const duration=buffer.duration;

  const overlay=document.createElement('div');
  overlay.className='mmpc-trim-overlay'; overlay.id='mmpcTrimOverlay';
  overlay.innerHTML=`
    <div class="mmpc-trim-modal">
      <div class="mmpc-trim-title">✂ Trim Sample — ${fileName}</div>
      <div class="mmpc-trim-waveform" id="mmpcTrimWaveWrap">
        <canvas id="mmpcTrimCanvas" width="440" height="80"></canvas>
        <div class="mmpc-trim-shade" id="mmpcTrimShade" style="width:0%"></div>
        <div class="mmpc-trim-marker" id="mmpcTrimMarker" style="left:0%"></div>
      </div>
      <div class="mmpc-trim-row">
        <span class="mmpc-trim-lbl">Start</span>
        <input type="range" class="mmpc-trim-slider" id="mmpcTrimSlider"
          min="0" max="1000" value="0" step="1">
        <span class="mmpc-trim-val" id="mmpcTrimVal">0.000s</span>
      </div>
      <div style="font-size:.6rem;color:var(--text-dim);margin-bottom:.5rem;">
        Drag the slider or click the waveform to set the start point. Hit Preview to audition.
      </div>
      <div class="mmpc-trim-btns">
        <button class="mmpc-trim-btn cancel" id="mmpcTrimCancel">Cancel</button>
        <button class="mmpc-trim-btn preview" id="mmpcTrimPreview">▶ Preview</button>
        <button class="mmpc-trim-btn confirm" id="mmpcTrimConfirm">✓ Confirm Trim</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Draw waveform
  const canvas=document.getElementById('mmpcTrimCanvas');
  mmpcDrawWaveform(canvas, buffer, 0);

  function updateMarker(frac){
    startFrac=Math.max(0,Math.min(0.98,frac));
    const pct=(startFrac*100).toFixed(1);
    document.getElementById('mmpcTrimMarker').style.left=pct+'%';
    document.getElementById('mmpcTrimShade').style.width=pct+'%';
    document.getElementById('mmpcTrimSlider').value=Math.round(startFrac*1000);
    document.getElementById('mmpcTrimVal').textContent=(startFrac*duration).toFixed(3)+'s';
  }

  // Slider
  document.getElementById('mmpcTrimSlider').oninput=function(){
    updateMarker(parseInt(this.value)/1000);
  };

  // Click on waveform
  const waveWrap=document.getElementById('mmpcTrimWaveWrap');
  waveWrap.addEventListener('click',e=>{
    const rect=waveWrap.getBoundingClientRect();
    updateMarker((e.clientX-rect.left)/rect.width);
  });
  // Drag on waveform
  let waving=false;
  waveWrap.addEventListener('mousedown',()=>{ waving=true; });
  window.addEventListener('mousemove',e=>{
    if(!waving) return;
    const rect=waveWrap.getBoundingClientRect();
    updateMarker((e.clientX-rect.left)/rect.width);
  });
  window.addEventListener('mouseup',()=>{ waving=false; });

  // Preview
  document.getElementById('mmpcTrimPreview').onclick=function(){
    if(previewSrc){ try{previewSrc.stop();}catch(e){} previewSrc=null; }
    const trimmed=mmpcApplyTrim(buffer,startFrac);
    const ctx=mmpcCtx();
    previewSrc=ctx.createBufferSource();
    previewSrc.buffer=trimmed;
    previewSrc.connect(ctx.destination);
    previewSrc.start();
    this.textContent='▶ Playing...';
    const btn=this;
    previewSrc.onended=()=>{ btn.textContent='▶ Preview'; previewSrc=null; };
  };

  // Confirm
  document.getElementById('mmpcTrimConfirm').onclick=function(){
    if(previewSrc){ try{previewSrc.stop();}catch(e){} }
    const trimmed=mmpcApplyTrim(buffer,startFrac);
    overlay.remove();
    onConfirm(trimmed);
  };

  // Cancel
  document.getElementById('mmpcTrimCancel').onclick=function(){
    if(previewSrc){ try{previewSrc.stop();}catch(e){} }
    overlay.remove();
  };
}

async function mmpcLoadCustomSample(bankIdx,padIdx){
  return new Promise(resolve=>{
    const input=document.createElement('input');
    input.type='file'; input.accept='.wav,.mp3,.aif,.aiff,.opus';
    input.onchange=async e=>{
      const file=e.target.files[0]; if(!file){resolve();return;}
      try{
        const ab=await file.arrayBuffer();
        const decoded=await mmpcCtx().decodeAudioData(ab.slice(0));
        const displayName=file.name.replace(/[.][^.]+$/,'');
        const padName=displayName.toUpperCase().slice(0,8);

        // Show trim modal — user confirms trim before sample is committed
        mmpcShowTrimModal(decoded, displayName, function(finalBuffer){
          const key='custom_'+bankIdx+'_'+padIdx+'_'+Date.now();
          mmpcBuffers[key]=finalBuffer;
          const bank=mmpcGetBanks()[bankIdx];
          const existingNote=bank[padIdx].note||(80+padIdx);
          const existingKey=bank[padIdx].key||null;
          bank[padIdx]={
            note:existingNote, name:padName,
            file:key, key:existingKey,
            custom:true, empty:false,
            vol:bank[padIdx].vol||1.0,
            pan:bank[padIdx].pan||0,
            rev:bank[padIdx].rev||0
          };
          mmpcRenderPads();
          mmpcRenderMixer();
          mmpcRebuildKeyMap(); // make new pad immediately keyboard-playable
          if(typeof showNotification==='function')
            showNotification('✓ Loaded: '+padName+(existingKey?' — Key: '+existingKey.toUpperCase():''));
          resolve(key);
        });
      }catch(err){alert('Could not load sample: '+err.message);resolve();}
      e.target.value='';
    };
    input.click();
  });
}

// ── TRIGGER with pan and reverb ──
function mmpcTrigger(file,vel,padVol,padPan,padRev){
  const buf=mmpcBuffers[file]; if(!buf) return;
  const ctx=mmpcCtx();
  const src=ctx.createBufferSource(); src.buffer=buf;
  const g=ctx.createGain();
  g.gain.value=Math.pow(vel/127,0.85)*(padVol||1.0);
  const panner=ctx.createStereoPanner();
  panner.pan.value=padPan||0;
  src.connect(g); g.connect(panner);
  // Apply reverb if send > 0
  const revAmt=padRev||0;
  if(revAmt>0.01 && mmpcReverbBuffer){
    const dry=ctx.createGain(); dry.gain.value=1-revAmt*0.5;
    const wet=ctx.createGain(); wet.gain.value=revAmt;
    const conv=ctx.createConvolver(); conv.buffer=mmpcReverbBuffer;
    panner.connect(dry); dry.connect(ctx.destination);
    panner.connect(conv); conv.connect(wet); wet.connect(ctx.destination);
  } else {
    panner.connect(ctx.destination);
  }
  src.start();
  // Flash VU meter for this pad
  const safeFile = file.replace(/[^a-zA-Z0-9_]/g,'_');
  mmpcFlashVu(safeFile, Math.pow(vel/127,0.85)*(padVol||1.0));
}

// ── RENDER PADS ──
window.mmpcSetBank=function(bankIdx,btn){
  mmpcBank=bankIdx;
  document.querySelectorAll('.mini-mpc-tab').forEach(t=>t.classList.remove('active'));
  if(btn) btn.classList.add('active');
  mmpcCloseVolPopup();
  mmpcRenderPads();
};

function mmpcRenderPads(){
  const grid=document.getElementById('mmpcPadGrid'); if(!grid) return;
  grid.innerHTML='';
  // Bank C hint
  if(mmpcBank===2){
    const hint=document.createElement('div');
    hint.className='mmpc-bankc-hint';
    hint.style.gridColumn='1/-1';
    hint.textContent='Bank C — Your Samples. Click any pad to load a WAV or MP3.';
    grid.appendChild(hint);
  }
  const bank=mmpcGetBanks()[mmpcBank];
  const order=mmpcPadOrder(mmpcBank);
  order.forEach(idx=>{
    const pad=bank[idx]; if(!pad) return;
    const isEmpty=!pad.file;
    const isCustom=pad.custom&&pad.file;
    const el=document.createElement('div');
    el.className='mini-pad'+(isEmpty?' empty-pad':isCustom?' custom-pad':'');
    el.dataset.idx=idx; el.dataset.bank=mmpcBank;
    el.style.position='relative';
    el.innerHTML=`<div class="mini-pad-num">${idx+1}</div>${pad.key?`<div class="mini-pad-key">${pad.key.toUpperCase()}</div>`:''}`;
    if(isEmpty){
      el.innerHTML+=`<div class="mini-pad-plus">+</div>`;
      el.title='Click to load your own sample'+(pad.key?' (Key: '+pad.key.toUpperCase()+')':'');
      el.onclick=()=>mmpcLoadCustomSample(mmpcBank,idx);
    } else {
      el.innerHTML+=isCustom
        ?`<div class="mini-pad-custom-lbl">${pad.name}</div><button class="mini-pad-rm" onclick="event.stopPropagation();mmpcClearPad(${mmpcBank},${idx})">x</button>`
        :`<div class="mini-pad-name">${pad.name}</div>`;
      el.onmousedown=e=>{ if(e.target.classList.contains('mini-pad-rm')) return; mmpcFirePad(mmpcBank,idx,100); };
      el.oncontextmenu=e=>{ e.preventDefault(); mmpcShowVolPopup(mmpcBank,idx,el); };
    }
    grid.appendChild(el);
  });
}

window.mmpcClearPad=function(bankIdx,padIdx){
  const bank=mmpcGetBanks()[bankIdx];
  if(bankIdx===1&&padIdx<8) bank[padIdx]={...MMPC_BANK_B_STOCK[padIdx]};
  else bank[padIdx]={note:bank[padIdx].note,name:'OPEN',file:null,key:null,custom:true,empty:true,vol:1.0,pan:0,rev:0};
  mmpcRenderPads();
};

// ── PER-PAD VOLUME ──
function mmpcShowVolPopup(bankIdx,padIdx,padEl){
  mmpcCloseVolPopup();
  const pad=mmpcGetBanks()[bankIdx][padIdx];
  const popup=document.createElement('div');
  popup.className='pad-vol-popup'; popup.id='mmpcVolPopup';
  const vol=Math.round((pad.vol||1.0)*100);
  popup.innerHTML=`
    <div class="pad-vol-popup-lbl">${pad.name} Volume</div>
    <input type="range" class="pad-vol-slider" min="0" max="100" value="${vol}"
      oninput="mmpcSetPadVol(${bankIdx},${padIdx},this.value)">
    <div style="font-size:.58rem;color:var(--text-dim);text-align:center;margin-top:2px;" id="mmpcVolVal">${vol}%</div>
  `;
  padEl.appendChild(popup);
  setTimeout(()=>document.addEventListener('click',mmpcCloseVolPopup,{once:true}),10);
}

window.mmpcSetPadVol=function(bankIdx,padIdx,val){
  mmpcGetBanks()[bankIdx][padIdx].vol=parseInt(val)/100;
  const lbl=document.getElementById('mmpcVolVal'); if(lbl) lbl.textContent=val+'%';
};

function mmpcCloseVolPopup(){
  const p=document.getElementById('mmpcVolPopup'); if(p) p.remove();
}

// ── FIRE PAD ──
function mmpcFirePad(bankIdx,padIdx,vel){
  const pad=mmpcGetBanks()[bankIdx][padIdx];
  if(!pad||!pad.file) return;
  mmpcTrigger(pad.file,vel,pad.vol||1.0,pad.pan||0,pad.rev||0);
  const el=document.querySelector(`.mini-pad[data-bank="${bankIdx}"][data-idx="${padIdx}"]`);
  if(el){el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),80);}
  if(mmpcIsRecording && mmpcActiveLayer>=0 && mmpcStartTime!==null){
    const ctx=mmpcCtx();
    const ms=(ctx.currentTime-mmpcStartTime)*1000;
    const rawTick=Math.round((ms/(60000/mmpcBpmVal))*MMPC_TPQN)%mmpcLoopTicks();
    const finalTick=mmpcApplyQuantize(rawTick);
    mmpcLayers[mmpcActiveLayer].events.push({tick:finalTick,note:pad.note,vel,padVol:pad.vol||1.0,padPan:pad.pan||0,padRev:pad.rev||0});
    mmpcRenderLayers();
  }
}

// ── QUANTIZE ──
function mmpcOnQChange(){
  const qNote=document.getElementById('mmpcQNote');
  const swingWrap=document.getElementById('mmpcSwingWrap');
  if(swingWrap) swingWrap.style.display=(qNote&&qNote.value==='8sw')?'flex':'none';
}

function mmpcApplyQuantize(rawTick){
  const qNote=document.getElementById('mmpcQNote');
  const qStr=document.getElementById('mmpcQStr');
  if(!qNote||qNote.value==='0') return rawTick;
  const strength=(qStr?parseInt(qStr.value):100)/100;

  // ── Swing quantize ──────────────────────────────────────────
  if(qNote.value==='8sw'){
    const swingEl=document.getElementById('mmpcSwingAmt');
    const swingPct=(swingEl?parseInt(swingEl.value):62)/100; // 0.50–0.75
    const beatTicks=MMPC_TPQN;           // ticks per beat
    const downTicks=Math.round(beatTicks*swingPct*2);  // long subdivision
    const upTicks  =beatTicks*2-downTicks;              // short subdivision
    // Find which beat we're on and position within that beat
    const beatPos=rawTick%beatTicks;
    const beatStart=rawTick-beatPos;
    // Two grid points per beat: beat itself (0) and swung offbeat (downTicks/2 equivalent)
    const swingOffset=Math.round(downTicks/2);
    const nearest=beatPos<swingOffset/2+upTicks/2 ? 0 : swingOffset;
    const nearestTick=(beatStart+nearest)%mmpcLoopTicks();
    return Math.round(rawTick+(nearestTick-rawTick)*strength)%mmpcLoopTicks();
  }

  // ── Standard quantize ───────────────────────────────────────
  const map={'4':MMPC_TPQN,'4t':Math.round(MMPC_TPQN*2/3),'8':MMPC_TPQN/2,'8t':Math.round(MMPC_TPQN/3),'16':MMPC_TPQN/4,'16t':Math.round(MMPC_TPQN/6)};
  const gridTicks=map[qNote.value]; if(!gridTicks) return rawTick;
  const nearest=Math.round(rawTick/gridTicks)*gridTicks;
  return Math.round(rawTick+(nearest-rawTick)*strength)%mmpcLoopTicks();
}

// ── TIME SIGNATURE ──
window.mmpcSetTimeSig=function(v){
  mmpcBPB=parseInt(v);
  if(mmpcMetroOn) mmpcRestartMetro();
};

// ── KEYBOARD ──
// Build a dynamic key map covering all three banks including open/custom slots.
// Rebuilt whenever a custom sample is loaded so new pads become immediately playable.
const mmpcKeyMap={};
function mmpcRebuildKeyMap(){
  Object.keys(mmpcKeyMap).forEach(k=>delete mmpcKeyMap[k]);
  mmpcGetBanks().forEach((bank,bi)=>{
    bank.forEach((p,idx)=>{
      if(p.key && p.file) mmpcKeyMap[p.key]={bank:bi,idx};
    });
  });
}
// Initial build from stock pads
mmpcRebuildKeyMap();
document.addEventListener('keydown',e=>{
  if(e.repeat||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  const body=document.getElementById('mmpcBody');
  if(!body||!body.classList.contains('open')) return;
  const m=mmpcKeyMap[e.key.toLowerCase()]; if(m) mmpcFirePad(m.bank,m.idx,100);
});

// ── TRANSPORT ──
window.mmpcToggleRec=function(){
  if(mmpcActiveLayer<0){
    if(typeof showNotification==='function')
      showNotification('Arm a layer first — click the red circle on a layer');
    else alert('Arm a layer first — click the red circle on a layer');
    return;
  }
  if(!mmpcIsPlaying) mmpcStart(true);
  else{mmpcIsRecording=!mmpcIsRecording; mmpcUpdateUI();}
};
window.mmpcTogglePlay=function(){ if(!mmpcIsPlaying) mmpcStart(false); };
window.mmpcStop=function(){
  mmpcIsPlaying=false; mmpcIsRecording=false;
  clearTimeout(mmpcLoopTimer); clearInterval(mmpcTickTimer);
  mmpcLoopTimer=null; mmpcTickTimer=null; mmpcStartTime=null;
  mmpcStopMetro();
  const p=document.getElementById('mmpcPos'); if(p) p.textContent='1.1';
  mmpcUpdateUI();
};
window.mmpcSetBars=function(v){ mmpcBars=parseInt(v); };
window.mmpcBpm=function(d){
  mmpcBpmVal=Math.max(40,Math.min(240,mmpcBpmVal+d));
  const el=document.getElementById('mmpcBpmDisp'); if(el) el.value=mmpcBpmVal;
  if(mmpcMetroOn) mmpcRestartMetro();
};

window.mmpcBpmSet=function(val){
  if(!val||isNaN(val)) return;
  mmpcBpmVal=Math.max(40,Math.min(240,val));
  const el=document.getElementById('mmpcBpmDisp'); if(el) el.value=mmpcBpmVal;
  if(mmpcMetroOn) mmpcRestartMetro();
};

function mmpcStart(rec){
  mmpcStop();
  mmpcIsPlaying=true; mmpcIsRecording=rec;
  // Don't clear events on rec — overdub into the armed layer
  const ctx=mmpcCtx(); mmpcStartTime=ctx.currentTime;
  mmpcScheduleLoop(); mmpcTickTimer=setInterval(mmpcUpdatePos,32);
  if(mmpcMetroOn){mmpcMetroBeat=0;mmpcMetroNext=ctx.currentTime;mmpcScheduleMetro();}
  mmpcUpdateUI();
  if(Object.keys(mmpcBuffers).length===0) mmpcLoadSamples();
}

function mmpcScheduleLoop(){
  if(!mmpcIsPlaying) return;
  const ctx=mmpcCtx();
  const loopMs=(mmpcLoopTicks()/MMPC_TPQN)*(60000/mmpcBpmVal);
  const elapsed=(ctx.currentTime-mmpcStartTime)*1000;
  const loopStart=mmpcStartTime+(Math.floor(elapsed/loopMs)*loopMs/1000);
  // Play all unmuted layers
  mmpcLayers.forEach(ly=>{
    if(ly.muted||!ly.events.length) return;
    ly.events.forEach(ev=>{
      const evT=loopStart+(ev.tick/MMPC_TPQN)*(60/mmpcBpmVal);
      if(evT>=ctx.currentTime-0.01){
        const allPads=[...MMPC_BANK_A,...mmpcBankB,...mmpcBankC];
        const pad=allPads.find(p=>p.note===ev.note);
        if(pad&&pad.file&&mmpcBuffers[pad.file]){
          const src=ctx.createBufferSource(); src.buffer=mmpcBuffers[pad.file];
          const g=ctx.createGain();
          g.gain.value=Math.pow(ev.vel/127,0.85)*(ev.padVol||1.0)*ly.volume;
          const pp=ctx.createStereoPanner();
          pp.pan.value=(ev.padPan||0)+(ly.pan||0); // combine pad pan + layer pan
          src.connect(g); g.connect(pp);
          const revAmt=ev.padRev||0;
          if(revAmt>0.01&&mmpcReverbBuffer){
            const dry=ctx.createGain();dry.gain.value=1-revAmt*0.5;
            const wet=ctx.createGain();wet.gain.value=revAmt;
            const conv=ctx.createConvolver();conv.buffer=mmpcReverbBuffer;
            pp.connect(dry);dry.connect(ctx.destination);
            pp.connect(conv);conv.connect(wet);wet.connect(ctx.destination);
          } else {
            pp.connect(ctx.destination);
          }
          src.start(evT);
          // Flash VU meter at scheduled time
          const evDelay = Math.max(0,(evT - ctx.currentTime)*1000);
          const safeF=pad.file.replace(/[^a-zA-Z0-9_]/g,'_');
          setTimeout(()=>mmpcFlashVu(safeF,Math.pow(ev.vel/127,0.85)*(ev.padVol||1.0)*ly.volume), evDelay);
        }
      }
    });
  });
  const nextMs=loopMs-(elapsed%loopMs);
  mmpcLoopTimer=setTimeout(mmpcScheduleLoop,nextMs-20);
}

function mmpcUpdatePos(){
  if(!mmpcIsPlaying||!mmpcStartTime) return;
  const ctx=mmpcCtx();
  const loopMs=(mmpcLoopTicks()/MMPC_TPQN)*(60000/mmpcBpmVal);
  const posBeats=((ctx.currentTime-mmpcStartTime)*1000%loopMs)/(60000/mmpcBpmVal);
  const bar=Math.floor(posBeats/mmpcBPB)+1;
  const beat=Math.floor(posBeats%mmpcBPB)+1;
  const el=document.getElementById('mmpcPos'); if(el) el.textContent=bar+'.'+beat;
}

function mmpcUpdateUI(){
  const r=document.getElementById('mmpcRecBtn');
  const p=document.getElementById('mmpcPlayBtn');
  if(r) r.classList.toggle('active',mmpcIsRecording);
  if(p) p.classList.toggle('active',mmpcIsPlaying&&!mmpcIsRecording);
}

// ── METRONOME ──
window.mmpcToggleMetro=function(){
  mmpcMetroOn=!mmpcMetroOn;
  const btn=document.getElementById('mmpcMetroBtn');
  if(btn){btn.textContent='Metro: '+(mmpcMetroOn?'On':'Off');btn.classList.toggle('active',mmpcMetroOn);}
  if(mmpcMetroOn&&mmpcIsPlaying){mmpcMetroBeat=0;mmpcMetroNext=mmpcCtx().currentTime;mmpcScheduleMetro();}
  else mmpcStopMetro();
};
function mmpcStopMetro(){ clearTimeout(mmpcMetroTimer); mmpcMetroTimer=null; }
function mmpcRestartMetro(){ mmpcStopMetro(); if(mmpcMetroOn&&mmpcIsPlaying){mmpcMetroBeat=0;mmpcMetroNext=mmpcCtx().currentTime;mmpcScheduleMetro();} }

function mmpcScheduleMetro(){
  if(!mmpcMetroOn) return;
  const ctx=mmpcCtx();
  const vol=parseFloat(document.getElementById('mmpcMetroVol')?.value||0.6);
  const beatMs=60000/mmpcBpmVal;
  while(mmpcMetroNext<ctx.currentTime+0.2){
    mmpcClickTone(mmpcMetroNext,mmpcMetroBeat===0,vol);
    mmpcMetroBeat=(mmpcMetroBeat+1)%mmpcBPB;
    mmpcMetroNext+=beatMs/1000;
  }
  mmpcMetroTimer=setTimeout(mmpcScheduleMetro,50);
}

function mmpcClickTone(time,isBeat1,vol){
  const ctx=mmpcCtx();
  const makeClick=(freq,gain,decay)=>{
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.frequency.value=freq; o.type='sine';
    g.gain.setValueAtTime(gain,time);
    g.gain.exponentialRampToValueAtTime(0.001,time+decay);
    o.connect(g);g.connect(ctx.destination);o.start(time);o.stop(time+decay+0.01);
  };
  if(isBeat1){ makeClick(1800,vol,0.04); makeClick(200,vol*0.5,0.06); }
  else        { makeClick(900,vol*0.3,0.03); }
}

// ── MIDI EXPORT ──
window.mmpcExportMidi=function(){
  const hasEvents=mmpcLayers.some(ly=>ly.events.length>0);
  if(!hasEvents){alert('Nothing recorded yet — arm a layer and record first.');return;}
  const tempo=Math.round(60000000/mmpcBpmVal);
  function vlq(v){if(v<0x80)return[v];const b=[];while(v>0){b.unshift(v&0x7f);v>>=7;}for(let i=0;i<b.length-1;i++)b[i]|=0x80;return b;}
  function u32(v){return[(v>>24)&0xff,(v>>16)&0xff,(v>>8)&0xff,v&0xff];}
  function u16(v){return[(v>>8)&0xff,v&0xff];}
  let evs=[];
  mmpcLayers.forEach(ly=>{
    if(!ly.events.length||ly.muted) return;
    ly.events.forEach(ev=>{
      const vel=Math.min(127,Math.round(ev.vel*(ev.padVol||1.0)*ly.volume));
      evs.push({tick:ev.tick,t:'on',note:ev.note,vel,ch:9});
      evs.push({tick:ev.tick+20,t:'off',note:ev.note,vel:0,ch:9});
    });
  });
  evs.sort((a,b)=>a.tick-b.tick);
  const trk=[];
  trk.push(...vlq(0),0xff,0x51,0x03,(tempo>>16)&0xff,(tempo>>8)&0xff,tempo&0xff);
  let last=0;
  evs.forEach(e=>{trk.push(...vlq(e.tick-last));last=e.tick;trk.push(e.t==='on'?0x90|e.ch:0x80|e.ch,e.note,e.vel);});
  trk.push(...vlq(mmpcLoopTicks()-last),0xff,0x2f,0x00);
  const hdr=[0x4d,0x54,0x68,0x64,...u32(6),...u16(0),...u16(1),...u16(MMPC_TPQN)];
  const trkC=[0x4d,0x54,0x72,0x6b,...u32(trk.length),...trk];
  const bytes=new Uint8Array([...hdr,...trkC]);
  const blob=new Blob([bytes],{type:'audio/midi'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='VWB_Perc_'+mmpcBpmVal+'bpm.mid'; a.click();
  URL.revokeObjectURL(url);
  if(typeof showNotification==='function') showNotification('MIDI exported: VWB_Perc_'+mmpcBpmVal+'bpm.mid');
};

// ── IMPORT LOOP ──
window.mmpcImportLoop=function(){
  const input=document.createElement('input');
  input.type='file'; input.accept='.mid,.midi';
  input.onchange=async e=>{
    const file=e.target.files[0]; if(!file) return;
    const ab=await file.arrayBuffer();
    try{
      const parsed=mmpcParseMidi(ab);
      const title=file.name.replace(/[.]midi?$/i,'').replace(/_/g,' ');
      mmpcLoops.push({title,bpm:parsed.bpm||mmpcBpmVal,events:parsed.notes,duration:parsed.duration,speed:1.0});
      mmpcRenderLoopList();
      if(typeof showNotification==='function') showNotification('Loop loaded: '+title);
    }catch(err){alert('Could not read MIDI file: '+err.message);}
    e.target.value='';
  };
  input.click();
};

function mmpcParseMidi(buffer){
  const view=new DataView(buffer); let pos=0;
  function ru32(){const v=view.getUint32(pos);pos+=4;return v;}
  function ru16(){const v=view.getUint16(pos);pos+=2;return v;}
  function ru8(){return view.getUint8(pos++);}
  function vlq(){let val=0,b;do{b=ru8();val=(val<<7)|(b&0x7f);}while(b&0x80);return val;}
  if(ru32()!==0x4D546864) throw new Error('Not a MIDI file');
  ru32();ru16();const numTracks=ru16();const tpqn=ru16();
  let tempoUs=500000;const notes=[];
  for(let t=0;t<numTracks;t++){
    if(ru32()!==0x4D54726B) break;
    const trackEnd=pos+ru32(); let tick=0,rs=0;
    while(pos<trackEnd){
      tick+=vlq();let st=view.getUint8(pos);
      if(st&0x80){rs=st;pos++;}else{st=rs;}
      const cmd=st&0xf0;
      if(cmd===0x90){const n=ru8(),v=ru8();if(v>0)notes.push({tick,note:n,vel:v,timeSec:tick/tpqn*(tempoUs/1e6)});}
      else if(cmd===0x80){ru8();ru8();}
      else if(cmd===0xa0||cmd===0xb0||cmd===0xe0){ru8();ru8();}
      else if(cmd===0xc0||cmd===0xd0){ru8();}
      else if(st===0xff){const mt=ru8(),ml=vlq();if(mt===0x51&&ml===3){tempoUs=(view.getUint8(pos)<<16)|(view.getUint8(pos+1)<<8)|view.getUint8(pos+2);}pos+=ml;}
      else if(st===0xf0||st===0xf7){pos+=vlq();}
      else pos++;
    }
    pos=trackEnd;
  }
  const bpm=Math.round(60000000/tempoUs);
  const duration=notes.length?Math.max(...notes.map(n=>n.timeSec))+0.5:0;
  return{notes,bpm,tpqn,duration};
}

function mmpcRenderLoopList(){
  const list=document.getElementById('mmpcLoopList');
  const noLoops=document.getElementById('mmpcNoLoops');
  if(!list) return;
  if(mmpcLoops.length===0){
    list.innerHTML=''; if(noLoops){noLoops.style.display='block';list.appendChild(noLoops);} return;
  }
  if(noLoops) noLoops.style.display='none';
  list.innerHTML='';
  mmpcLoops.forEach((loop,i)=>{
    const isActive=i===mmpcActiveLoop;
    const el=document.createElement('div');
    el.className='mmpc-loop-item'+(isActive?' active-loop':'');
    el.innerHTML=`
      <button class="mmpc-loop-play ${isActive?'on':''}" onclick="mmpcPlayLoop(${i})">${isActive?'■':'▶'}</button>
      <div class="mmpc-loop-title" title="${loop.title}">${loop.title}</div>
      <input type="range" class="mmpc-loop-speed" min="50" max="200" value="${Math.round((loop.speed||1)*100)}"
        title="Speed" oninput="mmpcSetLoopSpeed(${i},this.value)" style="width:44px;">
      <div class="mmpc-loop-meta">${Math.round((loop.speed||1)*loop.bpm)}bpm</div>
      <button class="mmpc-loop-rm" onclick="mmpcRemoveLoop(${i})">x</button>
    `;
    list.appendChild(el);
  });
}

window.mmpcPlayLoop=function(idx){
  if(mmpcActiveLoop===idx){mmpcActiveLoop=-1;mmpcStop();mmpcRenderLoopList();return;}
  mmpcActiveLoop=idx;
  const loop=mmpcLoops[idx]; if(!loop) return;
  mmpcBpmVal=Math.round((loop.speed||1)*loop.bpm);
  const el=document.getElementById('mmpcBpmDisp'); if(el) el.value=mmpcBpmVal;
  // Load into layer 1 for playback
  if(mmpcLayers.length===0) mmpcLayers.push(mmpcMkLayer('Loop'));
  mmpcLayers[0].events=loop.events.map(e=>({tick:e.tick,note:e.note,vel:e.vel,padVol:1.0}));
  mmpcRenderLayers();
  mmpcStart(false); mmpcRenderLoopList();
};

window.mmpcSetLoopSpeed=function(idx,val){
  const loop=mmpcLoops[idx]; if(!loop) return;
  loop.speed=parseInt(val)/100;
  const items=document.querySelectorAll('.mmpc-loop-meta');
  if(items[idx]) items[idx].textContent=Math.round(loop.speed*loop.bpm)+'bpm';
  if(idx===mmpcActiveLoop) mmpcBpmVal=Math.round(loop.speed*loop.bpm);
};

window.mmpcRemoveLoop=function(idx){
  if(mmpcActiveLoop===idx){mmpcActiveLoop=-1;mmpcStop();}
  else if(mmpcActiveLoop>idx) mmpcActiveLoop--;
  mmpcLoops.splice(idx,1); mmpcRenderLoopList();
};

// ── MIDI KEYBOARD INPUT ──
// Uses Web MIDI API (already enabled in VWB's Electron main process)
// Maps C3(60) through C4(72) to Bank A pads 0-11 and Bank B pad 0
// Velocity sensitive — how hard you press controls the hit volume
let mmpcMidiAccess = null;

async function mmpcInitMidi(){
  try{
    mmpcMidiAccess = await navigator.requestMIDIAccess({sysex:false});
    mmpcMidiAccess.inputs.forEach(input => {
      input.onmidimessage = mmpcOnMidiMessage;
    });
    // Handle new devices plugged in after launch
    mmpcMidiAccess.onstatechange = e => {
      if(e.port.type === 'input'){
        e.port.onmidimessage = mmpcOnMidiMessage;
      }
    };
    const count = mmpcMidiAccess.inputs.size;
    console.log('[MiniMPC] MIDI inputs connected:', count);
    // Update status display
    const el = document.getElementById('mmpcSampleStatus');
    if(el && count > 0){
      const current = el.textContent;
      if(current && !current.includes('MIDI')) el.textContent = current + ' · MIDI ready';
    }
  } catch(e){
    console.warn('[MiniMPC] Web MIDI not available:', e.message);
  }
}

function mmpcOnMidiMessage(msg){
  const [status, note, velocity] = msg.data;
  const cmd = status & 0xf0;

  // Note On with velocity > 0
  if(cmd === 0x90 && velocity > 0){
    // Bank A: C3(48) through B3(59) = pads 0-11
    if(note >= 48 && note <= 59){
      const padIdx = note - 48;
      mmpcFirePad(0, padIdx, velocity);
      // Flash pad even if bank B is showing
      if(mmpcBank !== 0){
        // Still trigger audio, just no visual flash on wrong bank
      }
    }
    // Bank B: C4(60) through G4(67) = pads 0-7
    else if(note >= 60 && note <= 67){
      const padIdx = note - 60;
      mmpcFirePad(1, padIdx, velocity);
    }
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded',()=>{
  mmpcRenderPads();
  mmpcRenderLayers();
  mmpcRenderMixer();
  mmpcRenderLoopList();
  // Init MIDI keyboard input
  mmpcInitMidi();
  // Samples load on first open of the panel
});

})();
