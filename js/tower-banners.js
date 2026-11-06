// 窗边挂旗：左右独立随机风，红布与金色纹样共享所在旗帜的形变。
import * as THREE from 'three';
import { BannerWind } from './banner-wind.js';

// 原模型的长方形只有两个三角形。补充顶点才能弯曲，插值保留原有颜色 / 光照 UV。
function subdivide(source, maxEdge = 0.065) {
  const entries = Object.entries(source.attributes);
  const offsets = [];
  let stride = 0;
  for (const [, attr] of entries) { offsets.push(stride); stride += attr.itemSize; }
  const positionOffset = offsets[entries.findIndex(([name]) => name === 'position')];
  const output = entries.map(() => []);
  const vertex = (index) => entries.flatMap(([, attr]) =>
    Array.from({ length: attr.itemSize }, (_, k) => attr.getComponent(index, k)));
  const distance2 = (a, b) => {
    let d = 0;
    for (let k = 0; k < 3; k++) d += (a[positionOffset + k] - b[positionOffset + k]) ** 2;
    return d;
  };
  function triangle(a, b, c) {
    const ab = distance2(a, b), bc = distance2(b, c), ca = distance2(c, a);
    if (Math.max(ab, bc, ca) > maxEdge * maxEdge) {
      // 旋转顺序，把最长边放到 a-b；保持三角形朝向不变。
      if (bc > ab && bc >= ca) [a, b, c] = [b, c, a];
      else if (ca > ab && ca > bc) [a, b, c] = [c, a, b];
      const mid = a.map((v, i) => (v + b[i]) * 0.5);
      triangle(a, mid, c);
      triangle(mid, b, c);
      return;
    }
    for (const v of [a, b, c]) entries.forEach(([, attr], i) => {
      for (let k = 0; k < attr.itemSize; k++) output[i].push(v[offsets[i] + k]);
    });
  }
  const count = source.index?.count ?? source.attributes.position.count;
  for (let i = 0; i < count; i += 3) {
    triangle(...[0, 1, 2].map((k) => vertex(source.index ? source.index.getX(i + k) : i + k)));
  }
  const geometry = new THREE.BufferGeometry();
  entries.forEach(([name, attr], i) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(output[i], attr.itemSize)));
  return geometry;
}

export class TowerBanners {
  constructor(room) {
    this.motion = { value: 1 };
    this.winds = [new BannerWind(), new BannerWind()];
    this.windUniforms = this.winds.map(() => ({ value: new THREE.Vector4() }));
    this.update(0);
    this.meshes = [...(room.byMat.get('tapestry') || []), ...(room.byMat.get('tapestry_gold') || [])];
    const bounds = [new THREE.Box3(), new THREE.Box3()];
    const p = new THREE.Vector3();
    for (const mesh of room.byMat.get('tapestry') || []) {
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        p.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        bounds[p.x < 0 ? 0 : 1].expandByPoint(p);
      }
    }
    const normals = bounds.map((box) => box.getCenter(new THREE.Vector3()).setY(0).normalize().negate());
    for (const mesh of this.meshes) {
      // 不修改公共 BakedRoom 着色器，也不重新导出模型或占用共享烘焙文件。
      mesh.geometry = subdivide(mesh.geometry);
      const positions = mesh.geometry.attributes.position;
      const wind = [];
      for (let i = 0; i < positions.count; i++) {
        p.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        const side = p.x < 0 ? 0 : 1, box = bounds[side], n = normals[side];
        const down = THREE.MathUtils.clamp((box.max.y - p.y - 0.015) / (box.max.y - box.min.y - 0.015), 0, 1);
        wind.push(p.x * n.z - p.z * n.x, down, n.x, n.z);
      }
      mesh.geometry.setAttribute('bannerWind', new THREE.Float32BufferAttribute(wind, 4));
      mesh.geometry.computeBoundingBox();
      mesh.geometry.boundingBox.expandByScalar(0.24);
      mesh.geometry.computeBoundingSphere();
      mesh.geometry.boundingSphere.radius += 0.24;
      const material = mesh.material;
      material.uniforms.bannerLeft = this.windUniforms[0];
      material.uniforms.bannerRight = this.windUniforms[1];
      material.uniforms.bannerMotion = this.motion;
      material.side = THREE.DoubleSide;
      material.vertexShader = /* glsl */`
        uniform float bannerMotion;
        uniform vec4 bannerLeft, bannerRight;
        attribute vec4 bannerWind;
        varying float bannerShade;
      ` + material.vertexShader.replace('vPos = wp.xyz;', /* glsl */`
        float down = bannerWind.y;
        float freeEdge = down * down * (3.0 - 2.0 * down);
        vec4 wind = mix(bannerLeft, bannerRight, step(0.0, wp.x));
        float swell = wind.z - down * 4.6;
        float fold = wind.w - down * 7.5 + bannerWind.x * 8.0;
        float strength = freeEdge * wind.y * bannerMotion;
        // 单纯向镜头拱起在全景里几乎不可见：增加沿墙的横摆，让轮廓也随风变化。
        // 法向位移始终朝室内（最高 17 cm），横摆含褶皱最高 11.7 cm，悬挂处仍完全固定。
        float displacement = strength * (0.09 + 0.055 * sin(swell) + 0.025 * sin(fold));
        float sideways = strength * (wind.x + 0.012 * sin(fold));
        vec2 tangent = vec2(bannerWind.w, -bannerWind.z);
        wp.xz += bannerWind.zw * displacement + tangent * sideways;
        wp.y += strength * 0.025 * (1.0 - cos(swell));
        bannerShade = 1.0 + strength * (0.12 * cos(swell) + 0.08 * cos(fold));
        vPos = wp.xyz;
      `);
      material.fragmentShader = 'varying float bannerShade;\n' + material.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        'gl_FragColor.rgb *= bannerShade;\n#include <tonemapping_fragment>',
      );
      material.needsUpdate = true;
    }
    // 系统要求减少动态时，旗帜恢复静止；不影响原有房间交互。
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotionChange = () => { this.motion.value = this.reducedMotion.matches ? 0 : 1; };
    this.reducedMotion.addEventListener('change', this.onMotionChange);
    this.onMotionChange();
  }

  update(time) {
    this.winds.forEach((wind, i) => {
      const value = wind.sample(time);
      this.windUniforms[i].value.set(value.sway, value.strength, value.swell, value.fold);
    });
  }
}
