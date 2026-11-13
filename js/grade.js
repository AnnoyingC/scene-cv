// 办公室场景的整体滤镜，分三段：
//   CameraPass：代替 RenderPass，把场景画进多重采样的 HDR 缓冲，再做白平衡 + 景深（薄透镜公式，焦点跟着镜头看的物件走）
//   StreakPass：接在辉光后面，亮的小光点往左右拉出细长的光（变形宽银幕镜头那种）
//   GradePass：接在 OutputPass 后面，处理已经 sRGB 编码好的画面 —— 调色、暗角、锐化 / 柔焦、色差、颗粒 / 传感器噪点、录像带扫描线
// 几种预设在 LOOKS 里；?look=名字 选一种，?looks 在左下角显示一排按钮现场切换（挑滤镜用）。
// 每种预设也可以改辉光（bloom）的强度 / 半径 / 阈值、色调映射方式和曝光（renderer.toneMappingExposure）。
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const V3 = (r, g, b) => new THREE.Vector3(r, g, b);
const TONE = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };
const SENSOR = 0.024; // 假想相机的底片高 24 毫米（全画幅），焦距由视角算出来

// 每个参数的含义：
//   exposure 整体亮度倍数（乘在画面上）；contrast 绕 0.5 的对比度；curve S 形曲线的强度（0 = 直线）
//   saturation 饱和度；lift / gamma / gain 暗部 / 中间调 / 亮部的 RGB（调色台上那三个轮子）
//   shadows / highlights 暗部 / 亮部各染一点什么颜色（分离色调）；fade 黑位抬高到多少（褪色感）
//   vignette 风格化暗角强度；falloff 镜头自然失光（cos⁴ 定律，0 ~ 1）；grain 胶片颗粒强度；noise 传感器噪点强度
//   aberration 画面边缘的红蓝错位（像素）；scan 扫描线强度；soft 轻微柔焦（像素）；sharpen 锐化强度
//   dof 景深的光圈 f 值（0 = 不做景深，数字越小背景越虚）；wb 白平衡（线性光里 RGB 各乘多少）
//   bloom [强度, 半径, 阈值]；halation 辉光最外圈的颜色（胶片的"晕"：亮处往外渗一圈偏红橙的光，越往外越偏这个颜色）
//   streak 横向拉丝光的颜色和强度（0 = 不要）；streakThreshold 多亮的光点才拉丝（线性 HDR 亮度）
//   tone 色调映射（aces / agx / neutral）；toneExposure 色调映射前的曝光
const BASE = {
  exposure: 1, contrast: 1, curve: 0, saturation: 1, lift: V3(0, 0, 0), gamma: V3(1, 1, 1), gain: V3(1, 1, 1),
  shadows: V3(0, 0, 0), highlights: V3(0, 0, 0), fade: V3(0, 0, 0), vignette: 0, falloff: 0, grain: 0, noise: 0,
  aberration: 0, scan: 0, soft: 0, sharpen: 0, dof: 0, wb: V3(1, 1, 1),
  bloom: [0.45, 0.5, 0.9], halation: V3(1, 1, 1), streak: V3(0, 0, 0), streakThreshold: 1.5, tone: 'aces', toneExposure: 1,
};

