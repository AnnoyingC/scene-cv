import * as THREE from 'three';

// A single camera-facing veil, anchored at the centre of the baked coffee surface.
export function makeSteam(scene, liquid) {
  if (!liquid) return null;
  const bounds = new THREE.Box3().setFromObject(liquid);
  const center = bounds.getCenter(new THREE.Vector3());
  const diameter = bounds.max.x - bounds.min.x;
  const time = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: { time },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 coords;
      void main(){
        coords = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
      }`,
    fragmentShader: `
      varying vec2 coords;
      uniform float time;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
      }
      float gaussian(float q){ return exp(-q*q); }
      void main(){
        float y=coords.y, x=coords.x-.5;
        float h=y*6.-time*.55;
        float curl=(noise(vec2(h*.82,time*.11))-.48)*(.08+y*.45);
        float fold=sin(h*1.95+noise(vec2(h*.7,2.))*3.)*(.015+y*.10);
        float broad=.028+.085*y;
        float strand=gaussian((x-curl-fold)/broad);
        float wisp=gaussian((x-curl+fold*.9+.023)/(broad*.57));
        float rise=noise(vec2(x*8.,h*1.7))*.62+.38;
        float fade=smoothstep(0.,.10,y)*(1.-smoothstep(.47,1.,y));
        gl_FragColor=vec4(.91,.85,.73, (.33*strand+.21*wisp)*fade*rise);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const height = diameter * 2.68;
  const geom = new THREE.PlaneGeometry(diameter * 2.05, height);
  geom.translate(0, height / 2, 0);
  const veil = new THREE.Mesh(geom, material);
  veil.position.copy(center);
  veil.position.y += diameter * 0.03;
  scene.add(veil);
  const view = {
    target: [center.x, center.y + diameter, center.z],
    dir: [0.365, 0.28, 0.888],
    size: [diameter * 1.7, diameter * 1.9],
  };
  function tick(t, camera) {
    time.value = t;
    veil.rotation.y = Math.atan2(camera.position.x - veil.position.x, camera.position.z - veil.position.z);
  }
  return { tick, view };
}
