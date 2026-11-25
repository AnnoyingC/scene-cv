import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { calendar, sources } from './calendar.js';

export async function makeBoard(scene, renderer, shelf, useLocal) {
  if (!shelf) return null;
  const board = new THREE.Group();
  const wallX = shelf.c[0] - shelf.h[2];
  board.position.set(wallX + 0.019, shelf.c[1] + 0.335 * shelf.h[1], shelf.c[2] + shelf.h[0] + 0.285);
  board.rotation.y = Math.PI / 2;
  board.scale.setScalar(0.00072);

  const [grain, mark, data] = await Promise.all([
    new THREE.TextureLoader().loadAsync(new URL('../../assets/activity/grain.jpg', import.meta.url).href),
    new SVGLoader().loadAsync(new URL('../../assets/activity/github.svg', import.meta.url).href),
    calendar(useLocal),
    document.fonts.load('36px "EB Garamond"'),
    document.fonts.load('14px Cinzel'),
  ]);
  const { days, last, level, reading, end, caption } = data;
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.anisotropy = renderer.capabilities.getMaxAnisotropy();
  function wood(color) {
    return new THREE.MeshStandardMaterial({
      color,
      map: grain,
      roughness: 0.73,
      bumpMap: grain,
      bumpScale: 0.065,
    });
  }
  const walnut = wood('#714432'),
    maple = wood('#edc58c'),
    cherry = wood('#c77e50');
  const ebony = wood('#402c26'),
    honey = wood('#e5ad6e'),
    ash = wood('#ffe3ad');
  const brass = new THREE.MeshStandardMaterial({ color: '#cca165', metalness: 0.29, roughness: 0.37 });
  function add(parent, geometry, material, x, y, z) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  function block(parent, x, y, z, w, h, d, mat, r = 2) {
    const geom = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, d * 0.48, h * 0.48, w * 0.48));
    return add(parent, geom, mat, x, y, z);
  }
  function oval(parent, x, y, z, w, h, d, mat) {
    const m = add(parent, new THREE.SphereGeometry(1, 24, 16), mat, x, y, z);
    m.scale.set(w / 2, h / 2, d / 2);
    return m;
  }

  // Stepped walnut moulding, narrow brass stringing and a figured maple panel.
  block(board, 0, 0, 0, 738, 722, 34, walnut, 13);
  block(board, 0, 0, 16, 720, 704, 13, ebony, 7);
  block(board, 0, 0, 22, 712, 696, 8, brass, 4);
  block(board, 0, 0, 27, 705, 689, 10, walnut, 5);
  block(board, 0, 0, 32, 681, 665, 10, maple, 5);
  for (const x of [-322, 322])
    for (const y of [-312, 312]) {
      oval(board, x, y, 39, 9, 9, 4, brass);
      block(board, x, y, 41, 5, 1.2, 0.7, ebony, 0.3).rotation.z = 0.6;
    }
  // One printed/engraved surface for all lettering; it updates only on input.
  const surface = document.createElement('canvas');
  surface.width = 1440;
  surface.height = 1440;
  const ctx = surface.getContext('2d');
  const print = new THREE.CanvasTexture(surface);
  print.colorSpace = THREE.SRGBColorSpace;
  print.anisotropy = grain.anisotropy;
  add(
    board,
    new THREE.PlaneGeometry(720, 720),
    new THREE.MeshBasicMaterial({ map: print, transparent: true, depthWrite: false }),
    0,
    0,
    38.1,
  );
  const ink = '#492e21',
    gild = '#92714b';
  const stains = ['#ecd4a6', '#cfaa75', '#ab794e', '#825137', '#4e342a'];
  let active = 0,
    selected = last;
  const cardXs = [-197, 0, 197],
    cols = 12,
    pitch = 46,
    rowPitch = 26;
  const gridX = (-(cols - 1) * pitch) / 2,
    gridY = 12;
  const labelY = 99;
  cardXs.forEach((x) => block(board, x, 166, 40, 176, 105, 12, walnut, 6));
  for (const x of cardXs) block(board, x, 166, 47, 164, 94, 6, ebony, 3);
  const bases = cardXs.map((x) => block(board, x, 116, 51, 125, 3, 2, brass, 1));

  function printPage() {
    ctx.setTransform(2, 0, 0, -2, 720, 720);
    ctx.clearRect(-360, -360, 720, 720);
    function text(str, x, y, size, font, align = 'center', color = ink) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, -1);
      ctx.fillStyle = color;
      ctx.font = size + 'px ' + font;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(str, 0, 0);
      ctx.restore();
    }
    function line(x, y, w) {
      ctx.fillStyle = gild;
      ctx.fillRect(x, y, w, 0.95);
    }
    text('Activity Almanac', -289, 265, 54, '"EB Garamond",Georgia', 'left');
    text(String(end.getUTCFullYear()), 282, 265, 27, 'Cinzel,Georgia', 'right');
    line(-290, 232, 580);
    sources.forEach((name, i) => text(name, cardXs[i], labelY, 20, 'Cinzel,Georgia'));
    line(-290, 77, 580);
    for (let col = 0; col < cols; col++) {
      const date = days[col * 7].date;
      if (col === 0 || date.getUTCMonth() !== days[(col - 1) * 7].date.getUTCMonth()) {
        text(
          date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
          gridX + col * pitch - 19,
          44,
          16,
          'Cinzel,Georgia',
          'left',
        );
      }
    }
    for (const [r, day] of [
      [0, 'Sun'],
      [2, 'Tue'],
      [4, 'Thu'],
      [6, 'Sat'],
    ])
      text(day, gridX - 34, gridY - r * rowPitch, 16, '"EB Garamond",Georgia', 'right');
    line(-290, -173, 580);
    text(sources[active], -282, -217, 33, '"EB Garamond",Georgia', 'left');
    text(reading(selected, active), 279, -217, 23, '"EB Garamond",Georgia', 'right');
    if (days.some((d) => d.values[active] === null))
      text('Gray · no record', -282, -278, 14, '"EB Garamond",Georgia', 'left');
    text('Less', -124, -278, 16, '"EB Garamond",Georgia', 'right');
    text('More', 66, -278, 16, '"EB Garamond",Georgia', 'left');
    text(caption, 281, -278, 16, '"EB Garamond",Georgia', 'right');
    print.needsUpdate = true;
    bases.forEach((base, i) => (base.visible = i === active));
  }
  // One instanced batch for the daily end-grain blocks. Future days are left open.
  const tile = new RoundedBoxGeometry(40, 21, 9, 2, 2.3);
  const batch = new THREE.InstancedMesh(tile, wood('#ffffff'), last + 1);
  board.add(batch);
  const transform = new THREE.Object3D(),
    colour = new THREE.Color();
  for (let i = 0; i < 5; i++) block(board, -104 + i * 36, -278, 41, 29, 14, 5, wood(stains[i]), 2);
  const cursor = block(board, 0, 0, 38.6, 44, 25, 2, brass, 1);
  function update() {
    for (let i = 0; i <= last; i++) {
      const n = level(i, active);
      transform.position.set(
        gridX + Math.floor(i / 7) * pitch,
        gridY - (i % 7) * rowPitch,
        41 + Math.max(0, n) * 0.95,
      );
      transform.updateMatrix();
      batch.setMatrixAt(i, transform.matrix);
      batch.setColorAt(i, colour.set(n < 0 ? '#9b9790' : stains[n]));
      if (i === selected) {
        cursor.position.x = transform.position.x;
        cursor.position.y = transform.position.y;
      }
    }
    batch.instanceMatrix.needsUpdate = true;
    batch.instanceColor.needsUpdate = true;
    printPage();
  }
  function choose(source) {
    active = source;
    update();
  }
  function chooseDay(i) {
    selected = i;
    update();
  }

  const figures = cardXs.map((x, i) => {
    const group = new THREE.Group();
    group.position.set(x, 168, 53);
    board.add(group);
    group.userData.source = i;
    return group;
  });
  // Extruded GitHub Octicon in pale marquetry.
  for (const path of mark.paths)
    for (const shape of SVGLoader.createShapes(path)) {
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: 1,
        bevelEnabled: true,
        bevelSize: 0.14,
        bevelThickness: 0.2,
        bevelSegments: 2,
      });
      const logo = add(figures[0], geom, ash, -37, 37, 2);
      logo.scale.set(3.1, -3.1, 3.1);
    }

  // Trace of the user's Dot icon, in local millimetres, from its alpha silhouette.
  const dot = figures[1];
  const rim = [
    [36, 0],
    [32, 12],
    [32, 18],
    [24, 29],
    [12, 33],
    [6, 33],
    [-6, 37],
    [-13, 35],
    [-22, 26],
    [-26, 22],
    [-32, 18],
    [-38, 7],
    [-38, 0],
    [-32, -12],
    [-32, -18],
    [-30, -25],
    [-24, -29],
    [-19, -33],
    [-12, -33],
    [-6, -34],
    [0, -37],
    [13, -37],
    [22, -26],
    [26, -22],
    [32, -18],
    [36, -13],
    [38, -7],
  ];
  const contour = new THREE.SplineCurve([...rim, rim[0]].map(([x, y]) => new THREE.Vector2(x, y)));
  const shape = new THREE.Shape(contour.getPoints(120));
  const carving = new THREE.ExtrudeGeometry(shape, {
    depth: 9,
    bevelEnabled: true,
    bevelSize: 2,
    bevelThickness: 2.5,
    bevelSegments: 4,
  });
  add(dot, carving, honey, 0, 0, 7);
  const dotEyes = [-9, 9].map((x) => oval(dot, x, -1, 18, 6.5, 18, 4, ebony));
  const crab = figures[2];
  block(crab, 0, 4, 12, 67, 44, 22, cherry, 3);
  const eyes = [-19, 19].map((x) => block(crab, x, 8, 24, 6, 12, 3, ebony, 1));
  const arms = [-1, 1].map((s) => block(crab, 37 * s, 0, 12, 12, 13, 16, cherry, 1));
  const feet = [-24, -13, 13, 24].map((x) => block(crab, x, -22, 12, 7, 16, 13, cherry, 1));
  function animate(t) {
    const rhythm = Math.sin(t * 2.15);
    dot.position.y = 167 + 2.2 * rhythm;
    dot.rotation.z = 0.065 * Math.sin(t * 1.6);
    dot.rotation.y = 0.11 * Math.sin(t * 1.19);
    dotEyes.forEach((e) => (e.scale.y = 9 * Math.min(1, 0.12 + Math.abs((t % 4.1) - 2.8) * 9)));
    crab.position.x = 197 + 5 * Math.sin(t * 1.12);
    crab.rotation.z = 0.035 * Math.sin(t * 4);
    feet.forEach((f, i) => (f.position.y = -21 + 2.9 * Math.sin(t * 4.1 + i * 2)));
    arms.forEach((a, i) => (a.rotation.z = 0.17 * Math.sin(t * 2.3 + i * 3)));
    eyes.forEach((e) => (e.scale.y = Math.min(1, 0.13 + Math.abs((t % 4.7) - 2) * 8)));
  }
  update();
  const pickPlane = add(
    board,
    new THREE.PlaneGeometry(730, 721),
    new THREE.MeshBasicMaterial({ visible: false }),
    0,
    0,
    68,
  );
  function hit(point) {
    const { x, y } = board.worldToLocal(point.clone());
    if (y > 83 && y < 226) {
      const source = cardXs.findIndex((cx) => Math.abs(x - cx) < 91);
      if (source >= 0)
        return { kind: 'source', key: 'activity-source-' + source, source, label: sources[source] };
    }
    const col = Math.round((x - gridX) / pitch),
      row = Math.round((gridY - y) / rowPitch);
    const i = 7 * col + row;
    if (col >= 0 && col < cols && row >= 0 && row < 7 && i <= last)
      return { kind: 'day', key: 'activity-day-' + i, day: i, label: reading(i, active, true) };
    return { kind: 'activity', key: 'activity' };
  }
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 256;
  const pen = shadowCanvas.getContext('2d');
  pen.fillStyle = '#211409';
  pen.shadowColor = 'rgba(30,15,5,.9)';
  pen.shadowBlur = 9;
  pen.shadowOffsetX = 2;
  pen.shadowOffsetY = 5;
  pen.fillRect(17, 15, 220, 219);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(860 * board.scale.x, 840 * board.scale.y),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowCanvas),
      transparent: true,
      opacity: 0.51,
      depthWrite: false,
    }),
  );
  shadow.position.set(wallX + 0.001, board.position.y - 0.006, board.position.z + 0.002);
  shadow.rotation.y = Math.PI / 2;
  scene.add(shadow);

  // The room uses baked lighting. Shade these new carvings locally to keep their
  // warm fill and raking highlights independent of other props' scene lights.
  const illumination = { value: 1 };
  const materials = new Set();
  board.traverse((o) => {
    if (o.material?.isMeshStandardMaterial) materials.add(o.material);
  });
  for (const mat of materials) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.illumination = illumination;
      shader.fragmentShader =
        'uniform float illumination;\n' +
        shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `
        #include <lights_fragment_end>
        vec3 keyDir = normalize(mat3(viewMatrix) * vec3(1.98,.98,-1.25));
        float grazing = max(0., dot(normal, keyDir));
        reflectedLight.indirectDiffuse = diffuseColor.rgb * (vec3(.36,.30,.25) + grazing*vec3(.67,.61,.52)) * illumination;
        reflectedLight.directDiffuse = vec3(0.);
        reflectedLight.directSpecular = vec3(0.);
        `,
        );
    };
  }
  scene.add(board);
  function tick(t, roomLight) {
    illumination.value = 0.12 + roomLight * 0.88;
    animate(t);
  }
  function keyPress(key) {
    if (['1', '2', '3'].includes(key)) {
      choose(Number(key) - 1);
      return true;
    }
    const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[key];
    if (!delta) return false;
    chooseDay(THREE.MathUtils.clamp(selected + delta, 0, last));
    return true;
  }
  const view = {
    target: [board.position.x + 40 * board.scale.x, board.position.y, board.position.z],
    dir: [0.997, 0.012, 0.076],
    size: [405 * board.scale.x, 405 * board.scale.y],
  };
  return { tick, hit, pickPlane, choose, chooseDay, keyPress, view };
}
