/**
 * Ice rain for the RATFIRE winter biomes — the frozen twin of rainSystem.
 *
 * Where the daily storm dumps water on the whole map, the winter zones
 * (src/game/winterBiomes.ts) have their own weather: while the player is
 * inside a frozen region, pale-blue ICE streaks pour from the cloud deck —
 * harder, brighter and slightly slower than water rain, like a sleet/hail
 * shower — and fade out smoothly as you walk back into the grass.
 *
 * Structure mirrors rainSystem.ts exactly:
 *  - MAIN FIELD: line-segment streaks seeded uniformly across the whole
 *    map, every drop's fall / wind slant / wrap animated inside the vertex
 *    shader (zero per-frame CPU cost). The field re-centres on the player
 *    so density is constant wherever the winter zones lie.
 *  - NEAR-FIELD BUMP: a light player-following box of extra streaks so the
 *    ice right around the camera reads bold.
 *  - Drops spawn just under the cumulus deck (FAR_TOP) so they visibly
 *    EMERGE FROM THE CLOUDS.
 *  - Terrain occludes via the depth buffer; FogExp2 fades far streaks.
 *  - intensity (0..1, = the player's winter factor) drives both layers'
 *    opacity plus an icy filtered-noise audio bed (WebAudio, no assets).
 */

import * as THREE from 'three';
import { onMuteChange } from './muteState';

/* ---------------- tuning: main field (whole terrain, GPU) ---------------- */
const FAR_DROPS = 80000; // budget scaled up with the taller sky column so
                         // on-screen density stays identical to the old height
const WORLD_HALF = 6400;
const FAR_TOP = 2600; // just above the raised cumulus deck (2000) — drops
                     // leave the clouds
const FAR_BOTTOM = -2400;
const FAR_SPEED_MIN = 340; // hail is heavier: a touch slower than water
const FAR_SPEED_MAX = 440;
const FAR_LENGTH_MIN = 22; // shorter darts — sleet reads stiffer than rain
const FAR_LENGTH_MAX = 40;
const FAR_OPACITY = 0.62; // ice reads brighter than translucent water
const NEAR_BOOST = 1.4;
const NEAR_RANGE = 700;

/* ---------------- tuning: light near-field bump (player-following) ------ */
const NEAR_DROPS = 380;
const NEAR_RADIUS = 320;
const NEAR_TOP = 440;
const NEAR_BOTTOM = -50;
const NEAR_LENGTH_MIN = 18;
const NEAR_LENGTH_MAX = 34;
const NEAR_OPACITY = 0.5;

const WIND = new THREE.Vector3(-70, 0, -30); // colder, gustier slant
const ICE_COLOR = 0xdff2ff; // pale glacial blue-white
const AUDIO_MAX_GAIN = 0.2;

/* GPU ice rain: same vertex layout as the water rain (see rainSystem.ts). */
const ICE_VERTEX = /* glsl */ `
  attribute vec4 aData;
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uTop;
  uniform float uBottom;
  uniform float uNearGain;
  uniform float uNearRange;
  uniform vec2 uCenter;
  varying float vFade;
  #include <fog_pars_vertex>
  void main() {
    vec2 seed = uCenter +
      (mod(position.xz - uCenter + vec2(${WORLD_HALF.toFixed(1)}), vec2(${(WORLD_HALF * 2).toFixed(1)})) - vec2(${WORLD_HALF.toFixed(1)}));
    float speed = aData.x;
    float span = uTop - uBottom;
    float fallen = mod(position.y * span + uTime * speed, span);
    float t = fallen / speed;
    vec3 head = vec3(seed.x + uWind.x * t, uTop - fallen, seed.y + uWind.z * t);
    vec3 tail = head + vec3(uWind.x, -speed, uWind.z) * (aData.y / speed);
    vec3 p = mix(head, tail, aData.w);
    vFade = aData.z * (1.0 - aData.w * 0.75);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float dist = length(mvPosition.xyz);
    vFade *= 1.0 + uNearGain * max(0.0, 1.0 - dist / uNearRange);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ICE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vFade);
    #include <fog_fragment>
  }
`;

export interface IceRainHandle {
  /** Both ice-rain layers — add it to the scene. */
  readonly object: THREE.LineSegments;
  /** Advance the shower. intensity 0 = hidden + silent (outside winter). */
  update(dt: number, focus: THREE.Vector3, intensity: number): void;
  readonly counts: { near: number; far: number };
  audioMuted(): boolean;
  audioGain(): number | null;
  dispose(): void;
}

