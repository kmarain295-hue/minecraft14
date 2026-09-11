import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getGlobalMuted, onMuteChange } from '@/game/muteState';

/* ============================================================================
 * petDrone.ts — "BUZZ" the RATFIRE pet quadcopter: micro-detail model with
 * PROPER PROCEDURAL TEXTURES + a completely working companion brain.
 *
 * MODEL (hand-built from primitives, merged per material like jeepProp):
 *  - carbon-fiber lower chassis (real twill-weave canvas texture) with a
 *    gunmetal top shell (procedural panel lines, screws, "RF-01" decal and
 *    a warning triangle painted on the canvas), amber RATFIRE nose chevrons
 *  - 4 diagonal arms ending in motor bells; each spins a 2-blade prop with
 *    built-in pitch twist + a translucent blur disc that fades in with RPM
 *  - stabilized camera gimbal at the nose: fork, camera shell, lens barrel,
 *    glass element and a blinking REC dot
 *  - aviation lights: green right / red left nav LEDs, double-flash white
 *    rear strobe, 1 Hz antenna beacon, pulsing teal status ring underneath
 *  - hazard-striped battery pack with carry loop, corner bumpers, side vent
 *    slits, landing skids, tilted rear antenna
 *  - a real SpotLight under the nose that fades in with the night factor
 *    so BUZZ lights the player's way after dusk (day/night aware)
 *
 * BRAIN (`update`):
 *  - damped-spring formation flight: hovers at the player's right-rear
 *    shoulder, pulls alongside while sprinting, stands off wider while the
 *    jeep is being driven (speed is estimated from the target's motion);
 *    the hover spot is WORLD-ANCHORED while the player stands still, so
 *    rotating them in place (A/D) never drags or orbits the drone along —
 *    the slot only swings back to the shoulder while the player really moves
 *  - INDEPENDENT heading: BUZZ faces its own flight direction, never the
 *    player's yaw — rotating the player (A/D) only swings the formation slot
 *    the drone flies to, and a hovering drone holds its heading like a real
 *    quadcopter instead of mirroring the player's turns
 *  - banking from its own motion (nose dips with forward speed, rolls into
 *    slips and arcs), hover bob, ground clearance via terrain height;
 *    the altitude reference is EASED toward the player's height, so blocky
 *    terrain steps, jumps and hard drops turn into smooth climbs and dives
 *    (BUZZ performs every drop, but glides — it never snaps or bounces)
 *  - rotor RPM eases up with speed, gimbal looks down while hovering and
 *    pans idly, the whole drone sways gently when the player stands still
 *  - flies in from above on spawn (the spring does the swoop naturally)
 *
 * COMBAT (`fireGun` / `launchMissile`):
 *  - a chin machine-gun on its OWN aiming turret (yaws/pitches onto the
 *    ordered point independent of the body heading, recoils, additive
 *    muzzle flash + point light, ~9.5 rounds/s, light spread)
 *  - two wing pods with 4 visible missiles; each launch hides its missile
 *    (the tube visibly empties) and reloads after 7s; bullets/rockets are
 *    flown by the game's bullet system via the `ordnance` callbacks
 *
 * SOUND: a tiny synthesized rotor hum (two detuned saws + band-passed
 * noise) whose gain follows speed, plus synthesized gun cracks and missile
 * thumps — all covered by the global mute (muteState).
 *
 * Scale: 100 world units = 1 m -> body ~34 u wide, ~56 u motor-to-motor.
 * The drone flies with +Z as its nose. `dispose()` frees everything.
 * ==========================================================================*/

/** Live target a homing missile chases (BUZZ's AI or an enemy drone's
 *  shot at BUZZ). Structurally identical to bulletSystem's RocketTracker. */
export interface PetRocketTracker {
  getPos(): THREE.Vector3 | null;
  getVel?(): THREE.Vector3 | null;
}

/** Ammo plumbing: BUZZ computes each shot, the game's pooled bullet system
 *  flies it — the same tracers, rockets, explosions and audio the player's
 *  weapons use. The page assigns the real impls once `bullets` exists. */
export interface PetDroneOrdnance {
  fireBullet(origin: THREE.Vector3, dir: THREE.Vector3): void;
  fireRocket(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Homing variant — wired by the page when the pooled system supports
   *  it; `launchMissile(aim, { tracker })` upgrades itself automatically. */
  fireHomingRocket?(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    tracker: PetRocketTracker
  ): void;
}

export interface PetDroneOptions {
  /** Low-end devices: fewer segments, no blur discs, no spotlight shadow. */
  lowSpec?: boolean;
  /** Terrain height callback for ground clearance (world units). */
  heightAt?: (x: number, z: number) => number;
  /** Weapon plumbing into the game's bullet/rocket system. */
  ordnance?: PetDroneOrdnance;
  /** HOSTILE AIRFRAME (enemyDrones.ts): identical model, red identity —
   *  status ring, beacon and nose chevrons swap from BUZZ's teal/amber
   *  to hostile red so dogfight opponents read as enemies at a glance. */
  hostile?: boolean;
}

export interface PetDroneUpdateContext {
  /** 0 = full day, 1 = deep night — drives the headlights/glow. */
  night?: number;
  /** Designated world target (e.g. a live dummy's chest). While the drone
   *  is PARKED (below flight speed) it yaws in place to face this point —
   *  a real quadcopter slews around its axis without translating, so the
   *  world-anchored hover slot stays untouched while the gun lines up. */
  combatTarget?: THREE.Vector3;
  /** AUTONOMOUS STRIKE MODE: world hover point the AI brain (droneAi.ts)
   *  wants to hold — an orbit slot around its designated target. The same
   *  critically-damped spring, own-velocity heading, banking, bob and
   *  terrain glide fly it there, and the ground clearance below still
   *  applies; when absent, the normal formation slot is flown unchanged. */
  flightOverride?: THREE.Vector3;
}

export interface PetDrone {
  /** Root group — already added to the scene you passed in. */
  group: THREE.Group;
  /** Drive the companion brain once per frame. */
  update(
    dt: number,
    targetPos: THREE.Vector3,
    targetYaw: number,
    ctx?: PetDroneUpdateContext
  ): void;
  /** Fire one chin-gun round at a world point (rate-limited inside).
   *  Hold-order friendly: call every frame while the trigger is held. */
  fireGun(aim: THREE.Vector3): boolean;
  /** Launch one missile from a wing pod at a world point (cooldown +
   *  per-tube reload). Returns false while reloading/empty. Pass a
   *  `tracker` and the rocket becomes a HOMING missile (true PN). */
  launchMissile(
    aim: THREE.Vector3,
    launchOpts?: { tracker?: PetRocketTracker }
  ): boolean;
  /** How many missiles are currently loaded across both pods. */
  missilesLoaded(): number;
  /** Instantly reload every missile tube (voice RESUPPLY order — the
   *  wing pods visibly re-arm). Additive, never touches flight code. */
  resupply(): void;
  /** Free geometries, materials, textures and the audio nodes. */
  dispose(): void;
  /** Smoothed own-flight velocity (world units/s) — the tracker other
   *  systems aim homing rockets with, and the enemy brain's lead input. */
  velocity(): THREE.Vector3;
  /** Build stats for debug surfaces. */
  stats: { meshes: number; triangles: number };
}

/* ---------------- small texture factory helpers ---------------- */

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('petDrone: 2D canvas unavailable');
  return [canvas, ctx];
}

