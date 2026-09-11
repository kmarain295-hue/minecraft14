/**
 * SNOW FOOTPRINTS for the RATFIRE winter biomes — the trail a player leaves
 * behind while walking across the snow countries.
 *
 * Every time a footstep lands (the SAME cadence as the footstep dust + run
 * audio: one step every 0.28s walking / 0.21s sprinting, alternating left/
 * right boot), a small dark FOOT-SHAPED print is stamped into the snow
 * exactly where that boot touches the terrain: mirrored left/right, rotated
 * to the walking direction, sitting a hair above the block top (the real
 * terrain surface comes from options.heightAt). The ground under each foot
 * is re-checked with the winter factor, so the trail naturally peters out
 * at the soft biome border — never a print on green grass.
 *
 * REMOVAL: each print holds full strength for the first ~third of its life,
 * then slowly melts away over FADE_SECONDS total. Just keep walking forward
 * and the snow quietly cleans itself up behind you.
 *
 * SHAPE (latest user request): the print is the user-provided CHROMAKEY
 * sole EMBLEM (public/textures/footprint-sole-chromakey-2.png — the
 * hexagonal circuit-board shield with an eye, blurred re-upload, background
 * keyed out to real transparency) used with its colours EXACTLY as
 * uploaded. EVERY earlier artwork (white emboss, dark night emblem and the
 * first chromakey) was removed — this single emblem now stamps day AND
 * night. Until the PNG arrives, a rounded-rect placeholder is used.
 *
 * SIZE: locked, independent of the artwork's own pixels — and shrunk by
 * another 5% for this request: the stamp quad is now 34.795 x 33.232
 * world units (was 36.626 x 34.981), with the left/right and behind-body
 * stride offsets scaled by the same 0.95 so the two-track trail keeps its
 * shape. Cadence, per-foot snow gating, the 40s melt-away and the pool
 * cap are untouched.
 *
 * OPACITY: the emblem renders 25% more transparent (uOpacity 0.75 in the
 * shader — kept from the previous iteration's user request).
 *
 * Rendering: ONE InstancedMesh (one draw call). Each instance carries a
 * birth time; a tiny custom shader does the fade by age entirely on the GPU
 * (zero per-frame CPU beyond stamping one matrix when a step lands), and the
 * standard fog chunks melt distant prints into the winter haze exactly like
 * the terrain itself.
 */

import * as THREE from 'three';
import { winterFactorWorld } from './winterBiomes';

/* ------------------------------ tuning ---------------------------------- */
const MAX_PRINTS = 240; // ring buffer size (mobile LOW tier: 120)
const FADE_SECONDS = 40; // a print's full lifetime — the "slowly removes" span
const HOLD_FRAC = 0.35; // fraction of the lifetime it stays fully dark first
const WALK_STEP = 0.28; // seconds per step — matches the footstep dust audio
const SPRINT_STEP = 0.21;
const FOOT_LEN = 33.232; // stamp long axis (toe -> heel): the 38.76 base,
// shrunk -5% THREE times now (36.822, 34.981, x0.95 again — user request)
const FOOT_WID = 34.795; // stamp width — previous 36.626 x 0.95 (user: -5%),
// still fixed by hand here: swapping artworks can never nudge the
// footprint's size
const SOLE_IMG = '/textures/footprint-sole-chromakey-2.png'; // sole emblem, day AND night
const SIDE_OFFSET = 12.003; // left/right foot spacing — shrunk 5% again with the print
const BACK_OFFSET = 6.859; // planted behind the body centre — shrunk 5% again too
const LIFT = 1.2; // clears the block top so the decal never z-fights
const SNOW_MIN = 0.5; // winter factor needed for snow under a foot
const CENTER_MIN = 0.3; // soft gate on the body's own factor (border strides)
const SOLE_OPACITY = 0.75; // both emblems at 75% strength (user: -25% visibility)

export interface FootprintOptions {
  /** World units per terrain block edge (100). */
  block: number;
  /** Grid origin offset (64) — matches winterFactorWorld's convention. */
  gridOffset: number;
  /** Terrain surface sampler — top of the block at a world x/z. */
  heightAt(x: number, z: number): number;
  /** Mobile LOW tier: smaller print pool. */
  lowSpec?: boolean;
}

export interface FootprintHandle {
  /**
   * Drive from the frame loop. A print is stamped every footstep while
   * `walking`, and only where the ground under that boot is truly snow.
   * The same emblem stamps day AND night — no artwork switching anymore.
   */
  update(
    dt: number,
    x: number,
    z: number,
    yaw: number,
    winterIntensity: number,
    walking: boolean,
    sprinting: boolean
  ): void;
  /** Debug handle: totals + how many prints are still visible. */
  stats(): {
    planted: number;
    live: number;
    capacity: number;
    /** World size of the stamp quad — locked, artwork-independent. */
    sole: { w: number; h: number };
    last: { x: number; z: number; y: number; age: number } | null;
  };
  /** Wipe every print instantly (respawn / debug). */
  clear(): void;
  dispose(): void;
}

