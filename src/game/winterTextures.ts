/**
 * Procedural pixel-art winter textures for the RATFIRE terrain — drawn once
 * into canvases at boot (no asset files, deterministic), then sampled with
 * NearestFilter so they read exactly like the hand-painted minecraft atlas
 * the grass world uses.
 *
 * The terrain UV scheme samples the TOP HALF of an atlas for up-facing
 * quads and the BOTTOM HALF for side quads (see terrainChunks.ts), so every
 * atlas here keeps that layout:
 *  - SNOW ATLAS: top half = snow cap, bottom half = dirt with a snow fringe
 *    (the winter twin of the classic grass-side tile).
 *  - ICE ATLAS: top half = cracked blue glacier ice, bottom half = the same
 *    ice with a frosted snow rim on top.
 */

import * as THREE from 'three';

/** Grid-pixel size of one half — 32 px keeps the chunky minecraft look. */
const HALF = 32;

/** Deterministic PRNG (mulberry32) so every boot paints identical tiles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

function px(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Speckle a rect with a palette, ~1-in-`density` pixels per pass. */
function speckle(
  ctx: Ctx,
  rand: () => number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colors: string[],
  density: number
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (rand() < density) {
        px(ctx, x, y, 1, 1, colors[(rand() * colors.length) | 0]);
      }
    }
  }
}

/** Dirt body with a ragged snow fringe hanging from the top edge — the
 *  winter twin of the classic grass-side tile. */
function paintSnowSide(ctx: Ctx, rand: () => number): void {
  const dirt = ['#8a6a48', '#7d5f42', '#937352', '#6f5539', '#84664a'];
  for (let y = 0; y < HALF; y++) {
    for (let x = 0; x < HALF; x++) {
      px(ctx, x, y, 1, 1, dirt[(rand() * dirt.length) | 0]);
    }
  }
  speckle(ctx, rand, 0, 0, HALF, HALF, ['#5f4a32', '#9c7c58'], 0.08);
  // fringe: 5-7 px of snow with a 1-2 px ragged bottom edge
  for (let x = 0; x < HALF; x++) {
    const depth = 4 + ((rand() * 3) | 0);
    for (let y = 0; y < depth; y++) {
      const snow = y < depth - 1 ? ['#f6fafc', '#eef4f8', '#ffffff'] : ['#e2ebf1', '#d8e3ea'];
      px(ctx, x, y, 1, 1, snow[(rand() * snow.length) | 0]);
    }
  }
}

/** Flat snow cap with gentle blue-grey shading speckles. */
function paintSnowTop(ctx: Ctx, rand: () => number): void {
  const snow = ['#f4f8fb', '#eef4f8', '#fbfdfe', '#e9f0f5'];
  for (let y = 0; y < HALF; y++) {
    for (let x = 0; x < HALF; x++) {
      px(ctx, x, y, 1, 1, snow[(rand() * snow.length) | 0]);
    }
  }
  speckle(ctx, rand, 0, 0, HALF, HALF, ['#dde7ee', '#ffffff'], 0.06);
}

/** Blue glacier ice with lighter pressure ridges + darker cracks. */
function paintIce(ctx: Ctx, rand: () => number, rim: boolean): void {
  const ice = ['#8cc6ea', '#84bfe6', '#9ad0ef', '#7db8e2'];
  for (let y = 0; y < HALF; y++) {
    for (let x = 0; x < HALF; x++) {
      px(ctx, x, y, 1, 1, ice[(rand() * ice.length) | 0]);
    }
  }
  // lighter ridges: a few short horizontal runs
  for (let r = 0; r < 7; r++) {
    const y = (rand() * HALF) | 0;
    const x0 = (rand() * HALF) | 0;
    const len = 3 + ((rand() * 6) | 0);
    px(ctx, x0, y, Math.min(len, HALF - x0), 1, '#b8e2f8');
  }
  // darker cracks: stepped diagonal polylines
  for (let c = 0; c < 4; c++) {
    let x = (rand() * HALF) | 0;
    let y = (rand() * HALF) | 0;
    const steps = 5 + ((rand() * 6) | 0);
    for (let s = 0; s < steps; s++) {
      px(ctx, x, y, 1, 1, '#6ba3d4');
      x = (x + (rand() < 0.5 ? 1 : 0) + HALF) % HALF;
      y = (y + 1) % HALF;
    }
  }
  speckle(ctx, rand, 0, 0, HALF, HALF, ['#cdeafc', '#7fb2de'], 0.05);
  if (rim) {
    // frosty snow lip along the top edge (side faces read as snow-capped)
    for (let x = 0; x < HALF; x++) {
      const depth = 2 + ((rand() * 3) | 0);
      for (let y = 0; y < depth; y++) {
        px(ctx, x, y, 1, 1, y < depth - 1 ? '#f2f8fb' : '#e0ebf2');
      }
    }
  }
}

/** Paints a 32x64 atlas: top half = top-face tile, bottom half = side tile. */
function buildAtlas(
  top: (ctx: Ctx, rand: () => number) => void,
  side: (ctx: Ctx, rand: () => number) => void,
  seed: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = HALF;
  canvas.height = HALF * 2;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    top(ctx, mulberry32(seed));
    ctx.save();
    ctx.translate(0, HALF);
    side(ctx, mulberry32(seed ^ 0x9e3779b9));
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter; // crisp minecraft pixels
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Snow world atlas: snow cap / dirt-with-snow-fringe. */
export function createSnowAtlas(): THREE.CanvasTexture {
  return buildAtlas(paintSnowTop, paintSnowSide, 0x51ed270b);
}

/** Glacier atlas: cracked blue ice / ice with a frosted rim. */
export function createIceAtlas(): THREE.CanvasTexture {
  return buildAtlas((ctx, rand) => paintIce(ctx, rand, false), (ctx, rand) => paintIce(ctx, rand, true), 0x1c3b5a);
}
