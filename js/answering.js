import * as THREE from 'three';
import { sfx } from './sfx.js';

// 桌子左头电话旁边的答录机（bake_room.py 里的 ANSWERING，外壳见 blender/answering_prep.py）：
// 留言 = 别人对你的评价（index.html #messages）。
//   - 平时：MESSAGES 键旁边的小红灯——有没听过的留言就闪，几条留言闪几下、停一会儿再来（老答录机就是这样报数的）；
//     听过就灭（记在这个浏览器里，留言改了会重新闪）
//   - 点它 = 按 MESSAGES：咔一声磁带转起来，"嘀"，屏幕下方像字幕一样一个词一个词地出这条留言，下面写谁说的；
//     放完一条接下一条，再点一下跳到下一条（最后一条时点一下就停）；最后两声"嘀"，End of messages。Esc / 去别的地方就停
//   - 镜头不动：你只是站在桌边听留言
//   - 有录音（data-audio）就放录音，字跟着录音的长度出；没有就按念的速度出，底下垫一点磁带底噪
// manifest.answering.led = 小灯 { c 中心, n 法线, right 长边方向, up 短边方向, w, h }（世界坐标，米）
const STORE = 'scenecv.messages';
const WORD = 0.3;  // 没录音时每个词多久（秒）
const HOLD = 2.4;  // 一条出完以后停多久再接下一条
const BEEP = 0.45; // "嘀"的长度
const v3 = (a) => new THREE.Vector3().fromArray(a);