/* --------------------------- boot-sole texture --------------------------- */
type Ctx = CanvasRenderingContext2D;

/** FALLBACK sole: a rounded-corner rectangle placeholder used until the
 *  player model finishes loading and its REAL boot soles replace it (see
 *  setSoleTextures). Drawn twice (soft halo + darker core) so it still
 *  reads as snow pressed down by a sole rather than a flat sticker. */
function solePath(ctx: Ctx, W: number, H: number, s: number): void {
  const hw = W * 0.32 * s; // half width of the sole rectangle
  const hh = H * 0.45 * s; // half height
  const x0 = W / 2 - hw;
  const x1 = W / 2 + hw;
  const y0 = H / 2 - hh;
  const y1 = H / 2 + hh;
  const r = W * 0.12 * s; // soft rounded corners

  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x1, y0, x1, y1, r);
  ctx.arcTo(x1, y1, x0, y1, r);
  ctx.arcTo(x0, y1, x0, y0, r);
  ctx.arcTo(x0, y0, x1, y0, r);
  ctx.closePath();
}

function makeFootprintTexture(): THREE.CanvasTexture {
  // 64x128 canvas matches the 20x38-unit print's 1:2 aspect — small mark,
  // so a small texture is plenty crisp
  const W = 64;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);

  // outer soft halo — snow squished out around the boot
  ctx.filter = 'blur(1.6px)';
  ctx.fillStyle = 'rgba(30, 38, 52, 0.55)';
  ctx.beginPath();
  solePath(ctx, W, H, 1.0);
  ctx.fill();

  // inner pressed core — the dark "black" mark itself
  ctx.filter = 'blur(0.7px)';
  ctx.fillStyle = 'rgba(14, 18, 26, 0.92)';
  ctx.beginPath();
  solePath(ctx, W, H, 0.8);
  ctx.fill();
  ctx.filter = 'none';

  // faint boot-tread notches down the middle of the sole
  ctx.fillStyle = 'rgba(240, 246, 252, 0.25)';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(W * 0.4 + i * 7, H * 0.26, 2.5, 26);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ------------------------------ system ----------------------------------- */

