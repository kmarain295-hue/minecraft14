/**
 * Realistic bullets + gun VFX for RATFIRE.
 *
 * Fired from the active weapon's muzzle (page.tsx computes the nozzle world
 * position). One call to fireFrom() spawns the whole shot package:
 *
 *   - BULLET: a pooled FMJ round built from a LatheGeometry profile (brass
 *     cartridge -> cannelure groove -> copper-jacket ogive nose) wrapped in a
 *     procedural canvas texture (metal bands + shading). Flies with a slight
 *     gravity drop, dies on terrain contact or range expiry.
 *   - TRACER: two crossed additive gradient planes riding the bullet (a "+"
 *     cross-section reads as a glowing streak from ANY viewing angle, no
 *     per-frame billboarding needed).
 *   - MUZZLE FLASH: additive star-burst quads that pop, spin and fade in
 *     ~90 ms, camera-facing.
 *   - SPARKS: one THREE.Points pool; particles eject in a cone, fall under
 *     gravity and fade to black (additive black = invisible, so no per-
 *     particle alpha attribute is needed).
 *   - SMOKE: pooled sprites that rise, drift, expand and fade.
 *   - ROCKET BOMB (fireRocket): a big finned rocket launched from the same
 *     muzzle (page.tsx binds it to the F key) — heavy flame + smoke exhaust
 *     trail with a glowing tail light, then a full impact package: layered
 *     fireballs, an expanding ground shockwave ring, a 40-spark shower, a
 *     lingering smoke column and an orange light pop (+ onBoom() audio hook).
 *
 * LOW_SPEC (phones) runs smaller pools + fewer particles per shot. A slowmo
 * factor (setSlowmo) exists purely so tools/screenshots can freeze a shot
 * mid-flight; gameplay always runs at 1.
 */

import * as THREE from 'three';

/* ------------------------------- tuning ---------------------------------- */
const BULLET_SPEED = 1500; // world units / s (~15 m/s at this world scale:
                           // fast enough to feel like a gun, slow enough to SEE)
const BULLET_GRAVITY = 260; // gentle drop over long shots
const BULLET_LIFE = 1.5; // s before range expiry
const WORLD_LIMIT = 6300; // beyond the terrain edge -> recycle

const BULLET_POOL = 10;
const BULLET_POOL_LOW = 6;
const BULLET_SCALE = 2.4; // chunky FMJ round (was 1.0)

const TRACER_W = 3.4; // doubled so the streak reads from any angle
const TRACER_L = 34;
const TRACER_OPACITY = 0.9;

const FLASH_PER_SHOT = 3;
const FLASH_PER_SHOT_LOW = 2;
const FLASH_POOL = 4;
const FLASH_SIZE = 46; // was 30 — now fully visible
const FLASH_LIFE = 0.13;

const SPARKS_PER_SHOT = 24;
const SPARKS_PER_SHOT_LOW = 12;
const SPARKS_PER_IMPACT = 14;
const SPARKS_PER_IMPACT_LOW = 6;
const SPARK_POOL = 220;
const SPARK_POOL_LOW = 90;
const SPARK_SIZE = 8;
const SPARK_SPEED_MIN = 240;
const SPARK_SPEED_MAX = 560;
const SPARK_SPREAD = 0.5; // rad of cone around the fire axis
const SPARK_GRAVITY = 1000;
const SPARK_LIFE_MIN = 0.3;
const SPARK_LIFE_MAX = 0.65;

const SMOKE_PER_SHOT = 6;
const SMOKE_PER_SHOT_LOW = 3;
const SMOKE_PER_IMPACT = 2;
const SMOKE_POOL = 56;
const SMOKE_POOL_LOW = 22;
const SMOKE_LIFE = 1.25;
const SMOKE_SCALE_START = 12;
const SMOKE_SCALE_GROW = 24;
const SMOKE_RISE = 30;
const SMOKE_OPACITY = 0.55;

/* --- rocket bomb (F key) --- */
const ROCKET_SPEED = 430; // world units / s — slow enough to watch it fly
const ROCKET_LIFE = 4; // s before a mid-air self-detonation
const ROCKET_POOL = 6; // homing duels share the pool (BUZZ + enemies)
const ROCKET_POOL_LOW = 3;
const ROCKET_TRAIL_RATE = 16; // exhaust puffs per second (LOW_SPEC: 8)
const ROCKET_TRAIL_SPARKS = 3; // sparks per emission
const ROCKET_SCALE = 1.8; // hulking silhouette, readable from far away
/* --- proportional navigation (homing rockets) --- */
const PN_GAIN = 3.5; // classic N — recommended 3..5 for dyships
const ROCKET_MAX_LAT = 300; // u/s² lateral accel clamp (turn performance)
const ROCKET_FUSE = 34; // air-burst range from the tracked point
const BULLET_AIR_GRACE = 0.08; // s before a round can hit air combatants
const ROCKET_AIR_GRACE = 0.16; // s before a rocket can hit air combatants

const FIREBALLS_PER_BLAST = 3; // staggered layers: core / bloom / afterglow
const FIREBALL_POOL = 6;
const FIREBALL_POOL_LOW = 3;
const FIREBALL_SIZE = 90; // base quad scale
const FIREBALL_LIFE = 0.5;

const RING_POOL = 4;
const RING_POOL_LOW = 2;
const RING_LIFE = 0.55;
const RING_SIZE = 150; // final shockwave diameter

const BLAST_SPARKS = 42;
const BLAST_SMOKE_NOW = 6; // column puffs spawned at detonation
const BLAST_SMOKE_LATE = 5; // …plus these trickling after (0.45s)
const BLAST_LIGHT = 140;
const BLAST_LIGHT_LIFE = 0.55;

/* --------------------------- procedural textures ------------------------- */

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** FMJ round jacket: brass cartridge base -> dark cannelure -> copper nose.
 *  v=0 (image bottom) is the bullet base, v=1 (top) is the tip. */
function bulletJacketTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    // vertical metal gradient (bottom brass -> top copper)
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0.0, '#6e4a1c'); // case rim shadow
    grad.addColorStop(0.08, '#c9a24a'); // brass rim shine
    grad.addColorStop(0.3, '#e8c469'); // brass body highlight
    grad.addColorStop(0.52, '#b98f3e'); // brass lower mid
    grad.addColorStop(0.56, '#2e2318'); // cannelure groove (dark ring)
    grad.addColorStop(0.62, '#c98544'); // copper jacket start
    grad.addColorStop(0.8, '#e8a25f'); // copper highlight
    grad.addColorStop(1.0, '#8f4f22'); // nose tip shading
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    // horizontal machining streaks (u axis = around the bullet)
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < 42; i++) {
      const y = Math.random() * 128;
      const w = 20 + Math.random() * 90;
      ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
      ctx.fillRect(Math.random() * (128 - w), y, w, 1);
    }
    ctx.globalAlpha = 1;
    // primer circle on the base
    const primer = ctx.createRadialGradient(64, 124, 2, 64, 124, 12);
    primer.addColorStop(0, '#f4e6c0');
    primer.addColorStop(1, 'rgba(244,230,192,0)');
    ctx.fillStyle = primer;
    ctx.fillRect(0, 110, 128, 18);
  });
}

/** Tracer streak: bright at the bullet end (v=1) fading down the tail. */
function tracerTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 128, (ctx) => {
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0.0, 'rgba(255,240,190,0)');
    grad.addColorStop(0.55, 'rgba(255,210,120,0.55)');
    grad.addColorStop(0.88, 'rgba(255,236,180,1)');
    grad.addColorStop(1.0, 'rgba(255,255,230,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 128);
    // soften across the width
    const side = ctx.createLinearGradient(0, 0, 32, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)');
    side.addColorStop(0.5, 'rgba(0,0,0,0)');
    side.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, 32, 128);
  });
}

/** Muzzle flash: hot core + random tapered spikes. */
function flashTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    ctx.translate(64, 64);
    // spikes first (behind the core)
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      const len = 34 + Math.random() * 26;
      const w = 4 + Math.random() * 5;
      ctx.rotate(angle);
      const spike = ctx.createLinearGradient(0, 0, len, 0);
      spike.addColorStop(0, 'rgba(255,220,120,0.95)');
      spike.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = spike;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-angle);
    }
    // hot core
    const core = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
    core.addColorStop(0, 'rgba(255,255,235,1)');
    core.addColorStop(0.35, 'rgba(255,214,110,0.9)');
    core.addColorStop(0.7, 'rgba(255,130,30,0.45)');
    core.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Soft grey smoke puff. */
function smokeTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    grad.addColorStop(0, 'rgba(210,206,198,0.55)');
    grad.addColorStop(0.55, 'rgba(190,188,182,0.28)');
    grad.addColorStop(1, 'rgba(180,180,178,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    // break up the perfect circle a little
    for (let i = 0; i < 10; i++) {
      const x = 30 + Math.random() * 68;
      const y = 30 + Math.random() * 68;
      const r = 10 + Math.random() * 22;
      const puff = ctx.createRadialGradient(x, y, 1, x, y, r);
      puff.addColorStop(0, 'rgba(215,212,205,0.20)');
      puff.addColorStop(1, 'rgba(215,212,205,0)');
      ctx.fillStyle = puff;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

/** Soft dot for spark points. */
function sparkTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 32, (ctx) => {
    const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
  });
}

/** Explosion fireball: white-hot core -> yellow -> orange -> deep red smoke
 *  edge, with a few darker roiling blotches so it doesn't read as a ball. */
function fireballTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const grad = ctx.createRadialGradient(64, 64, 3, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,240,1)');
    grad.addColorStop(0.28, 'rgba(255,214,110,0.95)');
    grad.addColorStop(0.55, 'rgba(255,128,32,0.75)');
    grad.addColorStop(0.8, 'rgba(190,60,16,0.38)');
    grad.addColorStop(1, 'rgba(90,30,10,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    // roiling blotches (destination-out bites the edges unevenly)
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 26 + Math.random() * 30;
      const x = 64 + Math.cos(a) * r;
      const y = 64 + Math.sin(a) * r;
      const br = 8 + Math.random() * 14;
      const bite = ctx.createRadialGradient(x, y, 1, x, y, br);
      bite.addColorStop(0, 'rgba(0,0,0,0.5)');
      bite.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = bite;
      ctx.fillRect(x - br, y - br, br * 2, br * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  });
}

/** Ground shockwave ring: a soft annulus, bright on the inner edge. */
function ringTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const grad = ctx.createRadialGradient(64, 64, 30, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,235,190,0)');
    grad.addColorStop(0.45, 'rgba(255,235,190,0.85)');
    grad.addColorStop(0.75, 'rgba(255,170,70,0.35)');
    grad.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/* ------------------------------ geometry --------------------------------- */

/** FMJ bullet profile (lathe, radius/y before the rotateX to +Z). */
function bulletGeometry(): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0), // flat base centre
    new THREE.Vector2(1.3, 0.0), // base rim
    new THREE.Vector2(1.3, 0.4),
    new THREE.Vector2(1.16, 3.2), // cartridge body taper
    new THREE.Vector2(1.16, 3.5), // case mouth
    new THREE.Vector2(1.28, 3.75), // jacket seat ring
    new THREE.Vector2(1.08, 4.1), // nose start
  ];
  // ogive curve to the tip
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(1.08 * (1 - Math.pow(t, 1.6)), 4.1 + 2.1 * t));
  }
  const geo = new THREE.LatheGeometry(pts, 14);
  geo.rotateX(Math.PI / 2); // tip now points +Z (flight axis)
  return geo;
}

function tracerGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(TRACER_W, TRACER_L);
  geo.rotateX(Math.PI / 2); // lies along Z, bright end (v=1) at +Z
  geo.translate(0, 0, -TRACER_L / 2 + 0.6); // front edge at the bullet tail
  return geo;
}

/* ----- rocket bomb parts (built once, shared by the pool) ----- */

function rocketBodyGeometry(): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(2.3, 2.5, 9.5, 14);
  geo.rotateX(Math.PI / 2); // long axis -> +Z (flight direction)
  return geo;
}

function rocketNoseGeometry(): THREE.ConeGeometry {
  const geo = new THREE.ConeGeometry(2.3, 5.2, 14);
  geo.rotateX(Math.PI / 2); // tip -> +Z
  geo.translate(0, 0, 7.3); // sit on the body's front end
  return geo;
}

function rocketFinGeometry(): THREE.BoxGeometry {
  // thin plate: x = thickness, y = radial span, z = chord along the body
  const geo = new THREE.BoxGeometry(0.5, 6.4, 3.4);
  geo.translate(0, 5.2, -4.4); // stick out +Y from the tail
  return geo;
}

/* ------------------------------- types ----------------------------------- */

