// 办公室场景的整体滤镜（调色 + 暗角 + 胶片颗粒 + 录像带效果），接在 OutputPass 后面，处理的是已经 sRGB 编码好的画面。
// 几种预设在 LOOKS 里；?look=名字 选一种，?looks 在左下角显示一排按钮现场切换（挑滤镜用）。
// 每种预设也可以改辉光（bloom）的强度 / 半径 / 阈值，和曝光（renderer.toneMappingExposure）。
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const V3 = (r, g, b) => new THREE.Vector3(r, g, b);

// 每个参数的含义：
//   exposure 整体亮度倍数（乘在画面上）；contrast 绕 0.5 的对比度；curve S 形曲线的强度（0 = 直线）
//   saturation 饱和度；lift / gamma / gain 暗部 / 中间调 / 亮部的 RGB（调色台上那三个轮子）
//   shadows / highlights 暗部 / 亮部各染一点什么颜色（分离色调）；fade 黑位抬高到多少（褪色感）
//   vignette 暗角强度；grain 颗粒强度；aberration 画面边缘的红蓝错位（像素）；scan 扫描线强度
//   soft 轻微柔焦（像素）；bloom [强度, 半径, 阈值]
const BASE = {
  exposure: 1, contrast: 1, curve: 0, saturation: 1, lift: V3(0, 0, 0), gamma: V3(1, 1, 1), gain: V3(1, 1, 1),
  shadows: V3(0, 0, 0), highlights: V3(0, 0, 0), fade: V3(0, 0, 0), vignette: 0, grain: 0, aberration: 0, scan: 0, soft: 0,
  bloom: [0.45, 0.5, 0.9], toneExposure: 1,
};

