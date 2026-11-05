import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#gl'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#161d25');
scene.fog = new THREE.Fog('#161d25', 3, 9);
const environment = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
const environmentRT = pmrem.fromScene(environment, .04);
scene.environment = environmentRT.texture;
scene.environmentIntensity = .65;
environment.dispose(); pmrem.dispose();
const camera = new THREE.PerspectiveCamera(37, 1, .01, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.minDistance = .18; controls.maxDistance = 4;
controls.maxPolarAngle = Math.PI * .49;
const views = {
  all: { p: [.92, .79, 1.55], t: [-.085, .225, .025] },
  keyboard: { p: [.27, .48, .68], t: [.015, .018, .24] },
  rear: { p: [-.88, .70, -1.23], t: [-.12, .23, -.04] },
};
let currentView = 'all';
function showView(name) {
  currentView = name;
  const { p, t } = views[name];
  camera.position.fromArray(p);
  controls.target.fromArray(t);
  camera.position.sub(controls.target).multiplyScalar(Math.max(1, 1.05 / camera.aspect)).add(controls.target);
  controls.update();
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === name));
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
const key = new THREE.DirectionalLight('#ffdebb', 3.2);
key.position.set(-.8, 1.6, 1.2); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: .1, far: 5 });
key.shadow.normalBias = .0015; key.shadow.bias = -.00015;
scene.add(key);
const fill = new THREE.DirectionalLight('#92bdff', 1.4); fill.position.set(.7, 1.1, -.8); scene.add(fill);
const desk = new THREE.Mesh(new THREE.BoxGeometry(2.2, .045, 1.35), new THREE.MeshStandardMaterial({ color: '#58402e', roughness: .55 }));
desk.position.y = -.027; desk.receiveShadow = true; scene.add(desk);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#161d25',roughness:.9}));
floor.rotation.x = -Math.PI/2; floor.position.y = -.052; floor.receiveShadow = true; scene.add(floor);
// A separate mat belongs to this preview, not the exported equipment.
const shape = new THREE.Shape(); const w=.66, h=.26, r=.022;
shape.moveTo(-w/2+r,-h/2);shape.lineTo(w/2-r,-h/2);shape.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);
shape.lineTo(w/2,h/2-r);shape.quadraticCurveTo(w/2,h/2,w/2-r,h/2);
shape.lineTo(-w/2+r,h/2);shape.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);
shape.lineTo(-w/2,-h/2+r);shape.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);
const pad = new THREE.Mesh(new THREE.ShapeGeometry(shape),new THREE.MeshStandardMaterial({color:'#283238',roughness:.95}));
pad.rotation.x=-Math.PI/2;pad.position.set(-.015,-.003,.225);pad.receiveShadow=true;scene.add(pad);
let displayScreen, originalMaterial, terminalMaterial, terminal = false;
const screenButton = document.querySelector('#screen'); screenButton.disabled = true;
screenButton.addEventListener('click', () => {
  terminal = !terminal;
  displayScreen.material = terminal ? terminalMaterial : originalMaterial;
  screenButton.textContent = terminal ? '返回桌面' : '点亮终端';
  screenButton.setAttribute('aria-pressed', terminal);
});
try {
  const gltf = await new GLTFLoader().loadAsync('../assets/studio-set/studio-set.glb');
  gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow=true; o.receiveShadow=true; } });
  scene.add(gltf.scene);
  renderer.shadowMap.needsUpdate = true;
  displayScreen = gltf.scene.getObjectByName('Screen');
  if (!displayScreen) throw new Error('Missing screen mesh');
  originalMaterial = displayScreen.material;
  const c = document.createElement('canvas'); c.width=1600;c.height=900;
  const ctx=c.getContext('2d');ctx.fillStyle='#0c1822';ctx.fillRect(0,0,1600,900);
  ctx.fillStyle='#a9c9d1';ctx.font='25px monospace';ctx.fillText('CITY STUDIO / PERSONAL TERMINAL',90,95);
  ctx.fillStyle='#e6ece7';ctx.font='52px monospace';
  ['hello, world.', '', '> a quiet place to build', '> ideas / experiments / stories', '', 'Ready when you are. _'].forEach((s,i)=>ctx.fillText(s,90,240+i*87));
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;
  terminalMaterial=new THREE.MeshBasicMaterial({map:texture});
  screenButton.disabled=false;
  document.querySelector('#status').hidden=true;
  window.__studio = { model: gltf.scene, screen: displayScreen, renderer, scene, camera };
} catch (error) {
  console.error(error);
  document.querySelector('#status').textContent='模型未能加载，请刷新重试。';
}
function resize() { renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();showView(currentView); }
addEventListener('resize',resize);resize();showView(currentView);
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