export interface IceRainOptions {
  /** Far-field streak budget (default FAR_DROPS); mobile LOW tier thins. */
  farDrops?: number;
}

/** Creates the winter-biome ice shower. Starts hidden (intensity 0). */
export function createIceRain(
  scene: THREE.Scene,
  options: IceRainOptions = {}
): IceRainHandle {
  const farDrops = Math.max(
    4000,
    Math.min(FAR_DROPS, Math.round(options.farDrops ?? FAR_DROPS))
  );
  // ---------- main field: world-fixed, GPU-animated ----------
  const positions = new Float32Array(farDrops * 2 * 3);
  const data = new Float32Array(farDrops * 2 * 4);

  for (let i = 0; i < farDrops; i++) {
    const sx = (Math.random() * 2 - 1) * WORLD_HALF;
    const sz = (Math.random() * 2 - 1) * WORLD_HALF;
    const phase = Math.random();
    const spd = FAR_SPEED_MIN + Math.random() * (FAR_SPEED_MAX - FAR_SPEED_MIN);
    const len = FAR_LENGTH_MIN + Math.random() * (FAR_LENGTH_MAX - FAR_LENGTH_MIN);
    const bright = 0.65 + Math.random() * 0.35; // ice is bright overall
    for (let v = 0; v < 2; v++) {
      const vi = (i * 2 + v) * 3;
      positions[vi + 0] = sx;
      positions[vi + 1] = phase;
      positions[vi + 2] = sz;
      const di = (i * 2 + v) * 4;
      data[di + 0] = spd;
      data[di + 1] = len;
      data[di + 2] = bright;
      data[di + 3] = v;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uWind: { value: WIND.clone() },
        uTop: { value: FAR_TOP },
        uBottom: { value: FAR_BOTTOM },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uColor: { value: new THREE.Color(ICE_COLOR) },
        uOpacity: { value: 0 },
        uNearGain: { value: NEAR_BOOST },
        uNearRange: { value: NEAR_RANGE },
      },
    ]),
    vertexShader: ICE_VERTEX,
    fragmentShader: ICE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });

  const mesh = new THREE.LineSegments(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 6; // after clouds so streaks draw on top
  scene.add(mesh);

  // ---------- light near-field bump: player-following wrap box ----------
  const nearPositions = new Float32Array(NEAR_DROPS * 2 * 3);
  const nearColors = new Float32Array(NEAR_DROPS * 2 * 3);
  const head = new Float32Array(NEAR_DROPS * 3);
  const nearSpeed = new Float32Array(NEAR_DROPS);
  const nearLength = new Float32Array(NEAR_DROPS);
  const nearBright = new Float32Array(NEAR_DROPS);

  function respawnDrop(i3: number, fx: number, fy: number, fz: number): void {
    head[i3 + 1] = fy + NEAR_TOP;
    head[i3 + 0] = fx + (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    head[i3 + 2] = fz + (Math.random() - 0.5) * 2 * NEAR_RADIUS;
  }

  for (let i = 0; i < NEAR_DROPS; i++) {
    const i3 = i * 3;
    head[i3 + 0] = (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    head[i3 + 1] = Math.random() * (NEAR_TOP - NEAR_BOTTOM) + NEAR_BOTTOM;
    head[i3 + 2] = (Math.random() - 0.5) * 2 * NEAR_RADIUS;
    nearSpeed[i] = FAR_SPEED_MIN + Math.random() * (FAR_SPEED_MAX - FAR_SPEED_MIN);
    nearLength[i] =
      NEAR_LENGTH_MIN + Math.random() * (NEAR_LENGTH_MAX - NEAR_LENGTH_MIN);
    nearBright[i] = 0.65 + Math.random() * 0.35;
  }

  const nearGeometry = new THREE.BufferGeometry();
  const nearPosAttr = new THREE.BufferAttribute(nearPositions, 3);
  nearPosAttr.setUsage(THREE.DynamicDrawUsage);
  nearGeometry.setAttribute('position', nearPosAttr);
  nearGeometry.setAttribute('color', new THREE.BufferAttribute(nearColors, 3));

  const nearMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    color: ICE_COLOR,
    depthWrite: false,
  });

  const nearMesh = new THREE.LineSegments(nearGeometry, nearMaterial);
  nearMesh.frustumCulled = false;
  nearMesh.visible = false;
  nearMesh.renderOrder = 6;
  scene.add(nearMesh);

  // ---------------- icy audio bed (filtered noise loop) ----------------
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
      // 2s brown-noise loop through a HIGHER band than the water rain:
      // hail on ice reads as a bright granular hiss, not a low roar
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
      filter.type = 'bandpass';
      filter.frequency.value = 2600;
      filter.Q.value = 0.7;
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
  let rainTime = 0;

  function update(dt: number, focus: THREE.Vector3, intensity: number) {
    const active = intensity > 0.005 && dt > 0;
    mesh.visible = active;
    nearMesh.visible = active;
    material.uniforms.uOpacity.value =
      THREE.MathUtils.clamp(intensity, 0, 1) * FAR_OPACITY;
    nearMaterial.opacity = THREE.MathUtils.clamp(intensity, 0, 1) * NEAR_OPACITY;

    if (active) {
      ensureAudio();
      if (audioCtx && audioGain) {
        if (audioCtx.state === 'suspended') {
          void audioCtx.resume().catch(() => undefined);
        }
        const target = muted ? 0 : intensity * AUDIO_MAX_GAIN;
        audioGain.gain.setTargetAtTime(
          target,
          audioCtx.currentTime,
          0.4
        );
      }
    } else if (audioGain && audioCtx) {
      audioGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    }

    if (!active) return;

    rainTime = (rainTime + dt) % 4096;
    material.uniforms.uTime.value = rainTime;
    (material.uniforms.uCenter.value as THREE.Vector2).set(focus.x, focus.z);

    const fx = focus.x;
    const fy = focus.y;
    const fz = focus.z;
    for (let i = 0; i < NEAR_DROPS; i++) {
      const i3 = i * 3;
      head[i3 + 1] -= nearSpeed[i] * dt;
      head[i3 + 0] += WIND.x * dt;
      head[i3 + 2] += WIND.z * dt;
      if (head[i3 + 1] < fy + NEAR_BOTTOM) {
        respawnDrop(i3, fx, fy, fz);
      }
      let dx = head[i3 + 0] - fx;
      let dz = head[i3 + 2] - fz;
      if (dx > NEAR_RADIUS) head[i3 + 0] -= 2 * NEAR_RADIUS;
      else if (dx < -NEAR_RADIUS) head[i3 + 0] += 2 * NEAR_RADIUS;
      if (dz > NEAR_RADIUS) head[i3 + 2] -= 2 * NEAR_RADIUS;
      else if (dz < -NEAR_RADIUS) head[i3 + 2] += 2 * NEAR_RADIUS;

      const tailFrac = nearLength[i] / nearSpeed[i];
      nearPositions[i3 * 2 + 0] = head[i3 + 0];
      nearPositions[i3 * 2 + 1] = head[i3 + 1];
      nearPositions[i3 * 2 + 2] = head[i3 + 2];
      nearPositions[i3 * 2 + 3] = head[i3 + 0] + WIND.x * tailFrac;
      nearPositions[i3 * 2 + 4] = head[i3 + 1] - nearSpeed[i] * tailFrac;
      nearPositions[i3 * 2 + 5] = head[i3 + 2] + WIND.z * tailFrac;

      const b = nearBright[i];
      nearColors[i3 * 2 + 0] = b;
      nearColors[i3 * 2 + 1] = b;
      nearColors[i3 * 2 + 2] = b;
      nearColors[i3 * 2 + 3] = b * 0.3;
      nearColors[i3 * 2 + 4] = b * 0.3;
      nearColors[i3 * 2 + 5] = b * 0.3;
    }
    nearPosAttr.needsUpdate = true;
    nearGeometry.getAttribute('color').needsUpdate = true;
  }

  function dispose() {
    unsubscribeMute();
    mesh.removeFromParent();
    geometry.dispose();
    material.dispose();
    nearMesh.removeFromParent();
    nearGeometry.dispose();
    nearMaterial.dispose();
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
    object: mesh,
    update,
    counts: { near: NEAR_DROPS, far: farDrops },
    audioMuted: () => muted,
    audioGain: () => (audioGain ? audioGain.gain.value : null),
    dispose,
  };
}
