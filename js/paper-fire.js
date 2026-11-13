// 塔楼"联系"的过场：点面板里的链接 → 桌上的羊皮纸揉成一团 → 扔进壁炉 → 火变绿、往上窜火星 → 跳到那个链接。
//   - 揉掉的是写着联系方式的最上面一张：卷轴和底下那张空白羊皮纸留在桌上（烘焙时纸挡着光，
//     纸下面的桌面在光照贴图里是黑的，不能露出来）。
//   - 这一张是细分过的网格，开始时和桌上的字迹贴花一模一样：同一份光照贴图、同一张字迹贴图，
//     所以换上去的那一下看不出来；揉的过程中再按折痕朝向加明暗。
//   - 场景怎么变绿、镜头怎么走由 tower.js 决定：这里只交出 { green, boost, flash } 三个系数和两个镜头。
//   - 时间线（秒）：0 开始揉 → 1.0 扔出 → 2.1 落进火里，绿火窜起 → 2.75 画面泛起绿光 → 3.35 跳转。
import * as THREE from 'three';
import { PARCHMENT } from './paint.js';

const Y = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

const T_CRUMPLE = 1.0, T_FLY = 1.1, T_BURN = 0.6, T_VEIL = 2.75, T_GO = 3.35;
const T_HIT = T_CRUMPLE + T_FLY;
const S = 18, T = 24;                         // 横向 S 段、纵向 T 段
const LIFT = 0.09, BALL_R = 0.05;            // 纸团在纸面上方 9 厘米处成形，半径 5 厘米
const FIRE_LIT_GREEN = new THREE.Color(0.25, 1.4, 0.5);