export const LOOKS = {
  cinema: {
    label: '电影感', toneExposure: 1.05, wb: V3(1.02, 1.0, 0.97), dof: 4,
    contrast: 1.06, curve: 0.28, saturation: 1.02, gain: V3(1.03, 1.0, 0.94),
    shadows: V3(-0.015, 0.006, 0.025), highlights: V3(0.035, 0.012, -0.02), fade: V3(0.018, 0.016, 0.022),
    vignette: 0.4, falloff: 0.4, grain: 0.045, soft: 0.25, aberration: 0.7,
    bloom: [0.8, 0.65, 0.78], halation: V3(1.0, 0.62, 0.42), streak: V3(0.1, 0.12, 0.16), streakThreshold: 4,
  },
  real: {
    label: '真实相机', tone: 'agx', toneExposure: 1.45, wb: V3(0.95, 1.0, 1.07), dof: 2.2,
    contrast: 1.04, curve: 0.18, saturation: 1.12, falloff: 0.7, aberration: 0.6, sharpen: 0.35, noise: 0.018,
    bloom: [0.16, 0.85, 0.0],
  },
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

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------- 相机：画场景 + 白平衡 + 景深（线性 HDR） ----------
// CameraPass 代替 RenderPass 当第一步：场景先画进它自己的多重采样 HDR 缓冲（带深度图和 mipmap），
// 再用一个全屏着色器把它"冲洗"进 composer 的普通缓冲，顺路做白平衡和景深。
// 只有画场景这一步多重采样；后面的辉光、调色都在普通缓冲里做，不用每一步都写 4 份样本。
// 景深用的是"单趟散射式收集"（Dennis Gustafsson 的做法）：沿黄金角螺旋往外采样，每个样本按它自己的弥散圆（CoC）
// 够不够得着这个像素决定算不算进来；比这个像素远的样本，CoC 最多当成这个像素的两倍，清晰的前景就不会被背景糊上。
// 在 HDR 里做，窗外的灯和台灯灯泡糊开以后是一个个亮的光斑，和真镜头一样。
// CoC 半径（CSS 像素）= cocK × |1/对焦距离 − 1/深度|，cocK 每帧按光圈、焦距、对焦距离算好（见 CameraPass.render）。
const LensShader = {
  uniforms: {
    tColor: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2(1, 1) }, px: { value: 1 },
    near: { value: 0.1 }, far: { value: 100 }, focus: { value: 2 }, cocK: { value: 0 }, maxR: { value: 0 }, wb: { value: V3(1, 1, 1) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    #include <packing>
    #define STEP 1.1
    uniform sampler2D tColor, tDepth;
    uniform vec2 res;
    uniform float px, near, far, focus, cocK, maxR;
    uniform vec3 wb;
    varying vec2 vUv;
    float depthAt(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
    float cocAt(float z) { return min(maxR, cocK * abs(1.0 / focus - 1.0 / z)); }
    void main() {
      vec3 c = textureLod(tColor, vUv, 0.0).rgb;
      if (maxR > 0.5) {
        float z0 = depthAt(vUv), r0 = cocAt(z0), tot = 1.0, r = STEP, ang = 0.0;
        vec2 step = px / res;
        for (int i = 0; i < 160; i++) {
          if (r >= maxR) break;
          vec2 tc = vUv + vec2(cos(ang), sin(ang)) * r * step;
          float z = depthAt(tc), sr = cocAt(z);
          if (z > z0) sr = min(sr, r0 * 2.0);
          // 这种螺旋的样本是均匀铺开的，相邻样本隔着约 sqrt(2π × STEP) ≈ 2.6 个 CSS 像素：从事先平均过的小一号 mipmap 取，
          // 把空隙填上，一盏小灯才会摊成一整片光斑，而不是一圈点。样本自己没那么糊时少平均一点
          vec3 s = textureLod(tColor, tc, log2(clamp(sr * px, 1.0, 2.6 * px))).rgb;
          c += mix(c / tot, s, smoothstep(r - 0.5, r + 0.5, sr));
          tot += 1.0;
          ang += 2.39996323;
          r += STEP / r;
        }
        c /= tot;
      }
      gl_FragColor = vec4(c * wb, 1.0);
    }`,
};

export class CameraPass extends Pass {
  constructor({ renderer, scene, camera, samples = 4 }) {
    super();
    this.needsSwap = false; // 和 RenderPass 一样：直接写进 readBuffer，后面的步骤接着读
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.focus = 2; // 对焦距离（米，沿视线方向量），room.js 每帧更新
    this.fStop = 0; // 0 = 不做景深
    this.maxRadius = 8; // 景深最大糊多少（CSS 像素半径），也决定采样数（大约 maxRadius² / 2.2 个）
    // mipmap 一直要生成：分配显存时只看这个开关，关着的话只分配第 0 层，按 mipmap 采样会读到黑的
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.uniforms = THREE.UniformsUtils.clone(LensShader.uniforms);
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: LensShader.vertexShader, fragmentShader: LensShader.fragmentShader, depthTest: false, depthWrite: false,
    }));
  }

  setSize(w, h) {
    this.target.setSize(w, h);
    this.uniforms.res.value.set(w, h);
    this.uniforms.px.value = this.renderer.getPixelRatio();
  }

  render(renderer, writeBuffer, readBuffer) {
    const U = this.uniforms, cam = this.camera;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, cam); // renderer.autoClear 默认开着，会先清屏
    U.tColor.value = this.target.texture;
    U.tDepth.value = this.target.depthTexture;
    U.near.value = cam.near;
    U.far.value = cam.far;
    // 薄透镜：焦距 f 由竖直视角和 24 毫米底片高算出，光圈直径 A = f / f 值；
    // 弥散圆直径（底片上）= A·f·s/(s−f) × |1/s − 1/d|，换成 CSS 像素再除以 2 就是半径
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const f = SENSOR / 2 / tanH, s = Math.max(this.focus, f * 3);
    const A = this.fStop > 0 ? f / this.fStop : 0;
    const heightCss = U.res.value.y / U.px.value;
    U.focus.value = s;
    U.cocK.value = ((A * f * s) / (s - f) / SENSOR) * heightCss * 0.5;
    // 画面里最糊的地方也到不了 maxRadius 时，少采几圈（远处无穷远的 CoC 是 cocK/s；近处按 25 厘米估）
    U.maxR.value = Math.min(this.maxRadius, U.cocK.value * Math.max(1 / s, 4 - 1 / s));
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

// ---------- 横向拉丝光（线性 HDR） ----------
// 变形宽银幕镜头的招牌：灯泡、城市灯光这种很亮的小光点，会往左右拉出一道细长的光。
// 做法：亮的部分缩到 1/4 大小，只在横向连着模糊 4 次（每次采样间隔是上一次的 3 倍，越拉越长），再叠加回画面。
const STREAK_PICK = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform float threshold;
  varying vec2 vUv;
  void main() { // 4 个双线性采样 = 原图 4×4 个像素的平均；只留超过阈值的那部分（软过渡）
    vec3 c = 0.25 * (texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tDiffuse, vUv + texel * vec2(1.0, -1.0)).rgb
      + texture2D(tDiffuse, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tDiffuse, vUv + texel * vec2(1.0, 1.0)).rgb);
    float l = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(threshold, threshold * 2.0, l), 1.0);
  }`;
const STREAK_BLUR = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float stride;
  varying vec2 vUv;
  void main() {
    vec3 acc = vec3(0.0);
    float tot = 0.0;
    for (int i = -4; i <= 4; i++) {
      float w = exp(-0.45 * abs(float(i)));
      acc += texture2D(tDiffuse, vUv + vec2(float(i) * stride, 0.0)).rgb * w;
      tot += w;
    }
    gl_FragColor = vec4(acc / tot, 1.0);
  }`;
const STREAK_ADD = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 tint;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * tint, 1.0); }`;

export class StreakPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false; // 叠加进 readBuffer，和辉光一样
    this.enabled = false;
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.a = rt();
    this.b = rt();
    const mat = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false, ...extra,
    });
    this.pick = mat(STREAK_PICK, { tDiffuse: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1.5 } });
    this.blur = mat(STREAK_BLUR, { tDiffuse: { value: null }, stride: { value: 0 } });
    this.add = mat(STREAK_ADD, { tDiffuse: { value: null }, tint: { value: V3(1, 1, 1) } }, { blending: THREE.AdditiveBlending, transparent: true });
    this.quad = new FullScreenQuad(null);
  }

  get tint() { return this.add.uniforms.tint.value; }

  setSize(w, h) {
    const sw = Math.max(1, Math.round(w / 4)), sh = Math.max(1, Math.round(h / 4));
    this.a.setSize(sw, sh);
    this.b.setSize(sw, sh);
    this.pick.uniforms.texel.value.set(1 / w, 1 / h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const q = this.quad, w = this.a.width;
    q.material = this.pick;
    this.pick.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.a);
    q.render(renderer);
    let src = this.a, dst = this.b;
    q.material = this.blur;
    for (let k = 0; k < 4; k++) {
      this.blur.uniforms.tDiffuse.value = src.texture;
      this.blur.uniforms.stride.value = 3 ** k / w;
      renderer.setRenderTarget(dst);
      q.render(renderer);
      [src, dst] = [dst, src];
    }
    q.material = this.add;
    this.add.uniforms.tDiffuse.value = src.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false; // 叠加：不能先把画面清掉
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    q.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    for (const o of [this.a, this.b, this.pick, this.blur, this.add, this.quad]) o.dispose();
  }
}

