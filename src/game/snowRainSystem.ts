/**
 * SNOWFALL for the RATFIRE winter biomes — the snow country's own weather,
 * deliberately nothing like a rain shower.
 *
 * Sprites are the classic SNOWFLAKE CRYSTALS from the three.js
 * "webgl_points_sprites" example (sketches after René Descartes' 1635 snow
 * crystal, MIT-licensed example assets, mirrored in /public/textures/
 * sprites): five 32px flake sprites packed into one atlas. These five
 * DOWNLOADED crystals are the ONLY flake shapes in the whole system —
 * every particle in both layers uses one of them, nothing home-made is
 * mixed in. The look follows the viral Manali first-snowfall reel: calm
 * air, big slow flakes, and — the photographic tell — FAKE DEPTH-OF-FIELD
 * bokeh: flakes drifting past the lens loom huge and turn translucent
 * (same downloaded sprite, just out of focus). Every crystal TUMBLES on
 * its own axis (wobbling per-flake rotation in the fragment shader) and
 * the fall itself DANCES: four superimposed motions — breathing wind
 * gusts that sweep and veer the whole shower in waves, a per-flake
 * corkscrew helix, multi-frequency pendulum sway and a vertical flutter
 * bob — drift down ~10x slower than rain. The audio hush swells on the
 * same gust curve, so the ear matches the eye.
 *
 * Structure mirrors iceRainSystem.ts:
 *  - MAIN FIELD: point sprites seeded uniformly across the whole map, each
 *    flake's fall / sway / spin / twinkle animated inside the vertex shader
 *    (zero per-frame CPU cost). The seed box re-centres on the player so
 *    density is constant wherever the snow countries lie.
 *  - NEAR-FIELD BUMP: a second, smaller GPU box that wraps around the
 *    player so the crystals right around the camera read big and bold.
 *  - The snow COLUMN: flakes are born at the MID of the cloud band (2900
 *    — halfway between the 2000 cumulus deck and the 3800 cirrus veil) so
 *    they visibly EMERGE FROM THE CLOUDS, and they MELT AWAY exactly when
 *    they reach the terrain: a world-anchored ground heightmap (sampled
 *    from the real surface) clips every flake at the local ground height.
 *  - Terrain occludes via the depth buffer; FogExp2 fades far flakes.
 *  - intensity (0..1, = the player's winter factor) drives both layers'
 *    opacity plus a soft low wind-hiss audio bed (WebAudio, no assets) —
 *    far quieter and deeper than the rain roar or the bright sleet hiss.
 */

import * as THREE from 'three';
import { onMuteChange } from './muteState';

/* ---------------- tuning: main field (whole terrain, GPU) ---------------- */
const FAR_FLAKES = 300000; // 10x-reduced from the 3M deluge; still 2x the
                           // original 150k field
const WORLD_HALF = 6400;
// The snow COLUMN: born at the MID of the cloud band (halfway between the
// 2000 cumulus deck and the 3800 cirrus veil), falling all the way down to
// the terrain — where the shader melts them at the local ground height.
const CLOUD_MID = 2900;
const GROUND_NOMINAL = -400; // span floor below nearly all terrain; flakes
                             // under their LOCAL ground are hidden by the
                             // heightmap clip, so this only sets the cycle
const FAR_SPEED_MIN = 21; // calm Himalayan snow: everything drifts, nothing
const FAR_SPEED_MAX = 38; // shoots — crystals float down slowly
const FAR_SIZE_MIN = 0.9; // reference-px scale fed to the size shader
const FAR_SIZE_MAX = 1.8;
const FAR_OPACITY = 0.85;
const NEAR_BOOST = 1.1;
const NEAR_RANGE = 520; // boost inside this, fade out to ~3x this

/* ---------------- tuning: near-field bump (player-following GPU box) ----- */
const NEAR_FLAKES = 20000; // the column grew from ~630 to ~3300 tall (cloud
                           // mid -> ground), so ~5x the old swarm keeps the
                           // same big-crystal density around the camera
const NEAR_RADIUS = 340;
const NEAR_SIZE_MIN = 3.4;
const NEAR_SIZE_MAX = 6.2;
const NEAR_OPACITY = 0.9;
const NEAR_MAX_PX = 110; // bokeh flakes looming past the lens may loom LARGE

