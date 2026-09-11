/**
 * Winter biome zones for the RATFIRE world — deterministic frozen regions
 * scattered across the endless map so exploring keeps turning up new
 * climates (see the user request: "some places are winter with ice
 * textured terrain and ice raining from clouds").
 *
 * Everything here is PURE MATH and 100% DETERMINISTIC — no THREE, no DOM,
 * no per-session state — so terrain meshes, the minimap, weather and any
 * future system all agree on where winter begins and ends:
 *
 *  - ZONES are fixed circles in GRID-block space (the same gx/gz space the
 *    height field uses: world x = (gx - gridOffset) * block). Spawn sits at
 *    grid (64, 64) = world (0, 0); the nearest zone is a short walk/jeep
 *    ride east-north-east, the others are spread around the compass so a
 *    trip in almost any direction eventually hits snow.
 *  - winterFactor(gx, gz) -> 0..1 rises inside a zone's soft border ring
 *    and saturates at its frozen core. The border is wobbled by a cheap
 *    value-noise jitter so the snow line wanders organically (3-block
 *    blobs) instead of reading as a perfect circle.
 *  - iceFactor(gx, gz) -> 0..1 only deep inside the core, where the snow
 *    field turns into a blue glacier (terrainChunks swaps in the ice
 *    atlas there).
 *  - naturalZoneAt + the loops in winterFactor/iceFactor: beyond the
 *    hand-placed zones the auto generator divides the endless world into
 *    320-block climate cells; each cell rolls a deterministic dice and on
 *    a hit raises ONE full-size snow country — deep core, soft ring,
 *    jittered coastline and its own 5% glacier heart — so EVERY winter
 *    area the generator makes is big like the main zones, never a small
 *    scattered patch (kept clear of the spawn plaza).
 *  - winterFactorWorld(x, z) is the world-space wrapper for per-frame
 *    callers (ice-rain driver, sky tint) — a handful of ops, safe to call
 *    every frame.
 */

/** One frozen region: circle in grid-block space with a soft border. */
export interface WinterZone {
  /** Zone centre, grid-block coordinates. */
  cx: number;
  cz: number;
  /** Outer radius in blocks — beyond this the land is normal grass. */
  radius: number;
  /** Core radius in blocks — inside this the snow field is deepest. */
  core: number;
}

/** Spawn sits at grid (64, 64) — zones are placed relative to that so the
 *  NEAREST one is an easy first discovery from spawn (~20 blocks of grass
 *  then the snow wall starts). Each zone's snow reach is core + BORDER; the
 *  current cores give roughly 21x the original winter area per zone (the
 *  centres were pushed outward along their original bearings each time the
 *  zones grew — 3x, 5x, +20%, then +70% — so the spawn plaza stays in
 *  temperate grass and a wide green heartland remains between the zones). */
export const WINTER_ZONES: WinterZone[] = [
  // first discovery: east-north-east of spawn, world ~(9400, 6100).
  // Centre pushed out from (120,100) for the +70% growth so the bigger snow
  // field still stops ~20 blocks short of the spawn plaza.
  { cx: 158, cz: 125, radius: 93, core: 83 },
  // far north-west, world ~(-10800, 8500)
  { cx: -44, cz: 149, radius: 115, core: 105 },
  // south-east, world ~(9800, -9000)
  { cx: 162, cz: -26, radius: 111, core: 101 },
  // deep south-west, world ~(-10800, -10000)
  { cx: -44, cz: -36, radius: 123, core: 113 },
];

/** Width of the soft snow-line ring (blocks) between grass and full snow. */
const BORDER = 9;

/* ---------------- deterministic border jitter ---------------- */