interface FlyingBullet {
  group: THREE.Group;
  vel: THREE.Vector3;
  life: number;
  /** seconds since launch — air-hit checks skip the launch grace so a
   *  round never collides with the airframe it was fired FROM (muzzles
   *  sit well inside every combatant's hit sphere). */
  age: number;
  active: boolean;
  /** ENEMY-side round: skips the ground-target capsules entirely (the
   *  shooters ARE the ground targets) and only bites air combatants
   *  (BUZZ's hull, the player's body) or terrain. */
  hostile: boolean;
}

/** Live target a homing rocket chases. `getPos()` returning null (target
 *  died / despawned) releases the guidance — the rocket flies straight
 *  and detonates on terrain or at life expiry like any other. */
export interface RocketTracker {
  getPos(): THREE.Vector3 | null;
  /** Optional target velocity — sharpens true proportional navigation. */
  getVel?(): THREE.Vector3 | null;
}

/** Which air combatant a round/rocket connected with (page routes the
 *  damage: enemy drones take it, BUZZ loses hull, the player bleeds). */
export interface AirHitInfo {
  kind: 'enemy' | 'pet' | 'player';
  id: number;
}

interface FlyingRocket {
  group: THREE.Group;
  glow: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  trailAcc: number;
  active: boolean;
  tracker: RocketTracker | null;
  /** seconds since launch — see FlyingBullet.age (rockets need longer:
   *  the pods sit ~50u from the airframe center at 430 u/s). */
  age: number;
}

interface FireballQuad {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
  s0: number;
  grow: number;
  active: boolean;
}

interface RingQuad {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  age: number;
  active: boolean;
}

/** Smoke puffs queued to trickle out of a blast over ~0.45s. */
interface DelayedPuff {
  pos: THREE.Vector3;
  scale: number;
  t: number;
}

interface FlashQuad {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  spin: number;
  age: number;
  active: boolean;
}

interface SmokePuff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  rise: number;
  drift: THREE.Vector3;
  spin: number;
  active: boolean;
}