function finishTexture(canvas: HTMLCanvasElement, repeat: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

/** Real 2x2 twill carbon-fiber weave with sheen variance + micro noise. */
function carbonTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  ctx.fillStyle = '#15181e';
  ctx.fillRect(0, 0, 256, 256);
  const cell = 32; // one weave cell
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const horizontal = (cx + cy) % 2 === 0;
      for (let s = 0; s < 4; s++) {
        const x = cx * cell + s * 8;
        const y = cy * cell;
        if (horizontal) {
          const shade = 26 + s * 5 + ((cx * 7 + cy * 13 + s * 3) % 5);
          ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 7})`;
          ctx.fillRect(x, y, 8, cell);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(x, y, 8, 2);
        } else {
          const shade = 26 + s * 5 + ((cx * 11 + cy * 5 + s * 7) % 5);
          ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 7})`;
          ctx.fillRect(x, y + s * 8, cell, 8);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(x, y + s * 8, 2, 8);
        }
      }
    }
  }
  // micro grain
  for (let i = 0; i < 900; i++) {
    const v = Math.random() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    ctx.fillStyle = v;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }
  return finishTexture(canvas, 2);
}

/** Gunmetal top-shell skin: panel lines, screws, RF-01 decal, warning mark. */
function panelTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const base = ctx.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, '#9aa1ab');
  base.addColorStop(1, '#7d848f');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  // random sub-panels slightly darker/lighter
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 7; i++) {
    const w = 40 + rand() * 90;
    const h = 30 + rand() * 70;
    const x = rand() * (256 - w);
    const y = rand() * (256 - h);
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    ctx.fillRect(x, y, w, h);
  }
  // panel seams
  ctx.strokeStyle = 'rgba(40,45,52,0.85)';
  ctx.lineWidth = 2;
  const seams = [0, 64, 128, 192, 256];
  for (let i = 1; i < seams.length - 1; i++) {
    const o = seams[i] + (i % 2 === 0 ? 8 : -6);
    ctx.beginPath();
    ctx.moveTo(0, o);
    ctx.lineTo(256, o);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(o, 0);
    ctx.lineTo(o, 256);
    ctx.stroke();
  }
  // screws in the corners of the main seam grid
  ctx.fillStyle = '#565d66';
  for (const sx of [10, 118, 246]) {
    for (const sy of [10, 118, 246]) {
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 2, sy);
      ctx.lineTo(sx + 2, sy);
      ctx.stroke();
    }
  }
  // RATFIRE pet decal
  ctx.fillStyle = '#23262c';
  ctx.font = '900 30px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RF-01', 128, 116);
  ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#c87a12';
  ctx.fillText('PET UNIT · RATFIRE', 128, 140);
  // amber warning triangle
  ctx.fillStyle = '#f2b418';
  ctx.beginPath();
  ctx.moveTo(224, 214);
  ctx.lineTo(240, 240);
  ctx.lineTo(208, 240);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#23262c';
  ctx.font = '900 16px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('!', 224, 234);
  return finishTexture(canvas, 1);
}

/** Yellow/black hazard stripes for the battery pack. */
function hazardTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128);
  ctx.fillStyle = '#23262b';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#f2c230';
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate(-Math.PI / 4);
  for (let x = -128; x < 128; x += 32) {
    ctx.fillRect(x, -128, 16, 256);
  }
  ctx.restore();
  // worn edge scuffs
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 1);
  }
  return finishTexture(canvas, 3);
}

/** Olive-drab ordnance skin for the wing missile pods: military green with
 *  classic yellow ordnance bands, panel seams, rivets and a stencil code.
 *  The pods used to share the near-black chassis material and disappeared
 *  against the body — this skin makes them read as visible hardware. */
function podTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  // olive-drab base
  ctx.fillStyle = '#6b7a42';
  ctx.fillRect(0, 0, 256, 256);
  // worn tone patches (lighter/darker olive)
  for (let i = 0; i < 10; i++) {
    const w = 30 + Math.random() * 90;
    const h = 20 + Math.random() * 60;
    ctx.fillStyle =
      Math.random() > 0.5 ? 'rgba(255,255,235,0.07)' : 'rgba(20,26,8,0.10)';
    ctx.fillRect(Math.random() * (256 - w), Math.random() * (256 - h), w, h);
  }
  // panel seams (dark olive)
  ctx.strokeStyle = 'rgba(38,46,20,0.9)';
  ctx.lineWidth = 2;
  for (const o of [52, 128, 204]) {
    ctx.beginPath();
    ctx.moveTo(0, o);
    ctx.lineTo(256, o);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(o, 0);
    ctx.lineTo(o, 256);
    ctx.stroke();
  }
  // rivets
  ctx.fillStyle = '#93a465';
  for (let x = 26; x < 256; x += 52) {
    for (let y = 26; y < 256; y += 52) {
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // yellow ordnance bands — the horizontal one wraps each launch tube as a
  // bright ring, exactly like real rocket rails
  ctx.fillStyle = '#f0b71e';
  ctx.fillRect(0, 92, 256, 20);
  ctx.fillRect(0, 182, 256, 10);
  // stencil ordnance code between the bands
  ctx.fillStyle = 'rgba(24,28,10,0.85)';
  ctx.font = '900 24px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ORD-04', 128, 152);
  // scuffs
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle =
      Math.random() > 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,230,0.06)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 3, 1);
  }
  return finishTexture(canvas, 1);
}

