// 塔楼里实时画的几样东西（都不参与烘焙）：
//   - 水盆的水面：放项目画面（TV 的 canvas），水晶落进去时荡开波纹
//   - 水晶球：玻璃球里流动的雾
//   - 壁炉的火苗：几片交叉的面，着色器里用噪声画出跳动的火舌
//   - 水晶：小六角双锥，按面算高光（模型导出时没带法线，用屏幕导数算面法线）
//   - 浮在水晶球上方的"关于我"文字（OrbText）：一个字一个字显现，可以滚动
import * as THREE from 'three';
import { wrap, makeCanvas } from './tapes/util.js';

// 三维值噪声 + 分形叠加，几个着色器共用
const NOISE = /* glsl */`
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
`;
const OUT = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// ---------- 水面 ----------
// 圆盘在本地 XY 平面上，网格绕 X 转 -90° 平放：本地 +y = 世界 -z（离开场镜头远的那一边），对应画面上方。
// 画面是 4:3，整张缩进圆里（对角线 = 直径），四角和边缘慢慢沉进深水里，画面四周的字不会被切掉。
export const RIPPLES = 4;
export function waterMaterial(map) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, time: { value: 0 }, level: { value: 1 }, hover: { value: 0 },
      tint: { value: new THREE.Color(1, 1, 1) },
      rip: { value: [...Array(RIPPLES)].map(() => new THREE.Vector4(0, 0, -99, 0)) },
    },
    vertexShader: /* glsl */`
      varying vec2 vP;
      varying vec3 vW;
      void main() {
        vP = uv * 2.0 - 1.0;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform float time, level, hover;
      uniform vec3 tint;
      uniform vec4 rip[${RIPPLES}];
      varying vec2 vP;
      varying vec3 vW;
      void main() {
        vec2 off = vec2(0.0);
        float crest = 0.0;
        for (int i = 0; i < ${RIPPLES}; i++) {
          vec4 r = rip[i];
          float age = time - r.z;
          if (age < 0.0 || age > 3.5) continue;
          vec2 d = vP - r.xy;
          float dist = length(d), x = dist - age * 0.6;
          float w = sin(x * 42.0) * exp(-x * x * 40.0) * exp(-age * 1.1) * r.w;
          off += d / (dist + 1e-3) * w * 0.035;
          crest += w;
        }
        // 平时也有一点细碎的水纹
        off += 0.004 * vec2(sin(vP.y * 23.0 + time * 1.3) + sin(vP.x * 9.0 - time * 0.7), cos(vP.x * 19.0 - time * 1.1));
        vec2 q = vP + off;
        vec2 iuv = vec2(0.5 + q.x * 0.6, 0.5 + q.y * 0.8);
        vec2 inRect = smoothstep(vec2(0.0), vec2(0.06), iuv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - iuv);
        vec3 img = texture2D(map, iuv, 0.6).rgb * inRect.x * inRect.y; // 稍微糊一点（取低一级的 mipmap），像隔着水看
        img = mix(img, vec3(dot(img, vec3(0.3, 0.55, 0.15))), 0.3) * mix(vec3(1.0), tint, 0.2); // 像水里的倒影：淡一点、染一点项目色
        float r = length(vP);
        float edge = smoothstep(1.02, 0.7, r);               // 靠近盆壁的水更暗、更深
        float facing = abs(normalize(cameraPosition - vW).y);  // 正上方看得清，斜着看主要是反光
        float see = mix(0.45, 1.0, smoothstep(0.25, 0.75, facing));
        vec3 deep = vec3(0.006, 0.012, 0.02) + tint * 0.012;
        vec3 col = deep + img * level * see * (0.2 + 0.9 * edge) * (1.0 + 0.25 * hover);
        col += tint * max(crest, 0.0) * 0.06;                 // 波峰反一点光
        col += vec3(0.5, 0.42, 0.32) * pow(smoothstep(0.55, 1.0, r), 3.0) * 0.05; // 盆沿反射的烛光
        gl_FragColor = vec4(col, 1.0);
        ${OUT}
      }`,
  });
}