// 红灯的光晕：中间亮、往外淡的一张小图，叠加着画
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,90,60,1)');
  r.addColorStop(0.25, 'rgba(255,50,30,0.45)');
  r.addColorStop(1, 'rgba(255,30,20,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 留言改了（多了、少了、换了字）红灯要重新闪：记一个简单的指纹
const signature = (list) => {
  let h = 0;
  for (const ch of list.map((m) => m.text).join('|')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${list.length}:${h}`;
};

// 闪几下报数：每下 0.22 秒亮、0.28 秒灭，n 下之后停 1.4 秒。t = 秒 → 亮度 0..1
function blinkCount(t, n) {
  const on = 0.22, off = 0.28, cycle = n * (on + off) + 1.4;
  const p = t % cycle, k = Math.floor(p / (on + off));
  if (k >= n) return 0;
  const q = p - k * (on + off);
  return q < on ? Math.sin((q / on) * Math.PI) ** 0.5 : 0;
}

export function createAnsweringMachine(room, messages = [], { parent = document.body, before = null } = {}) {
  const M = room.manifest.answering;
  if (!M?.led) return null;
  const scene = room.scene, n = messages.length, sig = signature(messages);
  let heard = false;
  try { heard = localStorage.getItem(STORE) === sig; } catch { /* 隐私模式：每次都算没听过 */ }

  // 红灯：贴在暗缝上的一小条 + 叠加的光晕
  const led = M.led;
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const ledMesh = new THREE.Mesh(new THREE.PlaneGeometry(led.w, led.h), ledMat);
  const lr = v3(led.right).normalize(), lu = v3(led.up).normalize(), ln = new THREE.Vector3().crossVectors(lr, lu);
  ledMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lr, lu, ln));
  ledMesh.position.copy(v3(led.c));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  glow.scale.setScalar(led.w * 5); // 开场镜头里灯本身只有两三个像素：光晕大一点，才看得出是一盏在闪的红灯
  glow.position.copy(ledMesh.position).addScaledVector(ln, 0.002);
  ledMesh.userData.answering = true;
  scene.add(ledMesh, glow);
  const groups = [ledMesh];

  // 字幕：和电视字幕同一种底子（.tvsub），上面一行是答录机报的"第几条、什么时候"，下面一行是谁说的
  const sub = document.createElement('div');
  sub.className = 'tvsub amsub';
  sub.hidden = true;
  sub.innerHTML = '<p class="amsub-head"></p><p class="tvsub-text amsub-text" aria-live="polite"></p><p class="amsub-from"></p>';
  parent.insertBefore(sub, before);
  const headEl = sub.querySelector('.amsub-head'), textEl = sub.querySelector('.amsub-text'), fromEl = sub.querySelector('.amsub-from');

  // ---------- 放留言 ----------
  // run = { i, phase: 'beep' | 'talk' | 'hold' | 'end', t, words, dur, audio }
  let run = null, hissing = null, blinkT = 0;
  let rec = false, ackT = 0; // 电话那边在录留言：灯常亮；录完闪两下（ackT = 还剩几秒）
  const say = (head, words = [], from = '') => {
    headEl.textContent = head;
    textEl.replaceChildren(...words.map((w, i) => {
      const s = document.createElement('span');
      s.textContent = (i ? ' ' : '') + w;
      s.style.opacity = '0';
      return s;
    }));
    fromEl.textContent = from;
    sub.hidden = false;
  };
  function startMessage(i, delay = 0) {
    const m = messages[i];
    say(`Message ${i + 1} of ${n}${m.when ? ' · ' + m.when : ''}`, [], '');
    sfx.tone(1000, { dur: BEEP, delay });
    let audio = null;
    if (m.audio && sfx.on) {
      audio = new Audio(m.audio);
      audio.preload = 'auto';
    }
    run = { i, phase: 'beep', t: -delay, words: m.text.split(/\s+/), dur: 0, audio };
  }
  function talk() {
    const m = messages[run.i];
    say(headEl.textContent, run.words, m.name ? `— ${m.name}${m.role ? ', ' + m.role : ''}` : '');
    run.phase = 'talk';
    run.t = 0;
    run.dur = run.words.length * WORD;
    if (run.audio) {
      const a = run.audio;
      a.addEventListener('loadedmetadata', () => { if (run?.audio === a && isFinite(a.duration)) run.dur = a.duration; }, { once: true });
      if (isFinite(a.duration) && a.duration) run.dur = a.duration;
      a.play().catch(() => { /* 放不了就只出字 */ });
    }
    if (!run.audio && !hissing) hissing = sfx.hiss();
  }
  function finish() {
    run?.audio?.pause();
    say('End of messages', [], '');
    sfx.tone(1000, { dur: 0.16 });
    sfx.tone(1000, { dur: 0.16, delay: 0.26 });
    hissing?.stop();
    hissing = null;
    run = { phase: 'end', t: 0 };
  }
  function stop() {
    if (!run) return;
    run.audio?.pause();
    hissing?.stop();
    hissing = null;
    run = null;
    sub.hidden = true;
  }
  function next() {
    run?.audio?.pause();
    const i = run && run.phase !== 'end' ? run.i + 1 : n;
    if (i < n) startMessage(i); else finish();
  }

  return {
    groups,
    get playing() { return !!run; },
    hint() {
      if (!n) return 'Answering machine · No messages';
      if (run && run.phase !== 'end') return run.i + 1 < n ? 'Answering machine · Next message' : 'Answering machine · Stop';
      return heard ? `Answering machine · Play ${n} message${n > 1 ? 's' : ''}` : `Answering machine · ${n} new message${n > 1 ? 's' : ''}`;
    },
    // 点答录机 = 按 MESSAGES 键
    press() {
      sfx.play('key', { gain: 0.7, rate: 0.8 });
      if (!n) { sfx.tone(1000, { dur: 0.5, delay: 0.15 }); return; }
      if (run && run.phase !== 'end') {
        if (run.i + 1 < n) next(); else stop();
        return;
      }
      sfx.play('tape-latch', { gain: 0.35, rate: 1.25, delay: 0.05 }); // 磁带转起来
      if (!heard) {
        heard = true;
        try { localStorage.setItem(STORE, sig); } catch { /* 存不了就只在这一次里记着 */ }
      }
      startMessage(0, 0.35); // 先让磁带转一下再"嘀"
    },
    stop,
    // 电话那边（js/phone.js）：on = 在录（灯常亮）；录完 { blinks } 闪几下
    recording(on, { blinks = 0 } = {}) { rec = on; if (!on && blinks) ackT = blinks * 0.5; },
    update(dt) {
      // 红灯：没听过 = 几条留言闪几下；正在放 = 亮着；听过 = 灭
      blinkT += dt;
      let v = 0;
      if ((run && run.phase !== 'end') || rec) v = 1;
      else if (ackT > 0) { ackT = Math.max(0, ackT - dt); v = (ackT % 0.5) > 0.25 ? 1 : 0; }
      else if (n && !heard) v = blinkCount(blinkT, n);
      ledMat.color.setRGB(0.12 + 2.4 * v, 0.02 + 0.25 * v, 0.015 + 0.15 * v);
      glow.material.opacity = 0.85 * v;
      // 留言
      if (!run) return;
      run.t += dt;
      if (run.phase === 'beep' && run.t >= BEEP + 0.25) talk();
      else if (run.phase === 'talk') {
        const k = run.dur ? Math.min(1, run.t / run.dur) : 1;
        const shownWords = Math.ceil(k * run.words.length);
        [...textEl.children].forEach((s, i) => { if (i < shownWords) s.style.opacity = '1'; });
        const audioDone = !run.audio || run.audio.ended || run.audio.paused;
        if (k >= 1 && (audioDone || run.t > run.dur + 1)) { run.phase = 'hold'; run.t = 0; }
      } else if (run.phase === 'hold' && run.t >= HOLD) next();
      else if (run.phase === 'end' && run.t >= 2.2) { run = null; sub.hidden = true; }
    },
  };
}
