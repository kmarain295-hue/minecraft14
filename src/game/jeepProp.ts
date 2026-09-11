import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ============================================================================
 * jeepProp.ts — armored-SUV replica: micro-detail model + DRIVABLE vehicle
 *
 * MICRO-DETAIL BUILD: a hand-built replica of the reference jeep photos made
 * from THOUSANDS of merged primitives — real 3D mud-terrain tread blocks on
 * every tire, sidewall lug rows, hex-cell grille mesh, segmented LED
 * C-frames, rivet/bolt rows on every panel, door hinges, wiper arms, coil
 * springs as true helix tubes, shock absorbers, brake discs behind rims...
 *
 * PERFORMANCE: every primitive is collected into a per-material bucket and
 * merged into ONE BufferGeometry per material (~18 draw calls total), so the
 * thousands of shapes cost almost nothing per frame. The four ROAD wheels
 * are their own small merged groups so they can spin/steer while driving.
 *
 * SMOOTH EDGES: body panels use RoundedBoxGeometry (soft automotive edges),
 * cylinders/tori run 12-36 segments, flares are beveled extrusions, springs
 * are smooth tube helices.
 *
 * SHINE: a light PMREM studio environment map is baked once and assigned
 * (low envMapIntensity) to the paint/chrome/glass materials — a soft,
 * believable showroom sheen rather than a mirror finish.
 *
 * DRIVING: `updateDrive()` runs an arcade car model — analog-eased
 * throttle/steering, speed-sensitive steering authority, Space handbrake
 * drift with hysteresis, terrain-following pitch/roll from heightAt samples
 * under the wheels, squat/dive/lean body attitude, spinning + steering
 * wheels. Every SLIPPING tyre burns its own fading tread ribbon (skid
 * marks) and boils rubber smoke. The page binds keys and swaps the
 * camera/player over while driving; the module stays self-contained.
 *
 * EXHAUST SMOKE: pooled sprite puffs emitted from the twin silencer tips.
 * The emission rate scales with speed (idle tick-over puff -> dense trail
 * at full throttle) and throttle load darkens the smoke slightly.
 *
 * COLLISION: `collide()` resolves the player against the jeep's oriented
 * bounding box in the XZ plane — the vehicle is solid while on foot.
 *
 * Scale: the game runs ~100 world units per metre (player = 190u tall), so
 * the jeep is ~5.0m x 2.0m x 1.96m -> 500 x 200 x 196 units, wheels r=47.
 * The jeep faces +Z. The group origin sits at ground level under the center.
 * ==========================================================================*/

/** Throttle/steer/handbrake input for one frame of `updateDrive`. */
export interface JeepDriveInput {
  /** -1 = brake/reverse, +1 = full throttle (analog allowed). */
  throttle: number;
  /** -1 = right, +1 = left (matches the A/D turn input convention). */
  steer: number;
  /** Space handbrake — strong deceleration toward zero. */
  brake: boolean;
}

/** Live driving telemetry returned by `updateDrive`. */
export interface JeepDriveState {
  /** Signed forward speed in world units/s (negative = reversing). */
  speed: number;
  /** Max forward speed (for HUD scaling). */
  maxSpeed: number;
  /** Jeep heading in radians (group.rotation.y). */
  heading: number;
  /** Lateral slide velocity in u/s (+ = sliding toward the car's right). */
  lateral: number;
  /** True while the tyres are sliding (drift — drives skid marks + smoke). */
  drifting: boolean;
}

export interface JeepPropHandle {
  /** Root group — already added to the scene. */
  group: THREE.Group;
  /** Park the jeep at a world position (y = ground height under it). */
  place(x: number, z: number, y: number, rotationY?: number): void;
  /**
   * Push a circle (player capsule footprint) out of the jeep's oriented
   * bounding box in the XZ plane. Returns the corrected world position, or
   * null when the point is clear of the jeep.
   */
  collide(px: number, pz: number, radius: number): { x: number; z: number } | null;
  /**
   * Advance the vehicle for one frame: physics, terrain follow, wheels,
   * body attitude and exhaust-smoke emission. Call ONLY while driven.
   */
  updateDrive(dt: number, input: JeepDriveInput): JeepDriveState;
  /**
   * Keep already-emitted exhaust smoke fading while NOT driving (call
   * every frame; cheap no-op when no puffs are alive).
   */
  updateFx(dt: number): void;
  /** Short burst of start-up puffs (engine ignition on enter). */
  smokeBurst(count: number): void;
  /** True while the engine is running (between enter/exit). */
  isDriving(): boolean;
  /** Build stats: primitive count, merged draw calls, triangle count. */
  stats(): { shapes: number; meshes: number; triangles: number };
  /** Suspension debug snapshot: sprung-body spring state + per-wheel strokes. */
  suspension(): {
    bodyY: number;
    heaveVel: number;
    pitch: number;
    roll: number;
    strokes: number[];
  };
  /** Free every geometry/material/texture and remove it from the scene. */
  dispose(): void;
}

/* ----------------------------- dimensions -------------------------------- */
const WHEEL_R = 47;
const TIRE_W = 32;
const TRACK_X = 78; // wheel center |x|
const AXLE_F = 160; // front wheel center z
const AXLE_R = -160; // rear wheel center z
const TUB_HALF_W = 77; // main body half width
const TUB_BOTTOM = 52;
const TUB_TOP = 122;
const ROOF_Y = 179; // roof panel center height
// collision footprint (wheels are the widest point now the arch covers are
// gone: outer tire face = TRACK_X + TIRE_W/2 = 94; length covers bumpers + spare)
const COLLIDE_HW = 94;
const COLLIDE_HL = 268;

/* ------------------------- procedural textures --------------------------- */
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
  return tex;
}

/** Dark steel honeycomb mesh — backing plate behind the 3D grille cells. */
function makeHexGrilleTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#0c0e10';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#33383f';
    ctx.lineWidth = 3;
    const r = 14;
    const dx = r * 1.5;
    const dy = r * Math.sqrt(3);
    for (let col = -1; col < 256 / dx + 1; col++) {
      for (let row = -1; row < 256 / dy + 1; row++) {
        const cx = col * dx;
        const cy = row * dy + (col % 2 === 0 ? 0 : dy / 2);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i;
          const px = cx + Math.cos(a) * (r - 2.5);
          const py = cy + Math.sin(a) * (r - 2.5);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

/** Rubber grain under the real 3D tread blocks. */
function makeTreadTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 128, (ctx) => {
    ctx.fillStyle = '#141518';
    ctx.fillRect(0, 0, 256, 128);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 8; col++) {
        const x = col * 32 + (row % 2 === 0 ? 0 : 16);
        const y = row * 32;
        ctx.fillStyle = '#232529';
        ctx.beginPath();
        ctx.moveTo(x + 4, y + 6);
        ctx.lineTo(x + 24, y + 2);
        ctx.lineTo(x + 28, y + 22);
        ctx.lineTo(x + 10, y + 28);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(0, 30, 256, 5);
    ctx.fillRect(0, 92, 256, 5);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 1);
  return tex;
}

/**
 * Soft studio environment for the SHINE pass: an equirectangular gradient
 * (bright zenith, warm horizon band, dark ground) with one broad highlight
 * blob. Assigned as material.envMap at LOW intensities — reads as a light
 * showroom sheen on the paint/chrome without needing the renderer for a
 * PMREM bake (WebGLRenderer converts equirect env maps internally).
 */
function makeShineEnvTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 128, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 128);
    sky.addColorStop(0, '#dfe7ee'); // cool bright zenith
    sky.addColorStop(0.42, '#aebcc6'); // upper sky
    sky.addColorStop(0.52, '#f2e9d8'); // warm horizon band
    sky.addColorStop(0.56, '#5d5a52'); // ground line
    sky.addColorStop(1, '#23241f'); // dark ground
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 128);
    // broad soft studio highlight up in the sky
    const blob = ctx.createRadialGradient(70, 26, 2, 70, 26, 44);
    blob.addColorStop(0, 'rgba(255,255,252,0.95)');
    blob.addColorStop(1, 'rgba(255,255,252,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, 256, 128);
    // faint fill light from the opposite side
    const fill = ctx.createRadialGradient(196, 40, 2, 196, 40, 36);
    fill.addColorStop(0, 'rgba(235,242,250,0.5)');
    fill.addColorStop(1, 'rgba(235,242,250,0)');
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 256, 128);
  });
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/** Off-road sidewall: ring of lug blocks around the tire face. */
function makeSidewallTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#212327';
    ctx.lineWidth = 3;
    for (const r of [96, 78, 60]) {
      ctx.beginPath();
      ctx.arc(128, 128, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#26282d';
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      ctx.save();
      ctx.translate(128, 128);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(-9, -124);
      ctx.lineTo(9, -124);
      ctx.lineTo(6, -100);
      ctx.lineTo(-6, -100);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#0d0e10';
    ctx.beginPath();
    ctx.arc(128, 128, 46, 0, Math.PI * 2);
    ctx.fill();
  });
  return tex;
}

/* --------------------------- geometry bucket ------------------------------ */
/**
 * Collects primitives for ONE material, then merges them into a single
 * BufferGeometry (one draw call). All input geometries are flattened to
 * non-indexed so mergeGeometries always succeeds.
 */
class Bucket {
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly dummy = new THREE.Object3D();
  count = 0;

  add(
    geo: THREE.BufferGeometry,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0
  ): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(rx, ry, rz);
    this.dummy.updateMatrix();
    g.applyMatrix4(this.dummy.matrix);
    this.geos.push(g);
    this.count += 1;
  }

  addM(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.applyMatrix4(m);
    this.geos.push(g);
    this.count += 1;
  }

  build(): THREE.BufferGeometry | null {
    if (this.geos.length === 0) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    return merged;
  }
}

/* ------------------------- helix curve (springs) -------------------------- */
class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly radius: number,
    private readonly height: number,
    private readonly turns: number
  ) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(
      Math.cos(a) * this.radius,
      t * this.height,
      Math.sin(a) * this.radius
    );
  }
}

