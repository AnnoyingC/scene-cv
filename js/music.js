// 两个场景共用的试听播放器；首次点击才加载音频，不影响 3D 首屏。
import { createVinylAudio } from './vinyl-audio.js';
import { MUSIC_TRACKS } from './music-tracks.js';

const VOLUME_KEY = 'scenecv.music.volume';
const TRACK_KEY = 'scenecv.music.track';

export function createMusicPlayer({ host = document.getElementById('room'), vinyl = false } = {}) {
  const audio = document.createElement('audio');
  audio.preload = 'none';
  audio.loop = true;
  let volume = 0.25;
  let track = MUSIC_TRACKS[0];
  const effectKey = `scenecv.music.vinyl.${document.documentElement.dataset.scene}`;
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) volume = Math.max(0, Math.min(1, Number(saved)));
    const tone = localStorage.getItem(effectKey);
    if (tone !== null) vinyl = tone === 'true';
    track = MUSIC_TRACKS.find((item) => item.id === localStorage.getItem(TRACK_KEY)) || track;
  } catch { /* 隐私模式也能正常试听。 */ }
  audio.volume = volume;

  const player = document.createElement('aside');
  player.className = 'music-player';
  player.setAttribute('aria-label', '场景配乐');
  player.innerHTML = `
    <div class="music-track"><span class="music-title"></span><span class="music-artist"></span></div>
    <div class="music-records" role="group" aria-label="选择唱片"></div>
    <div class="music-controls">
      <button class="music-toggle" type="button" aria-label="播放配乐" aria-pressed="false">▶ 播放</button>
      <label class="music-volume">音量 <input type="range" min="0" max="100" step="1" aria-label="配乐音量"></label>
      <output class="music-level"></output>
    </div>
    <div class="music-tone"><span>音色</span><button class="music-effect" type="button" aria-label="黑胶音色">黑胶音色</button></div>
    <p class="music-status" role="status" hidden></p>`;
  const title = player.querySelector('.music-title');
  const artist = player.querySelector('.music-artist');
  const records = player.querySelector('.music-records');
  const recordButtons = MUSIC_TRACKS.map((item) => {
    const record = document.createElement('button');
    record.type = 'button';
    record.className = 'music-record';
    record.setAttribute('aria-label', `换唱片：${item.title}`);
    record.title = item.title;
    record.style.setProperty('--record-label', item.label.color);
    const disc = document.createElement('span');
    disc.className = 'music-record-disc';
    disc.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = item.title;
    record.append(disc, name);
    record.addEventListener('click', () => selectTrack(item.id));
    records.append(record);
    return record;
  });
  function showTrack() {
    title.textContent = track.title;
    artist.textContent = track.artist;
    artist.hidden = !track.artist;
    recordButtons.forEach((record, i) => record.setAttribute('aria-pressed', String(MUSIC_TRACKS[i].id === track.id)));
  }
  showTrack();
  const button = player.querySelector('.music-toggle');
  const effect = player.querySelector('.music-effect');
  effect.setAttribute('aria-pressed', String(vinyl));
  effect.textContent = vinyl ? '黑胶 · 开' : '原声';
  const slider = player.querySelector('input');
  const level = player.querySelector('output');
  const status = player.querySelector('.music-status');
  slider.value = String(Math.round(volume * 100));
  level.value = `${slider.value}%`;
  player.append(audio);
  host.append(player);

  let pending = false;
  let failed = false;
  let active = false;
  let graph = null;
  let requestId = 0;
  let destroyed = false;
  function setActive(value) { active = value; graph?.setPlaying(value); }
  function message(text = '') {
    status.textContent = text;
    status.hidden = !text;
  }
  function update() {
    const playing = !audio.paused;
    button.textContent = pending ? '■ 取消' : playing ? 'Ⅱ 暂停' : '▶ 播放';
    button.setAttribute('aria-label', pending ? '取消加载配乐' : playing ? '暂停配乐' : '播放配乐');
    button.setAttribute('aria-pressed', String(playing || pending));
    player.classList.toggle('is-playing', playing && !pending);
  }
  function pause() {
    ++requestId;
    pending = false;
    setActive(false);
    audio.pause();
    message();
    update();
  }
  async function play() {
    if (destroyed) return;
    const request = ++requestId;
    if (!audio.src) audio.src = track.src;
    if (failed) { failed = false; audio.load(); }
    pending = true;
    message('正在加载…');
    update();
    try {
      if (!graph) {
        graph = createVinylAudio(audio, volume, vinyl);
        if (!graph) { effect.disabled = true; effect.textContent = '原声'; effect.setAttribute('aria-pressed', 'false'); }
      }
      // 两个调用都在点击手势里发起，兼容移动浏览器的音频解锁。
      await Promise.all([graph?.resume(), audio.play()]);
    } catch (err) {
      if (request !== requestId || destroyed) return;
      pending = false;
      audio.pause();
      setActive(false);
      message(err.name === 'NotAllowedError' ? '请再次点击播放。' : '音频暂时无法播放，点击重试。');
      update();
    }
  }
  function toggle() {
    if (destroyed) return;
    return pending || !audio.paused ? pause() : play();
  }
  function selectTrack(id, { autoplay = pending || !audio.paused } = {}) {
    const next = MUSIC_TRACKS.find((item) => item.id === id);
    if (destroyed || !next) return;
    if (next === track) return autoplay && audio.paused && !pending ? play() : undefined;
    pause(); // 使上一首尚未完成的 play() 失效，快速换片也不会回退状态。
    track = next;
    failed = false;
    audio.removeAttribute('src');
    audio.load();
    showTrack();
    try { localStorage.setItem(TRACK_KEY, track.id); } catch { /* 可不保存。 */ }
    if (autoplay) return play();
  }
  button.addEventListener('click', toggle);
  audio.addEventListener('playing', () => {
    if (destroyed || audio.paused || audio.readyState < 3) return;
    pending = false; setActive(true); message(); update();
  });
  audio.addEventListener('pause', () => {
    if (!audio.paused) return; // 换源前排队的 pause 事件不能清掉新曲的播放状态。
    pending = false; setActive(false); update();
  });
  audio.addEventListener('waiting', () => { setActive(false); if (!audio.paused) message('正在缓冲…'); });
  audio.addEventListener('ended', () => { setActive(false); update(); });
  audio.addEventListener('error', () => {
    if (!audio.error || destroyed) return;
    failed = true;
    pending = false;
    setActive(false);
    audio.pause();
    message('音频暂时无法播放，点击重试。');
    update();
  });
  slider.addEventListener('input', () => {
    volume = Number(slider.value) / 100;
    if (graph) graph.setVolume(volume);
    else audio.volume = volume;
    level.value = `${slider.value}%`;
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* 可不保存。 */ }
  });
  effect.addEventListener('click', () => {
    vinyl = !vinyl;
    graph?.setEnabled(vinyl);
    effect.setAttribute('aria-pressed', String(vinyl));
    effect.textContent = vinyl ? '黑胶 · 开' : '原声';
    try { localStorage.setItem(effectKey, String(vinyl)); } catch { /* 可不保存。 */ }
  });
  // 离开页面停止播放，浏览器后退恢复页面时也保持暂停。
  const hide = () => {
    pause();
    graph?.suspend();
  };
  addEventListener('pagehide', hide);
  return {
    toggle,
    selectTrack,
    get track() { return track; },
    get playing() { return active; },
    destroy() {
      hide();
      destroyed = true;
      removeEventListener('pagehide', hide);
      graph?.dispose();
      audio.removeAttribute('src');
      audio.load();
      player.remove();
    },
  };
}
