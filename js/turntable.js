import * as THREE from 'three';
import { MUSIC_TRACKS } from './music-tracks.js';

// 从烘焙结果按材质拆出唱片，仍共用房间的分层光照。机身和唱臂保持原位。
export function createTurntable(room, initialTrack = MUSIC_TRACKS[0]) {
  const disc = room.takeParts([['record', 'record_label']])[0];
  if (!disc) return null;
  const bodies = room.byMat.get('tt.0') || [];
  const bounds = new THREE.Box3();
  for (const mesh of [...bodies, ...disc.parts]) {
    bounds.expandByObject(mesh);
    mesh.userData.recordPlayer = true;
  }
  room.hotspots.music = [{
    c: bounds.getCenter(new THREE.Vector3()).toArray(),
    h: bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5).addScalar(0.005).toArray(), r: 0,
  }];

  // 原来的标签是纯色圆，转起来看不出来；印上不对称的曲名与浅色标记。
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = room.aniso;
  let trackId = null;
  function setTrack(track) {
    if (!track || track.id === trackId) return;
    trackId = track.id;
    ctx.fillStyle = track.label.color; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#e8cfaa'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(128, 128, 113, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f4dfb9'; ctx.textAlign = 'center';
    ctx.font = 'bold 26px sans-serif';
    track.label.lines.forEach((line, i) => ctx.fillText(line, 128, 68 + i * 28, 205));
    ctx.font = '15px sans-serif'; ctx.fillText(track.label.credit, 128, 188, 205);
    ctx.fillRect(117, 24, 22, 10);
    ctx.fillStyle = '#191715'; ctx.beginPath(); ctx.arc(128, 128, 10, 0, Math.PI * 2); ctx.fill();
    texture.needsUpdate = true;
  }
  setTrack(initialTrack);
  const label = room.decal('record_label', texture);
  if (label) {
    label.userData.recordPlayer = true;
    disc.group.attach(label);
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const rpm = 33 + 1 / 3;
  let speed = 0;
  return {
    group: disc.group,
    setTrack,
    update(dt, playing, track) {
      setTrack(track);
      const target = playing && !reduced.matches ? 1 : 0;
      speed += (target - speed) * (1 - Math.exp(-dt * (target ? 3 : 5)));
      if (speed < 0.001) speed = 0;
      disc.group.rotation.y = (disc.group.rotation.y - dt * speed * rpm * Math.PI * 2 / 60) % (Math.PI * 2);
    },
  };
}
