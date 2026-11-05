// 冥想盆的投掷仪式：入水后光柱升起，随后浮现没有语言含义的碎片符号。
// 符号用线段画进一次性图集，不使用字体或项目文案；动画全部在 GPU 上完成。
import * as THREE from 'three';

const smooth = (a, b, x) => {
  const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

function glyphAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  let seed = 87231;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  ctx.strokeStyle = '#dcffff';
  ctx.fillStyle = '#dcffff';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'square';
  for (let i = 0; i < 32; i++) {
    ctx.save();
    ctx.translate((i % 8) * 64 + 13, Math.floor(i / 8) * 64 + 10);
    // 不规则的断笔、分叉、点阵；每个格子都是独立的伪字形。
    for (let j = 0; j < 5; j++) {
      const x = Math.floor(rand() * 4) * 10, y = Math.floor(rand() * 4) * 10;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rand() > 0.5 ? 10 : -7), y + (rand() > 0.5 ? 10 : 0));
      if (rand() > 0.45) ctx.lineTo(x + 3, y + 17);
      ctx.stroke();
    }
    ctx.fillRect(Math.floor(rand() * 4) * 10, Math.floor(rand() * 4) * 10, 3, 3);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class BasinMagic {
  constructor(water) {
    this.age = -1;
    this.power = 0;
    this.flash = 0;
    this.height = water.r * 3.6;
    this.group = new THREE.Group();
    this.group.position.fromArray(water.pos);
    this.group.position.y += 0.008;
    this.group.visible = false;
    this.uniforms = {
      time: { value: 0 }, age: { value: 0 }, power: { value: 0 },
      tint: { value: new THREE.Color('#8ce9ff') }, atlas: { value: glyphAtlas() },
      height: { value: this.height }, radius: { value: water.r * 0.65 },
    };
    const material = (vertexShader, fragmentShader) => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const geo = new THREE.CylinderGeometry(water.r * 0.76, water.r * 0.63, this.height, 48, 1, true);
    geo.translate(0, this.height / 2, 0);
    this.beam = new THREE.Mesh(geo, material(/* glsl */`
      uniform float age;
      varying vec2 vUv;
      varying vec3 vNormal, vView;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.y *= smoothstep(0.0, 1.25, age);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`, /* glsl */`
      uniform float time, power;
      uniform vec3 tint;
      varying vec2 vUv;
      varying vec3 vNormal, vView;
      void main() {
        float y = vUv.y;
        float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 0.7);
        float ends = smoothstep(0.0, 0.035, y) * (1.0 - smoothstep(0.45, 1.0, y));
        float flow = sin(vUv.x * 69.115 + sin(y * 8.0 - time * 0.6) * 0.7 + time * 0.12);
        float threads = pow(max(0.0, flow), 10.0);
        float mist = 0.8 + 0.2 * sin(y * 19.0 - time * 1.5 + vUv.x * 30.0);
        float alpha = ends * edge * (0.12 * mist + 0.22 * threads) * power;
        gl_FragColor = vec4(tint * (1.4 + threads * 0.7), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`));
    this.beam.renderOrder = 2;
    this.group.add(this.beam);

    // 一次绘制全部符号。每个小面始终朝向镜头，沿各自轨道缓慢上浮。
    const positions = [], uvs = [], seeds = [], indices = [];
    for (let i = 0; i < 64; i++) {
      for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        positions.push(x, y, 0);
        uvs.push(x + 0.5, y + 0.5);
        seeds.push(i);
      }
      const v = i * 4;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const glyphGeo = new THREE.BufferGeometry();
    glyphGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    glyphGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    glyphGeo.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    glyphGeo.setIndex(indices);
    this.glyphs = new THREE.Mesh(glyphGeo, material(/* glsl */`
      attribute float seed;
      uniform float time, age, power, height, radius;
      varying vec2 vUv;
      varying float vAlpha;
      float hash(float n) { return fract(sin(n * 127.1 + 31.7) * 43758.5453); }
      void main() {
        float h = fract(hash(seed) + max(0.0, age - 1.0) * 0.055);
        float a = seed * 2.39996 + time * (0.08 + hash(seed + 2.0) * 0.08);
        float r = radius * (0.3 + hash(seed + 3.0) * 0.65);
        vec3 p = vec3(cos(a) * r, (0.08 + h * 0.86) * height, sin(a) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float size = 0.035 + hash(seed + 7.0) * 0.024;
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
        float cell = mod(seed * 7.0 + floor(time * 1.8 + seed) * step(0.82, hash(seed + 9.0)), 32.0);
        vUv = (uv + vec2(mod(cell, 8.0), 3.0 - floor(cell / 8.0))) / vec2(8.0, 4.0);
        float reveal = smoothstep(1.0 + hash(seed + 5.0) * 1.7, 2.2 + hash(seed + 5.0) * 1.7, age);
        vAlpha = reveal * power * smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.7, 1.0, h));
        vAlpha *= 0.7 + 0.3 * sin(time * 1.4 + seed);
      }`, /* glsl */`
      uniform sampler2D atlas;
      uniform vec3 tint;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 glyph = texture2D(atlas, vUv);
        gl_FragColor = vec4(mix(tint, vec3(0.8, 1.0, 1.0), 0.6) * 2.2, glyph.a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`));
    this.glyphs.frustumCulled = false; // 顶点着色器将小面移动到光柱内，CPU 包围盒不适用。
    this.glyphs.renderOrder = 3;
    this.group.add(this.glyphs);
  }

  trigger(color) {
    this.age = 0;
    this.uniforms.tint.value.set('#8ce9ff').lerp(new THREE.Color(color), 0.18);
    this.group.visible = true;
  }

  reset() {
    this.age = -1;
    this.power = this.flash = this.uniforms.power.value = 0;
    this.group.visible = false;
  }

  // 镜头与光柱共用同一个消散进度；升起阶段保持完整构图。
  get framing() {
    return this.age < 0 ? 0 : 1 - smooth(6.0, 8.5, this.age);
  }

  update(t, dt) {
    this.uniforms.time.value = t;
    if (this.age < 0) return;
    this.age += dt;
    this.flash = smooth(0, 0.15, this.age) * (1 - smooth(0.2, 1.2, this.age));
    this.power = smooth(0, 0.5, this.age) * this.framing;
    this.uniforms.age.value = this.age;
    this.uniforms.power.value = this.power;
    if (this.age >= 8.5) this.reset();
  }
}
