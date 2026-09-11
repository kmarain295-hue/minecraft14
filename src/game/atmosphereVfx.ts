/**
 * Atmosphere VFX for RATFIRE — the drama layer on top of the day/night +
 * storm systems (the RAIN_WINDOW / CYCLE_SECONDS drivers live in page.tsx).
 *
 * ONE pooled module, THREE effects:
 *
 *  1. LIGHTNING — during heavy rain (storm > 0.45) forked bolts strike the
 *     terrain around the player: a jagged camera-facing quad chain from the
 *     cloud deck to the ground (jittered main channel + 1-3 side branches),
 *     a double-flicker alpha envelope, a pooled point-light pop that
 *     illuminates the hills, a whole-screen white flash (self-managed DOM
 *     overlay) and a DISTANCE-DELAYED synthesized thunder rumble. The first
 *     strike of every storm lands within a few seconds — guaranteed drama.
 *     Every flash also lights the CLOUD DECK ITSELF from within: the strike
 *     cell blooms through the cloud shapes (skyClouds.applyFlash) and a
 *     SHEET-LIGHTNING scheduler flickers intra-cloud glows between bolts —
 *     ~1 in 3 escalates into a full ground strike out of the same cell.
 *  2. SHOOTING STARS — meteors cross the night sky (moon up, storm low):
 *     a bright additive head + gradient streak riding the velocity vector,
 *     re-anchored to the camera every frame like the star field; ~1 in 4
 *     is RARE and sprays a lingering sparkle tail (additive points pool).
 *  3. FOOTSTEP + LANDING DUST — pooled tan sprite puffs: small kicks
 *     behind the feet while running (page drives the cadence) and a radial
 *     burst on hard landings scaled by the impact speed — falls that HURT
 *     also billow MORE dust.
 *
 * LOW_SPEC (phones) thins every pool and drops one branch off each bolt.
 * All ephemeral — Math.random is fine, nothing here needs determinism.
 */

import * as THREE from 'three';
import type { CloudFlashState } from './skyClouds';

/* ------------------------------- tuning ---------------------------------- */

// --- lightning ---
const STORM_TRIGGER = 0.45; // rain intensity above which bolts can strike
const FIRST_STRIKE = [1.4, 3.6]; // s — first bolt after a storm rolls in
const NEXT_STRIKE = [7, 16]; // s — spacing between bolts in one storm
const BOLT_SEGMENTS = 14; // main channel points
const BOLT_LIFE = 0.34; // s of double-flicker
const BOLT_WIDTH = 30; // main channel quad width (world units)
const BOLT_TAPER = 0.35; // how much thinner the bolt gets toward the ground
const BOLT_JITTER = [280, 40]; // perpendicular jitter: top -> ground
const STRIKE_RANGE = [700, 3600]; // strike distance from the player
const FLASH_MAX = 0.5; // peak whole-screen white flash opacity
const LIGHT_PEAK = 60; // pooled point-light pop intensity
const LIGHT_FADE = 0.2; // s for the light pop to die out

// --- sheet lightning (intra-cloud flicker between ground strikes) ---
const SHEET_FIRST = [0.8, 2.4]; // s after a storm crosses the trigger
const SHEET_NEXT = [2.2, 7.5]; // s between intra-cloud flashes
const SHEET_LIFE = 0.55; // s of multi-pop flicker
const SHEET_RANGE = [900, 4600]; // glow cell distance from the player
const SHEET_RADIUS = [2200, 4200]; // deck glow falloff radius
const SHEET_ESCALATE = 0.34; // chance a sheet flash spawns a ground bolt
const SHEET_LIGHT_PEAK = 22; // pooled terrain light for sheet flashes
const SHEET_THUNDER = 0.45; // chance a sheet flash rolls distant thunder

// --- shooting stars ---
const METEOR_RADIUS = 9000; // sky-sphere anchor (inside camera.far)
const METEOR_DUR = [0.8, 1.5]; // s across the sky
const METEOR_TRAVEL = [3200, 5600]; // world units of arc
const METEOR_HEAD = [90, 150]; // head sprite size
const METEOR_TAIL = [380, 780]; // streak length
const METEOR_RARE = 0.26; // chance of a sparkle-tail meteor
const SPARKLE_POOL = 90; // pooled tail points (additive)

// --- dust ---
const DUST_POOL = 40; // puff sprites (LOW_SPEC: 20)
const DUST_FOOTSTEP = [0.4, 0.65]; // puff life range
const DUST_COLOR = 0xcbb694; // dry-earth tan

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
  return tex;
}