// 平滑的二维值噪声，-1..1。揉皱靠它：相邻的点往相近的方向走，才会折出成片的褶，而不是一团乱麻。
function hash(x, y, s) { const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// 纸面上一点对应的光照贴图坐标：落在哪个三角形里就按重心坐标插值（贴边的点取最近的三角形）
function lightUv(face, p) {
  let best = null, err = Infinity;
  for (const t of face) {
    const [A, B, C] = t.pts;
    const ax = B.x - A.x, az = B.z - A.z, bx = C.x - A.x, bz = C.z - A.z, px = p.x - A.x, pz = p.z - A.z;
    const den = ax * bz - bx * az;
    if (Math.abs(den) < 1e-12) continue;
    const w1 = (px * bz - bx * pz) / den, w2 = (ax * pz - px * az) / den, w0 = 1 - w1 - w2;
    const e = Math.max(0, -w0, -w1, -w2);
    if (e < err) { err = e; best = { w: [w0, w1, w2], uv: t.uv }; }
  }
  const w = best.w.map((x) => Math.max(0, x)), sum = w[0] + w[1] + w[2];
  return [0, 1].map((c) => best.uv.reduce((a, uv, i) => a + (c ? uv.y : uv.x) * w[i], 0) / sum);
}

// 纸：前面是字迹贴图、背面是素纸；光照 = 烘焙好的几层光照贴图 × 系数（和房间里的纸一样），揉皱时按折痕加明暗。
function paperMaterial(room, decal) {
  const layers = room.layers;
  const uniforms = {
    decal: { value: decal }, paper: { value: new THREE.Color(PARCHMENT) },
    crumple: { value: 0 }, burn: { value: 0 }, green: { value: 0 },
    fireP: { value: new THREE.Vector3() }, fireC: { value: new THREE.Color(0, 0, 0) },
  };
  for (const k of layers) { uniforms['m_' + k] = room.U['m_' + k]; uniforms['k_' + k] = room.U['k_' + k]; } // 共用对象：开关灯照样生效
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide, uniforms,
    vertexShader: /* glsl */`
      attribute vec2 lmUv;
      attribute vec2 decalUv;
      varying vec2 vLm, vDecal;
      varying vec3 vW;
      varying float vR;
      void main() {
        vLm = lmUv; vDecal = decalUv;
        vR = length(position) / ${BALL_R.toFixed(4)}; // 离纸团中心多远：越往里越暗
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D decal, ${layers.map((k) => 'm_' + k).join(', ')};
      uniform vec3 paper, ${layers.map((k) => 'k_' + k).join(', ')};
      uniform float crumple, burn, green;
      uniform vec3 fireP, fireC; // 飞近壁炉时被火照亮（烘焙的光照贴图只管它在桌上的时候）
      varying vec2 vLm, vDecal;
      varying vec3 vW;
      varying float vR;
      vec3 dec(sampler2D t) { vec3 c = texture2D(t, vLm).rgb; return c * c * c; }
      void main() {
        vec3 light = ${layers.map((k) => `dec(m_${k}) * k_${k}`).join(' + ')};
        vec3 base = gl_FrontFacing ? texture2D(decal, vDecal).rgb : paper * 0.86;
        // 每个小三角形按自己的朝向算明暗（屏幕导数求面法线，总是朝着镜头），揉皱的纸才有一棱一棱的折痕
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
        float shade = 0.3 + 0.95 * max(dot(n, normalize(vec3(0.3, 1.0, 0.45))), 0.0);
        shade *= mix(0.5, 1.0, smoothstep(0.55, 1.0, vR)); // 团里面的褶缝更暗
        vec3 col = base * light * mix(1.0, shade, crumple);
        vec3 tf = fireP - vW;
        col += base * fireC * shade * crumple / (1.0 + dot(tf, tf) * 5.0);
        // 烧：先焦黑，表面一层火光（绿火里是绿的）
        vec3 ember = mix(vec3(1.0, 0.42, 0.08), vec3(0.3, 1.0, 0.45), green);
        col = mix(col, col * 0.12, smoothstep(0.0, 0.6, burn)) + ember * burn * (1.2 + 2.5 * burn);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// 火星：一把绿色的光点，从火里往上喷，越飞越慢、慢慢暗下去
class Sparks {
  constructor(n = 280) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(1);
    this.life = new Float32Array(n).fill(1);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { scale: { value: 800 } },
      vertexShader: /* glsl */`
        uniform float scale;
        attribute float alpha, size;
        varying float vA;
        void main() {
          vA = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha > 0.0 ? size * scale / -mv.z : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.0, r); a *= a;
          gl_FragColor = vec4(mix(vec3(0.12, 1.0, 0.38), vec3(0.85, 1.0, 0.82), a) * a * vA * 2.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }
  emit(origin, out, count, power = 1) {
    for (let c = 0; c < count; c++) {
      const i = this.next++ % this.n, a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.16;
      this.pos[i * 3] = origin.x + Math.cos(a) * r;
      this.pos[i * 3 + 1] = origin.y + Math.random() * 0.08;
      this.pos[i * 3 + 2] = origin.z + Math.sin(a) * r;
      // 主要往屋里喷（往上喷会被炉口上面的石头挡住），再被热气托着往上飘
      const side = (Math.random() - 0.5) * 1.1, up = (0.5 + Math.random() * 1.3) * power, fwd = (0.7 + Math.random() * 1.4) * power;
      this.vel[i * 3] = out.x * fwd + out.z * side;
      this.vel[i * 3 + 1] = up;
      this.vel[i * 3 + 2] = out.z * fwd - out.x * side;
      this.age[i] = 0;
      this.life[i] = 0.8 + Math.random() * 1.1;
      this.size[i] = 0.012 + Math.random() * 0.022;
    }
    this.points.geometry.attributes.size.needsUpdate = true;
  }
  update(dt, camera, heightPx) {
    this.points.material.uniforms.scale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const drag = Math.exp(-dt * 1.6);
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      for (let c = 0; c < 3; c++) this.vel[i * 3 + c] *= drag;
      this.vel[i * 3 + 1] += dt * 0.6; // 热气往上托
      for (let c = 0; c < 3; c++) this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      this.alpha[i] = (1 - k) * (1 - k) * (0.6 + 0.4 * Math.sin(this.age[i] * 40 + i)); // 一闪一闪
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }
}

export class PaperFire {
  // decal：room.decal() 返回的纸面贴花（带 userData.frame），开场时藏起来，换成会动的这一张
  // fire：manifest.fire；viewDir：看纸时的镜头方向（manifest.views.online.dir）
  constructor({ room, scene, decal, texture, fire, viewDir, host }) {
    const frame = decal.userData.frame;
    this.decal = decal;
    this.sparks = new Sparks();
    scene.add(this.sparks.points);

    // ---------- 纸的网格 ----------
    const { center, right, long, hw, hh, face } = frame;
    const n = (S + 1) * (T + 1);
    const origin = this.origin = center.clone().addScaledVector(Y, LIFT); // 纸团的中心；顶点都相对它
    const flat = this.flat = new Float32Array(n * 3), ball = this.ball = new Float32Array(n * 3);
    const delay = this.delay = new Float32Array(n), wrinkle = this.wrinkle = new Float32Array(n);
    const lm = new Float32Array(n * 2), duv = new Float32Array(n * 2);
    const p = new THREE.Vector3(), q = new THREE.Vector3(), d = new THREE.Vector3();
    for (let j = 0; j <= T; j++) {
      const lu = -hh + (j / T) * 2 * hh; // 沿长边的位置
      for (let i = 0; i <= S; i++) {
        const v = j * (S + 1) + i, x = -hw + (i / S) * 2 * hw;
        q.copy(center).addScaledVector(right, x).addScaledVector(long, lu);
        lm.set(lightUv(face, q), v * 2);
        p.copy(q).addScaledVector(Y, 0.0006).sub(origin); // 比贴花再高一点点，压在底下那张纸上面
        p.toArray(flat, v * 3);
        duv.set([x / (2 * hw) + 0.5, lu / (2 * hh) + 0.5], v * 2);
        // 揉成团以后的位置：大致按纸上的位置分到球面上，再用噪声打乱方向和半径
        const u = x / hw, w = lu / hh;
        const n2 = (a, b, sd) => 0.8 * vnoise(a * 1.3, b * 1.3, sd) + 0.45 * vnoise(a * 3.4, b * 3.4, sd + 10); // 大褶 + 小褶
        d.set(0, 0, 0)
          .addScaledVector(right, u + n2(u + 3.1, w, 1))
          .addScaledVector(Y, 0.9 * (1 - 0.35 * (u * u + w * w)) + n2(u, w + 5.3, 2))
          .addScaledVector(long, w + n2(u + 7.7, w + 2.2, 3))
          .normalize()
          // 半径：起伏 + 一道道往里凹的折痕（取噪声绝对值，零附近就是一条凹线）
          .multiplyScalar(BALL_R * (0.78 + 0.22 * vnoise(u * 2.7, w * 2.7, 4)) * (1 - 0.3 * (1 - Math.abs(vnoise(u * 4.1, w * 4.1, 5)))));
        d.toArray(ball, v * 3);
        delay[v] = 0.35 * (1 - Math.min(1, Math.hypot(u, w) / Math.SQRT2)); // 四周先往里收，中间最后
        wrinkle[v] = 1 - 2 * Math.abs(vnoise(u * 4.5, w * 4.5, 6)); // 揉的过程中先起的皱：尖的脊、宽的谷
      }
    }
    const index = [];
    for (let j = 0; j < T; j++) for (let i = 0; i < S; i++) {
      const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, e = c + 1;
      index.push(a, b, c, b, e, c);
    }
    // 正面要朝上（贴图画在正面）：看第一个三角形的朝向，反了就翻过来
    const nrm = new THREE.Vector3().subVectors(p.fromArray(flat, 3), q.fromArray(flat, 0))
      .cross(d.fromArray(flat, (S + 1) * 3).sub(q));
    if (nrm.y < 0) for (let k = 0; k < index.length; k += 3) [index[k + 1], index[k + 2]] = [index[k + 2], index[k + 1]];
    const geo = this.geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flat.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('lmUv', new THREE.BufferAttribute(lm, 2));
    geo.setAttribute('decalUv', new THREE.BufferAttribute(duv, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.mat = paperMaterial(room, texture);
    this.mat.uniforms.fireP.value.fromArray(fire.pos).addScaledVector(Y, 0.3);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.visible = false;
    scene.add(this.group);

    // ---------- 路线和镜头 ----------
    const F = fire, out = this.out = new THREE.Vector3().fromArray(F.dir).setY(0).normalize();
    this.hit = new THREE.Vector3().fromArray(F.pos).addScaledVector(Y, 0.1).addScaledVector(out, 0.02);
    // 看着壁炉时镜头的右边（书桌那一侧）。控制点在炉口右前方上空：纸团从画面右上方飞进来，正着落进炉口，不会擦着炉边
    const side = new THREE.Vector3().crossVectors(out, Y).negate();
    // 弧线不能太陡：最后一段要从炉口里斜着进去，而不是从上沿的石头后面掉下去
    this.ctrl = new THREE.Vector3().fromArray(F.pos).addScaledVector(out, 1.3).addScaledVector(side, 0.55);
    this.ctrl.y = Math.max(origin.y, this.hit.y) + 0.6;
    this.spinAxis = new THREE.Vector3().subVectors(this.hit, origin).setY(0).normalize().cross(Y).normalize();
    this.shots = {
      paper: { target: center.clone().addScaledVector(Y, 0.05).toArray(), size: [0.55, 0.46], dir: viewDir },
      // 离近一点、从右上方看炉口：镜头不会退到水盆后面被挡住，上面留出火星往上窜的地方
      fire: {
        target: new THREE.Vector3().fromArray(F.pos).addScaledVector(Y, 0.5).toArray(), size: [0.95, 1.05],
        dir: out.clone().addScaledVector(side, 0.35).addScaledVector(Y, 0.38).toArray(),
      },
    };

    // ---------- 跳转前的那层绿光（DOM） ----------
    this.veil = document.createElement('div');
    this.veil.className = 'veil';
    this.veil.setAttribute('aria-live', 'polite');
    host.append(this.veil);

    this.t = 0;
    this.active = false;
    this.fx = { green: 0, boost: 0, flash: 0 };
  }

  get busy() { return this.active; }

  // link：{ label, url }；cb：onCamera(shot | null, dur)、onImpact()、onDone(url)、onCancel()
  start(link, cb) {
    if (this.active) return;
    this.link = link;
    this.cb = cb;
    this.t = 0;
    this.active = true;
    this.flags = {};
    this.decal.visible = false;
    this.group.visible = true;
    this.group.position.copy(this.origin);
    this.group.quaternion.identity();
    this.group.scale.setScalar(1);
    this.shape(0);
    this.mat.uniforms.burn.value = 0;
    this.veil.textContent = `前往 ${link.label || link.url}`;
    cb.onCamera?.(this.shots.paper, 0.9);
  }

  // 中途点一下：不等了，直接跳
  skip() { if (this.active && !this.flags.done) this.finish(); }

  finish() {
    this.flags.done = true;
    this.veil.classList.add('show');
    const url = this.link.url;
    this.cb.onDone?.(url);
    // 跳转没有离开页面（mailto: 之类）或者迟迟没走：过一会儿把房间恢复原样
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel(), /^https?:/i.test(url) ? 8000 : 1200);
  }

  // 恢复原样：纸回到桌上，火慢慢变回原来的颜色（从目标网站按后退回来、按 Esc、中途切到别的视角时都走这里）
  cancel() {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.active = false;
    this.decal.visible = true;
    this.group.visible = false;
    this.veil.classList.remove('show');
    this.cb?.onCamera?.(null, 0);
    this.cb?.onCancel?.();
  }

  shape(k) {
    const pos = this.geo.attributes.position.array, { flat, ball, delay, wrinkle } = this;
    for (let v = 0, n = delay.length; v < n; v++) {
      const p = smooth(delay[v], delay[v] + 0.65, k), w = wrinkle[v] * Math.sin(Math.PI * p) * 0.02;
      for (let c = 0; c < 3; c++) pos[v * 3 + c] = flat[v * 3 + c] + (ball[v * 3 + c] - flat[v * 3 + c]) * p;
      pos[v * 3 + 1] += w;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.mat.uniforms.crumple.value = smooth(0, 0.4, k);
  }

  // 每帧：推进时间线，返回给场景用的系数 { green 绿火 0..1, boost 火势, flash 落火那一下的闪光 }
  // fire：壁炉现在有多旺（0 = 灭着），用来给飞过去的纸团打火光
  update(dt, camera, heightPx, fire = 1) {
    const fx = this.fx, f = this.flags || {};
    if (this.active) {
      const t = (this.t += dt);
      if (t <= T_CRUMPLE + dt) this.shape(1 - Math.pow(1 - clamp(t / T_CRUMPLE, 0, 1), 2.2)); // 一把攥住：一开始收得最快
      if (t >= T_CRUMPLE - 0.25 && !f.cut) { f.cut = true; this.cb.onCamera?.(this.shots.fire, 1.1); } // 纸团落火之前镜头到位
      if (t >= T_CRUMPLE && t < T_HIT) { // 抛物线：二次贝塞尔，参数匀速 = 水平匀速、竖直抛物线
        const k = (t - T_CRUMPLE) / T_FLY, u = 1 - k;
        this.group.position.copy(this.origin).multiplyScalar(u * u).addScaledVector(this.ctrl, 2 * u * k).addScaledVector(this.hit, k * k);
        this.group.quaternion.setFromAxisAngle(this.spinAxis, k * Math.PI * 3.2);
      }
      if (t >= T_HIT && !f.hit) {
        f.hit = true;
        this.group.position.copy(this.hit);
        this.cb.onImpact?.();
        this.sparks.emit(this.hit, this.out, 150, 1.15);
      }
      if (f.hit) {
        const b = clamp((t - T_HIT) / T_BURN, 0, 1);
        this.mat.uniforms.burn.value = b;
        this.mat.uniforms.green.value = smooth(0, 0.3, t - T_HIT);
        this.group.scale.setScalar(Math.max(0.001, 1 - ease(b)));
        if (b >= 1) this.group.visible = false;
        if (t < T_GO) this.sparks.emit(this.hit, this.out, Math.random() < dt * 70 ? 1 : 0, 0.8); // 绿火一直往上冒火星
        const since = t - T_HIT;
        fx.green = smooth(0, 0.12, since);
        fx.boost = 0.35 + 0.65 * Math.exp(-since * 1.6);
        fx.flash = Math.exp(-since * 7);
      }
      if (t >= T_VEIL && !f.veil) { f.veil = true; this.veil.classList.add('show'); }
      if (t >= T_GO && !f.done) this.finish();
    } else { // 恢复以后火慢慢变回原样
      const s = Math.exp(-dt * 1.5);
      fx.green *= s; fx.boost *= s; fx.flash *= s;
      if (fx.green < 1e-3) fx.green = fx.boost = fx.flash = 0;
    }
    this.mat.uniforms.fireC.value.setRGB(1.6, 0.75, 0.28).lerp(FIRE_LIT_GREEN, fx.green).multiplyScalar(Math.max(fire, 0.15));
    this.sparks.update(dt, camera, heightPx);
    return fx;
  }
}
