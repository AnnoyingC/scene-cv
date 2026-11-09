// 石盆的投掷仪式：水晶入水后，水面上升起一团银灰色的雾，绕着盆心慢慢打旋、往上飘，几秒后散去。
// 不用光柱、不用符号、不叠加发光：雾是一组始终朝向镜头的小面，形状和流动在片元着色器里用噪声算，动画全部在 GPU 上完成。
// 时间线和以前一样（8.5 秒），tower.js 的镜头照旧按 framing 先拉远框住雾、雾散时回到水面近景。
import * as THREE from 'three';
import { NOISE } from './magic.js';

const smooth = (a, b, x) => {
  const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};
const WISPS = 22;
const MIST = '#b9c6cf';

export class BasinMagic {
  constructor(water) {
    this.age = -1;
    this.power = 0;
    this.flash = 0;
    this.height = water.r * 3.0; // 雾升到的高度（镜头拉远时按它取景）
    this.group = new THREE.Group();
    this.group.position.fromArray(water.pos);
    this.group.position.y += 0.01;
    this.group.visible = false;
    this.uniforms = {
      time: { value: 0 }, age: { value: 0 }, power: { value: 0 },
      tint: { value: new THREE.Color(MIST) }, height: { value: this.height }, radius: { value: water.r },
    };

    // 一缕一个小面（一次画完）。seed 决定它什么时候冒出来、离盆心多远、飘多高
    const positions = [], uvs = [], seeds = [], indices = [];
    for (let i = 0; i < WISPS; i++) {
      for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        positions.push(x, y, 0);
        uvs.push(x + 0.5, y + 0.5);
        seeds.push(i);
      }
      const v = i * 4;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    geo.setIndex(indices);
    this.mist = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute float seed;
        uniform float time, age, power, height, radius;
        varying vec2 vUv;
        varying float vAlpha, vSeed;
        float h1(float n) { return fract(sin(n * 127.1 + 31.7) * 43758.5453); }
        void main() {
          float delay = h1(seed) * 1.8;                                  // 一缕一缕先后冒出来
          float life = 4.2 + h1(seed + 1.0) * 2.2;
          float k = clamp((age - delay) / life, 0.0, 1.0);               // 0 → 1：从水面飘到最高处
          float a = seed * 2.39996 + time * 0.22 + k * 2.4;              // 绕盆心打旋
          float r = radius * (0.1 + h1(seed + 3.0) * 0.6) * (1.0 + k * 0.6);
          vec3 p = vec3(cos(a) * r, k * height * (0.6 + 0.4 * h1(seed + 4.0)), sin(a) * r);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float size = radius * (0.7 + k * 1.3) * (0.8 + 0.4 * h1(seed + 7.0));
          mv.xy += position.xy * size * vec2(0.8, 1.6);
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vSeed = seed;
          vAlpha = power * step(delay, age) * smoothstep(0.0, 0.18, k) * (1.0 - smoothstep(0.5, 1.0, k));
        }`,
      fragmentShader: /* glsl */`
        uniform float time;
        uniform vec3 tint;
        varying vec2 vUv;
        varying float vAlpha, vSeed;
        ${NOISE}
        void main() {
          vec2 c = vUv - 0.5;
          float soft = 1.0 - smoothstep(0.12, 0.5, length(c * vec2(1.0, 0.85)));
          vec3 q = vec3(vUv * vec2(3.2, 1.1) + vSeed * 3.7, time * 0.12); // 横向密、竖向疏：拉成竖着的细丝
          q.y -= time * 0.16;
          float warp = fbm(q * 1.4 + 4.0);
          float n = fbm(q + vec3(warp * 1.2, warp * 0.5, 0.0));
          float wisp = smoothstep(0.5, 0.86, n);                          // 一缕一缕的银丝，不是一团蒸汽
          float alpha = soft * wisp * vAlpha * 0.24;
          gl_FragColor = vec4(tint * (0.5 + 0.5 * n), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.mist.frustumCulled = false; // 顶点着色器把小面挪到盆上方，CPU 的包围盒不对
    this.mist.renderOrder = 2;
    this.group.add(this.mist);
  }

  trigger(color) {
    this.age = 0;
    this.uniforms.tint.value.set(MIST).lerp(new THREE.Color(color), 0.1); // 只带一丝项目色
    this.group.visible = true;
  }

  reset() {
    this.age = -1;
    this.power = this.flash = this.uniforms.power.value = 0;
    this.group.visible = false;
  }

  // 镜头与雾共用同一个消散进度；升起阶段保持完整构图。
  get framing() {
    return this.age < 0 ? 0 : 1 - smooth(6.0, 8.5, this.age);
  }

  update(t, dt) {
    this.uniforms.time.value = t;
    if (this.age < 0) return;
    this.age += dt;
    this.flash = smooth(0, 0.15, this.age) * (1 - smooth(0.2, 1.2, this.age));
    this.power = smooth(0, 0.8, this.age) * this.framing;
    this.uniforms.age.value = this.age;
    this.uniforms.power.value = this.power;
    if (this.age >= 8.5) this.reset();
  }
}