export interface BulletSystem {
  /** Spawn a full shot package (bullet + tracer + flash + sparks + smoke).
   *  `hostile: true` flies the round for the ENEMY side — it skips the
   *  ground-target capsules and only chews air combatants + terrain. */
  fireFrom(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    fireOpts?: { hostile?: boolean }
  ): void;
  /** Missile-approach tripwire for the enemy AI: slant distance of the
   *  nearest ACTIVE rocket heading roughly toward `p` within maxDist,
   *  or -1 when nothing is inbound. */
  rocketThreatNear(p: THREE.Vector3, maxDist: number): number;
  /** Launch a big rocket bomb from the muzzle (page binds it to F).
   *  Flies straight with a flame+smoke trail; detonates on any impact. */
  fireRocket(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Launch a HOMING rocket: proportional-navigation guidance onto a
   *  live tracker, air fuse, flame trail — same detonation package. */
  fireHomingRocket(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    tracker: RocketTracker
  ): void;
  /** Advance rockets, bullets + every VFX pool. Call once per frame. */
  update(dt: number, camera: THREE.Camera): void;
  /** Verification helper: <1 slows bullets AND rockets down. */
  setSlowmo(factor: number): void;
  /** Verification helper: air-burst the first active rocket right now. */
  detonate(): boolean;
  /** Standalone detonation package (fireball + ring + sparks + boom +
   *  blast reports) — used for drone kills with no rocket involved. */
  explodeAt(p: THREE.Vector3): void;
  stats(): {
    flying: number;
    rockets: number;
    sparks: number;
    smoke: number;
    flashes: number;
  };
  dispose(): void;
}

/* ------------------------------- system ---------------------------------- */

export function createBulletSystem(
  scene: THREE.Scene,
  opts: {
    lowSpec?: boolean;
    heightAt?: (x: number, z: number) => number;
    /** Is a world point inside solid geometry (dungeon cave pieces)? —
     *  rounds and rockets detonate on it just like on terrain. */
    solidAt?: (x: number, y: number, z: number) => boolean;
    /** Ground height for effect seating that also knows about solid
     *  geometry above the terrain (a ruin's floor under an explosion). */
    surfaceAt?: (x: number, z: number, nearY: number) => number;
    /** Rocket detonation hook — page routes it into the audio manager. */
    onBoom?: () => void;
    /** Alive-target capsule test: a point inside any live target's body.
     *  Rounds die there (spark package) and rockets detonate on it. */
    hitTargetAt?: (p: THREE.Vector3) => boolean;
    /** A round connected with a target ('bullet') or a rocket detonated
     *  ('blast' — every detonation, so near-misses splash too). The page
     *  routes this into the target-dummy damage system. */
    onHitTarget?: (p: THREE.Vector3, kind: 'bullet' | 'blast') => void;
    /** AIR COMBAT: is a world point inside any flying combatant (enemy
     *  drones, BUZZ, the player's body)? Rounds die on them with sparks
     *  and homing rockets air-burst, reporting through onAirHit. */
    airHitTest?: (p: THREE.Vector3) => AirHitInfo | null;
    /** A round connected with a flying combatant ('bullet'). Blasts reach
     *  air units through onAirBlast (fired on EVERY detonation). */
    onAirHit?: (info: AirHitInfo, p: THREE.Vector3, kind: 'bullet') => void;
    /** Every explosion position — page applies drone splash damage. */
    onAirBlast?: (p: THREE.Vector3) => void;
  } = {}
): BulletSystem {
  const low = opts.lowSpec === true;
  const heightAt = opts.heightAt ?? (() => 0);
  const solidAt = opts.solidAt;
  const surfaceAt = opts.surfaceAt;
  const onBoom = opts.onBoom ?? (() => {});
  const hitTargetAt = opts.hitTargetAt;
  const onHitTarget = opts.onHitTarget;
  const airHitTest = opts.airHitTest;
  const onAirHit = opts.onAirHit;
  const onAirBlast = opts.onAirBlast;

  const bulletTex = bulletJacketTexture();
  const tracerTex = tracerTexture();
  const flashTex = flashTexture();
  const smokeTex = smokeTexture();
  const sparkTex = sparkTexture();
  const fireballTex = fireballTexture();
  const ringTex = ringTexture();

  /* ----- bullets ----- */
  const bulletGeo = bulletGeometry();
  const tracerGeo = tracerGeometry();
  const tracerMat = new THREE.MeshBasicMaterial({
    map: tracerTex,
    transparent: true,
    opacity: TRACER_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const bulletMat = new THREE.MeshStandardMaterial({
    map: bulletTex,
    metalness: 0.85,
    roughness: 0.3,
    emissive: new THREE.Color(0x38200a),
    emissiveIntensity: 0.55,
  });

  const bulletPoolSize = low ? BULLET_POOL_LOW : BULLET_POOL;
  const bullets: FlyingBullet[] = [];
  for (let i = 0; i < bulletPoolSize; i++) {
    const group = new THREE.Group();
    const round = new THREE.Mesh(bulletGeo, bulletMat);
    round.scale.setScalar(BULLET_SCALE); // chunky round
    round.frustumCulled = false;
    group.add(round);
    for (const spin of [0, Math.PI / 2]) {
      const tracer = new THREE.Mesh(tracerGeo, tracerMat);
      tracer.rotation.z = spin;
      tracer.frustumCulled = false;
      group.add(tracer);
    }
    group.visible = false;
    scene.add(group);
    bullets.push({
      group,
      vel: new THREE.Vector3(),
      life: 0,
      age: 0,
      active: false,
      hostile: false,
    });
  }
  let bulletCursor = 0;

  /* ----- muzzle flashes ----- */
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  const flashPoolSize = Math.max(FLASH_POOL, low ? 2 : FLASH_POOL);
  const flashes: FlashQuad[] = [];
  for (let i = 0; i < flashPoolSize; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: flashTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(flashGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    flashes.push({ mesh, spin: 0, age: 0, active: false });
  }
  let flashCursor = 0;

  /* ----- rocket bombs (F key) ----- */
  const rocketBodyGeo = rocketBodyGeometry();
  const rocketNoseGeo = rocketNoseGeometry();
  const rocketFinGeo = rocketFinGeometry();
  const rocketBodyMat = new THREE.MeshStandardMaterial({
    color: 0x5a5f66,
    metalness: 0.75,
    roughness: 0.35,
  });
  const rocketNoseMat = new THREE.MeshStandardMaterial({
    color: 0xb3241c,
    metalness: 0.35,
    roughness: 0.45,
    emissive: new THREE.Color(0x3a0603),
    emissiveIntensity: 0.6,
  });
  const rocketFinMat = new THREE.MeshStandardMaterial({
    color: 0x7a1f18,
    metalness: 0.5,
    roughness: 0.5,
  });
  const rocketGlowMat = new THREE.SpriteMaterial({
    map: sparkTex,
    color: 0xffa040,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const rocketPoolSize = low ? ROCKET_POOL_LOW : ROCKET_POOL;
  const rockets: FlyingRocket[] = [];
  for (let i = 0; i < rocketPoolSize; i++) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(rocketBodyGeo, rocketBodyMat);
    const nose = new THREE.Mesh(rocketNoseGeo, rocketNoseMat);
    group.add(body, nose);
    for (let f = 0; f < 4; f++) {
      const fin = new THREE.Mesh(rocketFinGeo, rocketFinMat);
      fin.rotation.z = f * (Math.PI / 2) + Math.PI / 4;
      group.add(fin);
    }
    const glow = new THREE.Sprite(rocketGlowMat.clone());
    glow.position.set(0, 0, -6.2); // exhaust at the tail
    glow.scale.setScalar(1);
    group.add(glow);
    group.scale.setScalar(ROCKET_SCALE); // hulking silhouette
    group.visible = false;
    scene.add(group);
    rockets.push({
      group,
      glow,
      vel: new THREE.Vector3(),
      life: 0,
      trailAcc: 0,
      active: false,
      tracker: null,
      age: 0,
    });
  }

  // ONE shared tail light that jumps to the newest rocket (cheap + reads well)
  const rocketLight = new THREE.PointLight(0xff9a40, 0, 1300, 2);
  scene.add(rocketLight);

  /* ----- explosion fireballs (additive billboard layers) ----- */
  const fireballGeo = new THREE.PlaneGeometry(1, 1);
  const fireballPoolSize = low ? FIREBALL_POOL_LOW : FIREBALL_POOL;
  const fireballs: FireballQuad[] = [];
  for (let i = 0; i < fireballPoolSize; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: fireballTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(fireballGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    fireballs.push({ mesh, age: 0, life: FIREBALL_LIFE, s0: 1, grow: 1, active: false });
  }
  let fireballCursor = 0;

  /* ----- ground shockwave rings ----- */
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  ringGeo.rotateX(-Math.PI / 2); // lie flat on the ground
  const ringPoolSize = low ? RING_POOL_LOW : RING_POOL;
  const rings: RingQuad[] = [];
  for (let i = 0; i < ringPoolSize; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: ringTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    rings.push({ mesh, age: 0, active: false });
  }

  // orange blast light: pops at detonation, decays over ~0.55s
  const blastLight = new THREE.PointLight(0xff8a3c, 0, 2600, 1.8);
  scene.add(blastLight);
  let blastLightAge = BLAST_LIGHT_LIFE + 1;

  // smoke column puffs that trickle out after the detonation
  const delayedPuffs: DelayedPuff[] = [];

  /* ----- sparks (single Points pool) ----- */
  const sparkMax = low ? SPARK_POOL_LOW : SPARK_POOL;
  const sparkPos = new Float32Array(sparkMax * 3);
  const sparkCol = new Float32Array(sparkMax * 3);
  const sparkVel = new Float32Array(sparkMax * 3);
  const sparkLife = new Float32Array(sparkMax);
  const sparkMaxLife = new Float32Array(sparkMax);
  for (let i = 0; i < sparkMax; i++) {
    sparkPos[i * 3 + 1] = -1e5; // parked underground
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({
    size: SPARK_SIZE,
    map: sparkTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
    fog: false,
  });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.renderOrder = 5;
  scene.add(sparkPoints);
  let sparkCursor = 0;

  function sparkBurst(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    speedScale = 1
  ) {
    for (let n = 0; n < count; n++) {
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % sparkMax;
      // cone around dir with tangential scatter
      const speed =
        (SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN)) *
        speedScale;
      const px = (Math.random() - 0.5) * 2 * SPARK_SPREAD;
      const py = (Math.random() - 0.5) * 2 * SPARK_SPREAD;
      const vel = new THREE.Vector3(
        dir.x + px,
        dir.y + py + 0.18, // slight upward bias -> arcs read better
        dir.z + (Math.random() - 0.5) * 2 * SPARK_SPREAD
      )
        .normalize()
        .multiplyScalar(speed);
      sparkPos[i * 3] = origin.x;
      sparkPos[i * 3 + 1] = origin.y;
      sparkPos[i * 3 + 2] = origin.z;
      sparkVel[i * 3] = vel.x;
      sparkVel[i * 3 + 1] = vel.y;
      sparkVel[i * 3 + 2] = vel.z;
      const life = SPARK_LIFE_MIN + Math.random() * (SPARK_LIFE_MAX - SPARK_LIFE_MIN);
      sparkLife[i] = life;
      sparkMaxLife[i] = life;
      // hot white-yellow -> orange mix
      const hot = Math.random();
      sparkCol[i * 3] = 1.0;
      sparkCol[i * 3 + 1] = 0.75 + hot * 0.25;
      sparkCol[i * 3 + 2] = 0.25 + hot * 0.45;
    }
  }

  /* ----- smoke sprites ----- */
  const smokePoolSize = low ? SMOKE_POOL_LOW : SMOKE_POOL;
  const smokeBaseMat = new THREE.SpriteMaterial({
    map: smokeTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    color: new THREE.Color(0xcac6be),
  });
  const smoke: SmokePuff[] = [];
  for (let i = 0; i < smokePoolSize; i++) {
    const mat = smokeBaseMat.clone();
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    smoke.push({
      sprite,
      age: 0,
      life: SMOKE_LIFE,
      rise: SMOKE_RISE,
      drift: new THREE.Vector3(),
      spin: 0,
      active: false,
    });
  }
  let smokeCursor = 0;

  function smokePuff(origin: THREE.Vector3, scale: number) {
    const s = smoke[smokeCursor];
    smokeCursor = (smokeCursor + 1) % smokePoolSize;
    s.sprite.position.copy(origin);
    s.sprite.material.opacity = SMOKE_OPACITY;
    s.sprite.material.rotation = Math.random() * Math.PI * 2;
    s.sprite.scale.setScalar(SMOKE_SCALE_START * scale);
    s.age = 0;
    s.life = SMOKE_LIFE * (0.8 + Math.random() * 0.4);
    s.rise = SMOKE_RISE * (0.7 + Math.random() * 0.6);
    s.drift.set((Math.random() - 0.5) * 14, 0, (Math.random() - 0.5) * 14);
    s.spin = (Math.random() - 0.5) * 1.6;
    s.sprite.visible = true;
    s.active = true;
  }

  /* ----- shot package ----- */
  const tmpQuat = new THREE.Quaternion();
  const tmpDir = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  // PN scratch (homing guidance — zero allocation per frame)
  const pnRel = new THREE.Vector3();
  const pnRelVel = new THREE.Vector3();
  const pnLos = new THREE.Vector3();
  const pnDir = new THREE.Vector3();
  const pnA = new THREE.Vector3();
  const pnZero = new THREE.Vector3();
  const lastCamQuat = new THREE.Quaternion(); // refreshed every update()
  const FORWARD = new THREE.Vector3(0, 0, 1);

  function fireFrom(
    origin: THREE.Vector3,
    dirIn: THREE.Vector3,
    fireOpts?: { hostile?: boolean }
  ) {
    const dir = tmpDir.copy(dirIn).normalize();

    // bullet (+ tracer) from the pool — recycle the oldest if exhausted
    let b: FlyingBullet | null = null;
    for (const cand of bullets) {
      if (!cand.active) {
        b = cand;
        break;
      }
    }
    if (!b) {
      b = bullets[bulletCursor];
      bulletCursor = (bulletCursor + 1) % bullets.length;
    }
    b.group.position.copy(origin);
    b.vel.copy(dir).multiplyScalar(BULLET_SPEED);
    b.life = BULLET_LIFE;
    b.age = 0;
    b.active = true;
    b.hostile = fireOpts?.hostile === true;
    b.group.visible = true;
    tmpQuat.setFromUnitVectors(FORWARD, dir);
    b.group.quaternion.copy(tmpQuat);

    // muzzle flash quads
    const flashCount = low ? FLASH_PER_SHOT_LOW : FLASH_PER_SHOT;
    for (let n = 0; n < flashCount; n++) {
      const f = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % flashes.length;
      f.mesh.position.copy(origin).addScaledVector(dir, 4 + n * 6);
      f.mesh.scale.setScalar(FLASH_SIZE * (0.8 + Math.random() * 0.6));
      f.mesh.material.opacity = 1;
      f.spin = Math.random() * Math.PI * 2;
      f.age = 0;
      f.active = true;
      f.mesh.visible = true;
    }

    // fire + smoke
    sparkBurst(origin, dir, low ? SPARKS_PER_SHOT_LOW : SPARKS_PER_SHOT);
    const puffs = low ? SMOKE_PER_SHOT_LOW : SMOKE_PER_SHOT;
    for (let n = 0; n < puffs; n++) {
      smokePuff(
        new THREE.Vector3(
          origin.x - dir.x * 6 + (Math.random() - 0.5) * 4,
          origin.y + 2 + n * 2,
          origin.z - dir.z * 6 + (Math.random() - 0.5) * 4
        ),
        0.8 + Math.random() * 0.5
      );
    }
  }

  /* ----- rocket bomb launch (F key / drone pods / enemy drones) ----- */
  function launchRocket(
    origin: THREE.Vector3,
    dirIn: THREE.Vector3,
    tracker: RocketTracker | null
  ) {
    const dir = tmpDir.copy(dirIn).normalize();

    let r: FlyingRocket | null = null;
    for (const cand of rockets) {
      if (!cand.active) {
        r = cand;
        break;
      }
    }
    if (!r) {
      // recycle the oldest (pool is tiny; front of the array is fine)
      r = rockets[0];
    }
    r.group.position.copy(origin);
    r.vel.copy(dir).multiplyScalar(ROCKET_SPEED);
    r.life = ROCKET_LIFE;
    r.trailAcc = 0;
    r.active = true;
    r.tracker = tracker;
    r.age = 0;
    r.group.visible = true;
    tmpQuat.setFromUnitVectors(FORWARD, dir);
    r.group.quaternion.copy(tmpQuat);
    r.glow.material.opacity = 1;
    r.glow.scale.setScalar(13);

    // BIG launch package: oversized flash + fire sparks + a smoke shove
    const flashCount = low ? 2 : 3;
    for (let n = 0; n < flashCount; n++) {
      const f = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % flashes.length;
      f.mesh.position.copy(origin).addScaledVector(dir, 10 + n * 12);
      f.mesh.scale.setScalar(FLASH_SIZE * (2.2 + Math.random() * 1.0));
      f.mesh.material.opacity = 1;
      f.spin = Math.random() * Math.PI * 2;
      f.age = 0;
      f.active = true;
      f.mesh.visible = true;
    }
    sparkBurst(origin, dir, low ? 12 : 22, 1.2);
    for (let n = 0; n < (low ? 2 : 5); n++) {
      smokePuff(
        new THREE.Vector3(
          origin.x - dir.x * 12 + (Math.random() - 0.5) * 10,
          origin.y + (Math.random() - 0.5) * 8,
          origin.z - dir.z * 12 + (Math.random() - 0.5) * 10
        ),
        2.2 + Math.random() * 1.0
      );
    }
    rocketLight.position.copy(origin).addScaledVector(dir, -6);
    rocketLight.intensity = 34;
  }

  /** Straight ballistic rocket (player F key, manual drone orders). */
  function fireRocket(origin: THREE.Vector3, dirIn: THREE.Vector3) {
    launchRocket(origin, dirIn, null);
  }

  /** HOMING rocket: true proportional-navigation guidance onto a live
   *  tracker. The commanded lateral accel is N · Vc · (ω × v̂) clamped to
   *  the airframe's turn performance — the classic dyship law, so the
   *  rocket LEADS and CUTS corners instead of tail-chasing. */
  function fireHomingRocket(
    origin: THREE.Vector3,
    dirIn: THREE.Vector3,
    tracker: RocketTracker
  ) {
    launchRocket(origin, dirIn, tracker);
  }

  /** Nearest ACTIVE rocket whose velocity carries it roughly toward `p`
   *  within maxDist (slant) — the ground enemies' missile-approach
   *  tripwire. Returns the distance, or -1 when nothing is inbound. */
  function rocketThreatNear(p: THREE.Vector3, maxDist: number): number {
    let best = -1;
    for (const r of rockets) {
      if (!r.active) continue;
      tmpDir.copy(r.vel).normalize();
      tmpPos.copy(p).sub(r.group.position);
      const dist = tmpPos.length();
      if (dist > maxDist || dist < 1e-3) continue;
      if (tmpDir.dot(tmpPos.divideScalar(dist)) < 0.72) continue; // not inbound
      if (best < 0 || dist < best) best = dist;
    }
    return best;
  }

  /* ----- detonation package ----- */
  function spawnFireball(pos: THREE.Vector3, s0: number, life: number) {
    const f = fireballs[fireballCursor];
    fireballCursor = (fireballCursor + 1) % fireballs.length;
    f.mesh.position.copy(pos);
    f.mesh.quaternion.copy(lastCamQuat);
    f.mesh.scale.setScalar(s0 * 0.55);
    f.mesh.material.opacity = 1;
    f.s0 = s0;
    f.grow = s0 * 1.9;
    f.age = 0;
    f.life = life;
    f.active = true;
    f.mesh.visible = true;
  }

  function spawnRing(pos: THREE.Vector3) {
    const r = rings.find((c) => !c.active) ?? rings[0];
    // seat the ring on solid geometry when known (a ruin's floor inside a
    // dungeon), falling back to the bare terrain height
    const ringGround = surfaceAt
      ? surfaceAt(pos.x, pos.z, pos.y)
      : heightAt(pos.x, pos.z);
    r.mesh.position.set(pos.x, ringGround + 1.6, pos.z);
    r.mesh.scale.setScalar(14);
    r.mesh.material.opacity = 0.85;
    r.age = 0;
    r.active = true;
    r.mesh.visible = true;
  }

  const blastUp = new THREE.Vector3();

  function explodeAt(p: THREE.Vector3) {
    // layered fireballs: tight white core, wide bloom, slow afterglow
    if (!low) {
      spawnFireball(p, FIREBALL_SIZE * 0.55, FIREBALL_LIFE * 0.7);
      spawnFireball(p, FIREBALL_SIZE * 0.85, FIREBALL_LIFE * 0.9);
    }
    spawnFireball(p, FIREBALL_SIZE, FIREBALL_LIFE * 1.15);
    spawnRing(p);
    blastUp.set(0, 1, 0);
    sparkBurst(p, blastUp, low ? 18 : BLAST_SPARKS, 1.35);
    for (let n = 0; n < BLAST_SMOKE_NOW; n++) {
      smokePuff(
        new THREE.Vector3(
          p.x + (Math.random() - 0.5) * 26,
          p.y + 4 + Math.random() * 22,
          p.z + (Math.random() - 0.5) * 26
        ),
        2.2 + Math.random() * 1.3
      );
    }
    // trailing column: staggered puffs bubbling up for ~0.45s
    for (let n = 0; n < (low ? 2 : BLAST_SMOKE_LATE); n++) {
      delayedPuffs.push({
        pos: new THREE.Vector3(
          p.x + (Math.random() - 0.5) * 20,
          p.y + 8 + Math.random() * 26,
          p.z + (Math.random() - 0.5) * 20
        ),
        scale: 2.4 + Math.random() * 1.4,
        t: 0.08 + n * 0.09,
      });
    }
    blastLight.position.copy(p).addScaledVector(blastUp, 14);
    blastLight.intensity = BLAST_LIGHT;
    blastLightAge = 0;
    // every detonation reports a blast so splash damage can reach nearby
    // targets even when the rocket itself hit the dirt next to them
    if (onHitTarget) onHitTarget(p, 'blast');
    if (onAirBlast) onAirBlast(p);
    onBoom();
  }

  /* ----- per-frame update ----- */
  function update(dt: number, camera: THREE.Camera) {
    lastCamQuat.copy(camera.quaternion);
    // bullets (slowmo scales ONLY the round so screenshots can catch it)
    const bdt = dt * slowmo;
    for (const b of bullets) {
      if (!b.active) continue;
      b.vel.y -= BULLET_GRAVITY * bdt;
      b.group.position.addScaledVector(b.vel, bdt);
      b.life -= bdt;
      // orient the round + tracer along the current velocity
      tmpDir.copy(b.vel).normalize();
      tmpQuat.setFromUnitVectors(FORWARD, tmpDir);
      b.group.quaternion.copy(tmpQuat);

      const p = b.group.position;
      const ground = heightAt(p.x, p.z);
      const out =
        Math.abs(p.x) > WORLD_LIMIT || Math.abs(p.z) > WORLD_LIMIT;
      // solid cave pieces stop rounds mid-flight just like the ground —
      // sparks kick back toward the shooter either way
      const inCave = solidAt ? solidAt(p.x, p.y, p.z) : false;
      // live ground targets stop rounds too (body capsule test) —
      // hostile rounds fly OVER their own team and never bite them
      const hitTarget =
        hitTargetAt && !b.hostile ? hitTargetAt(p) : false;
      // AIR COMBAT: rounds chew into flying combatants (enemy drones,
      // BUZZ, the player) — the page routes the damage via onAirHit.
      // The launch grace keeps rounds from biting their own airframe.
      b.age += bdt;
      const airInfo =
        airHitTest && b.age > BULLET_AIR_GRACE ? airHitTest(p) : null;
      if (
        b.life <= 0 ||
        out ||
        inCave ||
        hitTarget ||
        airInfo ||
        (b.vel.y <= 0 && p.y <= ground + 1)
      ) {
        b.active = false;
        b.group.visible = false;
        if (!out) {
          // terrain impact: fire kicks BACK toward the shooter (+ up)
          tmpDir
            .set(-b.vel.x, 0, -b.vel.z)
            .normalize()
            .multiplyScalar(0.85);
          tmpDir.y = 0.75;
          tmpDir.normalize();
          sparkBurst(
            p,
            tmpDir,
            low ? SPARKS_PER_IMPACT_LOW : SPARKS_PER_IMPACT,
            0.55
          );
          smokePuff(p, 1.6);
          if (hitTarget && onHitTarget) onHitTarget(p, 'bullet');
          if (airInfo && onAirHit) onAirHit(airInfo, p, 'bullet');
        }
      }
    }

    // rockets: straight flight + roll, exhaust trail, detonation on contact
    for (const r of rockets) {
      if (!r.active) continue;
      r.life -= bdt;
      r.group.position.addScaledVector(r.vel, bdt);
      r.group.rotateZ(2.4 * bdt); // slow menacing roll
      // exhaust glow flickers like a burning engine
      const flick = 0.75 + Math.random() * 0.5;
      r.glow.scale.setScalar(15 + 8 * flick);
      r.glow.material.opacity = Math.min(1, 0.75 + flick * 0.25);
      // heavy flame + smoke trail behind the tail
      r.trailAcc += dt * (low ? ROCKET_TRAIL_RATE * 0.5 : ROCKET_TRAIL_RATE);
      while (r.trailAcc >= 1) {
        r.trailAcc -= 1;
        tmpDir.copy(r.vel).normalize();
        const tail = tmpPos.copy(r.group.position).addScaledVector(tmpDir, -13);
        smokePuff(
          new THREE.Vector3(
            tail.x + (Math.random() - 0.5) * 6,
            tail.y + (Math.random() - 0.5) * 6,
            tail.z + (Math.random() - 0.5) * 6
          ),
          1.7 + Math.random() * 0.8
        );
        tmpDir.negate(); // exhaust sparks kick backward
        sparkBurst(tail, tmpDir, low ? 1 : ROCKET_TRAIL_SPARKS, 0.35);
      }
      const rp = r.group.position;
      const rGround = heightAt(rp.x, rp.z);
      const rOut = Math.abs(rp.x) > WORLD_LIMIT || Math.abs(rp.z) > WORLD_LIMIT;
      if (rOut) {
        r.active = false;
        r.group.visible = false;
        continue;
      }
      // --- proportional-navigation guidance (homing rockets) ---
      if (r.tracker) {
        const tp = r.tracker.getPos();
        if (tp) {
          pnRel.copy(tp).sub(rp);
          const range = Math.max(pnRel.length(), 1e-3);
          pnRelVel.copy(r.tracker.getVel?.() ?? pnZero).sub(r.vel);
          // closing speed along the line of sight (+ = closing)
          const closing = -pnRel.dot(pnRelVel) / range;
          // LOS rotation rate ω = (r × v_rel) / |r|²  — then the classic
          // command a = N · Vc · (ω × v̂), clamped to the airframe
          pnLos.copy(pnRel).cross(pnRelVel).divideScalar(range * range);
          pnDir.copy(r.vel).normalize();
          pnA.copy(pnLos).cross(pnDir).multiplyScalar(
            PN_GAIN * Math.max(closing, 0) * ROCKET_SPEED
          );
          if (pnA.length() > ROCKET_MAX_LAT) pnA.setLength(ROCKET_MAX_LAT);
          r.vel.addScaledVector(pnA, bdt);
          r.vel.setLength(ROCKET_SPEED);
          // nose follows the (turning) velocity; keep the menacing roll
          tmpDir.copy(r.vel).normalize();
          tmpQuat.setFromUnitVectors(FORWARD, tmpDir);
          r.group.quaternion.copy(tmpQuat);
          r.group.rotateZ(2.4 * bdt);
          // air fuse: close enough to the tracked point -> detonate NOW
          if (range < ROCKET_FUSE) {
            r.active = false;
            r.group.visible = false;
            explodeAt(rp);
            continue;
          }
        } else {
          r.tracker = null; // target gone — fly straight, die normally
        }
      }
      // detonate on terrain contact, on any solid cave piece (walls,
      // columns, rubble), on a live ground target's body — or on a
      // flying combatant caught in the path (air intercept). Launch
      // grace keeps rockets from air-bursting on their own pod rack.
      r.age += bdt;
      const airHit =
        airHitTest && r.age > ROCKET_AIR_GRACE ? airHitTest(rp) : null;
      if (
        r.life <= 0 ||
        rp.y <= rGround + 2.5 ||
        (solidAt ? solidAt(rp.x, rp.y, rp.z) : false) ||
        (hitTargetAt ? hitTargetAt(rp) : false) ||
        airHit
      ) {
        r.active = false;
        r.group.visible = false;
        explodeAt(rp);
        if (airHit && onAirHit) onAirHit(airHit, rp, 'bullet');
      }
    }
    // ONE shared tail light jumps to the newest flying rocket
    const newestRocket = rockets.find((c) => c.active);
    if (newestRocket) {
      tmpDir.copy(newestRocket.vel).normalize();
      rocketLight.position
        .copy(newestRocket.group.position)
        .addScaledVector(tmpDir, -8);
      rocketLight.intensity = 26 + Math.random() * 14;
    } else {
      rocketLight.intensity = 0;
    }

    // fireballs: camera-facing, expand fast, fade out
    for (const f of fireballs) {
      if (!f.active) continue;
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.mesh.quaternion.copy(lastCamQuat);
      f.mesh.scale.setScalar(f.s0 * 0.55 + f.grow * k);
      f.mesh.material.opacity = 1 - k * k;
    }

    // shockwave rings: expand fast then ease out, fading as they go
    for (const r of rings) {
      if (!r.active) continue;
      r.age += dt;
      const k = r.age / RING_LIFE;
      if (k >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - k, 2.2);
      r.mesh.scale.setScalar(14 + (RING_SIZE - 14) * e);
      r.mesh.material.opacity = 0.85 * (1 - k);
    }

    // blast light decay + the delayed smoke column trickling up
    blastLightAge += dt;
    if (blastLightAge <= BLAST_LIGHT_LIFE) {
      const k = blastLightAge / BLAST_LIGHT_LIFE;
      blastLight.intensity = BLAST_LIGHT * (1 - k) * (1 - k);
    } else if (blastLight.intensity !== 0) {
      blastLight.intensity = 0;
    }
    for (let i = delayedPuffs.length - 1; i >= 0; i--) {
      const d = delayedPuffs[i];
      d.t -= dt;
      if (d.t <= 0) {
        smokePuff(d.pos, d.scale);
        delayedPuffs.splice(i, 1);
      }
    }

    // flashes: pop outward, face the camera, fade fast
    for (const f of flashes) {
      if (!f.active) continue;
      f.age += dt;
      const k = f.age / FLASH_LIFE;
      if (k >= 1) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.mesh.material.opacity = 1 - k;
      f.mesh.quaternion.copy(camera.quaternion);
      f.mesh.rotateZ(f.spin);
      f.mesh.scale.multiplyScalar(1 + 3.2 * dt);
    }

    // sparks: ballistic + fade to black (additive black = gone)
    let sparksDirty = false;
    for (let i = 0; i < sparkMax; i++) {
      if (sparkLife[i] <= 0) continue;
      sparksDirty = true;
      sparkLife[i] -= dt;
      const i3 = i * 3;
      if (sparkLife[i] <= 0) {
        sparkLife[i] = 0;
        sparkCol[i3] = 0;
        sparkCol[i3 + 1] = 0;
        sparkCol[i3 + 2] = 0;
        sparkPos[i3 + 1] = -1e5;
        continue;
      }
      sparkVel[i3 + 1] -= SPARK_GRAVITY * dt;
      sparkPos[i3] += sparkVel[i3] * dt;
      sparkPos[i3 + 1] += sparkVel[i3 + 1] * dt;
      sparkPos[i3 + 2] += sparkVel[i3 + 2] * dt;
      const fade = sparkLife[i] / sparkMaxLife[i];
      const flicker = 0.75 + Math.random() * 0.25;
      sparkCol[i3] = fade * flicker;
      sparkCol[i3 + 1] = fade * (0.55 + flicker * 0.3);
      sparkCol[i3 + 2] = fade * 0.2;
    }
    if (sparksDirty) {
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
    }

    // smoke: rise, drift, expand, fade
    for (const s of smoke) {
      if (!s.active) continue;
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      s.sprite.position.y += s.rise * dt;
      s.sprite.position.x += s.drift.x * dt;
      s.sprite.position.z += s.drift.z * dt;
      s.sprite.material.rotation += s.spin * dt;
      s.sprite.material.opacity = SMOKE_OPACITY * (1 - k);
      s.sprite.scale.setScalar(
        SMOKE_SCALE_START + SMOKE_SCALE_GROW * Math.sqrt(k)
      );
    }
  }

  let slowmo = 1;

  function setSlowmo(factor: number) {
    // implemented as a time scale on the bullet only
    slowmo = Math.max(0.01, factor);
  }

  /** Verification helper: air-burst the first active rocket right now. */
  function detonate(): boolean {
    const r = rockets.find((c) => c.active);
    if (!r) return false;
    r.active = false;
    r.group.visible = false;
    explodeAt(r.group.position);
    return true;
  }

  function stats() {
    return {
      flying: bullets.reduce((n, b) => n + (b.active ? 1 : 0), 0),
      rockets: rockets.reduce((n, r) => n + (r.active ? 1 : 0), 0),
      sparks: sparkLife.reduce(
        (n, l, i) => n + (l > 0 && sparkPos[i * 3 + 1] > -1e4 ? 1 : 0),
        0
      ),
      smoke: smoke.reduce((n, s) => n + (s.active ? 1 : 0), 0),
      flashes: flashes.reduce((n, f) => n + (f.active ? 1 : 0), 0),
    };
  }

  function dispose() {
    for (const b of bullets) scene.remove(b.group);
    for (const f of flashes) scene.remove(f.mesh);
    scene.remove(sparkPoints);
    for (const s of smoke) scene.remove(s.sprite);
    for (const r of rockets) scene.remove(r.group);
    scene.remove(rocketLight);
    for (const f of fireballs) scene.remove(f.mesh);
    for (const r of rings) scene.remove(r.mesh);
    scene.remove(blastLight);
    bulletGeo.dispose();
    tracerGeo.dispose();
    tracerMat.dispose();
    bulletMat.dispose();
    bulletTex.dispose();
    tracerTex.dispose();
    flashTex.dispose();
    smokeTex.dispose();
    sparkTex.dispose();
    fireballTex.dispose();
    ringTex.dispose();
    flashGeo.dispose();
    for (const f of flashes) f.mesh.material.dispose();
    sparkGeo.dispose();
    sparkMat.dispose();
    smokeBaseMat.dispose();
    for (const s of smoke) s.sprite.material.dispose();
    rocketBodyGeo.dispose();
    rocketNoseGeo.dispose();
    rocketFinGeo.dispose();
    rocketBodyMat.dispose();
    rocketNoseMat.dispose();
    rocketFinMat.dispose();
    rocketGlowMat.dispose();
    for (const r of rockets) r.glow.material.dispose();
    fireballGeo.dispose();
    for (const f of fireballs) f.mesh.material.dispose();
    ringGeo.dispose();
    for (const r of rings) r.mesh.material.dispose();
  }

  return {
    fireFrom,
    fireRocket,
    fireHomingRocket,
    rocketThreatNear,
    update,
    setSlowmo,
    detonate,
    explodeAt,
    stats,
    dispose,
  };
}
