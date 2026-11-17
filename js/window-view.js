// 窗外的动态雨夜（只给书桌房间用，js/room.js 调用）。
// 城市是 blender/render_view.py 渲染好的两层"局部全景"（等距柱状投影：u = 经度从左到右，v = 纬度从下到上），
// 各贴在一个以窗户中心为球心、半径 10 米 / 40 米的球面片上，镜头一动就有视差；左右 ±80° 都铺满，镜头转到哪都看不到边。
// 在这上面实时加：
//   - 城市层（着色器读同名的 _data.png，B 通道是类别）：亮着的窗偶尔关灯、开灯，个别窗里是电视的蓝光；
//     楼顶的红色障碍灯慢慢闪；
//     水面：倒影上下抖动（波光粼粼）、雨点打出一圈圈涟漪（按水面上真实的米来算，远处的自然变小；只在灯光的倒影里看得见）
//   - 天空（以镜头为中心的大球，画在房间后面，只算从窗户露出来的那些像素）：地平线的城市光、慢慢转的星空和银河（星河流转）、
//     会闪的星星、月亮和光晕、两层往一个方向飘的薄云（底部被城市映成暖色），云缝里露出星星
//   - 车流：一对对车灯沿着车道慢慢开（白色车头灯朝我们开、红色尾灯开走），被楼挡住的地方看不见
//   - 雨：几千条实例化的斜雨丝，在窗外 1–30 米
import * as THREE from 'three';

const D2R = Math.PI / 180;

// ---------- 共用的 GLSL：哈希、值噪声、fbm ----------
const NOISE = /* glsl */ `
  float hash1(float n) { return fract(sin(n) * 43758.5453123); }
  float hash2(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
  vec3 hash33(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yxz + 19.19); return fract((p.xxy + p.yxx) * p.zyx); }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    float n = dot(i, vec3(1.0, 57.0, 113.0));
    return mix(mix(mix(hash1(n), hash1(n + 1.0), u.x), mix(hash1(n + 57.0), hash1(n + 58.0), u.x), u.y),
               mix(mix(hash1(n + 113.0), hash1(n + 114.0), u.x), mix(hash1(n + 170.0), hash1(n + 171.0), u.x), u.y), u.z);
  }
  float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.07 + 11.3; a *= 0.5; } return s; }
`;