/** Cheap deterministic 2D hash -> 0..1 (integer-safe, no allocations). */
function hash2(ix: number, iz: number, salt: number): number {
  let h = (ix * 374761393 + iz * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

/** Smooth-ish value noise sampled on a 3-block lattice — gives the snow
 *  line its organic 3-block-scale wander instead of a mathematical arc. */
function borderNoise(gx: number, gz: number, salt: number): number {
  const x = gx / 3;
  const z = gz / 3;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  // smoothstep the lattice corners
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const n00 = hash2(x0, z0, salt);
  const n10 = hash2(x0 + 1, z0, salt);
  const n01 = hash2(x0, z0 + 1, salt);
  const n11 = hash2(x0 + 1, z0 + 1, salt);
  return (
    (n00 + (n10 - n00) * sx) * (1 - sz) +
    (n01 + (n11 - n01) * sx) * sz
  );
}

/** Amplitude of the snow-line wobble, as a fraction of the zone radius. */
const JITTER = 0.16;

/* ---------- natural big snow countries (auto generator) ---------- */

/** The endless world is divided into big climate cells; each cell rolls a
 *  deterministic dice and on a hit raises ONE full-size snow country using
 *  the exact same shape language as WINTER_ZONES (deep core + soft ring +
 *  jittered coastline). That way every winter area the auto generator
 *  makes is big like the main zones — never a scattered small patch. */
const CLIMATE_CELL = 320;
const CLIMATE_CHANCE = 0.72;
/** Natural countries never encroach on the spawn plaza (a country's reach
 *  is core+BORDER+jitter ≈ 136 blocks, so this leaves ≥ ~34 blocks of
 *  guaranteed green grass around home). */
const SPAWN_SAFE_DIST = 170;

/** Scratch for naturalZoneAt (module-level keeps the per-block factor
 *  calls allocation-free). */
let natCx = 0;
let natCz = 0;
let natCore = 0;

/** Rolls the climate dice for a cell; on a hit fills the scratch with the
 *  country's circle (centre + core) and returns true. */
function naturalZoneAt(cellX: number, cellZ: number): boolean {
  if (hash2(cellX, cellZ, 7781) > CLIMATE_CHANCE) return false;
  const cx =
    cellX * CLIMATE_CELL + CLIMATE_CELL / 2 + (hash2(cellX, cellZ, 8821) - 0.5) * 180;
  const cz =
    cellZ * CLIMATE_CELL + CLIMATE_CELL / 2 + (hash2(cellX, cellZ, 9973) - 0.5) * 180;
  const dxs = cx - 64;
  const dzs = cz - 64;
  if (dxs * dxs + dzs * dzs < SPAWN_SAFE_DIST * SPAWN_SAFE_DIST) return false;
  natCx = cx;
  natCz = cz;
  // cores 80..108 — the same league as the hand-placed zones (83..113)
  natCore = 80 + hash2(cellX, cellZ, 5147) * 28;
  return true;
}

/** 0 outside every zone .. 1 deep inside a frozen core. */
export function winterFactor(gx: number, gz: number): number {
  let best = 0;
  for (let i = 0; i < WINTER_ZONES.length; i++) {
    const z = WINTER_ZONES[i];
    const dx = gx - z.cx;
    const dz = gz - z.cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    const wobble = (borderNoise(gx, gz, 17 + i * 101) - 0.5) * 2 * JITTER * z.radius;
    const edge = d - wobble;
    if (edge >= z.radius) continue; // fast reject before the smoothstep
    // 1 at/below the core, falling to 0 across the soft border ring
    const w = 1 - smoothstep01((edge - z.core) / BORDER);
    if (w > best) best = w;
  }
  // natural big snow countries: dice-rolled per climate cell, one full-size
  // country per hit, same soft ring + jitter as the main zones (max()
  // unions everything cleanly where countries touch)
  const cellX = Math.floor(gx / CLIMATE_CELL);
  const cellZ = Math.floor(gz / CLIMATE_CELL);
  for (let i = -1; i <= 1; i++) {
    for (let k = -1; k <= 1; k++) {
      if (!naturalZoneAt(cellX + i, cellZ + k)) continue;
      const dx = gx - natCx;
      const dz = gz - natCz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const wobble =
        (borderNoise(gx, gz, 331 + (cellX + i) * 7919 + (cellZ + k) * 104729) - 0.5) *
        2 *
        JITTER *
        (natCore + 10);
      const w = 1 - smoothstep01((d - natCore) / BORDER);
      if (w > best) best = w;
    }
  }
  return best;
}

/** 0 on the snow field .. 1 in the glacier core (blue-ice terrain). */
export function iceFactor(gx: number, gz: number): number {
  let best = 0;
  for (let i = 0; i < WINTER_ZONES.length; i++) {
    const z = WINTER_ZONES[i];
    const dx = gx - z.cx;
    const dz = gz - z.cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    const wobble =
      (borderNoise(gx, gz, 911 + i * 211) - 0.5) * 2 * JITTER * 0.213 * z.core;
    const edge = d - wobble;
    // glacier fills the inner ~21% of the core so the blue-ice disk covers
    // only ~5% of the visible winter region while the snow field keeps ~95%
    // (0.213 ratio solved against the snow 0.5-line at core+4.5 for every
    // zone), feathered over ~4 blocks; the wobble above uses the same 0.213
    // fraction so the small glacier keeps its organic raggedness
    const ice = 1 - smoothstep01((edge - z.core * 0.213) / 4);
    if (ice > best) best = ice;
  }
  // natural countries carry their own small glacier heart (same 95/5
  // snow/ice split as the hand-placed zones)
  const cellX = Math.floor(gx / CLIMATE_CELL);
  const cellZ = Math.floor(gz / CLIMATE_CELL);
  for (let i = -1; i <= 1; i++) {
    for (let k = -1; k <= 1; k++) {
      if (!naturalZoneAt(cellX + i, cellZ + k)) continue;
      const dx = gx - natCx;
      const dz = gz - natCz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const wobble =
        (borderNoise(gx, gz, 613 + (cellX + i) * 7919 + (cellZ + k) * 104729) - 0.5) *
        2 *
        JITTER *
        0.213 *
        natCore;
      const ice = 1 - smoothstep01((d - natCore * 0.213) / 4);
      if (ice > best) best = ice;
    }
  }
  return best;
}

/** World-space wrapper: world (x, z) -> grid, then the block-space field. */
export function winterFactorWorld(
  x: number,
  z: number,
  block: number,
  gridOffset: number
): number {
  return winterFactor(Math.round(x / block) + gridOffset, Math.round(z / block) + gridOffset);
}

/** World-space wrapper for the glacier-heart field: 1 on the blue ice
 *  hearts, 0 across the snow fields and green land (see iceFactor). */
export function iceFactorWorld(
  x: number,
  z: number,
  block: number,
  gridOffset: number
): number {
  return iceFactor(Math.round(x / block) + gridOffset, Math.round(z / block) + gridOffset);
}

/** 0..1 smoothstep for an already-normalised t (clamped). */
function smoothstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