/* ---------------- geometry bucket helper ---------------- */

type Vec3 = [number, number, number];

class Bucket {
  geos: THREE.BufferGeometry[] = [];
  add(
    geo: THREE.BufferGeometry,
    pos: Vec3 = [0, 0, 0],
    rot: Vec3 = [0, 0, 0],
    scale: Vec3 = [1, 1, 1]
  ): void {
    // RoundedBoxGeometry is non-indexed while primitive geometries are
    // indexed — normalize everything to non-indexed so mergeGeometries
    // always finds compatible attribute sets.
    if (geo.index) geo = geo.toNonIndexed();
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
      new THREE.Vector3(...scale)
    );
    geo.applyMatrix4(m);
    this.geos.push(geo);
  }
  mesh(material: THREE.Material, shadows: boolean): THREE.Mesh | null {
    if (this.geos.length === 0) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos = [];
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadows;
    return mesh;
  }
}

/* ---------------- module ---------------- */

export function createPetDrone(
  scene: THREE.Scene,
  opts: PetDroneOptions = {}
): PetDrone {
  const low = opts.lowSpec ?? false;
  const seg = low ? 2 : 3; // rounded-box segments
  const rad = low ? 8 : 14; // cylinder/torus radial segments

  /* ----- materials (procedural textures, no asset files) ----- */
  const carbonTex = carbonTexture();
  const panelTex = panelTexture();
  const hazardTex = hazardTexture();

  const carbonMat = new THREE.MeshStandardMaterial({
    map: carbonTex,
    metalness: 0.4,
    roughness: 0.5,
  });
  const shellMat = new THREE.MeshStandardMaterial({
    map: panelTex,
    metalness: 0.55,
    roughness: 0.42,
  });
  const hazardMat = new THREE.MeshStandardMaterial({
    map: hazardTex,
    metalness: 0.15,
    roughness: 0.6,
  });
  const podTex = podTexture();
  const podMat = new THREE.MeshStandardMaterial({
    map: podTex,
    metalness: 0.3,
    roughness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x191c21,
    metalness: 0.25,
    roughness: 0.72,
  });
  const bellMat = new THREE.MeshStandardMaterial({
    color: 0x3a4048,
    metalness: 0.9,
    roughness: 0.32,
  });
  const amberMat = new THREE.MeshStandardMaterial({
    color: 0xffb020,
    metalness: 0.4,
    roughness: 0.4,
    emissive: 0xff8c00,
    emissiveIntensity: 0.25,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d16,
    metalness: 1.0,
    roughness: 0.08,
  });
  const propMat = new THREE.MeshStandardMaterial({
    color: 0x22262c,
    metalness: 0.3,
    roughness: 0.5,
    transparent: true,
    opacity: 0.92,
  });
  const blurMat = new THREE.MeshBasicMaterial({
    color: 0x9aa4b2,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x35e0c8 });
  const ledGreenMat = new THREE.MeshBasicMaterial({ color: 0x36ff6a });
  const ledRedMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffb020 });

  /* ----- hostile identity: same airframe, red everything ----- */
  const hostile = opts.hostile === true;
  const ringBaseHex = hostile ? 0xff4034 : 0x35e0c8;
  if (hostile) {
    ringMat.color.setHex(ringBaseHex);
    beaconMat.color.setHex(0xff2222);
    amberMat.color.setHex(0xff5030);
    amberMat.emissive.setHex(0x8a1000);
    podMat.color.setHex(0xd98a80); // hostile pods shift red-tinted
  }

  /* ----- static merged buckets ----- */
  const carbon = new Bucket();
  const shell = new Bucket();
  const dark = new Bucket();
  const bell = new Bucket();
  const amber = new Bucket();
  const hazard = new Bucket();
  const pod = new Bucket();

  // lower chassis: rounded carbon slab with tapered feel (two stacked slabs)
  carbon.add(new RoundedBoxGeometry(30, 9, 42, seg, 3), [0, 0, 0]);
  carbon.add(new RoundedBoxGeometry(24, 5, 30, seg, 2.4), [0, 5.4, -1]);
  // upper shell (panel-textured canopy)
  shell.add(new RoundedBoxGeometry(22, 8, 32, seg, 3.4), [0, 10.4, -1]);
  // nose wedge (shell) — slight forward slope
  shell.add(new RoundedBoxGeometry(18, 5, 10, seg, 2.6), [0, 9.2, 18.5], [-0.35, 0, 0]);
  // battery pack: hazard-striped box + carry loop (dark torus)
  hazard.add(new RoundedBoxGeometry(14, 6.5, 12, seg, 2.2), [0, 12.4, -19]);
  const loop = new THREE.TorusGeometry(3.1, 1.0, low ? 6 : 10, rad);
  dark.add(loop, [0, 17.4, -19], [Math.PI / 2, 0, 0]);
  // corner bumpers
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      dark.add(
        new RoundedBoxGeometry(5, 5, 5, seg, 1.8),
        [sx * 15.2, 0.4, sz * 20.4]
      );
    }
  }
  // side vent slits (3 per side)
  for (const sx of [-1, 1]) {
    for (let v = 0; v < 3; v++) {
      dark.add(
        new THREE.BoxGeometry(1.4, 2.2, 12),
        [sx * 15.3, 1.5 + v * 0.4, 2 + v * 6 - 6],
        [0, 0, sx * 0.16]
      );
    }
  }
  // arms: 4 diagonal carbon beams out to the motors
  const greenLeds: THREE.Mesh[] = [];
  const redLeds: THREE.Mesh[] = [];
  const armLen = 17;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const dx = sx * 21.5;
      const dz = sz * 21.5;
      const yawA = Math.atan2(dx, dz);
      carbon.add(
        new RoundedBoxGeometry(6.5, 3.6, armLen, seg, 1.6),
        [sx * 12.2, 1.2, sz * 12.2],
        [0, yawA + Math.PI / 2, 0]
      );
      // motor bell + cap + shaft
      bell.add(
        new THREE.CylinderGeometry(5.4, 6.0, 6.4, rad),
        [dx, 4.6, dz]
      );
      bell.add(
        new THREE.CylinderGeometry(6.1, 6.1, 1.7, rad),
        [dx, 8.2, dz]
      );
      dark.add(
        new THREE.CylinderGeometry(0.9, 0.9, 3.4, 6),
        [dx, 10.2, dz]
      );
      // nav LEDs at the FRONT two arm tips (aviation: green right, red left)
      if (sz > 0) {
        const isRight = sx > 0;
        const ledGeo = new THREE.SphereGeometry(1.7, low ? 6 : 10, low ? 5 : 8);
        const m = new THREE.Mesh(
          ledGeo,
          isRight ? ledGreenMat : ledRedMat
        );
        m.position.set(dx, 2.6, dz);
        (isRight ? greenLeds : redLeds).push(m);
      }
    }
  }
  // landing skids: two rails + struts
  for (const sx of [-1, 1]) {
    dark.add(new RoundedBoxGeometry(2.6, 2.6, 30, seg, 1.2), [sx * 8.5, -8.2, 2]);
    dark.add(
      new RoundedBoxGeometry(2.6, 2.6, 8, seg, 1.2),
      [sx * 8.5, -6.4, 16.6],
      [0.5, 0, 0]
    );
    for (const sz of [-1, 1]) {
      dark.add(
        new THREE.BoxGeometry(2.2, 7, 2.2),
        [sx * 8.5, -4.4, sz * 8 + 2]
      );
    }
  }
  // rear antenna (tilted) — beacon tip added separately (blinks)
  dark.add(
    new THREE.CylinderGeometry(0.55, 0.8, 12, 6),
    [-7.5, 16.5, -14],
    [0.45, 0, 0.18]
  );
  // underside: teal status ring + round sensor plate
  const ring = new THREE.TorusGeometry(7.2, 0.9, low ? 6 : 10, low ? 18 : 32);
  const ringMesh = new THREE.Mesh(ring, ringMat);
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.position.set(0, -4.6, 1);
  dark.add(new THREE.CylinderGeometry(4.6, 5.2, 1.6, rad), [0, -4.9, 1]);
  // amber nose chevrons
  amber.add(new RoundedBoxGeometry(2.2, 1.6, 6, seg, 0.7), [-4.4, 9.6, 22.6], [0, 0.25, 0]);
  amber.add(new RoundedBoxGeometry(2.2, 1.6, 6, seg, 0.7), [4.4, 9.6, 22.6], [0, -0.25, 0]);
  // missile-pod rails + launch tubes under the front arms (static) — own
  // olive ordnance material so they are clearly visible (were near-black)
  for (const sx of [-1, 1]) {
    pod.add(
      new RoundedBoxGeometry(3.6, 2.0, 17, seg, 1.2),
      [sx * 13.8, -3.1, 10]
    );
    for (const mz of [6.4, 13.6]) {
      pod.add(
        new THREE.CylinderGeometry(1.95, 1.95, 6.4, low ? 6 : 10, 1, true),
        [sx * 13.8, -5.0, mz],
        [Math.PI / 2, 0, 0]
      );
    }
  }

  const root = new THREE.Group();
  root.name = 'petDrone';

  const carbonMesh = carbon.mesh(carbonMat, true);
  const shellMesh = shell.mesh(shellMat, true);
  const darkMesh = dark.mesh(darkMat, true);
  const bellMesh = bell.mesh(bellMat, true);
  const amberMesh = amber.mesh(amberMat, true);
  const hazardMesh = hazard.mesh(hazardMat, true);
  const podMesh = pod.mesh(podMat, true);
  for (const m of [
    carbonMesh,
    shellMesh,
    darkMesh,
    bellMesh,
    amberMesh,
    hazardMesh,
    podMesh,
  ]) {
    if (m) root.add(m);
  }
  if (ringMesh) root.add(ringMesh);
  for (const arr of [greenLeds, redLeds]) {
    for (const led of arr) root.add(led);
  }

  // white rear strobe + antenna beacon (blink via color swap)
  const strobe = new THREE.Mesh(
    new THREE.SphereGeometry(1.7, low ? 6 : 10, low ? 5 : 8),
    strobeMat
  );
  strobe.position.set(0, 8.2, -21.5);
  root.add(strobe);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.3, low ? 6 : 10, low ? 5 : 8),
    beaconMat
  );
  beacon.position.set(-10.2, 21.6, -16.6);
  root.add(beacon);

  // ----- camera gimbal (animated group) -----
  const gimbal = new THREE.Group();
  gimbal.position.set(0, 7.2, 16.5);
  root.add(gimbal);
  const fork = new Bucket();
  for (const sx of [-1, 1]) {
    fork.add(new THREE.BoxGeometry(1.6, 7, 1.6), [sx * 4.6, -2, 0]);
  }
  fork.add(new THREE.BoxGeometry(10.8, 1.6, 1.6), [0, -5.4, 0]);
  const forkMesh = fork.mesh(darkMat, true);
  if (forkMesh) gimbal.add(forkMesh);
  const camBody = new Bucket();
  camBody.add(new RoundedBoxGeometry(9.4, 7.6, 8.4, seg, 2));
  const camMesh = camBody.mesh(shellMat, true);
  if (camMesh) {
    camMesh.position.set(0, -8.2, 0.4);
    gimbal.add(camMesh);
  }
  const lens = new Bucket();
  lens.add(new THREE.CylinderGeometry(3.1, 3.4, 3.4, rad), [0, 0, 3.4], [Math.PI / 2, 0, 0]);
  const lensMesh = lens.mesh(bellMat, true);
  if (lensMesh) {
    lensMesh.position.set(0, -8.2, 4.2);
    gimbal.add(lensMesh);
  }
  const lensGlass = new THREE.Mesh(
    new THREE.SphereGeometry(2.5, low ? 8 : 14, low ? 6 : 10),
    glassMat
  );
  lensGlass.position.set(0, -8.2, 6.2);
  lensGlass.scale.z = 0.5;
  gimbal.add(lensGlass);
  const recDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xff2222 })
  );
  recDot.position.set(3.2, -5.4, 4.6);
  gimbal.add(recDot);
  const recMat = recDot.material as THREE.MeshBasicMaterial;

  // ----- chin gun turret (aims + fires independent of the body heading) ---
  const turret = new THREE.Group();
  turret.position.set(6.2, -1.2, 12.5);
  root.add(turret);
  const turretDark = new Bucket();
  turretDark.add(new RoundedBoxGeometry(6.4, 5.2, 8.6, seg, 1.8), [0, 0, 0]);
  turretDark.add(
    new THREE.CylinderGeometry(1.05, 1.2, 13, low ? 6 : 10),
    [0, -0.4, 8.6],
    [Math.PI / 2, 0, 0]
  );
  turretDark.add(
    new THREE.CylinderGeometry(1.7, 1.7, 2.2, low ? 6 : 10),
    [0, -0.4, 3.4],
    [Math.PI / 2, 0, 0]
  );
  const turretDarkMesh = turretDark.mesh(darkMat, true);
  if (turretDarkMesh) turret.add(turretDarkMesh);
  const turretAmber = new Bucket();
  turretAmber.add(
    new THREE.CylinderGeometry(1.25, 1.25, 1.1, low ? 6 : 10),
    [0, -0.4, 14.6],
    [Math.PI / 2, 0, 0]
  );
  const turretAmberMesh = turretAmber.mesh(amberMat, false);
  if (turretAmberMesh) turret.add(turretAmberMesh);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.4, 15.6);
  turret.add(muzzle);
  // muzzle flash: additive glow ball at the tip + a brief point light
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd27a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), flashMat);
  flash.position.set(0, -0.4, 17.4);
  flash.scale.set(1, 1, 1.6);
  turret.add(flash);
  const flashLight = new THREE.PointLight(0xffc36b, 0, 170, 2);
  flashLight.position.set(0, -0.4, 16.5);
  if (!low) turret.add(flashLight);

  // ----- missiles: 2 per pod, each its own mesh so launches can empty and
  // reload the tubes visibly (shared merged geometry, one draw call each) --
  const missiles: Array<{
    group: THREE.Group;
    loaded: boolean;
    reloadAt: number;
  }> = [];
  const missileProto = new Bucket();
  missileProto.add(
    new THREE.CylinderGeometry(1.5, 1.5, 8.6, low ? 6 : 10),
    [0, 0, 0],
    [Math.PI / 2, 0, 0]
  );
  missileProto.add(
    new THREE.CylinderGeometry(0.05, 1.5, 3.4, low ? 6 : 10),
    [0, 0, 5.9],
    [Math.PI / 2, 0, 0]
  );
  missileProto.add(new THREE.CylinderGeometry(1.0, 1.3, 1.0, low ? 6 : 8), [0, 0, -4.7], [Math.PI / 2, 0, 0]);
  missileProto.add(new THREE.BoxGeometry(2.4, 0.4, 2.6), [0, 1.3, -3.3]);
  missileProto.add(new THREE.BoxGeometry(2.4, 0.4, 2.6), [0, -1.3, -3.3]);
  missileProto.add(new THREE.BoxGeometry(0.4, 2.4, 2.6), [1.3, 0, -3.3]);
  missileProto.add(new THREE.BoxGeometry(0.4, 2.4, 2.6), [-1.3, 0, -3.3]);
  const missileMeshProto = missileProto.mesh(bellMat, true);
  if (missileMeshProto) {
    const missileGeo = missileMeshProto.geometry;
    // interleave left/right so launches alternate pods
    for (const mz of [6.4, 13.6]) {
      for (const sx of [-1, 1]) {
        const g = new THREE.Group();
        g.position.set(sx * 13.8, -5.0, mz);
        const mm = new THREE.Mesh(missileGeo, bellMat);
        mm.castShadow = true;
        g.add(mm);
        root.add(g);
        missiles.push({ group: g, loaded: true, reloadAt: 0 });
      }
    }
  }

  // ----- headlight spotlight (night) -----
  const headlight = new THREE.SpotLight(0xfff2cc, 0, low ? 500 : 900, 0.55, 0.55, 1.2);
  headlight.position.set(0, -6.5, 6);
  root.add(headlight);
  const headTarget = new THREE.Object3D();
  headTarget.position.set(0, -55, 130);
  root.add(headTarget);
  headlight.target = headTarget;

  // ----- props (4 animated assemblies) -----
  const props: Array<{ pivot: THREE.Group; blur: THREE.Mesh; dir: number }> = [];
  const bladeGeo = new RoundedBoxGeometry(2.0, 0.55, 26, 1, 0.8);
  const spinnerGeo = new THREE.CylinderGeometry(1.5, 1.9, 2.2, rad);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 21.5, 11.4, sz * 21.5);
      const a = new Bucket();
      a.add(bladeGeo.clone(), [0, 0, 0], [0, 0, 0.10]);
      a.add(bladeGeo.clone(), [0, 0, 0], [0, Math.PI / 2, 0.10]);
      const blades = a.mesh(propMat, true);
      if (blades) pivot.add(blades);
      const spinner = new THREE.Mesh(spinnerGeo, bellMat);
      spinner.position.y = 0.2;
      pivot.add(spinner);
      let blur: THREE.Mesh | null = null;
      if (!low) {
        blur = new THREE.Mesh(
          new THREE.CircleGeometry(14.5, 24),
          blurMat
        );
        blur.rotation.x = -Math.PI / 2;
        blur.position.y = 0.9;
        pivot.add(blur);
      }
      root.add(pivot);
      props.push({ pivot, blur: blur as THREE.Mesh, dir: sx * sz > 0 ? 1 : -1 });
    }
  }

  scene.add(root);

  /* ----- brain state ----- */
  const anchor = new THREE.Vector3(); // spring anchor (world), seeded on 1st update
  let seeded = false;
  let spin = 10; // rad/s
  let yawSm = 0;
  let yawRateSm = 0;
  let slotYawSm = 0; // formation yaw — world-anchored while the target idles
  let baseY = 0; // eased player altitude reference (smooth terrain following)
  let pitchSm = 0;
  let rollSm = 0;
  let nightSm = 0;
  let idleTime = 0;
  let swayPhase = Math.random() * Math.PI * 2;
  const lastTarget = new THREE.Vector3();
  const targetVel = new THREE.Vector3();
  const lastAnchor = new THREE.Vector3(); // own-flight velocity source
  const droneVel = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /* ----- tiny synthesized rotor hum (mute-aware) ----- */
  let audioCtx: AudioContext | null = null;
  let humGain: GainNode | null = null;
  let humStarted = false;
  let muted = getGlobalMuted();
  const offMute = onMuteChange((m) => {
    muted = m;
  });

  function ensureHum(): void {
    if (humStarted || low) return;
    humStarted = true;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
      humGain = audioCtx.createGain();
      humGain.gain.value = 0;
      humGain.connect(audioCtx.destination);
      // two detuned saw oscillators = body of the whir
      for (const f of [82, 97]) {
        const osc = audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        const og = audioCtx.createGain();
        og.gain.value = 0.5;
        osc.connect(og);
        og.connect(humGain);
        osc.start();
      }
      // band-passed noise = blade flutter
      const len = audioCtx.sampleRate * 1.2;
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const noise = audioCtx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 880;
      bp.Q.value = 1.4;
      const ng = audioCtx.createGain();
      ng.gain.value = 0.55;
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(humGain);
      noise.start();
    } catch {
      audioCtx = null;
      humGain = null;
    }
  }

  /* ----- combat state ----- */
  const GUN_RATE = 0.105; // s between chin-gun rounds (~9.5 rps)
  const MISSILE_CD = 1.15; // s between missile launches
  const MISSILE_RELOAD = 7; // s for one tube to reload
  let lastShotAt = -10;
  let lastLaunchAt = -10;
  let lastOrderAt = -10; // last fire order — the turret stays on target a while
  let flashT = 0; // muzzle flash envelope 0..1
  let turretKick = 0; // gun recoil envelope 0..1
  let launchKick = 0; // missile launch nose-pop envelope 0..1
  let turretYaw = 0;
  let turretPitch = 0;
  const lastAim = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  const shotDir = new THREE.Vector3();
  const aimLocal = new THREE.Vector3();

  /** Tiny synthesized gun crack / missile thump (best-effort, mute-aware). */
  function combatSound(kind: 'shot' | 'thump'): void {
    if (!audioCtx || muted || low) return;
    try {
      const t0 = audioCtx.currentTime;
      const g = audioCtx.createGain();
      g.connect(audioCtx.destination);
      const o = audioCtx.createOscillator();
      if (kind === 'shot') {
        o.type = 'square';
        o.frequency.setValueAtTime(1500, t0);
        o.frequency.exponentialRampToValueAtTime(240, t0 + 0.055);
        g.gain.setValueAtTime(0.045, t0);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.07);
        o.start(t0);
        o.stop(t0 + 0.08);
      } else {
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t0);
        o.frequency.exponentialRampToValueAtTime(38, t0 + 0.28);
        g.gain.setValueAtTime(0.16, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
        o.start(t0);
        o.stop(t0 + 0.32);
      }
      o.connect(g);
    } catch {
      // audio is best-effort
    }
  }

  /* ----- weapon orders (called from the game loop / input handlers) ----- */
  function fireGun(aim: THREE.Vector3): boolean {
    if (!opts.ordnance) return false;
    const nowS = performance.now() / 1000;
    if (nowS - lastShotAt < GUN_RATE) return false;
    lastShotAt = nowS;
    lastOrderAt = nowS;
    lastAim.copy(aim);
    ensureHum();
    muzzle.getWorldPosition(shotOrigin);
    shotDir.copy(aim).sub(shotOrigin).normalize();
    // light spread so bursts read as a gun, not a laser
    shotDir.x += (Math.random() - 0.5) * 0.02;
    shotDir.y += (Math.random() - 0.5) * 0.02;
    shotDir.z += (Math.random() - 0.5) * 0.02;
    shotDir.normalize();
    opts.ordnance.fireBullet(shotOrigin, shotDir);
    flashT = 1;
    turretKick = 1;
    combatSound('shot');
    return true;
  }

  function launchMissile(
    aim: THREE.Vector3,
    launchOpts?: { tracker?: PetRocketTracker }
  ): boolean {
    if (!opts.ordnance) return false;
    const nowS = performance.now() / 1000;
    if (nowS - lastLaunchAt < MISSILE_CD) return false;
    const slot = missiles.find((m) => m.loaded);
    if (!slot) return false;
    lastLaunchAt = nowS;
    lastOrderAt = nowS;
    lastAim.copy(aim);
    ensureHum();
    slot.loaded = false;
    slot.reloadAt = nowS + MISSILE_RELOAD;
    slot.group.visible = false; // the tube visibly empties, then reloads
    slot.group.getWorldPosition(shotOrigin);
    shotDir.copy(aim).sub(shotOrigin).normalize();
    if (launchOpts?.tracker && opts.ordnance.fireHomingRocket) {
      // HOMING: the rocket chases the tracked target (true PN in the
      // bullet system) — used by the AI brain and enemy dogfights
      opts.ordnance.fireHomingRocket(shotOrigin, shotDir, launchOpts.tracker);
    } else {
      opts.ordnance.fireRocket(shotOrigin, shotDir);
    }
    launchKick = 1;
    combatSound('thump');
    return true;
  }

  function missilesLoaded(): number {
    return missiles.reduce((n, m) => n + (m.loaded ? 1 : 0), 0);
  }

  /** Voice RESUPPLY: every tube snaps back to loaded and its missile
   *  mesh re-appears — the pods visibly re-arm on the spot. */
  function resupply(): void {
    for (const m of missiles) {
      m.loaded = true;
      m.group.visible = true;
    }
  }

  /* ----- per-frame brain ----- */
  function update(
    dt: number,
    targetPos: THREE.Vector3,
    targetYaw: number,
    ctx?: PetDroneUpdateContext
  ): void {
    if (!seeded) {
      seeded = true;
      anchor.copy(targetPos).add(tmp.set(30, 300, -60));
      lastAnchor.copy(anchor);
      lastTarget.copy(targetPos);
      baseY = targetPos.y;
      yawSm = targetYaw; // spawn facing the player, then follow our own path
      slotYawSm = targetYaw;
    }

    // --- estimate the target's velocity (drives standoff + hum + gimbal) ---
    tmp.copy(targetPos).sub(lastTarget).divideScalar(Math.max(dt, 1e-4));
    targetVel.lerp(tmp, 1 - Math.exp(-6 * dt));
    lastTarget.copy(targetPos);
    const speed = targetVel.length();
    const speedF = THREE.MathUtils.clamp(speed / 380, 0, 1);
    if (speed > 24) idleTime = 0;
    else idleTime += dt;

    // --- formation offset: shoulder -> alongside -> wide standoff ---
    const alongside = THREE.MathUtils.smoothstep(speedF, 0.25, 0.85);
    const wide = THREE.MathUtils.smoothstep(speedF, 0.9, 1.0);
    const right = 66 + alongside * 26 + wide * 34;
    // flight height (lightly raised again)
    const up = 248 - alongside * 34 + wide * 50;
    const back = 64 - alongside * 60 + wide * 36;
    // --- eased altitude reference: the raw player Y stair-steps over the
    // blocky terrain, bounces on every jump and plunges on hard drops —
    // feeding it straight into the slot would jar BUZZ around. Easing it
    // turns all of those into one smooth glide: the drone still performs
    // every climb and drop, just like a real quadcopter would.
    baseY += (targetPos.y - baseY) * (1 - Math.exp(-2.2 * dt));
    // --- formation yaw: the hover spot is WORLD-ANCHORED while the player
    // stands still. Spinning them with A/D used to swing the slot (and
    // BUZZ with it) around the player "like one body" — now the drone just
    // stays parked wherever it is. The spot swings back onto the shoulder
    // only while the player genuinely moves; a parked drone also lazily
    // drifts home after 5s of idling so it never ends up stuck offside.
    if (speed > 60) {
      let dsy = targetYaw - slotYawSm;
      dsy = Math.atan2(Math.sin(dsy), Math.cos(dsy));
      slotYawSm += dsy * (1 - Math.exp(-2.8 * dt));
    } else if (idleTime > 5) {
      let dsy = targetYaw - slotYawSm;
      dsy = Math.atan2(Math.sin(dsy), Math.cos(dsy));
      slotYawSm += dsy * (1 - Math.exp(-0.4 * dt));
    }
    const sinY = Math.sin(slotYawSm);
    const cosY = Math.cos(slotYawSm);
    // yaw frame (character faces +Z at yaw 0):
    //   forward = ( sinY, cosY)   right = (-cosY, sinY)
    // world offset = right * rightVec + back * (-forward)
    if (ctx?.flightOverride) {
      // AUTONOMOUS AI STRIKE: the brain designates the hover point (an
      // orbit slot around its locked target). Everything downstream — the
      // spring, own-velocity heading, banking, bob, terrain glide — is
      // untouched, so the strike approach flies exactly as smoothly as
      // formation flight (Tasks 11-13 behavior preserved bit for bit).
      desired.copy(ctx.flightOverride);
    } else {
      desired.set(
        targetPos.x - cosY * right - sinY * back,
        baseY + up,
        targetPos.z + sinY * right - cosY * back
      );
    }
    // ground clearance: never dip under terrain + 70 (both flight modes)
    if (opts.heightAt) {
      const g = opts.heightAt(desired.x, desired.z);
      desired.y = Math.max(desired.y, g + 70);
    }

    // --- critically-damped spring toward the formation slot ---
    const k = 1 - Math.exp(-3.4 * dt);
    anchor.lerp(desired, k);

    // --- our OWN flight velocity (from the spring path; excludes the bob
    // and sway that are added to root later, so it is pure translation) ---
    tmp.copy(anchor).sub(lastAnchor).divideScalar(Math.max(dt, 1e-4));
    droneVel.lerp(tmp, 1 - Math.exp(-8 * dt));
    lastAnchor.copy(anchor);
    const flyX = droneVel.x;
    const flyZ = droneVel.z;
    const flySpeed = Math.hypot(flyX, flyZ);

    // --- hover bob + idle sway ---
    swayPhase += dt * (idleTime > 5 ? 0.9 : 2.1);
    const bob = Math.sin(swayPhase) * 2.8 + Math.sin(swayPhase * 1.73) * 1.2;
    root.position.copy(anchor);
    root.position.y += bob;
    if (idleTime > 5) {
      // gentle "scanning" sway while the player stands still
      root.position.x += Math.sin(swayPhase * 0.6) * 4;
    }

    // --- orientation: face our OWN flight direction, never the player's
    // yaw. Turning the player (A/D) swings the formation slot and BUZZ
    // flies over to it, but the drone only yaws while it is actually
    // moving — a hovering drone holds its heading exactly like a real
    // quadcopter instead of spinning with every player turn.
    let yawRate = 0;
    if (flySpeed > 60) {
      // heading from velocity: forward = (sin yaw, cos yaw)
      const desiredYaw = Math.atan2(flyX, flyZ);
      let dyaw = desiredYaw - yawSm;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const step = dyaw * (1 - Math.exp(-4.5 * dt));
      yawSm += step;
      yawRate = dt > 1e-4 ? step / dt : 0; // signed rad/s (+ = arcing left)
    } else if (ctx?.combatTarget) {
      // PARKED COMBAT PIVOT: with no flight motion, slew in place to face
      // the designated target (measured from the anchor — the pure
      // translation point, excluding bob/sway). The hover slot itself
      // never moves: the drone spins on its own axis like a real gunship
      // holding position, instead of waiting for the next flight to face
      // the right way.
      const wantYaw = Math.atan2(
        ctx.combatTarget.x - anchor.x,
        ctx.combatTarget.z - anchor.z
      );
      let dyaw = wantYaw - yawSm;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const step = dyaw * (1 - Math.exp(-2.6 * dt));
      yawSm += step;
      yawRate = dt > 1e-4 ? step / dt : 0;
    }
    yawRateSm += (yawRate - yawRateSm) * (1 - Math.exp(-6 * dt));
    root.rotation.y = yawSm + (idleTime > 5 ? Math.sin(swayPhase * 0.5) * 0.14 : 0);
    // banking comes from the drone's own motion in its own yaw frame:
    //   forward = (sinY, cosY); right = (-cosY, sinY).
    // Positive rotation.x dips the nose (quads pitch nose-down to travel);
    // positive rotation.z dips the -X (right) skid — sliding right leans
    // right and arcing left banks left (dips the +X/left skid).
    const fwdX = Math.sin(yawSm);
    const fwdZ = Math.cos(yawSm);
    const vAlong = flyX * fwdX + flyZ * fwdZ;
    const vSide = -flyX * fwdZ + flyZ * fwdX;
    const bankEase = 1 - Math.exp(-4.5 * dt);
    pitchSm += (THREE.MathUtils.clamp(vAlong * 0.00085, -0.32, 0.32) - pitchSm) *
      bankEase;
    rollSm += (THREE.MathUtils.clamp(
      vSide * 0.0011 - yawRateSm * 0.55, -0.38, 0.38
    ) - rollSm) * bankEase;
    root.rotation.x = pitchSm + launchKick * 0.16;
    root.rotation.z = rollSm;

    // --- rotors: RPM + blur discs ---
    const spinTarget = 24 + speedF * 72;
    spin += (spinTarget - spin) * (1 - Math.exp(-2.5 * dt));
    for (const p of props) {
      p.pivot.rotation.y += spin * p.dir * dt;
      if (p.blur) {
        (p.blur.material as THREE.MeshBasicMaterial).opacity =
          THREE.MathUtils.smoothstep(spin, 34, 72) * 0.16;
      }
    }

    // --- lights: strobes, beacon, ring, REC, headlights ---
    const t = performance.now() / 1000;
    // white double-flash every 1.4 s
    const ph = t % 1.4;
    const strobeOn = ph < 0.06 || (ph > 0.16 && ph < 0.22);
    strobeMat.color.setHex(strobeOn ? 0xffffff : 0x2a2d33);
    // 1 Hz antenna beacon
    beaconMat.color.setHex(
      t % 1 < 0.5
        ? hostile
          ? 0xff2222
          : 0xffb020
        : hostile
          ? 0x501010
          : 0x5a4010
    );
    // REC dot blinks 2 Hz
    recMat.color.setHex(t % 0.5 < 0.25 ? 0xff2222 : 0x551111);
    // teal ring pulse (brighter at night) — hostile airframes pulse red
    const nRaw = ctx?.night ?? 0;
    nightSm += (nRaw - nightSm) * (1 - Math.exp(-2 * dt));
    ringMat.color.setHex(ringBaseHex).multiplyScalar(
      0.75 + 0.3 * Math.sin(t * 2.6) + nightSm * 0.6
    );
    headlight.intensity = nightSm * (low ? 1.6 : 2.6);

    // --- gimbal: look down while hovering, level off when moving, pan idle ---
    const gimbalTarget = -0.28 + alongside * 0.22;
    gimbal.rotation.x += (gimbalTarget - gimbal.rotation.x) *
      (1 - Math.exp(-3.5 * dt));
    gimbal.rotation.y = idleTime > 4 ? Math.sin(t * 0.7) * 0.35 : 0;

    // --- combat per-frame: turret tracking, flash/recoil envelopes, reloads
    const onTarget = t - lastOrderAt < 2.5;
    if (onTarget) {
      // swing the chin turret onto the last ordered world point (in the
      // drone's LOCAL frame, so body heading never matters)
      aimLocal.copy(lastAim);
      root.worldToLocal(aimLocal);
      const dx = aimLocal.x - 6.2;
      const dy = aimLocal.y + 1.2;
      const dz = aimLocal.z - 12.5;
      const wantYaw = THREE.MathUtils.clamp(Math.atan2(dx, dz), -1.15, 1.15);
      const wantPitch = THREE.MathUtils.clamp(
        Math.atan2(-dy, Math.hypot(dx, dz)),
        -0.35,
        1.35
      );
      const tEase = 1 - Math.exp(-7 * dt);
      turretYaw += (wantYaw - turretYaw) * tEase;
      turretPitch += (wantPitch - turretPitch) * tEase;
    } else {
      const tEase = 1 - Math.exp(-3 * dt);
      turretYaw += (0 - turretYaw) * tEase;
      turretPitch += (0 - turretPitch) * tEase;
    }
    turret.rotation.y = turretYaw;
    turret.rotation.x = turretPitch;
    flashT = Math.max(0, flashT - dt * 14);
    flashMat.opacity = flashT * 0.9;
    flash.scale.setScalar(0.7 + flashT * 0.9);
    flash.scale.z = (0.7 + flashT * 0.9) * 1.6;
    flashLight.intensity = flashT * 22;
    turretKick = Math.max(0, turretKick - dt * 9);
    turret.position.z = 12.5 - turretKick * 1.8;
    launchKick = Math.max(0, launchKick - dt * 2.6);
    for (const m of missiles) {
      if (!m.loaded && t >= m.reloadAt) {
        m.loaded = true;
        m.group.visible = true;
      }
    }

    // --- audio: subtle hum, gain follows speed + mute ---
    ensureHum();
    if (audioCtx && humGain) {
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => undefined);
      }
      const targetGain = muted ? 0 : 0.028 + speedF * 0.03;
      humGain.gain.value += (targetGain - humGain.gain.value) *
        (1 - Math.exp(-2 * dt));
    }
  }

  /* ----- stats + disposal ----- */
  let triangles = 0;
  let meshCount = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshCount++;
      const g = m.geometry as THREE.BufferGeometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });

  function dispose(): void {
    offMute();
    bladeGeo.dispose();
    spinnerGeo.dispose();
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
    scene.remove(root);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat.dispose();
      }
    });
    carbonTex.dispose();
    panelTex.dispose();
    hazardTex.dispose();
    podTex.dispose();
  }

  return {
    group: root,
    update,
    fireGun,
    launchMissile,
    missilesLoaded,
    resupply,
    velocity: () => droneVel.clone(),
    dispose,
    stats: { meshes: meshCount, triangles: Math.round(triangles) },
  };
}