export function createJeepProp(
  scene: THREE.Scene,
  opts: { lowSpec?: boolean; heightAt?: (x: number, z: number) => number } = {}
): JeepPropHandle {
  const lowSpec = opts.lowSpec ?? false;
  const HI = !lowSpec; // full micro-detail vs thinned mobile build
  const heightAt = opts.heightAt ?? ((x: number, z: number) => 0);
  const group = new THREE.Group();

  /* ------------------------------ materials ------------------------------ */
  const shineEnv = makeShineEnvTexture(); // shared by every glossy part

  const greenMat = new THREE.MeshStandardMaterial({
    color: 0x5f6b47, // deep sage-olive (game sun is intense — pre-darkened)
    roughness: 0.34, // light satin-shine paint (was matte 0.45)
    metalness: 0.42,
    envMap: shineEnv,
    envMapIntensity: lowSpec ? 0.35 : 0.55, // very light showroom sheen
  });
  const greenDarkMat = new THREE.MeshStandardMaterial({
    color: 0x4d5839,
    roughness: 0.4,
    metalness: 0.38,
    envMap: shineEnv,
    envMapIntensity: lowSpec ? 0.3 : 0.45,
  });
  const blackMat = new THREE.MeshStandardMaterial({
    color: 0x141518, // glossy black trim
    roughness: 0.32,
    metalness: 0.5,
    envMap: shineEnv,
    envMapIntensity: lowSpec ? 0.4 : 0.6,
  });
  const blackMatteMat = new THREE.MeshStandardMaterial({
    color: 0x1b1d20, // matte black bumper/plastic
    roughness: 0.85,
    metalness: 0.1,
  });
  const archMat = new THREE.MeshStandardMaterial({
    color: 0x0b0c0e, // wheel-well shadow
    roughness: 0.95,
    metalness: 0.0,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a0e12, // near-black glass canopy (faint interior glimpse)
    roughness: 0.08,
    metalness: 0.85,
    transparent: true,
    opacity: 0.86,
    envMap: shineEnv,
    envMapIntensity: 1.1,
  });
  const silverMat = new THREE.MeshStandardMaterial({
    color: 0xc9cdd3,
    roughness: 0.16, // polished chrome-silver
    metalness: 0.88,
    envMap: shineEnv,
    envMapIntensity: lowSpec ? 0.6 : 0.95,
  });
  const steelDarkMat = new THREE.MeshStandardMaterial({
    color: 0x4a4e54, // suspension / exhaust
    roughness: 0.3,
    metalness: 0.82,
    envMap: shineEnv,
    envMapIntensity: 0.55,
  });
  const rubberMat = new THREE.MeshStandardMaterial({
    color: 0x191a1e, // 3D tread blocks + sidewall lugs
    roughness: 0.96,
    metalness: 0.0,
  });
  const grilleMat = new THREE.MeshStandardMaterial({
    map: makeHexGrilleTexture(),
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.5,
  });
  const tireSideMat = new THREE.MeshStandardMaterial({
    map: makeTreadTexture(),
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
  });
  const tireCapMat = new THREE.MeshStandardMaterial({
    map: makeSidewallTexture(),
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });
  const ledWhiteMat = new THREE.MeshStandardMaterial({
    color: 0x30302c,
    emissive: 0xf7fbf2,
    emissiveIntensity: 2.0,
    roughness: 0.4,
  });
  const ledRedMat = new THREE.MeshStandardMaterial({
    color: 0x330604,
    emissive: 0xff2314,
    emissiveIntensity: 1.9,
    roughness: 0.4,
  });
  const ledRedSoftMat = new THREE.MeshStandardMaterial({
    color: 0x2a0503,
    emissive: 0xe02010,
    emissiveIntensity: 0.9,
    roughness: 0.5,
  });
  const caliperMat = new THREE.MeshStandardMaterial({
    color: 0xa8221c, // red brake calipers + coil springs from the photos
    roughness: 0.38,
    metalness: 0.35,
    envMap: shineEnv,
    envMapIntensity: 0.4,
  });
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xb9bdc2, // license plate
    roughness: 0.6,
    metalness: 0.1,
  });
  const interiorMat = new THREE.MeshStandardMaterial({
    color: 0x232527, // seats / dash seen through the glass
    roughness: 0.9,
    metalness: 0.05,
  });

  /* --------------------------- part placement ---------------------------- */
  const buckets = new Map<THREE.Material, Bucket>();
  const bucketFor = (mat: THREE.Material): Bucket => {
    let b = buckets.get(mat);
    if (!b) {
      b = new Bucket();
      buckets.set(mat, b);
    }
    return b;
  };

  /** Place a pre-built geometry (consumed by the bucket). */
  function part(
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0
  ): void {
    bucketFor(mat).add(geo, x, y, z, rx, ry, rz);
  }

  /** Place a pre-built geometry with a full matrix (mirrored sub-assemblies). */
  function partM(mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    bucketFor(mat).addM(geo, m);
  }

  /** Smooth-edged panel: RoundedBox with auto radius (or explicit). */
  function box(
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    radius = 0
  ): void {
    let r = radius > 0 ? radius : Math.min(1.8, w / 3, h / 3, d / 3);
    r = Math.max(0.12, Math.min(r, w / 2 - 0.05, h / 2 - 0.05, d / 2 - 0.05));
    const seg = r > 1.2 ? 3 : 2;
    part(mat, new RoundedBoxGeometry(w, h, d, seg, r), x, y, z, rx, ry, rz);
  }

  function cyl(
    mat: THREE.Material,
    rTop: number,
    rBot: number,
    h: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    open = false
  ): void {
    part(
      mat,
      new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open),
      x,
      y,
      z,
      rx,
      ry,
      rz
    );
  }

  function torus(
    mat: THREE.Material,
    R: number,
    tube: number,
    radSeg: number,
    tubSeg: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    arc = Math.PI * 2
  ): void {
    part(
      mat,
      new THREE.TorusGeometry(R, tube, radSeg, tubSeg, arc),
      x,
      y,
      z,
      rx,
      ry,
      rz
    );
  }

  function ball(
    mat: THREE.Material,
    r: number,
    x: number,
    y: number,
    z: number,
    seg = 12
  ): void {
    part(mat, new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.7))), x, y, z);
  }

  /** Hex bolt head (axis along X by default). */
  function boltX(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number): void {
    cyl(mat, r, r, h, 6, x, y, z, 0, 0, Math.PI / 2);
  }

  /** Dome rivet head. */
  function rivet(mat: THREE.Material, r: number, x: number, y: number, z: number): void {
    ball(mat, r, x, y, z, 6);
  }

  /* ------------------------------- wheels -------------------------------- */
  // One micro-detailed wheel, built in wheel-local space (axis X, outboard
  // face = local +X). The SPARE is merged straight into the global buckets;
  // the four ROAD wheels get their own small merged groups so they can
  // spin (roll around the axle) and steer while driving.
  type WheelPut = (
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    lx: number,
    ly: number,
    lz: number,
    rx?: number,
    ry?: number,
    rz?: number
  ) => void;

  function buildWheelInto(put: WheelPut): void {
    // tire carcass (open cylinder, rubber grain texture)
    put(
      tireSideMat,
      new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, TIRE_W, HI ? 36 : 22, 1, true),
      0, 0, 0, 0, 0, Math.PI / 2
    );
    // sidewall caps (lug-ring texture)
    put(tireCapMat, new THREE.RingGeometry(24, WHEEL_R - 0.5, HI ? 36 : 20), TIRE_W / 2 - 0.4, 0, 0, 0, Math.PI / 2, 0);
    put(tireCapMat, new THREE.RingGeometry(24, WHEEL_R - 0.5, HI ? 36 : 20), -(TIRE_W / 2 - 0.4), 0, 0, 0, -Math.PI / 2, 0);

    // REAL 3D mud-terrain tread blocks — 5 circumferential rows
    const rows = HI
      ? [
          { w: 20, off: 0, n: 36, tilt: 0, phase: 0 },
          { w: 12, off: 8, n: 40, tilt: 0.1, phase: 0.045 },
          { w: 12, off: -8, n: 40, tilt: -0.1, phase: 0.045 },
          { w: 10, off: 13.2, n: 44, tilt: 0.16, phase: 0.09 },
          { w: 10, off: -13.2, n: 44, tilt: -0.16, phase: 0.09 },
        ]
      : [
          { w: 22, off: 0, n: 16, tilt: 0, phase: 0 },
          { w: 11, off: 10.2, n: 18, tilt: 0.14, phase: 0.09 },
          { w: 11, off: -10.2, n: 18, tilt: -0.14, phase: 0.09 },
        ];
    for (const row of rows) {
      for (let i = 0; i < row.n; i++) {
        const a = (i / row.n) * Math.PI * 2 + row.phase;
        put(
          rubberMat,
          new RoundedBoxGeometry(row.w, 4.5, 12, 1, 1.4),
          0,
          Math.cos(a) * (WHEEL_R + 1.1),
          Math.sin(a) * (WHEEL_R + 1.1),
          a + row.tilt, 0, 0
        );
      }
    }

    // outboard sidewall lug blocks (deep off-road shoulder)
    if (HI) {
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        put(
          rubberMat,
          new RoundedBoxGeometry(3, 10, 5, 1, 0.8),
          TIRE_W / 2 - 0.8,
          Math.cos(a) * (WHEEL_R - 9),
          Math.sin(a) * (WHEEL_R - 9),
          a, 0, 0
        );
      }
    }

    // rim barrel + face
    put(blackMat, new THREE.CylinderGeometry(24, 24, TIRE_W - 8, HI ? 24 : 14, 1, true), 0, 0, 0, 0, 0, Math.PI / 2);
    put(blackMatteMat, new THREE.CylinderGeometry(27, 27, 3, HI ? 24 : 14), TIRE_W / 2 - 2.5, 0, 0, 0, 0, Math.PI / 2);

    // 12 spokes = 6 full-diameter blades
    const spokes = HI ? 6 : 4;
    for (let i = 0; i < spokes; i++) {
      put(
        blackMat,
        new RoundedBoxGeometry(2.8, 40, 6, 1, 0.9),
        TIRE_W / 2 - 1,
        0, 0,
        (i / spokes) * Math.PI, 0, 0
      );
    }
    // one hex nut at each spoke end
    for (let i = 0; i < spokes * 2; i++) {
      const a = (i / (spokes * 2)) * Math.PI * 2;
      put(
        silverMat,
        new THREE.CylinderGeometry(1.5, 1.5, 2.2, 6),
        TIRE_W / 2 - 0.2,
        Math.cos(a) * 19.5,
        Math.sin(a) * 19.5,
        0, 0, Math.PI / 2
      );
    }

    // hub cap + silver ring + 8 lug nuts
    put(blackMatteMat, new THREE.CylinderGeometry(6.5, 6.5, 4, 14), TIRE_W / 2 + 0.6, 0, 0, 0, 0, Math.PI / 2);
    put(silverMat, new THREE.TorusGeometry(7.2, 0.9, HI ? 10 : 6, HI ? 22 : 12), TIRE_W / 2 + 1.6, 0, 0, 0, Math.PI / 2, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      put(
        silverMat,
        new THREE.CylinderGeometry(1.8, 1.8, 2.5, 6),
        TIRE_W / 2 + 0.4,
        Math.cos(a) * 13.5,
        Math.sin(a) * 13.5,
        0, 0, Math.PI / 2
      );
    }

    // brake disc + red caliper with bolts (peeks through the spokes)
    put(silverMat, new THREE.CylinderGeometry(18, 18, 2.6, HI ? 28 : 16), 4, 0, 0, 0, 0, Math.PI / 2);
    put(caliperMat, new RoundedBoxGeometry(4, 13, 8, 2, 1), 4.5, 11, 9);
    if (HI) {
      boltX(silverMat, 1.1, 1.8, 4.5, 16.5, 9);
      boltX(silverMat, 1.1, 1.8, 4.5, 5.5, 9);
    }
  }

  /** Tailgate spare: merged into the STATIC buckets (never spins). */
  function buildSpareWheel(cx: number, cy: number, cz: number, rotY: number, rotZ: number): void {
    const frame = new THREE.Object3D();
    const partFrame = new THREE.Object3D();
    const frameM = new THREE.Matrix4();
    frame.position.set(cx, cy, cz);
    frame.rotation.set(0, rotY, rotZ);
    frame.updateMatrix();
    buildWheelInto((mat, geo, lx, ly, lz, rx = 0, ry = 0, rz = 0) => {
      partFrame.position.set(lx, ly, lz);
      partFrame.rotation.set(rx, ry, rz);
      partFrame.updateMatrix();
      frameM.multiplyMatrices(frame.matrix, partFrame.matrix);
      partM(mat, geo, frameM);
    });
  }

  // --- the four ROAD wheels: independent rigs (pivot -> spin -> meshes) ---
  interface RoadWheel {
    /** Hub group: holds the mirror yaw + live steering angle (front). */
    pivot: THREE.Group;
    /** Rolls around the local X axle; holds all wheel meshes. */
    spin: THREE.Group;
    /** +1 right side, -1 left side (mirror flips the roll direction). */
    spinSign: number;
    /** Front wheels steer, rear wheels only roll. */
    steers: boolean;
  }
  const roadWheels: RoadWheel[] = [];
  let roadWheelShapes = 0; // wheel shapes counted for the stats surface
  for (const [wx, wz] of [
    [TRACK_X, AXLE_F],
    [-TRACK_X, AXLE_F],
    [TRACK_X, AXLE_R],
    [-TRACK_X, AXLE_R],
  ]) {
    const mirror = wx < 0 ? Math.PI : 0;
    const pivot = new THREE.Group();
    pivot.position.set(wx, WHEEL_R, wz);
    pivot.rotation.y = mirror;
    const spin = new THREE.Group();
    pivot.add(spin);
    // the same micro-detail geometry as before, merged per material into
    // this wheel's own meshes (a handful of extra draw calls total)
    const localBuckets = new Map<THREE.Material, Bucket>();
    buildWheelInto((mat, geo, lx, ly, lz, rx = 0, ry = 0, rz = 0) => {
      let b = localBuckets.get(mat);
      if (!b) {
        b = new Bucket();
        localBuckets.set(mat, b);
      }
      b.add(geo, lx, ly, lz, rx, ry, rz);
      roadWheelShapes += 1;
    });
    for (const [mat, bucket] of localBuckets) {
      const merged = bucket.build();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      spin.add(mesh);
    }
    group.add(pivot);
    roadWheels.push({
      pivot,
      spin,
      spinSign: mirror === 0 ? 1 : -1,
      steers: wz === AXLE_F,
    });
  }

  // NOTE: the fender flares / arch covers were intentionally REMOVED per the
  // user request — all four wheels are fully exposed from above, showing the
  // tread blocks, sidewall lugs, brakes, coils and shocks with no arch cover.

  /* ----------------------------- main body ------------------------------- */
  // body shell split into 4 pieces so the wheel arches are OPEN (real
  // wheel wells): full-height sill between the axles, short lower tips
  // ahead of / behind the arches, solid upper slab above them
  box(greenMat, TUB_HALF_W * 2, TUB_TOP - 92, 466, 0, (92 + TUB_TOP) / 2, -5, 0, 0, 0, 3); // upper slab
  box(greenMat, TUB_HALF_W * 2, 92 - TUB_BOTTOM, 218, 0, (TUB_BOTTOM + 92) / 2, 0, 0, 0, 0, 2.5); // sill between arches
  box(greenMat, TUB_HALF_W * 2, 92 - TUB_BOTTOM, 17, 0, (TUB_BOTTOM + 92) / 2, 219.5, 0, 0, 0, 2); // front tip
  box(greenMat, TUB_HALF_W * 2, 92 - TUB_BOTTOM, 27, 0, (TUB_BOTTOM + 92) / 2, -224.5, 0, 0, 0, 2); // rear tip

  // rocker black trim + side steps with real tread bars and brackets
  for (const s of [1, -1] as const) {
    box(blackMatteMat, 2.2, 10, 200, s * (TUB_HALF_W - 0.4), 57, 0);
    box(blackMatteMat, 14, 9, 170, s * 84, 42, -20, 0, 0, 0, 1.6);
    for (let i = 0; i < 10; i++) {
      box(blackMat, 16, 2, 3.2, s * 84, 47.2, 60 - i * 17, 0, 0, 0, 0.7);
    }
    for (const zb of [60, -20, -100]) {
      box(blackMatteMat, 2.4, 9, 6, s * 84, 34, zb);
    }
    // rivet row along the rocker
    if (HI) {
      for (let i = 0; i < 16; i++) {
        rivet(blackMat, 0.9, s * (TUB_HALF_W + 0.6), 100, 96 - i * 13.7);
      }
    }
  }

  // door seams + handles with base plates and keyholes (4 doors)
  for (const s of [1, -1] as const) {
    for (const zs of [30, -38, -96]) {
      box(greenDarkMat, 0.9, 64, 1.4, s * (TUB_HALF_W + 0.3), 88, zs, 0, 0, 0, 0.4);
    }
    // front + rear handles on each side
    for (const [hz, rear] of [
      [12, false],
      [-52, true],
    ] as const) {
      const len = rear ? 10 : 15;
      box(blackMat, len + 3, 4.5, 1.6, s * (TUB_HALF_W + 0.4), 117.6, hz, 0, 0, 0, 0.7);
      box(silverMat, len, 3, 2.6, s * (TUB_HALF_W + 0.55), 118, hz, 0, 0, 0, 1);
      if (HI) ball(blackMatteMat, 0.7, s * (TUB_HALF_W + 1.9), 118, hz + len / 2 - 1.6, 6);
    }
    // angular vent slash behind the front wheel + 4 slats
    box(blackMatteMat, 3, 24, 42, s * (TUB_HALF_W + 0.3), 100, 104, 0, 0, 0, 0.8);
    for (let i = 0; i < 4; i++) {
      box(blackMat, 3.4, 2, 38, s * (TUB_HALF_W + 0.5), 93 + i * 4.7, 104, 0, 0, 0, 0.7);
    }
    // door hinges at each seam (top + bottom), body + knuckle + pin
    if (HI) {
      for (const zs of [30, -38, -96]) {
        for (const hy of [60, 112]) {
          cyl(blackMat, 1.7, 1.7, 6, 8, s * (TUB_HALF_W + 1.2), hy, zs + 1.5);
          boltX(blackMat, 1.1, 1.6, s * (TUB_HALF_W + 1.2), hy + 3.4, zs + 1.5);
          boltX(blackMat, 1.1, 1.6, s * (TUB_HALF_W + 1.2), hy - 3.4, zs + 1.5);
        }
      }
    }
  }

  // fuel cap with knurled edge (left side only)
  cyl(silverMat, 6, 6, 2.2, HI ? 18 : 10, -(TUB_HALF_W + 0.4), 112, -130, 0, 0, Math.PI / 2);
  if (HI) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      box(blackMat, 1.6, 1.2, 1.2, -(TUB_HALF_W + 1.6), 112 + Math.cos(a) * 5.2, -130 + Math.sin(a) * 5.2, a, 0, 0, 0.4);
    }
    box(blackMat, 2.5, 2, 4, -(TUB_HALF_W + 0.5), 118, -130, 0, 0, 0, 0.7);
  }

  // black belt band sealing the glass base + cowl panel under the windshield
  for (const s of [1, -1] as const) {
    box(blackMat, 2, 8, 278, s * (TUB_HALF_W + 0.2), 125, -51, 0, 0, 0, 0.7);
  }
  box(blackMat, 142, 8, 6, 0, 125, 89, 0, 0, 0, 1.5);

  /* -------------------------------- hood --------------------------------- */
  box(greenMat, 142, 12, 134, 0, 124, 159, 0, 0, 0, 3); // hood z 92..226
  box(greenMat, 64, 3.5, 118, 0, 131.4, 158, 0, 0, 0, 1.4); // raised center dome
  box(greenDarkMat, 5, 2, 118, -62, 131, 158, 0, 0, 0, 0.8); // pressed edge creases
  box(greenDarkMat, 5, 2, 118, 62, 131, 158, 0, 0, 0, 0.8);
  // twin extractor vents with real slats
  for (const vx of [-40, 40]) {
    box(blackMatteMat, 60, 3.5, 22, vx, 130.8, 192, 0, 0, 0, 1);
    const slats = HI ? 8 : 3;
    for (let i = 0; i < slats; i++) {
      box(blackMat, 7, 1.6, 20, vx - 24 + i * (48 / (slats - 1)), 132.2, 192, 0, 0, 0, 0.6);
    }
  }
  // hood hinge covers + rear edge rivets
  for (const s of [1, -1] as const) {
    box(blackMatteMat, 14, 3, 8, s * 50, 121, 96, 0, 0, 0, 1);
    if (HI) {
      boltX(blackMat, 1.2, 1.8, s * 50, 121, 100.5);
      boltX(blackMat, 1.2, 1.8, s * 50, 121, 91.5);
    }
  }
  if (HI) {
    for (let i = 0; i < 14; i++) {
      rivet(greenDarkMat, 0.9, -63 + i * 9.7, 130.2, 94);
    }
  }

  /* -------------------------- greenhouse / cabin ------------------------- */
  // windshield (raked) + smooth frame + green A-pillars
  box(glassMat, 140, 84, 3, 0, 149, 59, -0.785, 0, 0, 1.2);
  box(blackMat, 142, 5, 4, 0, 119.3, 88.4, -0.785, 0, 0, 1.4); // bottom frame
  box(blackMat, 142, 5, 4, 0, 178.7, 29.6, -0.785, 0, 0, 1.4); // top frame
  for (const s of [1, -1] as const) {
    box(greenMat, 7, 86, 7, s * 70, 149, 59, -0.785, 0, 0, 2); // A-pillars
    box(blackMat, 4, 88, 3.6, s * 69.2, 149, 59.6, -0.785, 0, 0, 1.2); // glass edge trim
  }
  // parked windshield wipers: pivot ball + arm + segmented blade
  for (const [wxp, dir, tilt] of [
    [-22, 1, 0.12],
    [24, -1, -0.1],
  ] as const) {
    ball(blackMatteMat, 2, wxp, 121.5, 88, 8);
    cyl(blackMat, 0.9, 0.9, 26, 8, wxp + dir * 13, 122.6, 87.4, 0, 0, Math.PI / 2 + tilt * dir);
    for (let i = 0; i < (HI ? 6 : 3); i++) {
      box(blackMat, 5.4, 1.2, 1.6, wxp + dir * (4 + i * 5.4), 121.6, 87.8, 0, 0, tilt, 0.4);
    }
  }
  // side glass slab + trim + pillars
  for (const s of [1, -1] as const) {
    box(glassMat, 3, 46, 144, s * (TUB_HALF_W + 0.5), 151, -46, 0, 0, 0, 1);
    box(blackMat, 3.6, 3, 146, s * (TUB_HALF_W + 0.5), 175.4, -46, 0, 0, 0, 1);
    box(blackMat, 3.6, 3, 146, s * (TUB_HALF_W + 0.5), 126.6, -46, 0, 0, 0, 1);
    box(blackMat, 5, 48, 7, s * (TUB_HALF_W + 0.5), 151, -30, 0, 0, 0, 1.6); // B-pillar
    box(greenMat, 11, 52, 26, s * (TUB_HALF_W - 2), 150, -106, -0.45, 0, 0, 2); // C-pillar
  }
  // black roof with pressed ribs + gutter drip rails
  box(blackMat, 150, 10, 150, 0, ROOF_Y, -45, 0, 0, 0, 3);
  box(blackMatteMat, 4, 1.6, 140, -30, 184.6, -45, 0, 0, 0, 0.6);
  box(blackMatteMat, 4, 1.6, 140, 30, 184.6, -45, 0, 0, 0, 0.6);
  for (const s of [1, -1] as const) {
    box(blackMatteMat, 3, 3, 148, s * 74, 184.4, -45, 0, 0, 0, 1);
  }
  if (HI) {
    for (let i = 0; i < 20; i++) {
      rivet(blackMat, 0.9, -66 + i * 6.95, 184.2, 28.5);
    }
  }
  // roof scoop above the windshield + mesh intake + cheeks
  box(blackMat, 58, 8, 30, 0, 189, 45, 0.15, 0, 0, 2);
  box(grilleMat, 44, 5, 2.5, 0, 191.8, 58, 0.15, 0, 0, 0.8);
  for (const s of [1, -1] as const) {
    box(blackMatteMat, 4, 9, 28, s * 28, 189.5, 44, 0.15, 0, 0, 1);
  }
  // antenna: base dome + mast + tip
  ball(blackMatteMat, 2.6, 52, 184.5, -95, 8);
  cyl(blackMatteMat, 0.8, 0.8, 26, 8, 52, 197, -94, 0.12, 0, 0);
  ball(blackMatteMat, 1.2, 52, 210, -92.4, 6);

  // rear glass (raked forward-up) + frame + parked wiper
  box(glassMat, 130, 62, 3, 0, 156, -140, 0.785, 0, 0, 1.2);
  box(blackMat, 132, 5, 4, 0, 127.5, -161.5, 0.785, 0, 0, 1.4);
  box(blackMat, 132, 5, 4, 0, 184.5, -118.5, 0.785, 0, 0, 1.4);
  for (const s of [1, -1] as const) {
    box(blackMat, 4, 64, 3.6, s * 65.4, 156, -140.4, 0.785, 0, 0, 1.2);
  }
  ball(blackMatteMat, 1.8, 14, 135.5, -159.5, 8);
  cyl(blackMat, 0.8, 0.8, 18, 8, 22, 136.5, -159, 0, 0, Math.PI / 2 + 0.3);
  for (let i = 0; i < (HI ? 5 : 3); i++) {
    box(blackMat, 4.6, 1.1, 1.5, 27 + i * 4.6, 136.2, -158.6, 0, 0, 0.3, 0.4);
  }
  // rear quarter panels up to the tailgate
  for (const s of [1, -1] as const) {
    box(greenMat, 10, 30, 80, s * (TUB_HALF_W - 5), 132, -195, 0, 0, 0, 2);
    box(blackMatteMat, 3, 20, 8, s * (TUB_HALF_W - 1), 148, -160, 0, 0, 0, 1); // quarter glass edge trim
  }

  /* --------------------------- roof accessories -------------------------- */
  // LED light bar: housing + 4 pods with real lens rings + brackets
  box(blackMatteMat, 148, 9, 14, 0, 189.5, 24, 0, 0, 0, 2);
  for (const px of [-58, -24, 24, 58]) {
    box(ledWhiteMat, 20, 3, 2.5, px, 189.5, 31.5, 0, 0, 0, 1);
    torus(blackMat, 11, 1, HI ? 8 : 5, HI ? 18 : 10, px, 189.5, 30.2, 0, 0, 0);
  }
  for (const s of [1, -1] as const) {
    box(blackMat, 6, 7, 8, s * 60, 184.8, 22, 0, 0, 0, 1);
    if (HI) {
      boltX(blackMat, 1.1, 1.6, s * 60, 182.5, 22);
    }
  }
  // rear spoiler (kicks up) + end plates + brackets + third-brake strip
  box(blackMat, 150, 8, 26, 0, 182, -130, -0.15, 0, 0, 2);
  for (const s of [1, -1] as const) {
    box(blackMat, 4, 10, 24, s * 73, 183.5, -131, -0.15, 0, 0, 1.2);
    box(blackMat, 6, 8, 10, s * 40, 176.5, -122, 0, 0, 0, 1);
  }
  box(ledRedSoftMat, 120, 2.5, 2, 0, 179, -120.5, 0, 0, 0, 0.8);

  /* -------------------------------- mirrors ------------------------------ */
  for (const s of [1, -1] as const) {
    cyl(blackMat, 1.6, 1.6, 16, 8, s * 87, 156, 40, 0, 0, Math.PI / 2); // arm
    ball(blackMat, 2.4, s * 93, 156, 40, 8); // joint
    box(blackMat, 16, 3, 4, s * 94, 156, 40, 0, 0, 0, 1); // stalk
    box(blackMat, 8, 15, 7, s * 97, 157, 40, 0, 0, 0, 1.6); // housing
    box(silverMat, 1.5, 10, 4.5, s * 101.3, 157, 40, 0, 0, 0, 0.5); // indicator stripe
    box(glassMat, 1.2, 11, 5.2, s * 93.4, 157, 40, 0, 0, 0, 0.4); // mirror glass
    if (HI) boltX(blackMat, 1, 1.4, s * 94, 152.6, 40);
  }

  /* ------------------------------- tailgate ------------------------------ */
  box(greenMat, 150, 84, 8, 0, 112, -236, 0, 0, 0, 2.5);
  // hex emblem + ring
  part(silverMat, new THREE.CylinderGeometry(9, 9, 3, 6), 0, 148, -241.5, Math.PI / 2, 0, 0);
  torus(silverMat, 10.5, 1.1, HI ? 8 : 6, HI ? 20 : 12, 0, 148, -241.8, 0, 0, 0);
  // plate recess + plate + frame + bolts
  box(blackMatteMat, 56, 17, 3, 0, 112, -241, 0, 0, 0, 1);
  box(plateMat, 50, 13, 1.2, 0, 112, -242.8, 0, 0, 0, 0.4);
  if (HI) {
    for (const [pbx, pby] of [
      [-22, 116.5],
      [22, 116.5],
      [-22, 107.5],
      [22, 107.5],
      [-11, 118.2],
      [11, 118.2],
      [-11, 105.8],
      [11, 105.8],
    ]) {
      boltX(blackMat, 0.9, 1.2, pbx, pby, -243.6);
    }
  }
  box(greenDarkMat, 122, 2.5, 1.5, 0, 131, -240.6, 0, 0, 0, 0.6); // pressed creases
  box(greenDarkMat, 122, 2.5, 1.5, 0, 93, -240.6, 0, 0, 0, 0.6);
  // tailgate hinges + rivets around the plate recess
  for (const s of [1, -1] as const) {
    for (const hy of [88, 136]) {
      cyl(blackMat, 2, 2, 5, 8, s * 60, hy, -240.5);
      if (HI) boltX(blackMat, 1.1, 1.5, s * 60, hy, -243.4);
    }
  }
  if (HI) {
    for (let i = 0; i < 14; i++) {
      rivet(greenDarkMat, 0.9, -63 + i * 9.7, 152, -240.4);
    }
  }

  /* ---------------------------- C-shaped tail lights --------------------- */
  for (const s of [1, -1] as const) {
    box(blackMat, 34, 44, 2, s * 70, 133, -244.5, 0, 0, 0, 1); // housing plate
    // segmented C: top bar, outer vertical, bottom bar + corner pods
    const segs = HI ? 8 : 4;
    for (let i = 0; i < segs; i++) {
      box(ledRedMat, 26 / segs + 0.4, 6, 4, s * (69 - 13 + (i + 0.5) * (26 / segs)), 147, -243, 0, 0, 0, 0.8);
      box(ledRedMat, 26 / segs + 0.4, 6, 4, s * (69 - 13 + (i + 0.5) * (26 / segs)), 119, -243, 0, 0, 0, 0.8);
      box(ledRedMat, 6, 30 / segs + 0.4, 4, s * 81, 118 + (i + 0.5) * (30 / segs), -243, 0, 0, 0, 0.8);
    }
    ball(ledRedMat, 3, s * 81, 147, -243, 8);
    ball(ledRedMat, 3, s * 81, 119, -243, 8);
    box(ledWhiteMat, 8, 5, 3, s * 58, 133, -242.5, 0, 0, 0, 0.8); // reverse light
  }

  /* ------------------------------ rear bumper ---------------------------- */
  box(blackMatteMat, 190, 34, 24, 0, 62, -248, 0, 0, 0, 2);
  box(blackMat, 40, 3, 12, 0, 79.6, -244, 0, 0, 0, 1); // step pad
  if (HI) {
    for (let i = 0; i < 10; i++) {
      cyl(blackMat, 1.5, 1.5, 2, 6, (i % 2 === 0 ? 1 : -1) * 82, 54 + Math.floor(i / 2) * 6, -260.2, Math.PI / 2, 0, 0);
    }
  }
  for (const s of [1, -1] as const) {
    cyl(steelDarkMat, 8, 8, 18, HI ? 14 : 8, s * 46, 63, -252, Math.PI / 2, 0, 0); // exhaust
    torus(silverMat, 8, 1, HI ? 8 : 6, HI ? 18 : 10, s * 46, 63, -260.5, 0, 0, 0); // tip ring
    part(archMat, new THREE.CircleGeometry(6.5, HI ? 12 : 6), s * 46, 63, -261.2, 0, Math.PI, 0); // dark bore
    torus(steelDarkMat, 8.6, 1.1, HI ? 8 : 5, HI ? 16 : 8, s * 46, 63, -249, 0, 0, 0); // clamp
    box(ledRedSoftMat, 18, 3.5, 2, s * 74, 66, -260.5, 0, 0, 0, 0.8); // reflector
    if (HI) {
      boltX(blackMat, 1.2, 1.8, s * 46, 72.5, -252);
      boltX(blackMat, 1.2, 1.8, s * 46, 53.5, -252);
    }
  }
  torus(blackMatteMat, 5, 1.4, HI ? 8 : 6, HI ? 16 : 10, 0, 55, -252, 0, 0, 0); // tow loop
  box(blackMatteMat, 14, 8, 8, 0, 48, -250, 0, 0, 0, 1.2); // hitch receiver

  /* ------------------------------ front clip ----------------------------- */
  // short black bumper + full-width green fascia (photo layout: green wraps
  // the grille and headlights, black only below)
  box(blackMatteMat, 192, 40, 26, 0, 66, 240, 0, 0, 0, 2);
  box(greenMat, 190, 44, 14, 0, 113, 232, 0, 0, 0, 2);
  for (const s of [1, -1] as const) {
    box(blackMat, 26, 3, 12, s * 62, 86.6, 238, 0, 0, 0, 1); // step pads
  }
  if (HI) {
    for (let i = 0; i < 10; i++) {
      cyl(blackMat, 1.5, 1.5, 2, 6, (i % 2 === 0 ? 1 : -1) * 84, 56 + Math.floor(i / 2) * 5, 253.2, Math.PI / 2, 0, 0);
    }
  }
  // honeycomb grille: recessed mesh plate + 3D hex cells + bezels
  box(grilleMat, 104, 38, 4, 0, 113, 239, 0, 0, 0, 1);
  {
    const cells = HI ? 45 : 18;
    let placed = 0;
    outer: for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 9; c++) {
        if (placed >= cells) break outer;
        const hx = -44 + c * 11 + (r % 2 === 1 ? 5.5 : 0);
        const hy = 98 + r * 8.4;
        part(blackMat, new THREE.CylinderGeometry(4.8, 4.8, 5, 6), hx, hy, 241.5, Math.PI / 2, 0, 0);
        placed += 1;
      }
    }
  }
  box(blackMat, 112, 4, 6, 0, 93.5, 241, 0, 0, 0, 1.4);
  box(blackMat, 112, 4, 6, 0, 132.5, 241, 0, 0, 0, 1.4);
  box(silverMat, 104, 2.5, 3, 0, 135.5, 240, 0, 0, 0, 0.8);
  part(silverMat, new THREE.CylinderGeometry(8, 8, 3, 6), 0, 126, 243, Math.PI / 2, 0, 0); // emblem
  torus(silverMat, 9.2, 1, HI ? 8 : 6, HI ? 18 : 10, 0, 126, 243.2, 0, 0, 0);
  // headlights: housing + segmented C-shaped LED frame + projector + ring
  for (const s of [1, -1] as const) {
    box(blackMat, 30, 24, 6, s * 64, 116, 240, 0, 0, 0, 1.4);
    const segs = HI ? 8 : 4;
    for (let i = 0; i < segs; i++) {
      box(ledWhiteMat, 28 / segs + 0.3, 3, 2.5, s * (64 - 14 + (i + 0.5) * (28 / segs)), 127, 243.5, 0, 0, 0, 0.7);
      box(ledWhiteMat, 28 / segs + 0.3, 3, 2.5, s * (64 - 14 + (i + 0.5) * (28 / segs)), 105, 243.5, 0, 0, 0, 0.7);
      box(ledWhiteMat, 3, 21 / segs + 0.3, 2.5, s * 78, 105.5 + (i + 0.5) * (21 / segs), 243.5, 0, 0, 0, 0.7);
    }
    ball(ledWhiteMat, 2.2, s * 78, 127, 243.5, 8);
    ball(ledWhiteMat, 2.2, s * 78, 105, 243.5, 8);
    ball(ledWhiteMat, 4.5, s * 60, 116, 243.6, 12); // projector lens
    torus(silverMat, 5.5, 0.8, HI ? 8 : 6, HI ? 18 : 10, s * 60, 116, 243.8, 0, 0, 0);
    // fog-light cluster: plate + 4 pods with rings
    box(blackMatteMat, 22, 16, 4, s * 74, 67, 245, 0, 0, 0, 1);
    for (const dx of [-5, 5]) {
      for (const dy of [4, -4]) {
        torus(blackMat, 3.6, 0.8, HI ? 6 : 5, HI ? 12 : 8, s * (74 + dx), 67 + dy, 247.2, 0, 0, 0);
        ball(ledWhiteMat, 2.6, s * (74 + dx), 67 + dy, 247.6, 8);
      }
    }
    // silver tow hook on a dark hex plate
    part(blackMatteMat, new THREE.CylinderGeometry(8, 8, 2.5, 6), s * 24, 58, 244, Math.PI / 2, 0, 0);
    torus(silverMat, 4.6, 1.3, HI ? 8 : 6, HI ? 14 : 8, s * 24, 58, 246.5, 0, 0, 0);
    cyl(silverMat, 1.2, 1.2, 8, 8, s * 24, 58, 246.5, 0, 0, Math.PI / 2); // shackle pin
    // lower honeycomb intake + vertical slats
    box(grilleMat, 28, 18, 4, s * 52, 66, 253.2, 0, 0, 0, 0.8);
    for (let i = 0; i < (HI ? 4 : 2); i++) {
      box(blackMat, 2, 16, 3, s * (44 + i * 5.4), 66, 254.6, 0, 0, 0, 0.6);
    }
  }
  box(blackMat, 54, 16, 12, 0, 50, 246, 0, 0, 0, 1.5); // center skid plate
  if (HI) {
    for (const s of [1, -1] as const) {
      boltX(blackMat, 1.2, 1.6, s * 20, 50, 252.4);
      boltX(blackMat, 1.2, 1.6, s * 8, 50, 252.4);
    }
  }

  /* ------------------------- suspension + exhaust ------------------------ */
  for (const az of [AXLE_F, AXLE_R]) {
    cyl(steelDarkMat, 6.5, 6.5, 150, HI ? 16 : 10, 0, WHEEL_R, az, 0, 0, Math.PI / 2); // axle
    ball(steelDarkMat, 9.5, 0, WHEEL_R, az, 14); // differential pumpkin
  }
  // differential cover bolt rings (cleaner placement, avoids the mess above)
  if (HI) {
    for (const az of [AXLE_F, AXLE_R]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.4;
        cyl(steelDarkMat, 1.3, 1.3, 2, 6, Math.cos(a) * 8.6, WHEEL_R + Math.sin(a) * 8.6, az + 9.6);
      }
    }
  }
  cyl(steelDarkMat, 4.5, 4.5, 120, HI ? 12 : 8, 0, 55, -40, Math.PI / 2, 0, 0); // driveshaft
  for (const dz of [-98, 18]) {
    cyl(steelDarkMat, 6.5, 6.5, 4, 6, 0, 55, dz, Math.PI / 2, 0, 0); // u-joints
  }
  // red coil springs as TRUE helix tubes
  for (const s of [1, -1] as const) {
    for (const az of [AXLE_F + 18, AXLE_R - 18]) {
      part(
        caliperMat,
        new THREE.TubeGeometry(new HelixCurve(8.5, 19, 4.5), HI ? 48 : 24, 2.1, HI ? 10 : 6, false),
        s * 66, 72, az
      );
      cyl(steelDarkMat, 10, 10, 2.5, HI ? 14 : 8, s * 66, 71.4, az); // spring seat
    }
    // shock absorbers: body + shaft + clamps
    for (const az of [AXLE_F, AXLE_R]) {
      cyl(steelDarkMat, 3, 3, 12, HI ? 10 : 6, s * 52, 90, az + (az > 0 ? 12 : -12), 0.35 * s, 0, 0);
      cyl(silverMat, 1.2, 1.2, 10, 6, s * 52, 100, az + (az > 0 ? 15 : -15), 0.35 * s, 0, 0);
      torus(steelDarkMat, 3.4, 0.8, 5, HI ? 10 : 6, s * 52, 85, az + (az > 0 ? 10.7 : -10.7), 0.35 * s, 0, Math.PI / 2);
      torus(steelDarkMat, 3.4, 0.8, 5, HI ? 10 : 6, s * 52, 95, az + (az > 0 ? 13.4 : -13.4), 0.35 * s, 0, Math.PI / 2);
    }
  }
  // steering tie rods + rod ends + brake lines
  cyl(steelDarkMat, 2, 2, 150, HI ? 10 : 6, 0, 60, AXLE_F, 0, 0, Math.PI / 2);
  cyl(steelDarkMat, 2, 2, 150, HI ? 10 : 6, 0, 60, AXLE_R, 0, 0, Math.PI / 2);
  for (const s of [1, -1] as const) {
    for (const az of [AXLE_F, AXLE_R]) {
      ball(steelDarkMat, 3, s * 74, 60, az, 8);
    }
  }
  cyl(steelDarkMat, 0.8, 0.8, 140, 6, 0, 40, AXLE_F, 0, 0, Math.PI / 2);
  cyl(steelDarkMat, 0.8, 0.8, 140, 6, 0, 40, AXLE_R, 0, 0, Math.PI / 2);
  // twin silver pipes curling out of the rear-left corner
  for (const [ex, ey, ez] of [
    [-82, 85, -238],
    [-74, 93, -242],
  ]) {
    cyl(silverMat, 4.5, 4.5, 42, HI ? 12 : 8, ex, ey, ez, -1.2, 0, 0);
    torus(silverMat, 4.8, 0.9, HI ? 8 : 5, HI ? 14 : 8, ex, ey + 5, ez - 13, Math.PI / 2 - 1.2, 0, 0);
  }

  /* ------------------------------- spare wheel --------------------------- */
  // tailgate-mounted spare — static, merged into the global buckets
  buildSpareWheel(-38, 104, -252, Math.PI / 2, 0.06);

  /* ------------------------------- interior ------------------------------ */
  // dark cockpit glimpsed through the tinted glass
  box(interiorMat, 130, 3, 210, 0, 55, -30); // floor
  box(interiorMat, 136, 18, 24, 0, 118, 48, 0, 0, 0, 2); // dashboard
  box(blackMatteMat, 30, 10, 10, -34, 130, 40, 0, 0, 0, 1.4); // instrument binnacle
  box(blackMat, 20, 9, 2, 6, 130, 38, 0, 0, 0, 0.8); // center screen
  for (const s of [1, -1] as const) {
    box(interiorMat, 40, 10, 42, s * 34, 68, -20, 0, 0, 0, 2); // seat cushion
    box(interiorMat, 40, 46, 9, s * 34, 96, -44, -0.15, 0, 0, 2); // seat back
    box(interiorMat, 18, 12, 8, s * 34, 124, -48, -0.15, 0, 0, 1.6); // headrest
  }
  box(interiorMat, 100, 10, 36, 0, 68, -110, 0, 0, 0, 2); // rear bench
  box(interiorMat, 100, 40, 8, 0, 92, -130, -0.1, 0, 0, 2); // bench back
  box(interiorMat, 24, 14, 50, 0, 66, -8, 0, 0, 0, 1.6); // center console
  cyl(blackMatteMat, 1.2, 1.2, 14, 8, 0, 78, -2, -0.3, 0, 0); // gear lever
  ball(blackMatteMat, 2.2, 0, 85.6, -6.2, 8); // knob
  torus(blackMat, 13, 1.8, HI ? 8 : 6, HI ? 20 : 12, -34, 122, 34, -0.5, 0, 0); // steering wheel
  for (const a of [0, 2.1, -2.1]) {
    box(blackMat, 2, 12, 2, -34 + Math.sin(a) * 6, 122 - Math.cos(a) * 5.4, 34 + Math.cos(-0.5) * 6, -0.5, 0, a, 0.8);
  }
  cyl(blackMat, 2, 2, 14, 8, -34, 116, 40, -1.1, 0, 0); // steering column
  box(blackMatteMat, 8, 10, 4, -44, 58, 44, 0, 0, 0, 0.8); // pedals
  box(blackMatteMat, 8, 7, 4, -34, 58, 44, 0, 0, 0, 0.8);

  /* ------------------------------- underbody ----------------------------- */
  box(steelDarkMat, 60, 16, 80, 10, 42, -80, 0, 0, 0, 2); // fuel tank
  for (const tz of [-110, -50]) {
    box(steelDarkMat, 64, 3, 5, 10, 41, tz);
  }
  box(steelDarkMat, 90, 3, 60, 0, 44, 60, 0, 0, 0, 1.5); // transmission skid
  box(steelDarkMat, 40, 12, 30, 0, 46, 20, 0, 0, 0, 2); // transfer case

  /* -------------------------- merge into meshes -------------------------- */
  let meshCount = 0;
  let triangleCount = 0;
  for (const [mat, bucket] of buckets) {
    const merged = bucket.build();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mat !== glassMat;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshCount += 1;
    triangleCount += merged.attributes.position.count / 3;
  }
  // the four road wheels are extra merged meshes hanging off their pivots
  for (const w of roadWheels) {
    for (const child of w.spin.children) {
      if (child instanceof THREE.Mesh) {
        meshCount += 1;
        triangleCount += child.geometry.attributes.position.count / 3;
      }
    }
  }
  const shapeCount =
    Array.from(buckets.values()).reduce((sum, b) => sum + b.count, 0) +
    roadWheelShapes;
  console.log(
    `[jeepProp] ${shapeCount} primitives merged into ${meshCount} draw calls (${Math.round(triangleCount)} triangles, ${lowSpec ? 'LOW_SPEC' : 'full detail'})`
  );

  scene.add(group);

  /* ========================================================================
   * DRIVING — arcade car model
   * ===================================================================== */
  const MAX_FWD = 2222; // u/s — HUD reads speed*0.09 km/h => 200 km/h top
  const MAX_REV = 460;
  const ACCEL = 1350; // full-throttle acceleration u/s² (reaches 200 fast)
  const REV_ACCEL = 300;
  const BRAKE_DECEL = 1400; // Space handbrake
  const DRAG_K = 0.55; // proportional drag while coasting
  const ROLL_RESIST = 55; // constant coast-down
  const STEER_RATE = 1.5; // rad/s at full lock (before high-speed fade)
  const STEER_SPEED_REF = 260; // u/s at which steering gains full authority
  const STEER_ATTEN = 1200; // u/s — beyond this the lock progressively fades
  const WHEEL_STEER_MAX = 0.46; // rad — visual front-wheel angle
  // --- SMOOTH SUSPENSION: the body rides on spring-damper mounts — tuned
  // VERY LIGHT: a firm, near-rigid ride that only barely cushions the
  // terrain instead of wallowing over it (no bounce, no visible squat)
  const SUS_STIFFNESS = 140; // spring rate 1/s² — stiff coil (~1.9 Hz): tiny sag, quick follow
  const SUS_DAMPING = 26; // damper 1/s — ratio ≈1.1 (overdamped): zero bounce, firm settle
  const WHEEL_TRAVEL = 4; // max wheel stroke vs the sprung body (u) — barely-visible articulation
  // --- drift model: cornering throws the rear out, Space cuts grip ---
  const DRIFT_SLIDE = 0.62; // how hard cornering converts into sideways slide
  const GRIP = 7.5; // lateral velocity decay 1/s (grippy)
  const GRIP_DRIFT = 3.0; // sustained slide — the car hangs sideways
  const GRIP_HANDBRAKE = 1.7; // Space loosens the rear -> the drift trigger
  const DRIFT_MIN = 60; // u/s of slide before marks + smoke kick in
  const DRIFT_MIN_EXIT = 34; // slide must die below this to regain grip
  const DRIFT_SCRUB = 0.5; // sliding tyres scrub off forward speed
  const SLIP_BRAKE = 220; // u/s — braking harder than this locks the fronts
  const SLIP_LAUNCH = 160; // u/s — full-throttle launch spins the rears

  let driving = false;
  let speed = 0;
  let lateral = 0; // sideways slide velocity (+ = sliding to the car's right)
  let drifting = false;
  let steerVis = 0; // smoothed visual front-wheel angle
  let steerSmooth = 0; // eased steering input — progressive wheel turn
  let throttleSmooth = 0; // eased throttle — engine response lag
  let bodyPitch = 0; // sprung body pitch (spring position, rad)
  let bodyRoll = 0; // sprung body roll (spring position, rad)
  let bodyY = 0; // sprung body height (spring position, world u)
  let bodyYVel = 0; // heave spring velocity, u/s
  let bodyPitchVel = 0; // pitch spring velocity, rad/s
  let bodyRollVel = 0; // roll spring velocity, rad/s

  /* ========================================================================
   * EXHAUST SMOKE — pooled sprite puffs off the twin silencer tips.
   * Emission rate scales with speed (idle tick-over -> dense trail) and
   * throttle load darkens the smoke like a working diesel.
   * ===================================================================== */
  const smokeTex = canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
  interface SmokePuff {
    sprite: THREE.Sprite;
    vel: THREE.Vector3;
    age: number;
    life: number;
    s0: number;
    active: boolean;
  }
  const smokePuffs: SmokePuff[] = [];
  const smokeGroup = new THREE.Group();
  scene.add(smokeGroup);
  for (let i = 0; i < (lowSpec ? 22 : 44); i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      color: 0xccd1d6,
      fog: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    smokeGroup.add(sprite);
    smokePuffs.push({ sprite, vel: new THREE.Vector3(), age: 0, life: 1, s0: 8, active: false });
  }
  let smokeCursor = 0;
  let emitAccum = 0;
  const smokeAccum4 = [0, 0, 0, 0]; // per-tyre rubber-smoke accumulators
  const wheelSlip = [0, 0, 0, 0]; // per-tyre slip 0..1 this frame
  let tipToggle = 0;

  // silencer tip positions in jeep-local space (just above the curled pipes)
  const EXHAUST_TIPS: Array<[number, number, number]> = [
    [-82, 97, -251],
    [-74, 105, -255],
  ];

  function spawnSmoke(
    x: number,
    y: number,
    z: number,
    velX: number,
    velY: number,
    velZ: number,
    scale: number,
    life: number,
    load: number
  ): void {
    const p = smokePuffs[smokeCursor];
    smokeCursor = (smokeCursor + 1) % smokePuffs.length;
    p.sprite.position.set(x, y, z);
    p.vel.set(velX, velY, velZ);
    p.age = 0;
    p.life = life;
    p.s0 = scale;
    p.active = true;
    p.sprite.visible = true;
    p.sprite.material.opacity = 0.38;
    // throttle load tints the puff from light vapour to working-engine grey
    p.sprite.material.color.setHex(0xccd1d6).lerp(new THREE.Color(0x767d84), load);
    p.sprite.scale.setScalar(scale);
  }

  /** One puff from the active silencer tip, trailing behind the jeep. */
  function emitExhaustPuff(load: number): void {
    const [tx, ty, tz] = EXHAUST_TIPS[tipToggle % EXHAUST_TIPS.length];
    tipToggle += 1;
    const h = group.rotation.y;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    const wx = group.position.x + tx * cos + tz * sin;
    const wz = group.position.z - tx * sin + tz * cos;
    const wy = group.position.y + ty;
    // blow backwards relative to the jeep + upward, with a little jitter.
    // the backward bias grows only gently with speed so the trail stays
    // visible behind the chase camera even at 200 km/h
    const back = 6 + Math.abs(speed) * 0.08;
    const jx = (Math.random() - 0.5) * 14;
    const jz = (Math.random() - 0.5) * 14;
    spawnSmoke(
      wx + jx * 0.3,
      wy,
      wz + jz * 0.3,
      -Math.sin(h) * back + jx + Math.sin(tipToggle * 12.9898) * 6,
      12 + Math.random() * 14,
      -Math.cos(h) * back + jz + Math.cos(tipToggle * 78.233) * 6,
      7 + Math.random() * 4 + Math.abs(speed) * 0.004,
      1.0 + Math.random() * 0.7,
      load
    );
  }

  function updateSmoke(dt: number): void {
    for (const p of smokePuffs) {
      if (!p.active) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.vel.y += 16 * dt; // warm exhaust rises
      p.vel.x *= 1 - 1.6 * dt;
      p.vel.z *= 1 - 1.6 * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.material.opacity = 0.38 * (1 - k) * (k < 0.12 ? k / 0.12 : 1);
      p.sprite.scale.setScalar(p.s0 * (1 + 2.4 * k));
    }
  }

  function updateFx(dt: number): void {
    updateSmoke(dt);
    fadeSkids(Math.min(dt, 0.1)); // marks keep fading while on foot
  }

  function smokeBurst(count: number): void {
    for (let i = 0; i < count; i++) {
      emitExhaustPuff(0.5);
    }
  }

  /* ========================================================================
   * SKID MARKS — every SLIPPING tyre burns its own tread ribbon into the
   * terrain. One rolling-buffer mesh holds every segment (2 triangles each):
   * dropping a mark rewrites only 12 position floats + 4 colour floats, zero
   * allocation. Slip drives each ribbon's width (light scrub -> full-lock
   * smear) and darkness, and every segment fades away over SKID_LIFE
   * seconds like real rubber wearing off the road.
   * ===================================================================== */
  const skidTex = canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = 'rgba(24,24,27,0.94)';
    ctx.fillRect(0, 0, 64, 64);
    // lengthwise tread grooves (lighter strips the ground peeks through)
    ctx.fillStyle = 'rgba(60,60,64,0.55)';
    ctx.fillRect(0, 6, 64, 5);
    ctx.fillRect(0, 30, 64, 5);
    ctx.fillRect(0, 53, 64, 5);
    // faint cross-bars like a real mud-terrain footprint
    ctx.fillStyle = 'rgba(45,45,49,0.5)';
    for (let i = 0; i < 4; i++) ctx.fillRect(0, i * 16 + 12, 64, 3);
  });
  skidTex.wrapS = THREE.RepeatWrapping;
  skidTex.wrapT = THREE.RepeatWrapping;

  const SKID_POOL = lowSpec ? 130 : 280; // segments (all four wheels share)
  const SKID_VERTS = SKID_POOL * 4;
  const skidPos = new Float32Array(SKID_VERTS * 3); // unused = collapsed
  const skidUV = new Float32Array(SKID_VERTS * 2);
  const skidCol = new Float32Array(SKID_VERTS * 4); // per-segment fading alpha
  const skidIndex = new Uint16Array(SKID_POOL * 6);
  for (let i = 0; i < SKID_POOL; i++) {
    const v = i * 4;
    skidIndex.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
  }
  const skidGeo = new THREE.BufferGeometry();
  skidGeo.setAttribute('position', new THREE.BufferAttribute(skidPos, 3));
  skidGeo.setAttribute('uv', new THREE.BufferAttribute(skidUV, 2));
  skidGeo.setAttribute('color', new THREE.BufferAttribute(skidCol, 4));
  skidGeo.setIndex(new THREE.BufferAttribute(skidIndex, 1));
  const skidMat = new THREE.MeshBasicMaterial({
    map: skidTex,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const skidMesh = new THREE.Mesh(skidGeo, skidMat);
  skidMesh.frustumCulled = false;
  skidMesh.renderOrder = 2; // draw after the terrain, before smoke
  scene.add(skidMesh);
  let skidCursor = 0;
  const skidAge = new Float32Array(SKID_POOL); // seconds since stamped
  const skidAlpha = new Float32Array(SKID_POOL); // alpha the segment starts with
  const SKID_W_MIN = 26; // light scrub ribbon width
  const SKID_W_MAX = 40; // full-lock slide smear width
  const SKID_LIFE = 16; // seconds before a mark has fully faded away
  const SKID_SEG = 16; // drop a fresh mark every this many units per wheel
  const SKID_LIFT = 3; // hover above the ground to avoid z-fighting

  // per-wheel ribbon state: last stamped contact + tread distance for UVs
  const wheelTrail = roadWheels.map(() => ({
    x: 0,
    z: 0,
    v: 0,
    live: false,
  }));

  /** Stamp one tread segment from (ax,az) to (bx,bz). `slip` 0..1 drives the
   *  ribbon's width and darkness; every corner samples the ground so marks
   *  hug side slopes instead of clipping into hills. */
  function dropSkid(
    wheel: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    slip: number
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const ux = dx / len;
    const uz = dz / len;
    const half = (SKID_W_MIN + (SKID_W_MAX - SKID_W_MIN) * slip) / 2;
    const px = -uz * half;
    const pz = ux * half;
    const trail = wheelTrail[wheel];
    const v0 = trail.v;
    const v1 = v0 + len / 26; // the tread texture repeats every 26 units
    trail.v = v1;
    const i = skidCursor;
    skidCursor = (skidCursor + 1) % SKID_POOL;
    const o = i * 12;
    const yAL = heightAt(ax - px, az - pz) + SKID_LIFT;
    const yAR = heightAt(ax + px, az + pz) + SKID_LIFT;
    const yBL = heightAt(bx - px, bz - pz) + SKID_LIFT;
    const yBR = heightAt(bx + px, bz + pz) + SKID_LIFT;
    skidPos[o] = ax - px; skidPos[o + 1] = yAL; skidPos[o + 2] = az - pz;
    skidPos[o + 3] = ax + px; skidPos[o + 4] = yAR; skidPos[o + 5] = az + pz;
    skidPos[o + 6] = bx - px; skidPos[o + 7] = yBL; skidPos[o + 8] = bz - pz;
    skidPos[o + 9] = bx + px; skidPos[o + 10] = yBR; skidPos[o + 11] = bz + pz;
    const uo = i * 8;
    skidUV[uo] = 0; skidUV[uo + 1] = v0;
    skidUV[uo + 2] = 1; skidUV[uo + 3] = v0;
    skidUV[uo + 4] = 0; skidUV[uo + 5] = v1;
    skidUV[uo + 6] = 1; skidUV[uo + 7] = v1;
    // freshness + slip set the starting darkness; fadeSkids ages it out
    const a = 0.3 + slip * 0.48;
    skidAlpha[i] = a;
    skidAge[i] = 0;
    const co = i * 16 + 3;
    skidCol[co] = a; skidCol[co + 4] = a; skidCol[co + 8] = a; skidCol[co + 12] = a;
    skidGeo.attributes.position.needsUpdate = true;
    skidGeo.attributes.uv.needsUpdate = true;
    skidGeo.attributes.color.needsUpdate = true;
  }

  /** Age every live segment and ease its alpha to zero — marks wear away
   *  like real rubber, then the slot is silently reusable by the pool. */
  function fadeSkids(dt: number): void {
    let dirty = false;
    for (let i = 0; i < SKID_POOL; i++) {
      if (skidAge[i] >= SKID_LIFE) continue;
      skidAge[i] += dt;
      const k = 1 - skidAge[i] / SKID_LIFE;
      const a = k <= 0 ? 0 : skidAlpha[i] * (k * (2 - k)); // ease-out fade
      const co = i * 16 + 3;
      skidCol[co] = a; skidCol[co + 4] = a; skidCol[co + 8] = a; skidCol[co + 12] = a;
      dirty = true;
    }
    if (dirty) skidGeo.attributes.color.needsUpdate = true;
  }

  /* --------------------------- drive integration -------------------------- */
  function updateDrive(dt: number, input: JeepDriveInput): JeepDriveState {
    driving = true;
    const step = Math.min(dt, 1 / 20); // lag-spike safety
    const t = THREE.MathUtils.clamp(input.throttle, -1, 1);
    const steering = THREE.MathUtils.clamp(input.steer, -1, 1);

    // --- analog easing: the wheel turns progressively and the engine
    // spools up, so binary keys produce smooth, flowing inputs ---
    const easeUp = 1 - Math.exp(-6.5 * step);
    const easeDown = 1 - Math.exp(-10 * step);
    steerSmooth +=
      (steering - steerSmooth) *
      (Math.abs(steering) > Math.abs(steerSmooth) ? easeUp : easeDown);
    if (Math.abs(steerSmooth) < 0.002) steerSmooth = 0;
    throttleSmooth +=
      (t - throttleSmooth) *
      (Math.abs(t) > Math.abs(throttleSmooth)
        ? 1 - Math.exp(-5 * step)
        : easeDown);

    // --- longitudinal: brake / throttle / reverse / coast ---
    let accel: number;
    if (input.brake) {
      accel = speed > 0 ? -BRAKE_DECEL : speed < 0 ? BRAKE_DECEL : 0;
    } else if (t > 0.01) {
      accel = speed < -10 ? BRAKE_DECEL : throttleSmooth * ACCEL; // brake out of reverse
    } else if (t < -0.01) {
      accel = speed > 10 ? -BRAKE_DECEL : throttleSmooth * REV_ACCEL;
    } else {
      accel = speed > 0 ? -ROLL_RESIST : speed < 0 ? ROLL_RESIST : 0;
      if (Math.abs(speed) < 6) speed = 0;
    }
    speed += accel * step;
    if (!input.brake) speed -= speed * DRAG_K * step;
    speed = THREE.MathUtils.clamp(speed, -MAX_REV, MAX_FWD);

    // --- steering: authority ramps in with speed, then fades off toward
    // top speed (a 200 km/h car must not snap-rotate). A sliding car rotates
    // livelier — the rear is already loose — and the handbrake sharpens yaw
    // for the classic flick. ---
    const authority = Math.min(1, Math.abs(speed) / STEER_SPEED_REF);
    const atten = 1 / (1 + Math.abs(speed) / STEER_ATTEN);
    const dir = speed >= 0 ? 1 : -1;
    const driftYaw = drifting ? 1 + Math.min(0.3, Math.abs(lateral) / 850) : 1;
    const yawRate = STEER_RATE * atten * (input.brake ? 1.4 : 1) * driftYaw;
    const heading =
      group.rotation.y + steerSmooth * yawRate * authority * dir * step;

    // --- DRIFT: cornering throws the rear out; the handbrake converts
    // steering into slide far harder (the flick) and cuts grip. Holding
    // throttle keeps a slide alive — power oversteer — while counter-steer
    // tames it. Hysteresis stops the state flickering at the threshold. ---
    const slideConv = DRIFT_SLIDE * (input.brake ? 1.6 : 1);
    lateral +=
      steerSmooth * yawRate * authority * dir * speed * slideConv * step;
    const gripBase = input.brake
      ? GRIP_HANDBRAKE
      : drifting
        ? GRIP_DRIFT
        : GRIP;
    const gripEff =
      drifting && !input.brake && t > 0.05 ? gripBase * 0.72 : gripBase;
    lateral *= Math.exp(-gripEff * step);
    const latMax = Math.max(60, Math.abs(speed)) * 0.85;
    lateral = THREE.MathUtils.clamp(lateral, -latMax, latMax);
    const absLat = Math.abs(lateral);
    const absSpd = Math.abs(speed);
    drifting =
      absLat > (drifting ? DRIFT_MIN_EXIT : DRIFT_MIN) && absSpd > 110;
    if (drifting) {
      // sliding tyres scrub off forward speed
      speed -= Math.sign(speed) * Math.min(absSpd, absLat * DRIFT_SCRUB * step);
    }

    // --- integrate the move: forward*speed + right*lateral ---
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const nx = group.position.x + (sinH * speed + cosH * lateral) * step;
    const nz = group.position.z + (cosH * speed - sinH * lateral) * step;

    // --- terrain follow: sample the ground under all four wheel pads ---
    const padY = (lx: number, lz: number): number =>
      heightAt(nx + lx * cosH + lz * sinH, nz - lx * sinH + lz * cosH);
    const hFR = padY(TRACK_X, AXLE_F); // front-right (+X = right)
    const hFL = padY(-TRACK_X, AXLE_F);
    const hRR = padY(TRACK_X, AXLE_R);
    const hRL = padY(-TRACK_X, AXLE_R);
    const targetY = (hFR + hFL + hRR + hRL) / 4;
    // nose tips UP uphill: rotation.x positive tips forward (+Z) down
    const targetPitch = -Math.atan2(
      (hFR + hFL) / 2 - (hRR + hRL) / 2,
      AXLE_F - AXLE_R
    );
    // right side rises: rotation.z positive lifts +X
    const targetRoll = Math.atan2(
      (hFR + hRR) / 2 - (hFL + hRL) / 2,
      TRACK_X * 2
    );

    // --- SMOOTH SUSPENSION (LIGHT TUNE): the body is a mass riding on
    // stiff, overdamped spring-damper mounts. Every frame a Hooke force
    // pulls height/pitch/roll toward the terrain target while a heavy
    // damper bleeds the velocity — the stiff spring keeps the ride firm
    // and tight (the body only barely cushions bumps, then locks onto
    // the ground with no overshoot or wobble), and weight transfer is
    // folded into the SAME springs but at whisper amplitude: a hint of
    // squat/dive and a trace of lean instead of body roll.
    // (Stability: step is capped at 1/20 s — k·dt² = 0.35 and 1−c·dt =
    // −0.3 stay inside the semi-implicit Euler stability region.)
    const spring = (
      pos: number,
      vel: number,
      target: number,
      dt: number
    ): [number, number] => {
      const v =
        vel + ((target - pos) * SUS_STIFFNESS - vel * SUS_DAMPING) * dt;
      return [pos + v * dt, v];
    };
    const accelVis = THREE.MathUtils.clamp(accel / ACCEL, -1, 1);
    const pitchTarget = targetPitch - accelVis * 0.014; // faint squat / brake dive
    const rollTarget =
      targetRoll + // trace of cornering lean + outward slide roll
      steerSmooth *
        authority *
        Math.min(1, Math.abs(speed) / MAX_FWD) *
        0.016 -
      THREE.MathUtils.clamp(lateral / 500, -1, 1) * 0.018;
    [bodyY, bodyYVel] = spring(bodyY, bodyYVel, targetY, step);
    [bodyPitch, bodyPitchVel] = spring(
      bodyPitch,
      bodyPitchVel,
      pitchTarget,
      step
    );
    [bodyRoll, bodyRollVel] = spring(bodyRoll, bodyRollVel, rollTarget, step);

    group.position.set(nx, bodyY, nz);
    group.rotation.order = 'YXZ'; // yaw first so pitch/roll stay in the car frame
    group.rotation.y = heading;
    group.rotation.x = bodyPitch; // fully sprung (terrain + squat/dive)
    group.rotation.z = bodyRoll; // fully sprung (terrain + lean + slide roll)

    // --- wheels: roll + steer visuals; locked tyres stop turning, a power
    // slide spins the rears faster than the road does ---
    const rollDelta = (speed / WHEEL_R) * step;
    steerVis +=
      (steerSmooth * WHEEL_STEER_MAX * dir - steerVis) * (1 - Math.exp(-10 * step));
    for (const w of roadWheels) {
      let roll = rollDelta;
      if (input.brake && absSpd > 40) roll *= w.steers ? 0.25 : 0.1;
      else if (drifting && !w.steers && t > 0.05) roll *= 1.4;
      w.spin.rotation.x += w.spinSign * roll;
      if (w.steers) {
        w.pivot.rotation.y = (w.spinSign === 1 ? 0 : Math.PI) + steerVis;
      }
      // --- suspension travel: every wheel rides its OWN corner of the
      // terrain while the sprung body floats between the axles — over a
      // bump the wheels stroke UP into the arches, into dips they hang
      // OUT (the exposed coil/shock detail visibly compresses) — clamped
      // to the travel range like real bump stops ---
      const groundH = w.steers
        ? w.spinSign === 1
          ? hFR
          : hFL
        : w.spinSign === 1
          ? hRR
          : hRL;
      w.pivot.position.y =
        WHEEL_R +
        THREE.MathUtils.clamp(
          groundH - bodyY,
          -WHEEL_TRAVEL,
          WHEEL_TRAVEL
        );
    }

    // --- SKID MARKS: every tyre that slips burns its own ribbon. Rears
    // slide in a drift, lock under the handbrake and spin on a hard launch;
    // fronts slide in the drift and lock under heavy braking. ---
    const handbrakeLock = input.brake && absSpd > 40;
    const brakeLock = input.brake && absSpd > SLIP_BRAKE;
    const launchSpin = t > 0.85 && speed > -10 && absSpd < SLIP_LAUNCH;
    for (let i = 0; i < roadWheels.length; i++) {
      const w = roadWheels[i];
      const lx = w.spinSign === 1 ? TRACK_X : -TRACK_X;
      const lz = w.steers ? AXLE_F : AXLE_R;
      const wx = nx + lx * cosH + lz * sinH;
      const wz = nz - lx * sinH + lz * cosH;
      let slip = 0;
      if (drifting) slip = Math.min(1, 0.25 + absLat / 420);
      if (!w.steers) {
        if (handbrakeLock) slip = Math.max(slip, 0.9);
        if (launchSpin) slip = Math.max(slip, 0.5);
      } else if (brakeLock) {
        slip = Math.max(slip, Math.min(1, 0.35 + absSpd / MAX_FWD));
      }
      wheelSlip[i] = slip;
      const trail = wheelTrail[i];
      if (slip > 0.12) {
        if (trail.live) {
          const ddx = wx - trail.x;
          const ddz = wz - trail.z;
          if (ddx * ddx + ddz * ddz > SKID_SEG * SKID_SEG) {
            dropSkid(i, trail.x, trail.z, wx, wz, slip);
            trail.x = wx;
            trail.z = wz;
          }
        } else {
          trail.live = true;
          trail.x = wx;
          trail.z = wz;
        }
      } else {
        trail.live = false; // grip regained — the next slide starts a fresh ribbon
      }
    }
    fadeSkids(step);

    // --- rubber smoke: boils off EVERY sliding tyre, denser the harder it
    // slips, tinted darker like burnt rubber and drifting with the slide ---
    for (let i = 0; i < roadWheels.length; i++) {
      const s = wheelSlip[i];
      if (s <= 0.12) {
        smokeAccum4[i] = 0;
        continue;
      }
      const w = roadWheels[i];
      const lx = w.spinSign === 1 ? TRACK_X : -TRACK_X;
      const lz = w.steers ? AXLE_F : AXLE_R;
      smokeAccum4[i] += step * (2.5 + s * 10);
      while (smokeAccum4[i] >= 1) {
        smokeAccum4[i] -= 1;
        spawnSmoke(
          nx + lx * cosH + lz * sinH + (Math.random() - 0.5) * 16,
          padY(lx, lz) + 8,
          nz - lx * sinH + lz * cosH + (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 36 + cosH * lateral * 0.3,
          14 + Math.random() * 20,
          (Math.random() - 0.5) * 36 - sinH * lateral * 0.3,
          8 + s * 9 + Math.random() * 5,
          0.75 + Math.random() * 0.5,
          0.45 // darker tint: burnt rubber, not exhaust vapour
        );
      }
    }

    // --- exhaust smoke: rate scales with speed + throttle load ---
    const load = Math.min(1, Math.abs(t) * 0.7 + Math.abs(speed) / MAX_FWD * 0.5);
    const rate = 3.2 + (Math.abs(speed) / MAX_FWD) * 30 + Math.abs(t) * 7;
    emitAccum += step * rate;
    while (emitAccum >= 1) {
      emitAccum -= 1;
      emitExhaustPuff(load);
    }

    return { speed, maxSpeed: MAX_FWD, heading, lateral, drifting };
  }

  function isDriving(): boolean {
    return driving;
  }

  /* ------------------------------- handle -------------------------------- */
  function place(x: number, z: number, y: number, rotationY = 0): void {
    group.position.set(x, y, z);
    group.rotation.set(0, rotationY, 0);
    bodyPitch = 0;
    bodyRoll = 0;
    bodyY = y; // suspension starts settled at the placed height
    bodyYVel = 0;
    bodyPitchVel = 0;
    bodyRollVel = 0;
    speed = 0;
    lateral = 0;
    drifting = false;
    steerVis = 0;
    steerSmooth = 0;
    throttleSmooth = 0;
    for (const w of roadWheels) {
      w.spin.rotation.x = 0;
      w.pivot.position.y = WHEEL_R; // suspension strokes reset
      if (w.steers) w.pivot.rotation.y = w.spinSign === 1 ? 0 : Math.PI;
    }
    for (const tr of wheelTrail) tr.live = false;
  }

  function collide(
    px: number,
    pz: number,
    radius: number
  ): { x: number; z: number } | null {
    const dx = px - group.position.x;
    const dz = pz - group.position.z;
    const cos = Math.cos(group.rotation.y);
    const sin = Math.sin(group.rotation.y);
    // world -> jeep local (inverse of the yaw rotation)
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    // closest point on the footprint rectangle
    const qx = Math.max(-COLLIDE_HW, Math.min(COLLIDE_HW, lx));
    const qz = Math.max(-COLLIDE_HL, Math.min(COLLIDE_HL, lz));
    const ox = lx - qx;
    const oz = lz - qz;
    const d2 = ox * ox + oz * oz;
    if (d2 > radius * radius) return null;
    let nlx: number;
    let nlz: number;
    if (d2 > 1e-6) {
      // outside the rectangle but within radius: push out along the normal
      const d = Math.sqrt(d2);
      const push = (radius - d) / d;
      nlx = lx + ox * push;
      nlz = lz + oz * push;
    } else {
      // center inside the footprint: exit along the shallowest axis
      const penX = COLLIDE_HW - Math.abs(lx) + radius;
      const penZ = COLLIDE_HL - Math.abs(lz) + radius;
      if (penX < penZ) {
        nlx = (lx >= 0 ? COLLIDE_HW + radius : -COLLIDE_HW - radius);
        nlz = lz;
      } else {
        nlx = lx;
        nlz = (lz >= 0 ? COLLIDE_HL + radius : -COLLIDE_HL - radius);
      }
    }
    // local -> world
    return {
      x: group.position.x + nlx * cos + nlz * sin,
      z: group.position.z - nlx * sin + nlz * cos,
    };
  }

  function stats(): { shapes: number; meshes: number; triangles: number } {
    return { shapes: shapeCount, meshes: meshCount, triangles: Math.round(triangleCount) };
  }

  function dispose(): void {
    scene.remove(group);
    scene.remove(smokeGroup);
    scene.remove(skidMesh);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    smokeGroup.traverse((o) => {
      if (o instanceof THREE.Sprite) {
        o.material.dispose();
      }
    });
    smokeTex.dispose();
    skidTex.dispose();
    skidGeo.dispose();
    skidMat.dispose();
    shineEnv.dispose();
    for (const mat of buckets.keys()) mat.dispose();
    grilleMat.map?.dispose();
    tireSideMat.map?.dispose();
    tireCapMat.map?.dispose();
  }

  return {
    group,
    place,
    collide,
    updateDrive,
    updateFx,
    smokeBurst,
    isDriving,
    stats,
    suspension: () => ({
      bodyY,
      heaveVel: bodyYVel,
      pitch: bodyPitch,
      roll: bodyRoll,
      strokes: roadWheels.map((w) =>
        Number((w.pivot.position.y - WHEEL_R).toFixed(2))
      ),
    }),
    dispose,
  };
}