/** Soft elliptical glow — one bolt segment quad. Hot core + wide halo so
 *  the channel reads even at 3 km. */
function boltSegmentTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.32, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(226,240,255,0.9)');
    g.addColorStop(0.72, 'rgba(150,195,255,0.42)');
    g.addColorStop(1, 'rgba(110,165,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/** Meteor head: hot dot with a tight halo. */
function dotTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,250,1)');
    g.addColorStop(0.35, 'rgba(255,244,214,0.9)');
    g.addColorStop(0.7, 'rgba(255,220,160,0.25)');
    g.addColorStop(1, 'rgba(255,210,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

/** Meteor streak: bright at the head (right), fading down the tail. */
function streakTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 32, (ctx) => {
    const along = ctx.createLinearGradient(0, 0, 256, 0);
    along.addColorStop(0, 'rgba(255,235,190,0)');
    along.addColorStop(0.55, 'rgba(255,228,170,0.5)');
    along.addColorStop(0.9, 'rgba(255,244,220,0.95)');
    along.addColorStop(1, 'rgba(255,255,245,0)');
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, 256, 32);
    // soften across the width (destination-out on the edges)
    const across = ctx.createLinearGradient(0, 0, 0, 32);
    across.addColorStop(0, 'rgba(0,0,0,1)');
    across.addColorStop(0.5, 'rgba(0,0,0,0)');
    across.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, 256, 32);
  });
}