// ---------- 调色 + 镜头 / 底片质感（sRGB 画面） ----------
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, px: { value: 1 }, tanHalf: { value: 0.3 },
    exposure: { value: 1 }, contrast: { value: 1 }, curve: { value: 0 }, saturation: { value: 1 },
    lift: { value: V3(0, 0, 0) }, gamma: { value: V3(1, 1, 1) }, gain: { value: V3(1, 1, 1) },
    shadows: { value: V3(0, 0, 0) }, highlights: { value: V3(0, 0, 0) }, fade: { value: V3(0, 0, 0) },
    vignette: { value: 0 }, falloff: { value: 0 }, grain: { value: 0 }, noise: { value: 0 },
    aberration: { value: 0 }, scan: { value: 0 }, soft: { value: 0 }, sharpen: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 res;
    uniform float time, px, tanHalf, exposure, contrast, curve, saturation, vignette, falloff, grain, noise, aberration, scan, soft, sharpen;
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
      if (sharpen > 0.0) { // 锐化（反锐化掩模）：和上下左右的平均值差多少，再往外推一点；相机出片都会做
        vec2 o = max(1.0, px * 0.75) / res;
        vec3 b = tap(uv + vec2(o.x, 0.0)) + tap(uv - vec2(o.x, 0.0)) + tap(uv + vec2(0.0, o.y)) + tap(uv - vec2(0.0, o.y));
        c = max(c + (c - b * 0.25) * sharpen, 0.0);
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
      if (falloff > 0.0) { // 镜头自然失光：照度 ∝ cos⁴(视场角)，tanθ 由画面位置和视角算；在线性光里乘，这里画面是 sRGB，所以开 2.2 次方
        float t2 = dot(q, q) * 4.0 * tanHalf * tanHalf;
        c *= pow(mix(1.0, 1.0 / ((1.0 + t2) * (1.0 + t2)), falloff), 1.0 / 2.2);
      }
      if (scan > 0.0) c *= 1.0 - scan * (0.5 + 0.5 * sin(uv.y * res.y / px * 3.14159 / 1.5));
      l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (grain > 0.0) { // 颗粒：每帧换一次，中间调最明显
        float n = hash(floor(uv * res / max(px, 1.0)) + fract(time * 7.13) * 91.7) - 0.5;
        c += n * grain * (1.0 - abs(l - 0.45) * 1.2);
      }
      if (noise > 0.0) { // 传感器噪点：每个物理像素一颗、每帧换；暗部最明显（读出噪声），亮部被压下去，以亮度噪点为主、带一点彩色噪点
        vec2 p = floor(uv * res) + vec2(fract(time * 7.13), fract(time * 3.71)) * 517.0;
        float n = hash(p) + hash(p + 31.7) - 1.0;
        vec3 ch = vec3(hash(p + 7.1), hash(p + 13.3), hash(p + 19.9)) - 0.5;
        float a = noise * sqrt(px) * mix(1.6, 0.5, smoothstep(0.02, 0.7, l)) * (1.0 - smoothstep(0.9, 1.0, l));
        c += (vec3(n) + ch * 0.5) * a;
      }
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class GradePass extends ShaderPass {
  constructor({ renderer, bloom, lens = null, streak = null, camera = null }) {
    super(GradeShader);
    this.renderer = renderer;
    this.bloom = bloom;
    this.lens = lens;
    this.streak = streak;
    this.camera = camera;
    this.name = 'none';
    this.lite = false; // 机器太慢时关掉景深（room.js 的自适应画质会调 lighten()）
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
    // 辉光分 5 层，越往后越大越淡：从白色渐变到 halation 的颜色，外圈的光晕就偏暖
    this.bloom.bloomTintColors.forEach((v, i) => v.set(1, 1, 1).lerp(L.halation, i / 4));
    if (this.streak) {
      this.streak.tint.copy(L.streak);
      this.streak.pick.uniforms.threshold.value = L.streakThreshold;
      this.streak.enabled = L.streak.lengthSq() > 0;
    }
    this.renderer.toneMapping = TONE[L.tone] ?? TONE.aces;
    this.renderer.toneMappingExposure = L.toneExposure;
    if (this.lens) { // 相机那一步一直开着（场景是它画的），只改光圈和白平衡
      this.lens.fStop = this.lite ? 0 : L.dof;
      this.lens.uniforms.wb.value.copy(L.wb);
    }
    this.enabled = name !== 'none';
    return name;
  }

  lighten() {
    this.lite = true;
    this.set(this.name);
  }

  setSize(w, h) {
    this.uniforms.res.value.set(w, h);
    this.uniforms.px.value = this.renderer.getPixelRatio();
  }

  render(renderer, writeBuffer, readBuffer, dt, maskActive) {
    this.uniforms.time.value += dt || 0;
    if (this.camera) this.uniforms.tanHalf.value = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    super.render(renderer, writeBuffer, readBuffer, dt, maskActive);
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