// ---------- 城市层 ----------
function cityMaterial(map, data, pano, near) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      map: { value: map }, dataMap: { value: data }, time: { value: 0 }, near: { value: near ? 1 : 0 },
      lon: { value: new THREE.Vector2(pano.lon[0] * D2R, pano.lon[1] * D2R) },
      lat: { value: new THREE.Vector2(pano.lat[0] * D2R, pano.lat[1] * D2R) },
      rain: { value: 1 },
      texel: { value: new THREE.Vector2(1 / data.image.width, 1 / data.image.height) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map, dataMap;
      uniform float time, near, rain;
      uniform vec2 lon, lat, texel;
      varying vec2 vUv;
      ${NOISE}
      // 水面上的雨点涟漪：p = 水面上的位置（米）。一格一个雨点：一圈波从落点往外扩、越来越弱；三层大小不同的格子错开。
      // 返回水面坡度（不直接加亮）：涟漪只是把倒影推歪、让倒影亮一点暗一点，所以只在灯光的倒影里看得见，暗处的水面上几乎看不出来
      vec2 ripples(vec2 p) {
        vec2 grad = vec2(0.0);
        for (int k = 0; k < 3; k++) {
          float cs = k == 0 ? 0.9 : k == 1 ? 0.62 : 0.47;
          vec2 q = p / cs + float(k) * 7.31;
          vec2 cell = floor(q), f = fract(q);
          float h = hash2(cell + float(k) * 3.7);
          float ph = fract(time * (0.6 + 0.5 * h) + h * 9.1);
          vec2 c = 0.3 + 0.4 * vec2(hash2(cell + 1.3), hash2(cell + 2.9));
          vec2 dv = f - c;
          float d = length(dv), r = 0.04 + ph * 0.42;
          float x = (d - r) / 0.045;
          float fade = (1.0 - ph) * (1.0 - ph) * step(h, 0.75);
          grad += sin(x * 3.14159) * exp(-x * x) * fade * dv / max(d, 1e-3);   // 一圈波峰、一圈波谷
        }
        return grad;
      }
      void main() {
        vec4 d = texture2D(dataMap, vUv);
        float cat = d.b;
        bool water = cat > 0.75, beacon = cat > 0.4 && cat < 0.6;
        vec2 uv = vUv;
        float shade = 0.0;
        if (water) {
          // 这个像素看到的水面在哪（米）：从窗户中心（离水面约 24.5 米）沿这个方向射下去
          float lo = mix(lon.x, lon.y, vUv.x), la = mix(lat.x, lat.y, vUv.y);
          vec3 dir = vec3(sin(lo) * cos(la), sin(la), cos(lo) * cos(la));
          float dist = 24.5 / max(-dir.y, 0.02);
          vec2 wp = vec2(dir.x, dir.z) * dist;
          float nearK = clamp(70.0 / dist, 0.15, 1.0);              // 远处的涟漪小、看不清
          // 倒影：被风吹皱的水面把灯光拉成竖条，竖着慢慢抖
          float n = noise2(vec2(wp.x * 0.35, wp.y * 2.2 - time * 1.4)) - 0.5;
          uv.y += n * 0.0035 * clamp(60.0 / dist, 0.25, 1.0);
          uv.x += (noise2(vec2(wp.x * 0.8 + time * 0.3, wp.y)) - 0.5) * 0.0008;
          // 雨点涟漪：把倒影推歪一点，迎光那半圈亮一点、背光那半圈暗一点
          vec2 g = ripples(wp) * rain;
          uv += vec2(g.x * 0.0009, g.y * 0.0022) * nearK;
          shade = g.y * 0.35 * nearK;
        }
        vec4 c = texture2D(map, uv);
        if (c.a < 0.004) discard; // 透明的天空部分（两层全景大部分是这个）：直接跳过
        vec3 col = c.rgb * (1.0 + shade);
        float a = c.a;
        if (cat < 0.1 && c.a > 0.5) { // 楼：数据图是一半分辨率，窗的边缘对不齐 —— 看上下左右和自己 5 个数据像素，哪个是"要关的亮窗"就整片压暗
          float off = 0.0, tv = 0.0, tvId = 0.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            if (i * j != 0) continue; // 十字形的 5 个就够（窗边最多差一个数据像素）
            vec4 q = texture2D(dataMap, vUv + vec2(float(i), float(j)) * texel);
            if (q.b > 0.1 || q.r < 0.5) continue;
            float id = q.g;
            float per = 22.0 + id * 47.0;
            float k = floor(time / per + id * 13.7);
            off = max(off, step(hash1(k * 17.31 + id * 911.7), 0.07));    // 每隔几十秒，约 7% 的窗关灯（下一轮又亮）
            if (id < 0.035) { tv = 1.0; tvId = id; }                       // 个别窗里是电视：蓝光一闪一闪
          }
          vec3 tvc = vec3(0.55, 0.78, 1.3) * (0.75 + 0.25 * sin(time * 9.0 + tvId * 300.0) * sin(time * 2.3 + tvId * 50.0));
          col = mix(col, col * tvc, tv);
          col *= mix(1.0, 0.08, off);
        }
        if (beacon) col *= 0.12 + 2.2 * smoothstep(0.8, 0.86, fract(time * 0.45 + d.r));
        gl_FragColor = vec4(col, a);
      }`,
  });
}

function panoGeometry(R, pano, segX = 96, segY = 48) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segY; j++) {
    const v = j / segY, la = (pano.lat[0] + (pano.lat[1] - pano.lat[0]) * v) * D2R;
    for (let i = 0; i <= segX; i++) {
      const u = i / segX, lo = (pano.lon[0] + (pano.lon[1] - pano.lon[0]) * u) * D2R;
      pos.push(R * Math.sin(lo) * Math.cos(la), R * Math.sin(la), -R * Math.cos(lo) * Math.cos(la));
      uv.push(u, v);
    }
  }
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i, b = a + 1, c = a + segX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------- 车流：一个个车灯沿着车道慢慢开（view.json 的 pano.lanes，render_view.py 写的）----------
// 车的真实位置在几百米到几公里外，但画的时候放到它所在那一层全景的球面上（方向不变，大小按真实距离缩），视差和城市一致。
// 有没有被楼挡住：看它所在那一层的数据图，那个方向（周围 3×3 个数据像素）是不是"车道"；远处的车还要看近景那层在那个方向是不是透明的
function carsMesh(pano, nearMap, nearData, farData) {
  const lanes = pano.lanes || [];
  const A = [], DIR = [], PAR = [];
  for (const L of lanes) {
    const a = new THREE.Vector3(...L.a), b = new THREE.Vector3(...L.b);
    const len = a.distanceTo(b), dir = b.clone().sub(a).divideScalar(len);
    const speed = 7 + Math.random() * 4;            // 每条车道一个速度（米 / 秒，25–40 公里每小时），同一条道上的车不会互相穿过去
    for (let s0 = Math.random() * 50; s0 < len; s0 += 30 + Math.random() * 70) {
      for (const side of [-0.75, 0.75]) {           // 一辆车两盏灯
        A.push(a.x, a.y, a.z);
        DIR.push(dir.x, dir.y, dir.z, len);
        PAR.push(s0, speed, side, L.toward ? 1 : 0);
      }
    }
  }
  const n = PAR.length / 4;
  const base = new THREE.PlaneGeometry(2, 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(new Float32Array(A), 3));
  g.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(DIR), 4));
  g.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array(PAR), 4));
  g.instanceCount = n;
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 }, pxAngle: { value: 0.0005 }, split: { value: pano.split || 250 },
      lon: { value: new THREE.Vector2(pano.lon[0] * D2R, pano.lon[1] * D2R) },
      lat: { value: new THREE.Vector2(pano.lat[0] * D2R, pano.lat[1] * D2R) },
      nearMap: { value: nearMap }, nearData: { value: nearData }, farData: { value: farData },
      texN: { value: new THREE.Vector2(1 / nearData.image.width, 1 / nearData.image.height) },
      texF: { value: new THREE.Vector2(1 / farData.image.width, 1 / farData.image.height) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aA;
      attribute vec4 aDir, aP;
      uniform float time, pxAngle, split;
      uniform vec2 lon, lat, texN, texF;
      uniform sampler2D nearMap, nearData, farData;
      varying vec2 vQ;
      varying vec3 vColor;
      float laneN(vec2 p) { float m = 0.0; for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { float b = texture2D(nearData, p + vec2(float(i), float(j)) * texN).b; m = max(m, step(0.15, b) * step(b, 0.35)); } return m; }
      float laneF(vec2 p) { float m = 0.0; for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { float b = texture2D(farData, p + vec2(float(i), float(j)) * texF).b; m = max(m, step(0.15, b) * step(b, 0.35)); } return m; }
      void main() {
        float s = mod(aP.x + aP.y * time, aDir.w);
        vec3 perp = normalize(vec3(-aDir.y, aDir.x, 0.0));
        vec3 pb = aA + aDir.xyz * s + perp * aP.z;          // Blender 坐标（相机 = 窗户中心在原点，+Y 朝外，Z 朝上）
        vec3 p = vec3(pb.x, pb.z, -pb.y);                    // → three（以窗户中心为原点）
        float dist = length(p);
        vec3 dir = p / dist;
        vec2 pu = vec2((atan(dir.x, -dir.z) - lon.x) / (lon.y - lon.x), (asin(dir.y) - lat.x) / (lat.y - lat.x));
        bool far = dist > split;
        float vis = far ? laneF(pu) * step(texture2D(nearMap, pu).a, 0.5) : laneN(pu);
        float R = far ? 39.5 : 9.85;                         // 画在那一层球面的前面一点
        vec4 mv = modelViewMatrix * vec4(dir * R, 1.0);
        float trueSize = R * 0.35 / dist;                    // 车灯连光晕约 35 厘米
        float size = max(trueSize, pxAngle * 1.6 * -mv.z);   // 至少一个多像素，太远的就变淡
        mv.xy += position.xy * size * vis;
        gl_Position = projectionMatrix * mv;
        vQ = position.xy;
        float k = clamp(trueSize * trueSize / (size * size), 0.025, 1.0) * exp(-dist / 1400.0); // 远处的车被雾吃掉，不会在路的尽头挤成一团亮光
        vColor = (aP.w > 0.5 ? vec3(1.0, 0.9, 0.75) * 6.0 : vec3(1.0, 0.1, 0.04) * 4.5) * k * vis;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vQ;
      varying vec3 vColor;
      void main() {
        float a = exp(-dot(vQ, vQ) * 3.5);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- 天空 ----------
function skyMaterial(moonDir) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { time: { value: 0 }, moonDir: { value: moonDir }, skyRot: { value: new THREE.Matrix3() }, cover: { value: 0.55 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float time, cover;
      uniform vec3 moonDir;
      uniform mat3 skyRot;
      varying vec3 vDir;
      ${NOISE}
      vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
      // 一层星星：每个格子最多一颗；格子越小星星越小越密
      vec3 stars(vec3 sd, float scale, float density, float gain) {
        vec3 p = sd * scale, cell = floor(p), f = fract(p);
        vec3 h = hash33(cell);
        if (h.x > density) return vec3(0.0);
        vec3 c = 0.5 + (h - 0.5) * 0.7;
        float d = length(f - c);
        float px = length(fwidth(p));                       // 一个像素有多少"格"：星星至少一个像素大
        float s = max(0.045, px * 0.7);
        float b = exp(-d * d / (s * s)) * pow(h.y, 5.0) * gain;
        b *= 0.65 + 0.35 * sin(time * (1.5 + h.z * 4.0) + h.z * 40.0);   // 闪
        return b * mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.88, 0.72), h.z);
      }
      void main() {
        vec3 d = normalize(vDir);
        float alt = d.y;
        // 底色：和 Blender 里原来的天空同一条渐变（地平线的城市光雾 → 深蓝 → 几乎黑）
        float t = clamp((alt + 0.02) / 0.62, 0.0, 1.0);
        vec3 c0 = lin(vec3(0.227, 0.165, 0.251)), c1 = lin(vec3(0.173, 0.137, 0.314)), c2 = lin(vec3(0.063, 0.086, 0.227)), c3 = lin(vec3(0.016, 0.024, 0.059));
        vec3 sky = t < 0.05 ? mix(c0, c1, t / 0.05) : t < 0.25 ? mix(c1, c2, (t - 0.05) / 0.2) : mix(c2, c3, (t - 0.25) / 0.75);
        sky += lin(vec3(1.0, 0.55, 0.3)) * 0.05 * exp(-max(alt, 0.0) / 0.06);   // 地平线上城市的光污染
        // 星空、银河：在转动的坐标里算（skyRot 每帧绕天极转一点 = 星河流转）
        vec3 sd = skyRot * d;
        vec3 nmw = normalize(vec3(0.82, 0.55, 0.12));                    // 银河所在大圆的法线
        float b = dot(sd, nmw);
        float band = exp(-b * b / 0.035);
        vec3 milky = vec3(0.0);
        if (band > 0.004 && alt > 0.0) { // 只在银河附近算噪声
          float st = fbm3(sd * 5.0);
          float dust = noise3(sd * 11.0 + 3.0) * 0.6 + noise3(sd * 23.0) * 0.4;
          float mw = band * (0.35 + 0.9 * st) * (1.0 - 0.75 * smoothstep(0.45, 0.7, dust) * exp(-b * b / 0.006));
          milky = mix(vec3(0.5, 0.58, 0.85), vec3(1.0, 0.86, 0.68), smoothstep(0.4, 0.75, st)) * mw * 0.055;
        }
        vec3 starry = stars(sd, 170.0, 0.22 + 0.35 * band, 2.2) + stars(sd, 85.0, 0.1, 3.5) + stars(sd, 340.0, 0.3 * band, 1.2);
        float ext = smoothstep(0.0, 0.22, alt);                          // 地平线附近被雾吃掉
        vec3 night = sky + (milky + starry) * ext;
        // 月亮：一直隔着一层薄云——不是一个刺眼的亮点，而是云后面一团柔和的光（亮度在辉光阈值以下，不会被放大成一大片）
        float md = dot(d, moonDir);
        float ang = acos(clamp(md, -1.0, 1.0));                         // 离月亮多少弧度
        float disc = smoothstep(0.0135, 0.0085, ang);                    // 月面：半径约 0.6°，边缘是虚的
        night += vec3(1.0, 0.95, 0.85) * disc * 0.45 + vec3(0.5, 0.56, 0.78) * (exp(-ang / 0.05) * 0.05 + exp(-ang / 0.22) * 0.012);
        // 云：两层薄云往一个方向飘，底部被城市映成暖色；覆盖一半左右，缝里露出星星和月亮
        if (alt > 0.0) {
          vec2 p = d.xz / (alt + 0.12);
          float c1 = fbm2(p * 0.9 + vec2(time * 0.012, time * 0.004));
          float c2 = fbm2(p * 2.1 + vec2(time * 0.03, -time * 0.006) + 5.0);
          float cov = smoothstep(1.0 - cover, 1.0 - cover + 0.28, c1) * 0.85 + smoothstep(0.58, 0.85, c2) * 0.3;
          cov = max(cov, 0.5 * exp(-ang / 0.18));                          // 月亮前面总有一层薄云
          cov = clamp(cov, 0.0, 0.96) * smoothstep(0.0, 0.05, alt);
          vec3 cc = mix(lin(vec3(0.16, 0.1, 0.09)), lin(vec3(0.38, 0.2, 0.13)), exp(-alt / 0.2)) * 0.6;
          cc += vec3(0.07, 0.075, 0.095) * exp(-ang / 0.16);               // 月亮旁边的云被照亮：一圈柔和的光
          night = mix(night, cc, cov);
        } else {
          night = c0 * 0.6;
        }
        gl_FragColor = vec4(night, 1.0);
      }`,
  });
}