/** Small dust puff. */
function dustTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 7; i++) {
      const x = 16 + Math.random() * 32;
      const y = 16 + Math.random() * 32;
      const r = 4 + Math.random() * 9;
      const p = ctx.createRadialGradient(x, y, 1, x, y, r);
      p.addColorStop(0, 'rgba(255,255,255,0.18)');
      p.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = p;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

/* ------------------------------- types ----------------------------------- */

/** Per-frame world state pushed by page.tsx (same numbers the sky uses). */
export interface AtmosContext {
  camera: THREE.Camera;
  playerPos: THREE.Vector3;
  /** Normalized direction TO the sun. */
  sunDir: THREE.Vector3;
  /** 0..1 sun/moon height factors (same smoothsteps updateSky uses). */
  sunUp: number;
  moonUp: number;
  /** 0..1 storm intensity (rain). */
  storm: number;
}

export interface AtmosphereVfxHandle {
  /** Drive every effect. Call once per frame after the sky update. */
  update(dt: number, ctx: AtmosContext): void;
  /** One small dust kick at a foot position (page drives running cadence
   *  and alternates left/right; `sprint` scales the puff count + size). */
  footstep(x: number, y: number, z: number, sprint: boolean): void;
  /** Landing burst; `impact` is the landing speed (fall-damage units). */
  landing(x: number, y: number, z: number, impact: number): void;
  stats(): {
    strikes: number;
    sheets: number;
    meteors: number;
    sparkles: number;
    footsteps: number;
    landings: number;
    flashAlpha: number;
    cloudGlow: number;
    storm: number;
  };
  /** Verification helpers: force-trigger a bolt / a meteor right now. */
  debugStrike(): boolean;
  debugMeteor(): boolean;
  /** Force one intra-cloud sheet flash right now (verification). */
  debugSheet(): boolean;
  /** Live cloud-deck illumination — pass straight into
   *  skyClouds.applyFlash() every frame after update(). */
  cloudFlash(): CloudFlashState;
  dispose(): void;
}

export interface AtmosphereVfxOptions {
  lowSpec?: boolean;
  /** Terrain surface height at a world position (for ground hits). */
  heightAt?: (x: number, z: number) => number;
  /** Thunder hook — page routes it into the audio manager. */
  onThunder?: (delaySeconds: number) => void;
}

/* ------------------------------- system ---------------------------------- */

export function createAtmosphereVfx(
  scene: THREE.Scene,
  opts: AtmosphereVfxOptions = {}
): AtmosphereVfxHandle {
  const low = opts.lowSpec === true;
  const heightAt = opts.heightAt ?? (() => 0);
  const onThunder = opts.onThunder ?? (() => {});

  /* ----- shared textures ----- */
  const boltTex = boltSegmentTexture();
  const dotTex = dotTexture();
  const streakTex = streakTexture();
  const dustTex = dustTexture();

  /* ======================================================================
   * 1. LIGHTNING
   * ====================================================================== */
  const boltMat = new THREE.MeshBasicMaterial({
    map: boltTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const boltMesh = new THREE.Mesh(new THREE.BufferGeometry(), boltMat);
  boltMesh.visible = false;
  boltMesh.frustumCulled = false;
  scene.add(boltMesh);

  const boltLight = new THREE.PointLight(0xcfe0ff, 0, 3200, 1.6);
  scene.add(boltLight);

  // whole-screen white flash: a self-managed fixed overlay div, opacity
  // driven per frame (no CSS transition — the loop owns the envelope)
  const flashDiv = document.createElement('div');
  flashDiv.setAttribute('aria-hidden', 'true');
  flashDiv.style.cssText =
    'position:fixed;inset:0;z-index:35;pointer-events:none;background:#fff;opacity:0;';
  document.body.appendChild(flashDiv);

  let boltActive = false;
  let boltT = 0;
  let boltTimer = 2.5;
  let prevStorm = 0;
  let strikeCount = 0;
  let flashAlpha = 0;
  let boltX = 0; // strike xz — the deck glow centres on it
  let boltZ = 0;

  /** Cloud-deck illumination, rebuilt every frame and read by page.tsx via
   *  cloudFlash() -> skyClouds.applyFlash(). `sheet` flickers the whole
   *  deck faintly, `spot` blooms the strike cell through the cloud shapes. */
  const cloudGlow = {
    sheet: 0,
    spot: 0,
    centerX: 0,
    centerZ: 0,
    radius: 2600,
  };

  /** Flicker envelope: hard pop, dip, re-pop, long fade. */
  function boltAlpha(t: number): number {
    if (t < 0.05) return t / 0.05;
    if (t < 0.09) return 1 - ((t - 0.05) / 0.04) * 0.55;
    if (t < 0.14) return 0.45 + ((t - 0.09) / 0.05) * 0.55;
    return Math.max(0, 1 - (t - 0.14) / (BOLT_LIFE - 0.14));
  }

  /** Intra-cloud envelope: several hard pops that decay — real sheet
   *  lightning strobes 2-4 times as different pockets of the cell short. */
  function sheetAlpha(t: number): number {
    const pop = (c: number, s: number) =>
      t >= c && t < c + s ? Math.sin(((t - c) / s) * Math.PI) : 0;
    const tail =
      t >= 0.36
        ? Math.max(0, 1 - (t - 0.36) / (SHEET_LIFE - 0.36)) * 0.22
        : 0;
    return Math.min(
      1,
      pop(0, 0.075) + pop(0.12, 0.07) * 0.8 + pop(0.26, 0.09) * 0.55 + tail
    );
  }

  /** Build one strike: a jittered camera-facing quad chain + branches. */
  function buildBolt(
    top: THREE.Vector3,
    ground: THREE.Vector3,
    camPos: THREE.Vector3
  ): THREE.BufferGeometry {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const t = i / BOLT_SEGMENTS;
      const p = top.clone().lerp(ground, t);
      if (i > 0 && i < BOLT_SEGMENTS) {
        const amp = THREE.MathUtils.lerp(BOLT_JITTER[0], BOLT_JITTER[1], t);
        p.x += (Math.random() - 0.5) * 2 * amp;
        p.z += (Math.random() - 0.5) * 2 * amp;
      }
      pts.push(p);
    }
    pts[0].copy(top);
    pts[BOLT_SEGMENTS].copy(ground);
    // one sharp kink — the "hook" that makes bolts read as lightning
    const k = 3 + ((Math.random() * (BOLT_SEGMENTS - 6)) | 0);
    pts[k].x += (Math.random() - 0.5) * 320;
    pts[k].z += (Math.random() - 0.5) * 320;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const dir = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    const side = new THREE.Vector3();

    const addSegment = (a: THREE.Vector3, b: THREE.Vector3, width: number) => {
      dir.copy(b).sub(a).normalize();
      toCam.copy(camPos).sub(a).normalize();
      side.crossVectors(dir, toCam);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize().multiplyScalar(width / 2);
      const base = positions.length / 3;
      positions.push(
        a.x - side.x, a.y - side.y, a.z - side.z,
        a.x + side.x, a.y + side.y, a.z + side.z,
        b.x - side.x, b.y - side.y, b.z - side.z,
        b.x + side.x, b.y + side.y, b.z + side.z
      );
      uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    };

    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const t = (i + 0.5) / BOLT_SEGMENTS;
      addSegment(
        pts[i],
        pts[i + 1],
        BOLT_WIDTH * (1.1 - BOLT_TAPER * t)
      );
    }

    // 1-3 downward side branches off the upper two thirds
    const branchCount = low ? 1 : 1 + ((Math.random() * 2.4) | 0);
    for (let b = 0; b < branchCount; b++) {
      const s = 1 + ((Math.random() * (BOLT_SEGMENTS - 5)) | 0);
      const bp: THREE.Vector3[] = [pts[s].clone()];
      const segs = 4;
      const step = pts[s + 1].clone().sub(pts[s]).normalize().multiplyScalar(
        pts[0].distanceTo(pts[BOLT_SEGMENTS]) / BOLT_SEGMENTS
      );
      for (let i = 1; i <= segs; i++) {
        const p = bp[i - 1].clone().addScaledVector(step, 0.9);
        const out = new THREE.Vector3(
          (Math.random() - 0.2) * 150,
          -step.length() * 0.4,
          (Math.random() - 0.2) * 150
        );
        p.add(out);
        bp.push(p);
      }
      for (let i = 0; i < segs; i++) {
        addSegment(bp[i], bp[i + 1], BOLT_WIDTH * 0.5);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  function doStrike(ctx: AtmosContext): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = THREE.MathUtils.lerp(STRIKE_RANGE[0], STRIKE_RANGE[1], Math.random());
    doStrikeAt(
      ctx.playerPos.x + Math.cos(ang) * dist,
      ctx.playerPos.z + Math.sin(ang) * dist,
      ctx
    );
  }

  /** Strike at an explicit spot (debug + sheet-lightning escalations).
   *  `silent` skips the thunder hook — the escalating sheet already rolled
   *  its own rumble, and stacking both would double-bang the mix. */
  function doStrikeAt(
    gx: number,
    gz: number,
    ctx: AtmosContext,
    silent = false
  ): void {
    const dist = Math.hypot(gx - ctx.playerPos.x, gz - ctx.playerPos.z);
    const ground = heightAt(gx, gz);
    const top = new THREE.Vector3(
      gx + (Math.random() - 0.5) * 700,
      ground + 3300 + Math.random() * 900, // starts at/above the raised deck
      gz + (Math.random() - 0.5) * 700
    );
    const groundV = new THREE.Vector3(gx, ground, gz);

    boltMesh.geometry.dispose();
    boltMesh.geometry = buildBolt(top, groundV, ctx.camera.position);
    boltMesh.visible = true;
    boltLight.position.set(gx, ground + 900, gz);
    boltActive = true;
    boltT = 0;
    boltX = gx;
    boltZ = gz;
    strikeCount += 1;

    // thunder rolls in later the farther the bolt landed
    if (!silent) onThunder(0.55 + (dist / 4200) * 1.9 + Math.random() * 0.35);
  }

  /* ----- sheet lightning state ----- */
  const sheetLight = new THREE.PointLight(0xbfd2ff, 0, 3000, 1.8);
  scene.add(sheetLight);
  let sheetActive = false;
  let sheetT = 0;
  let sheetTimer = 1.5;
  let sheetPeak = 0.8;
  let sheetX = 0;
  let sheetZ = 0;
  let sheetR = 3000;
  let sheetGroundY = 0;
  let sheetCount = 0;
  /** A sheet flash can escalate: a channel punches out of the same cell a
   *  beat after the glow builds (the classic glow -> CRACK sequence). */
  let pendingBolt: { x: number; z: number; at: number } | null = null;

  /** Drop an intra-cloud glow into a storm cell around the player. */
  function doSheet(ctx: AtmosContext): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = THREE.MathUtils.lerp(
      SHEET_RANGE[0],
      SHEET_RANGE[1],
      Math.random()
    );
    sheetX = ctx.playerPos.x + Math.cos(ang) * dist;
    sheetZ = ctx.playerPos.z + Math.sin(ang) * dist;
    sheetGroundY = heightAt(sheetX, sheetZ);
    sheetR = THREE.MathUtils.lerp(SHEET_RADIUS[0], SHEET_RADIUS[1], Math.random());
    sheetPeak = 0.55 + Math.random() * 0.45;
    sheetActive = true;
    sheetT = 0;
    sheetCount += 1;
    if (Math.random() < SHEET_ESCALATE) {
      pendingBolt = {
        x: sheetX,
        z: sheetZ,
        at: 0.12 + Math.random() * 0.22,
      };
    }
    if (Math.random() < SHEET_THUNDER) {
      onThunder(0.8 + (dist / 4200) * 2.2 + Math.random() * 0.5);
    }
  }

  function updateSheet(dt: number, ctx: AtmosContext): void {
    // sheets fire only in storms, but arm fast so a fresh storm starts
    // flickering before the first ground bolt lands
    if (ctx.storm > STORM_TRIGGER) {
      if (prevStorm <= STORM_TRIGGER) {
        sheetTimer = THREE.MathUtils.lerp(
          SHEET_FIRST[0],
          SHEET_FIRST[1],
          Math.random()
        );
      } else {
        sheetTimer -= dt;
      }
      if (sheetTimer <= 0) {
        doSheet(ctx);
        sheetTimer = THREE.MathUtils.lerp(
          SHEET_NEXT[0],
          SHEET_NEXT[1],
          Math.random()
        );
      }
    } else {
      sheetTimer = Math.min(sheetTimer, 0.8);
    }

    if (sheetActive) {
      sheetT += dt;
      const a = sheetAlpha(sheetT) * sheetPeak;
      sheetLight.position.set(sheetX, sheetGroundY + 700, sheetZ);
      sheetLight.intensity = SHEET_LIGHT_PEAK * a;
      if (sheetT >= SHEET_LIFE) {
        sheetActive = false;
        sheetLight.intensity = 0;
      } else if (a > cloudGlow.spot) {
        // the strongest glow owns the deck bloom this frame
        cloudGlow.spot = a;
        cloudGlow.centerX = sheetX;
        cloudGlow.centerZ = sheetZ;
        cloudGlow.radius = sheetR;
      }
      cloudGlow.sheet = Math.max(cloudGlow.sheet, a * 0.3);
    }
  }

  function updateBolt(dt: number, ctx: AtmosContext): void {
    // a pending escalation fires its ground bolt out of the glowing cell
    if (pendingBolt) {
      pendingBolt.at -= dt;
      if (pendingBolt.at <= 0) {
        doStrikeAt(pendingBolt.x, pendingBolt.z, ctx, true);
        pendingBolt = null;
      }
    }

    // scheduling: the FIRST bolt of a storm lands fast, then every NEXT_STRIKE
    if (ctx.storm > STORM_TRIGGER) {
      if (prevStorm <= STORM_TRIGGER) {
        boltTimer = THREE.MathUtils.lerp(
          FIRST_STRIKE[0],
          FIRST_STRIKE[1],
          Math.random()
        );
      } else {
        boltTimer -= dt;
      }
      if (boltTimer <= 0) {
        doStrike(ctx);
        boltTimer = THREE.MathUtils.lerp(NEXT_STRIKE[0], NEXT_STRIKE[1], Math.random());
      }
    } else {
      // armed but capped, so a fresh storm always strikes promptly
      boltTimer = Math.min(boltTimer, 1.2);
    }
    prevStorm = ctx.storm;

    if (!boltActive) {
      flashAlpha = Math.max(0, flashAlpha - dt * 4);
      flashDiv.style.opacity = (flashAlpha * FLASH_MAX).toFixed(3);
      return;
    }
    boltT += dt;
    const a = boltAlpha(boltT);
    boltMat.opacity = a;
    boltLight.intensity = LIGHT_PEAK * Math.max(0, 1 - boltT / LIGHT_FADE);
    flashAlpha = a;
    flashDiv.style.opacity = (a * FLASH_MAX).toFixed(3);
    // the channel rakes the deck from within as it flickers — bloom the
    // strike cell harder than any sheet flash could
    if (a > cloudGlow.spot) {
      cloudGlow.spot = a * 1.15;
      cloudGlow.centerX = boltX;
      cloudGlow.centerZ = boltZ;
      cloudGlow.radius = Math.max(cloudGlow.radius, 3400);
    }
    cloudGlow.sheet = Math.max(cloudGlow.sheet, a * 0.42);
    if (boltT >= BOLT_LIFE) {
      boltActive = false;
      boltMesh.visible = false;
      boltLight.intensity = 0;
      boltMesh.geometry.dispose();
    }
  }

  /* ======================================================================
   * 2. SHOOTING STARS
   * ====================================================================== */
  interface Meteor {
    active: boolean;
    t: number;
    dur: number;
    rare: boolean;
    /** Start offset from the camera (re-anchored every frame). */
    off: THREE.Vector3;
    vel: THREE.Vector3;
    head: THREE.Sprite;
    trail: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  }

  const meteorMax = low ? 1 : 2;
  const meteors: Meteor[] = [];
  const trailGeo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < meteorMax; i++) {
    const headMat = new THREE.SpriteMaterial({
      map: dotTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const head = new THREE.Sprite(headMat);
    head.visible = false;
    head.renderOrder = 6;
    scene.add(head);
    const mat = new THREE.MeshBasicMaterial({
      map: streakTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const trail = new THREE.Mesh(trailGeo, mat);
    trail.visible = false;
    trail.frustumCulled = false;
    trail.renderOrder = 6;
    scene.add(trail);
    meteors.push({
      active: false,
      t: 0,
      dur: 1,
      rare: false,
      off: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      head,
      trail,
    });
  }
  let meteorTimer = 5;
  let meteorCount = 0;

  // sparkle tail points (shared pool, additive — fade via color like sparks)
  const sparkleMax = low ? 44 : SPARKLE_POOL;
  const spPos = new Float32Array(sparkleMax * 3);
  const spCol = new Float32Array(sparkleMax * 3);
  const spVel = new Float32Array(sparkleMax * 3);
  const spLife = new Float32Array(sparkleMax);
  const spMaxLife = new Float32Array(sparkleMax);
  for (let i = 0; i < sparkleMax; i++) spPos[i * 3 + 1] = -1e5;
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
  spGeo.setAttribute('color', new THREE.BufferAttribute(spCol, 3));
  const spMat = new THREE.PointsMaterial({
    map: dotTex,
    size: 42,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
    fog: false,
  });
  const sparkles = new THREE.Points(spGeo, spMat);
  sparkles.frustumCulled = false;
  sparkles.renderOrder = 7;
  scene.add(sparkles);
  let spCursor = 0;

  function spawnMeteor(ctx: AtmosContext): void {
    const slot = meteors.find((m) => !m.active);
    if (!slot) return;
    const az = Math.random() * Math.PI * 2;
    const el = 0.42 + Math.random() * 0.4; // start high on the sky sphere
    slot.off.set(
      Math.cos(az) * Math.cos(el) * METEOR_RADIUS,
      Math.sin(el) * METEOR_RADIUS,
      Math.sin(az) * Math.cos(el) * METEOR_RADIUS
    );
    const dur = THREE.MathUtils.lerp(METEOR_DUR[0], METEOR_DUR[1], Math.random());
    const travel = THREE.MathUtils.lerp(METEOR_TRAVEL[0], METEOR_TRAVEL[1], Math.random());
    const pitch = 0.16 + Math.random() * 0.22; // downward slope
    const az2 = az + (Math.random() - 0.5) * 0.9;
    slot.vel
      .set(
        Math.sin(az2) * Math.cos(pitch),
        -Math.sin(pitch),
        Math.cos(az2) * Math.cos(pitch)
      )
      .normalize()
      .multiplyScalar(travel / dur);
    slot.dur = dur;
    slot.t = 0;
    slot.rare = Math.random() < METEOR_RARE;
    slot.active = true;
    slot.head.visible = true;
    slot.trail.visible = true;
    meteorCount += 1;
  }

  const meteorBasis: {
    x: THREE.Vector3;
    y: THREE.Vector3;
    z: THREE.Vector3;
    m: THREE.Matrix4;
    pos: THREE.Vector3;
  } = {
    x: new THREE.Vector3(),
    y: new THREE.Vector3(),
    z: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    pos: new THREE.Vector3(),
  };

  function updateMeteors(dt: number, ctx: AtmosContext): void {
    // night + clear skies only
    meteorTimer -= dt;
    if (
      meteorTimer <= 0 &&
      ctx.moonUp > 0.45 &&
      ctx.storm < 0.25
    ) {
      spawnMeteor(ctx);
      meteorTimer = 6 + Math.random() * 12;
    }

    const B = meteorBasis;
    for (const m of meteors) {
      if (!m.active) continue;
      m.t += dt;
      const k = m.t / m.dur;
      if (k >= 1) {
        m.active = false;
        m.head.visible = false;
        m.trail.visible = false;
        continue;
      }
      const env = Math.sin(Math.PI * k); // fade in and out
      B.pos
        .copy(ctx.camera.position)
        .add(m.off)
        .addScaledVector(m.vel, m.t);
      m.head.position.copy(B.pos);
      m.head.material.opacity = env;
      const headSize = THREE.MathUtils.lerp(METEOR_HEAD[0], METEOR_HEAD[1], 1 - k);
      m.head.scale.setScalar(headSize);

      // trail: stretched quad riding the velocity, billboarded to the camera
      const len = THREE.MathUtils.lerp(METEOR_TAIL[1], METEOR_TAIL[0], k);
      const width = 46 + 26 * env;
      B.x.copy(m.vel).normalize();
      B.z.copy(ctx.camera.position).sub(B.pos).normalize();
      B.y.crossVectors(B.z, B.x).normalize();
      B.z.crossVectors(B.x, B.y).normalize();
      B.m.makeBasis(B.x, B.y, B.z);
      m.trail.quaternion.setFromRotationMatrix(B.m);
      m.trail.position.copy(B.pos).addScaledVector(B.x, -len * 0.42);
      m.trail.scale.set(len, width, 1);
      m.trail.material.opacity = env * 0.95;

      // rare ones leave a lingering sparkle tail
      if (m.rare) {
        const emit = 2 + ((Math.random() * 2) | 0);
        for (let n = 0; n < emit; n++) {
          const i = spCursor;
          spCursor = (spCursor + 1) % sparkleMax;
          spPos[i * 3] = B.pos.x + (Math.random() - 0.5) * 40;
          spPos[i * 3 + 1] = B.pos.y + (Math.random() - 0.5) * 40;
          spPos[i * 3 + 2] = B.pos.z + (Math.random() - 0.5) * 40;
          spVel[i * 3] = -m.vel.x * 0.05 + (Math.random() - 0.5) * 40;
          spVel[i * 3 + 1] = -m.vel.y * 0.05 + (Math.random() - 0.5) * 40;
          spVel[i * 3 + 2] = -m.vel.z * 0.05 + (Math.random() - 0.5) * 40;
          const life = 0.5 + Math.random() * 0.45;
          spLife[i] = life;
          spMaxLife[i] = life;
        }
      }
    }

    // advance + fade the sparkle pool (additive: black = gone)
    let dirty = false;
    for (let i = 0; i < sparkleMax; i++) {
      if (spLife[i] <= 0) continue;
      dirty = true;
      spLife[i] -= dt;
      const i3 = i * 3;
      if (spLife[i] <= 0) {
        spLife[i] = 0;
        spCol[i3] = spCol[i3 + 1] = spCol[i3 + 2] = 0;
        spPos[i3 + 1] = -1e5;
        continue;
      }
      spVel[i3] *= 1 - 1.4 * dt;
      spVel[i3 + 1] *= 1 - 1.4 * dt;
      spVel[i3 + 2] *= 1 - 1.4 * dt;
      spPos[i3] += spVel[i3] * dt;
      spPos[i3 + 1] += spVel[i3 + 1] * dt;
      spPos[i3 + 2] += spVel[i3 + 2] * dt;
      const f = spLife[i] / spMaxLife[i];
      const tw = 0.7 + Math.random() * 0.3; // sparkle flicker
      spCol[i3] = f * tw;
      spCol[i3 + 1] = f * tw * 0.95;
      spCol[i3 + 2] = f * tw * 0.8;
    }
    if (dirty) {
      spGeo.attributes.position.needsUpdate = true;
      spGeo.attributes.color.needsUpdate = true;
    }
  }

  /* ======================================================================
   * 3. FOOTSTEP + LANDING DUST
   * ====================================================================== */
  interface DustPuff {
    sprite: THREE.Sprite;
    vel: THREE.Vector3;
    age: number;
    life: number;
    s0: number;
    active: boolean;
  }
  const dustPuffs: DustPuff[] = [];
  const dustGroup = new THREE.Group();
  scene.add(dustGroup);
  for (let i = 0; i < (low ? 20 : DUST_POOL); i++) {
    const mat = new THREE.SpriteMaterial({
      map: dustTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      color: DUST_COLOR,
      fog: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    dustGroup.add(sprite);
    dustPuffs.push({
      sprite,
      vel: new THREE.Vector3(),
      age: 0,
      life: 1,
      s0: 10,
      active: false,
    });
  }
  let dustCursor = 0;
  let footstepCount = 0;
  let landingCount = 0;

  function spawnDust(
    x: number,
    y: number,
    z: number,
    velX: number,
    velY: number,
    velZ: number,
    scale: number,
    life: number
  ): void {
    const d = dustPuffs[dustCursor];
    dustCursor = (dustCursor + 1) % dustPuffs.length;
    d.sprite.position.set(x, y, z);
    d.vel.set(velX, velY, velZ);
    d.age = 0;
    d.life = life;
    d.s0 = scale;
    d.active = true;
    d.sprite.visible = true;
    d.sprite.material.opacity = 0.46;
    d.sprite.scale.setScalar(scale);
  }

  function footstep(x: number, y: number, z: number, sprint: boolean): void {
    // Sprinting kicks up more, bigger dust; the x/z scatter stays tight so
    // the page-side left/right alternation reads as a two-track trail.
    const n = sprint && !low ? 3 : 2;
    const speed = sprint ? 26 : 18;
    const scale0 = sprint ? 14 : 11;
    const rise = sprint ? 14 : 10;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed + Math.random() * (sprint ? 34 : 30);
      spawnDust(
        x + (Math.random() - 0.5) * 14,
        y + Math.random() * 10,
        z + (Math.random() - 0.5) * 14,
        Math.cos(a) * sp,
        rise + Math.random() * 22,
        Math.sin(a) * sp,
        scale0 + Math.random() * 7,
        THREE.MathUtils.lerp(DUST_FOOTSTEP[0], DUST_FOOTSTEP[1], Math.random())
      );
    }
    footstepCount += 1;
  }

  function landing(x: number, y: number, z: number, impact: number): void {
    const n = Math.min(14, Math.max(3, Math.round(3 + impact / 110)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.7;
      const sp = Math.min(210, 55 + impact * 0.14) * (0.7 + Math.random() * 0.6);
      spawnDust(
        x + Math.cos(a) * 14,
        y + 6 + Math.random() * 10,
        z + Math.sin(a) * 14,
        Math.cos(a) * sp,
        30 + Math.random() * 70 + impact * 0.05,
        Math.sin(a) * sp,
        Math.min(30, 12 + impact / 55),
        0.55 + Math.random() * 0.4
      );
    }
    landingCount += 1;
  }

  function updateDust(dt: number): void {
    for (const d of dustPuffs) {
      if (!d.active) continue;
      d.age += dt;
      const k = d.age / d.life;
      if (k >= 1) {
        d.active = false;
        d.sprite.visible = false;
        continue;
      }
      d.vel.y -= 130 * dt; // light settle
      d.vel.x *= 1 - 2 * dt;
      d.vel.z *= 1 - 2 * dt;
      d.sprite.position.addScaledVector(d.vel, dt);
      d.sprite.material.opacity = 0.46 * (1 - k);
      d.sprite.scale.setScalar(d.s0 * (1 + 1.9 * k));
    }
  }

  /* ----- last context (debug triggers reuse it) ----- */
  let lastCtx: AtmosContext | null = null;

  /** Live cloud-deck illumination — pass straight into
   *  skyClouds.applyFlash() every frame after update(). */
  function cloudFlash(): CloudFlashState {
    return cloudGlow;
  }

  function update(dt: number, ctx: AtmosContext): void {
    lastCtx = ctx;
    cloudGlow.sheet = 0;
    cloudGlow.spot = 0;
    updateBolt(dt, ctx);
    updateSheet(dt, ctx);
    updateMeteors(dt, ctx);
    updateDust(dt);
  }

  function stats() {
    let alive = 0;
    for (let i = 0; i < sparkleMax; i++) {
      if (spLife[i] > 0 && spPos[i * 3 + 1] > -1e4) alive += 1;
    }
    return {
      strikes: strikeCount,
      sheets: sheetCount,
      meteors: meteorCount,
      sparkles: alive,
      footsteps: footstepCount,
      landings: landingCount,
      flashAlpha: Number(flashAlpha.toFixed(3)),
      cloudGlow: Number(cloudGlow.spot.toFixed(3)),
      storm: Number((lastCtx?.storm ?? 0).toFixed(3)),
    };
  }

  function debugStrike(): boolean {
    if (!lastCtx) return false;
    doStrike(lastCtx);
    return true;
  }

  function debugMeteor(): boolean {
    if (!lastCtx) return false;
    spawnMeteor(lastCtx);
    return true;
  }

  function debugSheet(): boolean {
    if (!lastCtx) return false;
    doSheet(lastCtx);
    return true;
  }

  function dispose(): void {
    document.body.removeChild(flashDiv);
    scene.remove(boltMesh, boltLight, sheetLight, sparkles, dustGroup);
    boltMesh.geometry.dispose();
    boltMat.dispose();
    for (const m of meteors) {
      m.head.material.dispose();
      m.trail.material.dispose();
    }
    trailGeo.dispose();
    spGeo.dispose();
    spMat.dispose();
    for (const d of dustPuffs) d.sprite.material.dispose();
    boltTex.dispose();
    dotTex.dispose();
    streakTex.dispose();
    dustTex.dispose();
  }

  return {
    update,
    footstep,
    landing,
    stats,
    debugStrike,
    debugMeteor,
    debugSheet,
    cloudFlash,
    dispose,
  };
}
