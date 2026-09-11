/**
 * Loot chests for the RATFIRE endless world.
 *
 * Rare treasure crates scattered across the streamed voxel terrain — the
 * in-world counterpart of the lobby economy: walk up to one and it pops
 * open automatically (no key needed — identical on desktop and mobile),
 * bursting coins (rare chests also drop gems) that are banked into the
 * HUD balance while the chest sinks into the ground and despawns.
 *
 *  - DETERMINISTIC REGIONS: the plane is cut into square REGIONS (in
 *    height-grid cells, same trick as groundWater.ts). Each region entered
 *    for the first time is scanned for GENTLY-FLAT cells (slope <= 1, so
 *    chests appear on hilltops and in valleys alike) and samples up to
 *    MAX_CHESTS_PER_REGION spaced sites from them with a region-seeded
 *    mulberry32 PRNG — a region always grows the same chests, even after
 *    its sites were pruned and you return later. Some regions roll empty,
 *    keeping chests genuinely rare.
 *  - SESSION LOOTED SET: an opened chest's region key is remembered for
 *    the session — revisiting never respawns it (rediscovery replays the
 *    same sites minus the looted ones).
 *  - MODEL: each chest is ONE merged mesh (body + lid + latch, optional
 *    gold bands on rare chests) with per-part VERTEX COLORS, so a screen
 *    full of chests costs one draw call each. Rare chests get an additive
 *    gold sparkle sprite floating above and a stronger bob.
 *  - LIFECYCLE: idle chests bob + slowly spin so they read as interactive
 *    from a distance. Opening plays a pop (scale bounce), a pooled gold
 *    coin-burst (THREE.Points, gravity + fade), then the chest sinks into
 *    the terrain and its geometry is disposed — the world stays clean.
 *  - `update(dt, px, py, pz, active)` drives everything; `active=false`
 *    (lobby / death) freezes auto-open while keeping the ambient bob so
 *    the lobby showcase stays alive.
 *  - `mapMarkers()` feeds the minimap: cached array of live, unopened
 *    chests (world xz + rarity), rebuilt only when the chest set changes.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ---------------- tuning ---------------- */
const REGION_CELLS = 24; // height-grid cells per chest region
const KEEP_REGIONS = 2; // Chebyshev region distance kept around the player
const MAX_CHESTS_PER_REGION = 3; // lowSpec drops this by one
const MIN_CELL_SPACING = 4; // Chebyshev grid distance between chests
const EMPTY_REGION_CHANCE = 0.3; // fraction of regions with no chests
const RARE_CHANCE = 0.22; // fraction of chests that are rare (gold + gems)
const OPEN_RADIUS = 130; // world units — auto-open walks this close
const OPEN_SECONDS = 0.95; // pop + sink duration
const BOB_AMP = 3.5; // idle hover amplitude (world units)
const BOB_SPEED = 1.9; // rad/s
const SPIN_SPEED = 0.7; // idle yaw rad/s

/* chest palette (vertex colors) */
const COL_BODY = new THREE.Color(0x8a5a2b);
const COL_LID = new THREE.Color(0x5f3d1c);
const COL_LATCH = new THREE.Color(0xf0b93a);
const COL_GOLD = new THREE.Color(0xffd24a);

/** One chest's reward bundle, fired through onLoot at open time. */
export interface LootEvent {
  x: number;
  y: number;
  z: number;
  rare: boolean;
  coins: number;
  gems: number;
}

/** Marker for the minimap: a live, unopened chest. */
export interface ChestMarker {
  x: number;
  z: number;
  rare: boolean;
}

export interface LootChestsOptions {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset — world x = (gx - gridOffset) * block. */
  gridOffset: number;
  /** Deterministic integer block height at grid coordinates. */
  heightAt(gx: number, gz: number): number;
  /** Per-session terrain seed — desynchronises chest layouts per session. */
  seedZ: number;
  /** Mobile LOW tier: fewer chests + smaller coin burst. */
  lowSpec?: boolean;
  /** Called when a chest opens — page.tsx banks coins/gems + toasts + SFX. */
  onLoot?(loot: LootEvent): void;
}

export interface LootChestsHandle {
  /** Advance animations, discover/prune regions, auto-open near the player.
   *  `active=false` freezes auto-open (lobby / death) but keeps the bob. */
  update(dt: number, px: number, py: number, pz: number, active: boolean): void;
  /** Live unopened chests for the minimap (cached, rebuilt on change). */
  mapMarkers(): ChestMarker[];
  /** Live + session-opened counts (debug handle). */
  stats(): { live: number; opened: number };
  /** Nearest unopened chest to a world xz point (debug helper). */
  nearest(x: number, z: number): (ChestMarker & { y: number }) | null;
  dispose(): void;
}