// ---------- 水晶球 ----------
export function orbMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { time: { value: 0 }, focus: { value: 0 }, hover: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN, vV, vL;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vL = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float time, focus, hover;
      varying vec3 vN, vV, vL;
      ${NOISE}
      void main() {
        vec3 n = normalize(vN);
        float f = pow(1.0 - abs(dot(n, normalize(vV))), 2.2);
        // 球里的雾：在球面往里两层取噪声，慢慢旋转、往上飘
        vec3 p = normalize(vL);
        float a = time * 0.25;
        mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
        p.xz = rot * p.xz;
        float m1 = fbm(p * 2.2 + vec3(0.0, -time * 0.18, 0.0));
        float m2 = fbm(p * 1.3 * 0.7 + vec3(3.1, -time * 0.11, 1.7));
        float mist = smoothstep(0.35, 0.85, m1 * 0.6 + m2 * 0.6);
        float k = 0.35 + 0.65 * focus + 0.3 * hover;
        vec3 col = mix(vec3(0.08, 0.1, 0.45), vec3(0.35, 0.75, 1.0), mist) * mist * (0.6 + 1.6 * k);
        col += vec3(0.55, 0.75, 1.0) * f * (0.5 + 0.6 * k);  // 玻璃边缘
        col += vec3(1.0, 0.85, 0.6) * pow(max(dot(reflect(-normalize(vV), n), normalize(vec3(-0.3, 0.8, 0.4))), 0.0), 40.0) * 0.8; // 烛光的高光
        gl_FragColor = vec4(col, clamp(0.18 + f * 0.6 + mist * 0.45 * k, 0.0, 1.0));
        ${OUT}
      }`,
  });
}

// ---------- 火苗 ----------
// 平面底边在原点、往上 h。seed 让每片火苗形状不同；level 是火的强弱（0 = 熄灭）
export function flameMaterial(seed) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { time: { value: 0 }, level: { value: 1 }, seed: { value: seed } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float time, level, seed;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 uv = vUv;
        float t = time * 1.7;
        float n = fbm(vec3(uv.x * 4.0 + seed * 7.0, uv.y * 2.6 - t, seed + time * 0.3));
        float x = (uv.x - 0.5) * 2.0 + (n - 0.5) * 0.7 * uv.y;           // 越往上摆得越厉害
        float width = mix(0.95, 0.12, pow(uv.y, 0.8)) * (0.75 + 0.5 * level);
        float shape = 1.0 - smoothstep(width * 0.55, width, abs(x));
        float tongues = fbm(vec3(uv.x * 9.0 + seed * 3.0, uv.y * 3.5 - t * 1.6, seed * 2.0));
        float f = shape * smoothstep(0.0, 0.08, uv.y) * (1.0 - smoothstep(0.25 + 0.6 * level * tongues, 1.0, uv.y));
        f = clamp(f * (0.6 + tongues), 0.0, 1.0) * level;
        vec3 col = mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.55, 0.12), smoothstep(0.1, 0.6, f));
        col = mix(col, vec3(1.0, 0.9, 0.65), smoothstep(0.7, 1.0, f) * (1.0 - uv.y));
        gl_FragColor = vec4(col * f * 1.6, 1.0);
        ${OUT}
      }`,
  });
}

// ---------- 水晶 ----------
export function gemMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, glow: { value: 0 }, light: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`
      uniform vec3 color;
      uniform float glow, light;
      varying vec3 vW;
      void main() {
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
        vec3 v = normalize(cameraPosition - vW);
        if (dot(n, v) < 0.0) n = -n;
        vec3 L = normalize(vec3(-0.4, 0.9, 0.5)), L2 = normalize(vec3(0.6, 0.3, -0.7));
        float facet = 0.35 + 0.45 * max(dot(n, L), 0.0) + 0.2 * max(dot(n, L2), 0.0);
        float spec = pow(max(dot(reflect(-v, n), L), 0.0), 24.0);
        float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        vec3 col = color * facet * (0.5 + 0.5 * light) + vec3(1.0, 0.92, 0.8) * spec * 0.9 * light + color * rim * 0.6;
        col += color * (0.35 + 1.6 * glow);                // 自己微微发光，悬停 / 选中时更亮（会被辉光放大）
        gl_FragColor = vec4(col, 1.0);
        ${OUT}
      }`,
  });
}

