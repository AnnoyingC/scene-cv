// 两个场景共用的试听播放器；首次点击才加载音频，不影响 3D 首屏。
import { createVinylAudio } from './vinyl-audio.js';
import { MUSIC_TRACKS } from './music-tracks.js';

const VOLUME_KEY = 'scenecv.music.volume';
const TRACK_KEY = 'scenecv.music.track';

// 界面文字：zh（塔楼）/ en（书房）
const TEXT = {
  zh: { player: '场景配乐', close: '收起唱片', records: '选择唱片', play: '▶ 播放', pause: 'Ⅱ 暂停', cancel: '■ 取消', ariaPlay: '播放配乐',
    ariaPause: '暂停配乐', ariaCancel: '取消加载配乐', volume: '音量', ariaVolume: '配乐音量', tone: '音色', ariaTone: '黑胶音色', vinylOn: '黑胶 · 开',
    plain: '原声', swap: '换唱片：', loading: '正在加载…', again: '请再次点击播放。', failed: '音频暂时无法播放，点击重试。', buffering: '正在缓冲…' },
  en: { player: 'Soundtrack', close: 'Close', records: 'Choose a record', play: '▶ Play', pause: 'Ⅱ Pause', cancel: '■ Cancel', ariaPlay: 'Play music',
    ariaPause: 'Pause music', ariaCancel: 'Stop loading', volume: 'Volume', ariaVolume: 'Music volume', tone: 'Sound', ariaTone: 'Vinyl sound', vinylOn: 'Vinyl · on',
    plain: 'Clean', swap: 'Play record: ', loading: 'Loading…', again: 'Tap play again.', failed: 'Could not play the audio. Tap to retry.', buffering: 'Buffering…' },
};

// collapsed：一开始收起来，调 openCard() 才显示（书房里点唱机打开），卡片右上角有关掉的按钮；lang：界面文字 zh / en
export function createMusicPlayer({ host = document.getElementById('room'), vinyl = false, collapsed = false, lang = 'zh' } = {}) {
  const T = TEXT[lang] || TEXT.zh;
  const nameOf = (it) => (lang === 'en' && it.titleEn) || it.title, artistOf = (it) => (lang === 'en' && it.artistEn) || it.artist;
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
  player.setAttribute('aria-label', T.player);
  player.innerHTML = `
    <div class="music-track"><span class="music-title"></span><span class="music-artist"></span>${collapsed ? `<button class="music-close" type="button" aria-label="${T.close}">×</button>` : ''}</div>
    <div class="music-records" role="group" aria-label="${T.records}"></div>
    <div class="music-controls">
      <button class="music-toggle" type="button" aria-label="${T.ariaPlay}" aria-pressed="false">${T.play}</button>
      <label class="music-volume">${T.volume} <input type="range" min="0" max="100" step="1" aria-label="${T.ariaVolume}"></label>
      <output class="music-level"></output>
    </div>
    <div class="music-tone"><span>${T.tone}</span><button class="music-effect" type="button" aria-label="${T.ariaTone}">${T.ariaTone}</button></div>
    <p class="music-status" role="status" hidden></p>`;
  const title = player.querySelector('.music-title');
  const artist = player.querySelector('.music-artist');
  const records = player.querySelector('.music-records');
  const recordButtons = MUSIC_TRACKS.map((item) => {
    const record = document.createElement('button');
    record.type = 'button';
    record.className = 'music-record';
    record.setAttribute('aria-label', `${T.swap}${nameOf(item)}`);
    record.title = nameOf(item);
    record.style.setProperty('--record-label', item.label.color);
    const disc = document.createElement('span');
    disc.className = 'music-record-disc';
    disc.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = nameOf(item);
    record.append(disc, name);
    record.addEventListener('click', () => selectTrack(item.id));
    records.append(record);
    return record;
  });
  function showTrack() {
    title.textContent = nameOf(track);
    artist.textContent = artistOf(track);
    artist.hidden = !artistOf(track);
    recordButtons.forEach((record, i) => record.setAttribute('aria-pressed', String(MUSIC_TRACKS[i].id === track.id)));
  }
  showTrack();
  const button = player.querySelector('.music-toggle');
  const effect = player.querySelector('.music-effect');
  effect.setAttribute('aria-pressed', String(vinyl));
  effect.textContent = vinyl ? T.vinylOn : T.plain;
  const slider = player.querySelector('input');
  const level = player.querySelector('output');
  const status = player.querySelector('.music-status');
  slider.value = String(Math.round(volume * 100));
  level.value = `${slider.value}%`;
  player.append(audio);
  host.append(player);
  let cardOpen = !collapsed;
  function setCard(open) {
    cardOpen = open;
    player.classList.toggle('is-collapsed', !open);
  }
  setCard(cardOpen);
  player.querySelector('.music-close')?.addEventListener('click', () => setCard(false));

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
    button.textContent = pending ? T.cancel : playing ? T.pause : T.play;
    button.setAttribute('aria-label', pending ? T.ariaCancel : playing ? T.ariaPause : T.ariaPlay);
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
    message(T.loading);
    update();
    try {
      if (!graph) {
        graph = createVinylAudio(audio, volume, vinyl);
        if (!graph) { effect.disabled = true; effect.textContent = T.plain; effect.setAttribute('aria-pressed', 'false'); }
      }
      // 两个调用都在点击手势里发起，兼容移动浏览器的音频解锁。
      await Promise.all([graph?.resume(), audio.play()]);
    } catch (err) {
      if (request !== requestId || destroyed) return;
      pending = false;
      audio.pause();
      setActive(false);
      message(err.name === 'NotAllowedError' ? T.again : T.failed);
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
  audio.addEventListener('waiting', () => { setActive(false); if (!audio.paused) message(T.buffering); });
  audio.addEventListener('ended', () => { setActive(false); update(); });
  audio.addEventListener('error', () => {
    if (!audio.error || destroyed) return;
    failed = true;
    pending = false;
    setActive(false);
    audio.pause();
    message(T.failed);
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
    effect.textContent = vinyl ? T.vinylOn : T.plain;
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
    openCard: () => setCard(true),
    closeCard: () => setCard(false),
    toggleCard: () => setCard(!cardOpen),
    get cardOpen() { return cardOpen; },
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