const WIND = new THREE.Vector3(-16, 0, -7); // lazy mean drift, gusts breathe on top
const SNOW_COLOR = 0xc7d8e8; // blue-grey flake tint — pale enough to read
// as snow, dark enough to stay visible on white snow tops AND the pale
// winter sky (the example works on a black void; our scene is bright)
const AUDIO_MAX_GAIN = 0.12; // snow hushes the world; it never roars

/* ------------- terrain ground heightmap (flakes LAND on the ground) ----- */
// 128x128 R8 texture covering ±GROUND_COVER around an anchor that follows
// the player, filled from the REAL terrain surface (options.heightAt) so
// the shader can melt every flake exactly at the local ground height.
// Height encoded as (h + 2048) / 4096 in the red channel (~16-unit
// precision — far finer than the 48-unit melt band). All-zero data decodes
// to -2048, so with no heightAt given nothing is ever clipped (graceful).
const GROUND_TEX_SIZE = 128;
const GROUND_COVER = 1600; // coverage half-extent — reaches past the flake
                           // fade start (900), so clamped edge samples are
                           // always on already-faded flakes
const GROUND_REFRESH = 700; // rebuild once the player walked this far from
                            // the anchor (worst-case edge still >= 900 out)

function makeGroundMap(): {
  texture: THREE.DataTexture;
  rebuild(cx: number, cz: number, heightAt?: (x: number, z: number) => number): void;
} {
  const data = new Uint8Array(GROUND_TEX_SIZE * GROUND_TEX_SIZE);
  const texture = new THREE.DataTexture(
    data,
    GROUND_TEX_SIZE,
    GROUND_TEX_SIZE,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  function rebuild(
    cx: number,
    cz: number,
    heightAt?: (x: number, z: number) => number
  ): void {
    const step = (GROUND_COVER * 2) / (GROUND_TEX_SIZE - 1);
    let i = 0;
    for (let ty = 0; ty < GROUND_TEX_SIZE; ty++) {
      const z = cz - GROUND_COVER + ty * step;
      for (let tx = 0; tx < GROUND_TEX_SIZE; tx++) {
        const x = cx - GROUND_COVER + tx * step;
        const h = heightAt ? heightAt(x, z) : -2048;
        const b = Math.round(((h + 2048) / 4096) * 255);
        data[i++] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
    texture.needsUpdate = true;
  }

  return { texture, rebuild };
}

/* --------- flake atlas: ONLY the 5 downloaded three.js crystals -------- */
// atlas grid 4x2 (cells 0-4 = snowflake1..5.png, cells 5-7 stay blank),
// drawn at 64px (crystals upscaled from 32px source with smoothing so they
// stay crisp when magnified on near flakes). No extra home-made sprites.
const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const CELL_PX = 64;
const CRYSTAL_FRAMES = 5; // snowflake1..5.png — the only shapes that fall

/** Builds the flake atlas: every cell stays blank until its downloaded
 *  Descartes sprite arrives, so only the authentic example snowflakes ever
 *  render. Returns { texture, loadCrystals }. */
function makeFlakeAtlas(): {
  texture: THREE.CanvasTexture;
  loadCrystals(): Promise<void>;
} {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL_PX;
  canvas.height = ATLAS_ROWS * CELL_PX;
  const ctx = canvas.getContext('2d')!;
  // frame layout: cells 0-4 = snowflake1..5 (blank until each PNG lands)
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  async function loadCrystals(): Promise<void> {
    const imgs = await Promise.all(
      [1, 2, 3, 4, 5].map(
        (i) =>
          new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null); // graceful: cell stays blank
            img.src = `/textures/sprites/snowflake${i}.png`;
          })
      )
    );
    imgs.forEach((img, i) => {
      if (!img) return;
      const col = i % ATLAS_COLS;
      const row = Math.floor(i / ATLAS_COLS);
      ctx.clearRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
      ctx.drawImage(img, col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
    });
    if (imgs.some(Boolean)) texture.needsUpdate = true;
  }

  return { texture, loadCrystals };
}

/* GPU snowfall: point sprites, one shader drives both field layers. */
const SNOW_VERTEX = /* glsl */ `
  attribute vec4 aData; // x: speed, y: size, z: phase 0..1, w: brightness
  attribute vec2 aMeta; // x: atlas frame, y: spin speed (rad/s, signed)
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uTop;
  uniform float uBottom;
  uniform float uWrap;
  uniform float uSway;
  uniform float uSpiral;
  uniform float uBob;
  uniform float uGust;
  uniform float uPixelScale;
  uniform float uNearGain;
  uniform float uNearRange;
  uniform float uFadeStart; // camera-distance fade window (per layer)
  uniform float uFadeEnd;
  uniform sampler2D uGround; // terrain heights, (h + 2048) / 4096 in .r
  uniform vec2 uGroundCenter;
  uniform float uGroundHalf;
  uniform float uMaxSize;
  uniform vec2 uCenter;
  varying float vFade;
  varying float vFrame;
  varying float vAngle;
  #include <fog_pars_vertex>
  void main() {
    // seed box wraps around the focus so density never thins while moving
    vec2 seed = uCenter +
      (mod(position.xz - uCenter + vec2(uWrap), vec2(uWrap * 2.0)) - vec2(uWrap));
    float speed = aData.x;
    float phase = aData.z;
    // deterministic per-flake jitter streams (repeatable, allocation-free)
    float j1 = fract(phase * 7.31);
    float j2 = fract(phase * 3.77);
    float j3 = fract(phase * 5.31);
    float j4 = fract(phase * 9.71);
    float span = uTop - uBottom;
    float fallen = mod(position.y * span + uTime * speed, span);
    float t = fallen / speed;

    // THE DANCE — four superimposed motions:
    // 1) GUSTS: the wind itself breathes — slow global swells (0.2..1.0)
    //    sweep the whole field while the breeze slowly veers, so showers
    //    lean and ease in waves exactly like real weather
    float gust = 0.6 + 0.4 *
      (sin(uTime * 0.21) * 0.5 + sin(uTime * 0.083 + 1.7) * 0.5);
    vec2 veer = vec2(sin(uTime * 0.047), cos(uTime * 0.035));
    vec2 wind = vec2(uWind.x, uWind.z) * gust + veer * (uGust * gust);

    // 2) SPIRAL: each flake corkscrews down its own helix — the classic
    //    turbulent-air tumble you see when snow falls past a window
    float spiralAng = uTime * (0.55 + j1 * 1.25) * 1.35 + phase * 43.0;
    vec2 spiral = vec2(cos(spiralAng), sin(spiralAng)) * uSpiral * (0.4 + j2 * 0.8);

    // 3) SWAY + 4) BOB: multi-frequency pendulum drift with a gentle
    //    vertical flutter (flakes stall and catch in the eddies)
    vec2 sway = vec2(
      sin(uTime * 0.9 + phase * 41.0) + 0.55 * sin(uTime * 2.3 + phase * 17.0),
      cos(uTime * 0.7 + phase * 29.0) + 0.55 * cos(uTime * 1.9 + phase * 23.0)
    ) * uSway;
    float bob = sin(uTime * (0.85 + j3 * 0.7) + phase * 31.0) * uBob;

    vec3 p = vec3(
      seed.x + wind.x * t + spiral.x + sway.x,
      uTop - fallen + bob,
      seed.y + wind.y * t + spiral.y + sway.y
    );
    // Wrap the FINAL position around the focus (not just the seed):
    // wind drift accumulates over the whole fall (minutes of wind x slow
    // flakes), which would otherwise shred the cloud downwind and starve
    // the lens of close flakes. Wrapping the result makes flakes FLOW
    // through the volume like real snow — steady density everywhere.
    p.xz = uCenter +
      (mod(p.xz - uCenter + vec2(uWrap), vec2(uWrap * 2.0)) - vec2(uWrap));
    // LAND ON THE TERRAIN: sample the REAL ground height under the flake
    // (world-anchored heightmap of the actual surface) and melt away
    // across the last ~50 units — fully gone once under the surface
    vec2 guv = (p.xz - uGroundCenter) / (2.0 * uGroundHalf) + 0.5;
    float groundY = texture2D(uGround, clamp(guv, vec2(0.001), vec2(0.999)))
                      .r * 4096.0 - 2048.0;
    float groundFade = smoothstep(groundY - 48.0, groundY + 8.0, p.y);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float dist = max(1.0, length(mvPosition.xyz));
    // FAKE DEPTH-OF-FIELD (the camera look from the Manali reel): flakes
    // brushing past the lens are way outside the focal plane — they LOOM
    // large, go translucent and lose their outline
    float dof = smoothstep(150.0, 30.0, dist);
    // tumbling flakes catch the light edge-on — size pulses as they roll
    float pulse = 0.86 + 0.14 * sin(uTime * (0.55 + j4 * 0.5) + phase * 13.0);
    gl_PointSize = clamp(
      aData.y * uPixelScale * pulse * (1.0 + dof * 2.1) / dist,
      1.0,
      uMaxSize
    );
    vFade = aData.w;
    vFade *= 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
    vFade *= groundFade; // flakes never sink into the hills — they land
    vFade *= 1.0 + uNearGain * max(0.0, 1.0 - dist / (uNearRange * 0.45));
    vFade *= 1.0 - dof * 0.45; // bokeh = soft + see-through
    // gentle twinkle
    vFade *= 0.78 + 0.22 * sin(uTime * 2.1 + phase * 51.0);
    // every flake keeps its own downloaded crystal sprite, even out of
    // focus — bokeh only scales + fades it
    vFrame = aMeta.x;
    // TUMBLE: spin speed itself wobbles — crystals speed up, stall and
    // catch again instead of rotating like clockwork
    vAngle = uTime * aMeta.y + phase * 6.2831
           + sin(uTime * (0.35 + j1 * 0.5) + phase * 11.0) * 1.9;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SNOW_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCols;
  uniform float uRows;
  varying float vFade;
  varying float vFrame;
  varying float vAngle;
  #include <fog_pars_fragment>
  void main() {
    // rotate the sprite about its centre (screen space) — spinning crystals
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vAngle);
    float s = sin(vAngle);
    uv = mat2(c, s, -s, c) * uv;
    if (abs(uv.x) > 0.5 || abs(uv.y) > 0.5) discard; // spun-out corners
    // atlas cell lookup (flipY atlas: canvas top row = last v row)
    float col = mod(vFrame, uCols);
    float row = uRows - 1.0 - floor(vFrame / uCols);
    vec2 cellUv = (vec2(col, row) + uv + 0.5) / vec2(uCols, uRows);
    vec4 tex = texture2D(uMap, cellUv);
    // the sprites are OPAQUE white-on-black: the flake silhouette lives in
    // the LUMINANCE (the three.js example adds them additively against a
    // black void — additive would vanish on our bright snow). Use the red
    // channel as the coverage mask and tint it.
    gl_FragColor = vec4(uColor, uOpacity * vFade * tex.r);
    #include <fog_fragment>
  }
`;

export interface SnowRainHandle {
  /** Both snowfall layers — add it to the scene. */
  readonly object: THREE.Points;
  /** Advance the snowfall. intensity 0 = hidden + silent (outside winter). */
  update(dt: number, focus: THREE.Vector3, intensity: number): void;
  readonly counts: { near: number; far: number };
  audioMuted(): boolean;
  audioGain(): number | null;
  dispose(): void;
}

export interface SnowRainOptions {
  /** Far-field flake budget (default FAR_FLAKES); mobile LOW tier thins. */
  farFlakes?: number;
  /** Real terrain surface height sampler (world x/z -> Y). When given,
   *  flakes melt away exactly when they reach the ground. */
  heightAt?: (x: number, z: number) => number;
}

/** Creates the winter-biome snowfall. Starts hidden (intensity 0). */
export function createSnowRain(
  scene: THREE.Scene,
  options: SnowRainOptions = {}
): SnowRainHandle {
  const farFlakes = Math.max(
    4000,
    Math.min(FAR_FLAKES, Math.round(options.farFlakes ?? FAR_FLAKES))
  );
  const { texture: flakeMap, loadCrystals } = makeFlakeAtlas();
  void loadCrystals(); // the downloaded crystals appear as their PNGs land
  const groundMap = makeGroundMap();
  const heightAt = options.heightAt;
  let groundAnchor: { x: number; z: number } | null = null;
  const pixelScale =
    (typeof window !== 'undefined' ? window.innerHeight : 900) *
    (typeof navigator !== 'undefined'
      ? Math.min(window.devicePixelRatio || 1, 2)
      : 1) *
    1.1;

  // ---------------- layer factory: far field + near bump ----------------
  function buildLayer(
    count: number,
    wrap: number,
    top: number,
    bottom: number,
    sizeMin: number,
    sizeMax: number,
    sway: number,
    speedMin: number,
    speedMax: number,
    spiral: number, // radius of each flake's corkscrew (world units)
    bob: number, // vertical flutter amplitude (world units)
    gust: number, // strength of the veering gust breeze (world units)
    maxSize: number, // gl_PointSize clamp (near bokeh flakes may loom large)
    fadeStart: number, // camera-distance fade window (per layer)
    fadeEnd: number
  ): { points: THREE.Points; material: THREE.ShaderMaterial } {
    const positions = new Float32Array(count * 3);
    const data = new Float32Array(count * 4);
    const meta = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() * 2 - 1) * wrap;
      positions[i * 3 + 1] = Math.random(); // fall phase seed
      positions[i * 3 + 2] = (Math.random() * 2 - 1) * wrap;
      data[i * 4 + 0] = speedMin + Math.random() * (speedMax - speedMin);
      data[i * 4 + 1] = sizeMin + Math.random() * (sizeMax - sizeMin);
      data[i * 4 + 2] = Math.random(); // sway / twinkle phase
      data[i * 4 + 3] = 0.55 + Math.random() * 0.45; // soft depth variety
      // every single flake gets one of the five DOWNLOADED crystal sprites
      meta[i * 2 + 0] = Math.floor(Math.random() * CRYSTAL_FRAMES);
      meta[i * 2 + 1] =
        (0.25 + Math.random() * 0.85) * (Math.random() < 0.5 ? -1 : 1); // spin
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    geometry.setAttribute('aMeta', new THREE.BufferAttribute(meta, 2));
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uWind: { value: WIND.clone() },
          uTop: { value: top },
          uBottom: { value: bottom },
          uWrap: { value: wrap },
          uSway: { value: sway },
          uSpiral: { value: spiral },
          uBob: { value: bob },
          uGust: { value: gust },
          uPixelScale: { value: pixelScale },
          uCenter: { value: new THREE.Vector2(0, 0) },
          uMaxSize: { value: maxSize },
          uColor: { value: new THREE.Color(SNOW_COLOR) },
          uOpacity: { value: 0 },
          uNearGain: { value: NEAR_BOOST },
          uNearRange: { value: NEAR_RANGE },
          uFadeStart: { value: fadeStart },
          uFadeEnd: { value: fadeEnd },
          uGroundHalf: { value: GROUND_COVER },
          uGroundCenter: { value: new THREE.Vector2(0, 0) },
          uCols: { value: ATLAS_COLS },
          uRows: { value: ATLAS_ROWS },
        },
      ]),
      vertexShader: SNOW_VERTEX,
      fragmentShader: SNOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // NB: assign the sprite + ground map AFTER UniformsUtils.merge — merge
    // deep-clones uniform values and cloned textures never upload (blank)
    material.uniforms.uMap = { value: flakeMap };
    material.uniforms.uGround = { value: groundMap.texture };
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    points.renderOrder = 6; // after clouds so flakes draw on top
    scene.add(points);
    return { points, material };
  }

  const far = buildLayer(
    farFlakes,
    WORLD_HALF,
    CLOUD_MID, // born at the mid of the cloud band (2000 deck .. 3800 veil)
    GROUND_NOMINAL, // fall to the ground — the heightmap melts them there
    FAR_SIZE_MIN,
    FAR_SIZE_MAX,
    26,
    FAR_SPEED_MIN,
    FAR_SPEED_MAX,
    9, // corkscrew radius
    12, // flutter bob
    42, // calm gust breeze (Manali-quiet air)
    64, // far flakes stay small
    900, // fade window wide enough to SEE the column up to the cloud base
    2600
  );
  const near = buildLayer(
    NEAR_FLAKES,
    NEAR_RADIUS,
    CLOUD_MID, // same column: the big crystals also pour from the clouds
    GROUND_NOMINAL,
    NEAR_SIZE_MIN,
    NEAR_SIZE_MAX,
    14,
    FAR_SPEED_MIN * 0.85,
    FAR_SPEED_MAX * 0.85,
    16, // tighter, livelier corkscrew around the camera
    22, // stronger flutter bob up close
    42, // same gust field so both layers breathe together
    NEAR_MAX_PX, // bokeh flakes looming past the lens go BIG
    NEAR_RANGE, // classic local window
    NEAR_RANGE * 3.2
  );

  // ---------------- soft wind-hiss audio bed (filtered noise loop) --------
  let audioCtx: AudioContext | null = null;
  let audioGain: GainNode | null = null;

  let muted = false;
  const unsubscribeMute = onMuteChange((next) => {
    muted = next;
    if (audioCtx && audioGain) {
      try {
        audioGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.15);
      } catch {
        // decorative audio — never break the game over it
      }
    }
  });

  function ensureAudio(): void {
    if (audioCtx) return;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      // brown-noise loop through a LOW band: snowfall is a muffled hush,
      // nothing like the rain roar or the sleet's bright granular hiss
      const seconds = 2;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const bufferData = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < bufferData.length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        bufferData[i] = last * 3.2;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 620;
      filter.Q.value = 0.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();
      audioCtx = ctx;
      audioGain = gain;
    } catch {
      audioCtx = null;
      audioGain = null;
    }
  }

  // ---------------- per-frame update ----------------
  let snowTime = 0;

  function update(dt: number, focus: THREE.Vector3, intensity: number) {
    const active = intensity > 0.005 && dt > 0;
    far.points.visible = active;
    near.points.visible = active;
    const op = THREE.MathUtils.clamp(intensity, 0, 1);
    far.material.uniforms.uOpacity.value = op * FAR_OPACITY;
    near.material.uniforms.uOpacity.value = op * NEAR_OPACITY;

    if (active) {
      snowTime = (snowTime + dt) % 4096;
      ensureAudio();
      if (audioCtx && audioGain) {
        if (audioCtx.state === 'suspended') {
          void audioCtx.resume().catch(() => undefined);
        }
        // the hush SWELLS with the same gust curve the flakes dance to
        // (identical math + clock as the vertex shader, so ear matches eye)
        const gust =
          0.6 + 0.4 * (Math.sin(snowTime * 0.21) * 0.5 + Math.sin(snowTime * 0.083 + 1.7) * 0.5);
        const target = muted ? 0 : op * AUDIO_MAX_GAIN * (0.72 + 0.45 * gust);
        audioGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.4);
      }
    } else if (audioGain && audioCtx) {
      audioGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    }

    if (!active) return;

    (far.material.uniforms.uTime.value as number) = snowTime;
    (near.material.uniforms.uTime.value as number) = snowTime;
    (far.material.uniforms.uCenter.value as THREE.Vector2).set(focus.x, focus.z);
    (near.material.uniforms.uCenter.value as THREE.Vector2).set(focus.x, focus.z);
    // keep the ground heightmap centred near the player: rebuild (16k real
    // surface samples) only when the anchor drifts too far for coverage to
    // still reach past the flake fade start
    if (heightAt) {
      const dx = focus.x - (groundAnchor ? groundAnchor.x : Infinity);
      const dz = focus.z - (groundAnchor ? groundAnchor.z : Infinity);
      if (!groundAnchor || dx * dx + dz * dz > GROUND_REFRESH * GROUND_REFRESH) {
        groundAnchor = { x: focus.x, z: focus.z };
        groundMap.rebuild(focus.x, focus.z, heightAt);
      }
      (far.material.uniforms.uGroundCenter.value as THREE.Vector2).set(
        groundAnchor.x,
        groundAnchor.z
      );
      (near.material.uniforms.uGroundCenter.value as THREE.Vector2).set(
        groundAnchor.x,
        groundAnchor.z
      );
    }
  }

  function dispose() {
    unsubscribeMute();
    for (const layer of [far, near]) {
      layer.points.removeFromParent();
      layer.points.geometry.dispose();
      layer.material.dispose();
    }
    flakeMap.dispose();
    groundMap.texture.dispose();
    if (audioCtx) {
      try {
        void audioCtx.close();
      } catch {
        // already closed
      }
      audioCtx = null;
      audioGain = null;
    }
  }

  return {
    object: far.points,
    update,
    counts: { near: NEAR_FLAKES, far: farFlakes },
    audioMuted: () => muted,
    audioGain: () => (audioGain ? audioGain.gain.value : null),
    dispose,
  };
}