export const LOOKS = {
  none: { label: '原样' },
  film: {
    label: '暖胶片', curve: 0.25, saturation: 0.9, gain: V3(1.04, 1.0, 0.9), gamma: V3(1.02, 1.0, 0.96),
    shadows: V3(0.02, 0.0, -0.01), fade: V3(0.05, 0.04, 0.035), vignette: 0.38, grain: 0.07, soft: 0.4, bloom: [0.7, 0.6, 0.82],
  },
  cine: {
    label: '夜色电影', contrast: 1.08, curve: 0.3, saturation: 1.05, shadows: V3(-0.03, 0.01, 0.05), highlights: V3(0.05, 0.015, -0.04),
    gain: V3(1.02, 0.99, 0.96), vignette: 0.5, grain: 0.035, bloom: [0.55, 0.55, 0.85],
  },
  vhs: {
    label: '录像带', saturation: 0.82, curve: 0.1, gain: V3(1.02, 1.0, 0.95), fade: V3(0.04, 0.035, 0.05), vignette: 0.3, grain: 0.1,
    aberration: 2.2, scan: 0.12, soft: 0.9, bloom: [0.6, 0.7, 0.8],
  },
  polaroid: {
    label: '褪色相纸', contrast: 0.9, curve: 0.15, saturation: 0.8, fade: V3(0.08, 0.1, 0.1), shadows: V3(-0.01, 0.02, 0.02),
    highlights: V3(0.04, 0.03, -0.02), gain: V3(1.03, 1.0, 0.92), vignette: 0.55, grain: 0.06, soft: 0.5, bloom: [0.6, 0.6, 0.85],
  },
  lofi: {
    label: '深夜 lo-fi', exposure: 0.95, curve: 0.2, saturation: 0.85, shadows: V3(0.025, -0.01, 0.06), highlights: V3(0.04, 0.01, -0.01),
    gamma: V3(0.98, 0.96, 1.02), fade: V3(0.04, 0.03, 0.06), vignette: 0.45, grain: 0.05, soft: 0.6, bloom: [0.8, 0.75, 0.78],
  },
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, px: { value: 1 },
    exposure: { value: 1 }, contrast: { value: 1 }, curve: { value: 0 }, saturation: { value: 1 },
    lift: { value: V3(0, 0, 0) }, gamma: { value: V3(1, 1, 1) }, gain: { value: V3(1, 1, 1) },
    shadows: { value: V3(0, 0, 0) }, highlights: { value: V3(0, 0, 0) }, fade: { value: V3(0, 0, 0) },
    vignette: { value: 0 }, grain: { value: 0 }, aberration: { value: 0 }, scan: { value: 0 }, soft: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 res;
    uniform float time, px, exposure, contrast, curve, saturation, vignette, grain, aberration, scan, soft;
    uniform vec3 lift, gamma, gain, shadows, highlights, fade;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    vec3 tap(vec2 uv) {
      // 红蓝错位：越靠边错得越多（aberration 是画面角上的错位像素数，按 CSS 像素算）
      vec2 d = (uv - 0.5) * aberration * px / res * 2.0;
      vec3 c;
      c.r = texture2D(tDiffuse, uv + d).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - d).b;
      return c;
    }
    void main() {
      vec2 uv = vUv;
      vec3 c = tap(uv);
      if (soft > 0.0) { // 柔焦：周围四个点混进来一点
        vec2 o = soft * px / res;
        vec3 b = tap(uv + vec2(o.x, o.y)) + tap(uv + vec2(-o.x, o.y)) + tap(uv + vec2(o.x, -o.y)) + tap(uv - o);
        c = mix(c, b * 0.25, 0.5);
      }
      c *= exposure;
      c = gain * (c + lift * (1.0 - c));
      c = pow(max(c, 0.0), 1.0 / gamma);
      c = (c - 0.5) * contrast + 0.5;
      c = mix(c, c * c * (3.0 - 2.0 * c), curve);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c += shadows * (1.0 - smoothstep(0.0, 0.55, l)) + highlights * smoothstep(0.35, 1.0, l);
      c = fade + c * (1.0 - fade);
      vec2 q = (uv - 0.5) * vec2(res.x / res.y, 1.0);
      c *= 1.0 - vignette * smoothstep(0.35, 1.05, length(q));
      if (scan > 0.0) c *= 1.0 - scan * (0.5 + 0.5 * sin(uv.y * res.y / px * 3.14159 / 1.5));
      if (grain > 0.0) { // 颗粒：每帧换一次，中间调最明显
        float n = hash(floor(uv * res / max(px, 1.0)) + fract(time * 7.13) * 91.7) - 0.5;
        c += n * grain * (1.0 - abs(l - 0.45) * 1.2);
      }
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class GradePass extends ShaderPass {
  constructor({ renderer, bloom }) {
    super(GradeShader);
    this.renderer = renderer;
    this.bloom = bloom;
    this.name = 'none';
  }

  set(name) {
    if (!LOOKS[name]) name = 'none';
    this.name = name;
    const L = { ...BASE, ...LOOKS[name] }, U = this.uniforms;
    for (const k of Object.keys(BASE)) {
      if (!U[k]) continue;
      if (U[k].value instanceof THREE.Vector3) U[k].value.copy(L[k]);
      else U[k].value = L[k];
    }
    [this.bloom.strength, this.bloom.radius, this.bloom.threshold] = L.bloom;
    this.renderer.toneMappingExposure = L.toneExposure;
    this.enabled = name !== 'none';
    return name;
  }

  setSize(w, h) {
    this.uniforms.res.value.set(w, h);
    this.uniforms.px.value = this.renderer.getPixelRatio();
  }

  render(renderer, writeBuffer, readBuffer, dt) {
    this.uniforms.time.value += dt || 0;
    super.render(renderer, writeBuffer, readBuffer, dt);
  }
}

// 挑滤镜用的小按钮条（只在 ?looks 时出现）
export function lookPicker(grade, onPick) {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:12px;bottom:44px;z-index:50;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100vw - 24px);'
    + 'font:13px/1 system-ui,sans-serif';
  const btns = Object.entries(LOOKS).map(([k, v]) => {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid #fff4;background:#0009;color:#f3e9d8;cursor:pointer';
    b.onclick = (e) => { e.stopPropagation(); onPick(k); paint(); };
    b.onpointerdown = (e) => e.stopPropagation(); // 别让房间当成开始拖动
    b.dataset.look = k;
    bar.append(b);
    return b;
  });
  const paint = () => btns.forEach((b) => { b.style.background = b.dataset.look === grade.name ? '#d9a35acc' : '#0009'; });
  paint();
  document.body.append(bar);
  return bar;
}