interface Chest {
  key: string;
  x: number;
  y: number; // resting base y (terrain top face)
  z: number;
  rare: boolean;
  reward: { coins: number; gems: number };
  group: THREE.Group;
  sparkle: THREE.Sprite | null;
  state: 'idle' | 'opening';
  t: number; // open animation clock (seconds since open)
  phase: number; // bob phase offset
  seed: number; // per-chest spin variation 0.8..1.2
}

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  mat: THREE.PointsMaterial;
  t: number;
}

/** Small deterministic PRNG (mulberry32) so regions replay identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer hash of two region coordinates (+ session salt). */
function hashRegion(rx: number, rz: number, salt: number): number {
  const sx = (rx ^ salt) | 0;
  const sz = (rz + salt) | 0;
  let h = (sx * 374761393 + sz * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createLootChests(
  scene: THREE.Scene,
  options: LootChestsOptions
): LootChestsHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const heightAt = options.heightAt;
  const maxPerRegion = options.lowSpec ? MAX_CHESTS_PER_REGION - 1 : MAX_CHESTS_PER_REGION;
  const burstCount = options.lowSpec ? 8 : 14;

  // ---------------- shared chest materials/geometry ----------------
  const chestMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

  /** Radial gold glow sprite texture (shared, additive). */
  function createSparkleTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(
        size / 2, size / 2, 0, size / 2, size / 2, size / 2
      );
      g.addColorStop(0, 'rgba(255, 236, 160, 0.95)');
      g.addColorStop(0.35, 'rgba(255, 200, 80, 0.45)');
      g.addColorStop(1, 'rgba(255, 180, 40, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  const sparkleTexture = createSparkleTexture();
  const sparkleMaterial = new THREE.SpriteMaterial({
    map: sparkleTexture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  /**
   * Builds one chest as a single merged geometry with per-part vertex
   * colors (base sits on y=0, sized for the 100-unit block world).
   */
  function buildChestGeometry(rare: boolean): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];

    function push(
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      color: THREE.Color
    ) {
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.translate(x, y, z);
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      parts.push(geo);
    }

    push(46, 26, 34, 0, 13, 0, COL_BODY); // body
    push(49, 14, 37, 0, 31, 0, COL_LID); // lid slab
    push(9, 11, 5, 0, 25, 18.5, COL_LATCH); // front latch
    if (rare) {
      push(50, 3.5, 38, 0, 27.5, 0, COL_GOLD); // gold band under the lid
      push(50, 3.5, 38, 0, 8, 0, COL_GOLD); // gold band near the base
    }

    const merged = BufferGeometryUtils.mergeGeometries(parts);
    for (const part of parts) part.dispose();
    return merged ?? new THREE.BufferGeometry();
  }

  const idleGeometry = buildChestGeometry(false);
  const rareGeometry = buildChestGeometry(true);

  // ---------------- region-based chest discovery ----------------
  const salt = Math.floor(options.seedZ * 1000) | 0;
  const liveRegions = new Map<string, Chest[]>();
  const looted = new Set<string>(); // session memory of opened chest keys
  const bursts: Burst[] = [];
  const stats = { opened: 0 };
  let markersCache: ChestMarker[] = [];
  let markersDirty = true;

  function regionKey(rx: number, rz: number): string {
    return rx + ',' + rz;
  }

  /** Samples up to maxPerRegion spaced chest sites for one region. */
  function discoverRegion(rx: number, rz: number): void {
    const key = regionKey(rx, rz);
    if (liveRegions.has(key)) return;

    const rng = mulberry32(hashRegion(rx, rz, salt));
    const chests: Chest[] = [];

    if (rng() >= EMPTY_REGION_CHANCE) {
      const baseX = rx * REGION_CELLS;
      const baseZ = rz * REGION_CELLS;

      // gently-flat cells (slope <= 1 on all four neighbours)
      const cells: number[] = [];
      for (let lz = 0; lz < REGION_CELLS; lz++) {
        for (let lx = 0; lx < REGION_CELLS; lx++) {
          const gx = baseX + lx;
          const gz = baseZ + lz;
          const h = heightAt(gx, gz);
          if (
            Math.abs(heightAt(gx + 1, gz) - h) <= 1 &&
            Math.abs(heightAt(gx - 1, gz) - h) <= 1 &&
            Math.abs(heightAt(gx, gz + 1) - h) <= 1 &&
            Math.abs(heightAt(gx, gz - 1) - h) <= 1
          ) {
            cells.push(gz * 65536 + gx);
          }
        }
      }

      // Fisher-Yates (region-seeded) over the candidate cells
      for (let i = cells.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = cells[i];
        cells[i] = cells[j];
        cells[j] = t;
      }

      const takenX: number[] = [];
      const takenZ: number[] = [];
      let index = 0;
      for (const cell of cells) {
        if (chests.length >= maxPerRegion) break;
        const gx = cell % 65536;
        const gz = (cell / 65536) | 0;
        const chestKey = key + ':' + index;
        index++;
        if (looted.has(chestKey)) continue; // opened earlier this session

        let crowded = false;
        for (let t = 0; t < takenX.length; t++) {
          if (
            Math.abs(takenX[t] - gx) <= MIN_CELL_SPACING &&
            Math.abs(takenZ[t] - gz) <= MIN_CELL_SPACING
          ) {
            crowded = true;
            break;
          }
        }
        if (crowded) continue;
        takenX.push(gx);
        takenZ.push(gz);

        const rare = rng() < RARE_CHANCE;
        const wx = (gx - gridOffset) * block;
        const wz = (gz - gridOffset) * block;
        const wy = heightAt(gx, gz) * block + block / 2;

        const reward = rare
          ? { coins: 70 + ((rng() * 60) | 0), gems: 1 + ((rng() * 2.99) | 0) }
          : { coins: 25 + ((rng() * 30) | 0), gems: 0 };

        const mesh = new THREE.Mesh(rare ? rareGeometry : idleGeometry, chestMaterial);
        mesh.castShadow = true;

        const group = new THREE.Group();
        group.add(mesh);
        group.position.set(wx, wy, wz);

        let sparkle: THREE.Sprite | null = null;
        if (rare) {
          // per-chest material clone: each rare chest pulses on its own phase
          sparkle = new THREE.Sprite(sparkleMaterial.clone());
          sparkle.scale.setScalar(26);
          sparkle.position.y = 62;
          group.add(sparkle);
        }

        scene.add(group);
        chests.push({
          key: chestKey,
          x: wx,
          y: wy,
          z: wz,
          rare,
          reward,
          group,
          sparkle,
          state: 'idle',
          t: 0,
          phase: rng() * Math.PI * 2,
          seed: 0.8 + rng() * 0.4,
        });
      }
    }

    liveRegions.set(key, chests);
    markersDirty = true;
  }

  // ---------------- coin burst ----------------
  function spawnBurst(chest: Chest): void {
    const positions = new Float32Array(burstCount * 3);
    const vel = new Float32Array(burstCount * 3);
    for (let i = 0; i < burstCount; i++) {
      positions[i * 3] = chest.x;
      positions[i * 3 + 1] = chest.y + 34;
      positions[i * 3 + 2] = chest.z;
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 130;
      vel[i * 3] = Math.cos(a) * speed * 0.6;
      vel[i * 3 + 1] = 220 + Math.random() * 260;
      vel[i * 3 + 2] = Math.sin(a) * speed * 0.6;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffc63d,
      size: 26,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, mat);
    points.frustumCulled = false;
    scene.add(points);
    bursts.push({ points, vel, mat, t: 0 });
  }

  function updateBursts(dt: number): void {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.t += dt;
      const attr = b.points.geometry.attributes
        .position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let p = 0; p < burstCount; p++) {
        b.vel[p * 3 + 1] -= 900 * dt; // gravity
        arr[p * 3] += b.vel[p * 3] * dt;
        arr[p * 3 + 1] += b.vel[p * 3 + 1] * dt;
        arr[p * 3 + 2] += b.vel[p * 3 + 2] * dt;
      }
      attr.needsUpdate = true;
      b.mat.opacity = Math.max(0, 1 - b.t / 0.75);
      if (b.t >= 0.78) {
        scene.remove(b.points);
        b.points.geometry.dispose();
        b.mat.dispose();
        bursts.splice(i, 1);
      }
    }
  }

  // ---------------- open + despawn ----------------
  function openChest(chest: Chest): void {
    looted.add(chest.key);
    stats.opened++;
    chest.state = 'opening';
    chest.t = 0;
    markersDirty = true;
    spawnBurst(chest);
    options.onLoot?.({
      x: chest.x,
      y: chest.y,
      z: chest.z,
      rare: chest.rare,
      coins: chest.reward.coins,
      gems: chest.reward.gems,
    });
  }

  function removeChest(chest: Chest): void {
    scene.remove(chest.group);
    // geometry/material are shared, but each rare chest owns a cloned
    // sparkle material — dispose that one per-chest resource
    if (chest.sparkle) chest.sparkle.material.dispose();
    chest.group.clear();
  }

  // ---------------- per-frame update ----------------
  let lastRegionX = NaN;
  let lastRegionZ = NaN;
  let time = 0;

  function update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    active: boolean
  ): void {
    time += dt;

    // --- region discovery / pruning around the player ---
    const cgx = Math.round(px / block) + gridOffset;
    const cgz = Math.round(pz / block) + gridOffset;
    const prx = Math.floor(cgx / REGION_CELLS);
    const prz = Math.floor(cgz / REGION_CELLS);
    if (prx !== lastRegionX || prz !== lastRegionZ) {
      lastRegionX = prx;
      lastRegionZ = prz;
      let changed = false;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!liveRegions.has(regionKey(prx + dx, prz + dz))) {
            discoverRegion(prx + dx, prz + dz);
            changed = true;
          }
        }
      }
      for (const key of [...liveRegions.keys()]) {
        const sep = key.indexOf(',');
        const krx = Number(key.slice(0, sep));
        const krz = Number(key.slice(sep + 1));
        if (Math.max(Math.abs(krx - prx), Math.abs(krz - prz)) > KEEP_REGIONS) {
          for (const chest of liveRegions.get(key) ?? []) {
            if (chest.state === 'idle') removeChest(chest);
          }
          liveRegions.delete(key);
          changed = true;
        }
      }
      if (changed) markersDirty = true;
    }

    // --- per-chest animation / auto-open ---
    const openR2 = OPEN_RADIUS * OPEN_RADIUS;
    for (const chests of liveRegions.values()) {
      for (const chest of chests) {
        if (chest.state === 'idle') {
          const bob =
            Math.sin(time * BOB_SPEED + chest.phase) * BOB_AMP *
            (chest.rare ? 1.5 : 1);
          chest.group.position.y = chest.y + Math.max(0, bob);
          chest.group.rotation.y += dt * SPIN_SPEED * chest.seed;
          if (chest.sparkle) {
            const pulse = 0.55 + 0.45 * Math.sin(time * 3.1 + chest.phase);
            chest.sparkle.material.opacity = pulse;
            chest.sparkle.scale.setScalar(22 + pulse * 9);
          }
          if (active) {
            const dx = chest.x - px;
            const dy = chest.y - py;
            const dz = chest.z - pz;
            if (dx * dx + dy * dy * 0.2 + dz * dz < openR2) {
              openChest(chest); // marks looted + fires onLoot
            }
          }
        } else {
          // opening: pop (scale bounce) then sink into the ground
          chest.t += dt;
          const t = chest.t / OPEN_SECONDS;
          if (t < 0.28) {
            const s = 1 + 0.22 * Math.sin((t / 0.28) * Math.PI);
            chest.group.scale.setScalar(s);
          } else {
            const sink = (t - 0.28) / 0.72;
            chest.group.position.y = chest.y - sink * sink * 95;
            chest.group.rotation.y += dt * 6;
            chest.group.scale.setScalar(Math.max(0.4, 1.22 - sink * 0.5));
          }
          if (chest.t >= OPEN_SECONDS) {
            removeChest(chest);
            chest.state = 'opening'; // stays consumed; group already detached
            chest.t = Infinity;
          }
        }
      }
    }

    updateBursts(dt);

    // --- rebuild the minimap cache when the live set changed ---
    if (markersDirty) {
      markersDirty = false;
      const markers: ChestMarker[] = [];
      for (const chests of liveRegions.values()) {
        for (const chest of chests) {
          if (chest.state === 'idle') {
            markers.push({ x: chest.x, z: chest.z, rare: chest.rare });
          }
        }
      }
      markersCache = markers;
    }
  }

  // ---------------- public API ----------------
  function mapMarkers(): ChestMarker[] {
    return markersCache;
  }

  function statsSnapshot(): { live: number; opened: number } {
    let live = 0;
    for (const chests of liveRegions.values()) {
      for (const chest of chests) if (chest.state === 'idle') live++;
    }
    return { live, opened: stats.opened };
  }

  function nearest(x: number, z: number): (ChestMarker & { y: number }) | null {
    let best: (ChestMarker & { y: number }) | null = null;
    let bestD = Infinity;
    for (const chests of liveRegions.values()) {
      for (const chest of chests) {
        if (chest.state !== 'idle') continue;
        const d = (chest.x - x) * (chest.x - x) + (chest.z - z) * (chest.z - z);
        if (d < bestD) {
          bestD = d;
          best = { x: chest.x, y: chest.y, z: chest.z, rare: chest.rare };
        }
      }
    }
    return best;
  }

  function dispose(): void {
    for (const chests of liveRegions.values()) {
      for (const chest of chests) {
        scene.remove(chest.group);
        if (chest.sparkle) chest.sparkle.material.dispose();
      }
    }
    liveRegions.clear();
    for (const b of bursts) {
      scene.remove(b.points);
      b.points.geometry.dispose();
      b.mat.dispose();
    }
    bursts.length = 0;
    idleGeometry.dispose();
    rareGeometry.dispose();
    chestMaterial.dispose();
    sparkleMaterial.dispose();
    sparkleTexture.dispose();
    looted.clear();
    markersCache = [];
  }

  return {
    update,
    mapMarkers,
    stats: statsSnapshot,
    nearest,
    dispose,
  };
}