// ---------- 浮在水晶球上方的文字 ----------
// 画在黑底 canvas 上，平面用加法混合：黑色等于什么都不加，只有字和淡淡的雾会亮。
const SERIF = '"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",Georgia,serif';
const HEAD = `bold 60px ${SERIF}`, BODY = `40px ${SERIF}`;
export class OrbText {
  constructor({ name, tagline, about }, W = 1024, H = 910) {
    Object.assign(this, { W, H, padX: 84, padY: 70, lh: 58 });
    this.canvas = makeCanvas(W, H);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.ctx.font = BODY;
    const maxW = W - this.padX * 2;
    this.lines = [];
    const push = (text, kind) => {
      this.ctx.font = kind === 'h' ? HEAD : BODY;
      for (const l of wrap(this.ctx, text, maxW)) this.lines.push({ text: l, kind });
    };
    if (name) push(name, 'h');
    if (tagline) push(tagline, 'sub');
    this.lines.push({ text: '', kind: 'p' });
    for (const p of about) { push(p, 'p'); this.lines.push({ text: '', kind: 'p' }); }
    this.total = this.lines.reduce((n, l) => n + l.text.length + 1, 0);
    this.rows = Math.floor((H - this.padY * 2) / this.lh);
    this.typed = 0;
    this.active = false;
    this.scroll = 0;
    this.follow = true;
    this.acc = 1;
    this.fade = 0; // 0..1 整块文字的显隐（加法混合下直接乘到颜色上）
  }

  setActive(on) { this.active = on; }
  finish() { this.typed = this.total; }

  shown() {
    let left = Math.floor(this.typed);
    const out = [];
    for (const l of this.lines) {
      if (left <= 0) break;
      out.push({ ...l, text: l.text.slice(0, left), full: left >= l.text.length });
      left -= l.text.length + 1;
    }
    return out;
  }

  scrollBy(n) {
    const max = Math.max(0, this.shown().length - this.rows);
    this.scroll = Math.min(max, Math.max(0, this.scroll + n));
    this.follow = this.scroll >= max;
  }

  update(t, dt) {
    if (this.active && this.typed < this.total) this.typed = Math.min(this.total, this.typed + dt * 60);
    this.fade += ((this.active ? 1 : 0) - this.fade) * (1 - Math.exp(-dt * 3));
    this.acc += dt;
    if (this.acc < 1 / 30 || (this.fade < 0.002 && !this.active)) return;
    this.acc = 0;
    const { ctx, W, H, padX, padY, lh } = this;
    const lines = this.shown();
    const max = Math.max(0, lines.length - this.rows);
    if (this.follow) this.scroll = max;
    this.scroll = Math.min(this.scroll, max);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // 从下面的水晶球升起来的一团淡蓝色雾
    const g = ctx.createRadialGradient(W / 2, H * 1.05, 10, W / 2, H * 0.7, H * 0.75);
    g.addColorStop(0, `rgba(70,120,200,${0.32 + 0.05 * Math.sin(t * 1.3)})`);
    g.addColorStop(1, 'rgba(70,120,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(120,180,255,0.95)';
    ctx.shadowBlur = 16;
    const vis = lines.slice(this.scroll, this.scroll + this.rows);
    vis.forEach((l, i) => {
      const y = padY + i * lh;
      ctx.font = l.kind === 'h' ? HEAD : BODY;
      ctx.fillStyle = l.kind === 'sub' ? '#9fc4f0' : '#e2efff';
      const x = l.kind === 'p' ? padX : (W - ctx.measureText(l.text).width) / 2;
      ctx.fillText(l.text, x, l.kind === 'h' ? y - 10 : y);
    });
    ctx.shadowBlur = 0;
    // 上下和四周渐隐，看不出平面的边
    ctx.globalCompositeOperation = 'multiply';
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, W * 0.6);
    v.addColorStop(0, '#fff');
    v.addColorStop(1, '#000');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    const k = Math.round(255 * this.fade);
    ctx.fillStyle = `rgb(${k},${k},${k})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    if (max > 0) {
      const h = (H - padY * 2) * (this.rows / lines.length);
      const y = padY + (H - padY * 2 - h) * (this.scroll / max);
      ctx.fillStyle = `rgba(150,200,255,${0.4 * this.fade})`;
      ctx.fillRect(W - padX / 2, y, 3, h);
    }
    this.texture.needsUpdate = true;
  }
}