export function createFootprintSystem(
  scene: THREE.Scene,
  options: FootprintOptions
): FootprintHandle {
  const maxPrints = options.lowSpec ? 120 : MAX_PRINTS;
  const block = options.block;
  const gridOffset = options.gridOffset;

  const texture = makeFootprintTexture();
  let quadGeometry = new THREE.PlaneGeometry(FOOT_WID, FOOT_LEN); // toe +Y

  const births = new Float32Array(maxPrints).fill(-1e6);
  const birthAttr = new THREE.InstancedBufferAttribute(births, 1);
  quadGeometry.setAttribute('aBirth', birthAttr);
  // +1 samples uMapR, -1 uMapL — both uniforms carry the same emblem
  // today, but the per-foot hook stays for future left/right artwork
  const sides = new Float32Array(maxPrints).fill(1);
  const sideAttr = new THREE.InstancedBufferAttribute(sides, 1);
  quadGeometry.setAttribute('aSide', sideAttr);

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uMapL: { value: null as THREE.Texture | null },
        uMapR: { value: null as THREE.Texture | null },
        uTime: { value: 0 },
        uFade: { value: FADE_SECONDS },
        uOpacity: { value: SOLE_OPACITY },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute float aSide;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAge;
      varying float vSide;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vSide = aSide;
        vAge = uTime - aBirth;
        vec4 mvPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMapL;
      uniform sampler2D uMapR;
      uniform float uFade;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vAge;
      varying float vSide;
      #include <fog_pars_fragment>
      void main() {
        // quick press-in, slow melt-out: fully dark for the first HOLD_FRAC
        // of the lifetime, then a long fade to nothing by uFade seconds
        float fadeIn = smoothstep(0.0, 0.3, vAge);
        float fadeOut = 1.0 - smoothstep(uFade * ${HOLD_FRAC.toFixed(1)}, uFade, vAge);
        vec4 tex = vSide > 0.0 ? texture2D(uMapR, vUv) : texture2D(uMapL, vUv);
        float alpha = tex.a * uOpacity * fadeIn * fadeOut;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(tex.rgb, alpha);
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // mirrored (negative-scale) feet flip winding
    fog: true,
  });
  // UniformsUtils.merge deep-clones, so the textures go in AFTER the merge
  material.uniforms.uMapL.value = texture;
  material.uniforms.uMapR.value = texture;

  const mesh = new THREE.InstancedMesh(quadGeometry, material, maxPrints);
  mesh.frustumCulled = false; // the trail spans many chunks
  mesh.renderOrder = 3; // after the terrain, with the other decals
  mesh.matrixAutoUpdate = false; // world-space instances, identity root
  mesh.raycast = () => {}; // bullets/pickers must never hit a footprint
  scene.add(mesh);

  // start every instance collapsed — invisible until a step stamps it
  const dummy = new THREE.Object3D();
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let i = 0; i < maxPrints; i++) mesh.setMatrixAt(i, dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;

  let time = 0;
  let cursor = 0;
  let planted = 0;
  let stepTimer = 0;
  let footSide = 1; // +1 right boot, -1 left boot
  const soleSize = { w: FOOT_WID, h: FOOT_LEN }; // quad size — locked
  let last: { x: number; z: number; y: number; birth: number } | null = null;

  /** Stamp one boot print at the given body position + facing. */
  function plant(x: number, z: number, yaw: number, side: number): void {
    const jitter = () => (Math.random() - 0.5) * 3;
    const fx =
      x -
      Math.sin(yaw) * BACK_OFFSET +
      Math.cos(yaw) * side * SIDE_OFFSET +
      jitter();
    const fz =
      z -
      Math.cos(yaw) * BACK_OFFSET -
      Math.sin(yaw) * side * SIDE_OFFSET +
      jitter();
    // the print follows the FOOT, not the body: on the soft biome border a
    // boot on grass simply leaves no mark
    if (winterFactorWorld(fx, fz, block, gridOffset) < SNOW_MIN) return;

    const y = options.heightAt(fx, fz) + LIFT;
    dummy.position.set(fx, y, fz);
    // lie flat, toe pointing along the walking direction; mirrored X per foot
    dummy.rotation.set(-Math.PI / 2, yaw + Math.PI, 0, 'YXZ');
    const s = 0.92 + Math.random() * 0.16; // every step presses differently
    // NO per-foot mirroring: left/right use their own traced sole textures
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();

    mesh.setMatrixAt(cursor, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    births[cursor] = time;
    sides[cursor] = side;
    birthAttr.needsUpdate = true;
    sideAttr.needsUpdate = true;

    cursor = (cursor + 1) % maxPrints;
    planted++;
    last = { x: fx, z: fz, y, birth: time };
  }

  function update(
    dt: number,
    x: number,
    z: number,
    yaw: number,
    winterIntensity: number,
    walking: boolean,
    sprinting: boolean
  ): void {
    time += dt;
    material.uniforms.uTime.value = time;

    if (!walking || winterIntensity < CENTER_MIN) {
      stepTimer = 0;
      return;
    }
    stepTimer += dt;
    const interval = sprinting ? SPRINT_STEP : WALK_STEP;
    if (stepTimer >= interval) {
      stepTimer = 0;
      plant(x, z, yaw, footSide);
      footSide = -footSide; // alternate boots even across the border
    }
  }

  function clear(): void {
    births.fill(-1e6);
    birthAttr.needsUpdate = true;
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (let i = 0; i < maxPrints; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    cursor = 0;
    planted = 0;
    last = null;
    stepTimer = 0;
  }

  /** Debug: jump the print clock forward — every birth age grows by the
   *  same amount, so on-screen prints visibly melt on the next frame. */
  function debugFastForward(seconds: number): void {
    time += seconds;
    material.uniforms.uTime.value = time;
  }

  // ONE sole emblem, the user-provided CHROMAKEY artwork (background
  // keyed out to real transparency), stamping day AND night with its
  // colours EXACTLY as uploaded — both previous artworks were removed by
  // request. The stamp quad is NOT fitted to the artwork's aspect anymore:
  // its size is locked at FOOT_WID x FOOT_LEN (see the constants), so a
  // future artwork swap can never change the footprint's size.
  let placeholderLive = true;
  let loadedSole: THREE.Texture | null = null;

  new THREE.TextureLoader().load(SOLE_IMG, (loaded) => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    material.uniforms.uMapL.value = loaded;
    material.uniforms.uMapR.value = loaded;
    loadedSole = loaded;
    if (placeholderLive) {
      placeholderLive = false;
      texture.dispose(); // the canvas placeholder is superseded
    }
  });

  function stats(): {
    planted: number;
    live: number;
    capacity: number;
    sole: { w: number; h: number } | null;
    last: { x: number; z: number; y: number; age: number } | null;
  } {
    let live = 0;
    for (let i = 0; i < maxPrints; i++) {
      if (time - births[i] < FADE_SECONDS) live++;
    }
    return {
      planted,
      live,
      capacity: maxPrints,
      sole: { w: soleSize.w, h: soleSize.h },
      last: last ? { x: last.x, z: last.z, y: last.y, age: time - last.birth } : null,
    };
  }

  function dispose(): void {
    scene.remove(mesh);
    quadGeometry.dispose();
    material.dispose();
    if (placeholderLive) texture.dispose();
    loadedSole?.dispose();
  }

  return { update, clear, stats, debugFastForward, dispose };
}