// ---------- 雨 ----------
function rainMesh(count) {
  const base = new THREE.PlaneGeometry(1, 1);
  base.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  const off = new Float32Array(count * 3), par = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = -(1.0 + Math.pow(Math.random(), 1.6) * 29); // 近处多一点
    off.set([(Math.random() - 0.5) * (8 - z * 1.4), Math.random(), z], i * 3);
    par.set([7.5 + Math.random() * 3, 0.35 + Math.random() * 0.45, Math.random()], i * 3); // 速度、长度、随机数
  }
  g.setAttribute('offset', new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute('params', new THREE.InstancedBufferAttribute(par, 3));
  g.instanceCount = count;
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, // 面片在着色器里才转向镜头：正反面不固定
    uniforms: { time: { value: 0 }, camPos: { value: new THREE.Vector3() }, top: { value: 10 }, height: { value: 28 }, wind: { value: new THREE.Vector2(0.18, 0.05) }, amount: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 offset, params;
      uniform float time, top, height;
      uniform vec2 wind;
      uniform vec3 camPos;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vec3 fallDir = normalize(vec3(wind.x, -1.0, wind.y));
        float y = top - mod(offset.y * height + time * params.x, height);
        vec3 p = vec3(offset.x + wind.x * (top - y), y, offset.z + wind.y * (top - y));
        vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
        vec3 toCam = normalize(camPos - wp);
        vec3 side = normalize(cross(fallDir, toCam));
        float dist = length(camPos - wp);
        float width = 0.0025 + dist * 0.0009;                        // 远处的雨丝至少一个像素粗（变淡）
        wp += side * position.x * width - fallDir * position.y * params.y;
        vUv = uv;
        vFade = clamp(1.6 / (0.6 + dist * 0.12), 0.0, 1.0) * (0.55 + 0.45 * params.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float amount;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
        float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y)); // smoothstep 的两个边界不能反着写（Metal 上会是 0）
        float a = across * across * along * vFade * amount;
        gl_FragColor = vec4(vec3(0.62, 0.62, 0.66) * a * 0.22, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

// base：assets/baked/ 的地址；view：view.json；win：manifest.window（窗户中心）；moon：月亮方向（three 坐标）
export async function createWindowView({ base, view, win, scene, camera, renderer = null, moon = [-0.33, 0.28, -1.0], onProgress }) {
  const pano = view?.pano;
  if (!pano) return null;
  const loader = new THREE.TextureLoader();
  const v = encodeURIComponent(view.built || '');
  const load = (f, color) => loader.loadAsync(`${base}${f}?v=${v}`).then((t) => {
    if (color) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; } else {
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = t.magFilter = THREE.NearestFilter; // 数据图：类别不能插值
      t.generateMipmaps = false;
    }
    return t;
  });
  let done = 0;
  const total = pano.layers.length * 2;
  const tick = (x) => { onProgress?.(++done / total); return x; };
  const layers = await Promise.all(pano.layers.map(async (L) => {
    const [map, data] = await Promise.all([load(L.file, true).then(tick), load(L.data, false).then(tick)]);
    return { L, map, data };
  }));

  const root = new THREE.Group();
  root.position.set(win.x, win.y, win.z);
  scene.add(root);
  const mats = [];
  layers.forEach(({ L, map, data }, i) => {
    const near = L.dist < 20;
    const m = cityMaterial(map, data, pano, near);
    mats.push(m);
    const mesh = new THREE.Mesh(panoGeometry(L.dist, pano), m);
    mesh.renderOrder = 2 + i; // 远的先画，近的叠上去（透明物体按 renderOrder 排）
    mesh.frustumCulled = false;
    root.add(mesh);
  });

  // 天空：以镜头为中心（无穷远，镜头平移它不动），画在房间之后、城市之前
  const moonDir = new THREE.Vector3(...moon).normalize();
  const skyMat = skyMaterial(moonDir);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), skyMat);
  sky.renderOrder = 1;
  sky.frustumCulled = false;
  scene.add(sky);
  const pole = new THREE.Vector3(-0.35, 0.62, -0.7).normalize(); // 天极：窗外左上方，星空绕着它转
  const rot4 = new THREE.Matrix4();

  // 车流：近景那层和远景那层的数据图都要用（远处的车可能被近处的东西挡住）
  const nearL = layers.find((l) => l.L.dist < 20), farL = layers.find((l) => l.L.dist >= 20);
  const cars = nearL && farL && pano.lanes?.length ? carsMesh(pano, nearL.map, nearL.data, farL.data) : null;
  if (cars) { cars.renderOrder = 4; root.add(cars); }

  // 雨：窗外的一个盒子里（窗户中心的坐标系）
  const rain = rainMesh(2600);
  rain.renderOrder = 5;
  root.add(rain);

  let time = 0;
  return {
    root, sky, rain, cars,
    update(dt) {
      time += dt;
      for (const m of mats) m.uniforms.time.value = time;
      skyMat.uniforms.time.value = time;
      skyMat.uniforms.skyRot.value.setFromMatrix4(rot4.makeRotationAxis(pole, -time * 0.004)); // 约 0.23°/秒
      sky.position.copy(camera.position);
      rain.material.uniforms.time.value = time;
      rain.material.uniforms.camPos.value.copy(camera.position);
      if (cars) {
        cars.material.uniforms.time.value = time;
        const h = renderer?.domElement.height || innerHeight;
        cars.material.uniforms.pxAngle.value = (2 * Math.tan((camera.fov * D2R) / 2)) / h; // 一个物理像素对应的角度
      }
    },
  };
}
