'use client';

/**
 * Top-down exploration minimap for RATFIRE — top-LEFT corner of the
 * gameplay view, rendered as a CIRCULAR dial with the curved vitals
 * ring (see HealthBar.tsx) wrapped around it.
 *
 * North-up canvas map of the INFINITE world around the player:
 *  - TERRAIN TILE: an offscreen 64x64-block tile (4px per block) is painted
 *    from the same deterministic height function the terrain meshes use
 *    (injected through the bridge ref — the game loop owns the terrain), so
 *    the map always matches the world under your feet. It re-paints when
 *    the player walks >REFRESH_BLOCKS from the tile centre; between repaints
 *    the visible 44x44-block window scrolls SUB-PIXEL smoothly across it.
 *  - HEIGHT PALETTE: valley slate -> grass greens -> hill browns -> rock
 *    grey -> pale peaks, with a deterministic per-cell brightness jitter
 *    for a textured, hand-drawn look instead of flat bands.
 *  - MARKERS: gold dots for live, unopened loot chests (rare chests are
 *    brighter with a soft pulse), injected per-frame via the bridge.
 *  - PLAYER: an amber arrow at the exact (fractional) centre, rotated by
 *    the character's yaw, over a translucent view cone; "N" labels the top.
 *
 * The game loop pushes position every frame through the imperative
 * {@link MinimapHandle.update} handle — plain canvas 2D ops, zero React
 * re-renders per frame, same pattern as the HealthBar HUD.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type RefObject,
} from 'react';
import { iceFactor, winterFactor } from '@/game/winterBiomes';

/** Live chest markers the game loop exposes to the map. */
export interface MinimapMarker {
  x: number;
  z: number;
  rare: boolean;
}

/** Stable bridge the page effect fills with game-side data providers. */
export interface MinimapBridge {
  /** Deterministic integer block height at grid coordinates. */
  heightAt?: (gx: number, gz: number) => number;
  /** Live unopened chest markers. */
  getMarkers?: () => MinimapMarker[];
}

export interface MinimapHandle {
  /** Push the player state; draws straight to the canvas. */
  update(x: number, z: number, yaw: number): void;
}

interface MinimapProps {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset — gx = x / block + gridOffset. */
  gridOffset: number;
  /** Game-loop data providers, filled once by the page effect. */
  bridge: RefObject<MinimapBridge>;
}

/* ---------------- tuning ---------------- */
const TILE_BLOCKS = 64; // offscreen tile span, in blocks
const TILE_PX = 256; // offscreen tile resolution (4 px per block)
const PX_PER_BLOCK = TILE_PX / TILE_BLOCKS;
const MAP_BLOCKS = 44; // visible window span, in blocks (±22 around player)
const REFRESH_BLOCKS = 6; // re-paint the tile after drifting this far
const SRC_SPAN = MAP_BLOCKS * PX_PER_BLOCK; // visible source span in tile px

/* height palette bands [maxHeightExclusive, rgb] — valley -> peak */
const BANDS: Array<[number, [number, number, number]]> = [
  [-10, [96, 106, 122]], // deep valley slate
  [-4, [92, 138, 88]], // dark lowland grass
  [1, [124, 178, 88]], // grass green
  [7, [146, 190, 92]], // light grass
  [14, [168, 156, 96]], // dry hill brown
  [22, [146, 138, 118]], // rock grey-brown
  [32, [172, 172, 168]], // rock grey
  [Infinity, [222, 224, 220]], // pale peaks
];

const MINIMAP_BG = '#10131a';

function heightColor(h: number, gx: number, gz: number): string {
  let rgb = BANDS[BANDS.length - 1][1];
  for (const [max, col] of BANDS) {
    if (h < max) {
      rgb = col;
      break;
    }
  }
  // deterministic per-cell brightness jitter (hash of grid coords)
  const j =
    (((gx * 73856093) ^ (gz * 19349663)) >>> 0) % 1000 / 1000;
  const k = 0.88 + j * 0.24;
  // winter biomes frost the map: the snow field bleaches toward white,
  // the glacier core toward pale ice blue (same fields the terrain uses,
  // so the map always agrees with the world under your feet)
  const w = winterFactor(gx, gz);
  if (w > 0.01) {
    const ice = iceFactor(gx, gz) * w;
    const frost = [
      226 + (198 - 226) * ice,
      238 + (228 - 238) * ice,
      246 + (244 - 246) * ice,
    ];
    const t = 0.55 + 0.45 * w;
    rgb = [
      rgb[0] + (frost[0] - rgb[0]) * t,
      rgb[1] + (frost[1] - rgb[1]) * t,
      rgb[2] + (frost[2] - rgb[2]) * t,
    ];
  }
  return `rgb(${Math.min(255, (rgb[0] * k) | 0)},${Math.min(255, (rgb[1] * k) | 0)},${Math.min(255, (rgb[2] * k) | 0)})`;
}

const Minimap = forwardRef<MinimapHandle, MinimapProps>(function Minimap(
  { block, gridOffset, bridge },
  api
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileRef = useRef<HTMLCanvasElement | null>(null);
  const tileBaseRef = useRef<{ gx: number; gz: number } | null>(null);
  const sizeRef = useRef(150); // css px, re-measured on mount/resize

  // ---- offscreen tile painting (terrain) ----
  function ensureTile(px: number, pz: number) {
    const heightAt = bridge.current?.heightAt;
    if (!heightAt) return;
    const pgx = px / block + gridOffset;
    const pgz = pz / block + gridOffset;

    let tile = tileRef.current;
    if (!tile) {
      tile = document.createElement('canvas');
      tile.width = TILE_PX;
      tile.height = TILE_PX;
      tileRef.current = tile;
      tileBaseRef.current = null;
    }

    const base = tileBaseRef.current;
    const baseGx = Math.round(pgx) - TILE_BLOCKS / 2;
    const baseGz = Math.round(pgz) - TILE_BLOCKS / 2;
    const drifted =
      base === null ||
      Math.abs(base.gx + TILE_BLOCKS / 2 - pgx) > REFRESH_BLOCKS ||
      Math.abs(base.gz + TILE_BLOCKS / 2 - pgz) > REFRESH_BLOCKS;
    if (!drifted) return;

    const ctx = tile.getContext('2d');
    if (!ctx) return;
    const cell = PX_PER_BLOCK;
    for (let lz = 0; lz < TILE_BLOCKS; lz++) {
      for (let lx = 0; lx < TILE_BLOCKS; lx++) {
        const gx = baseGx + lx;
        const gz = baseGz + lz;
        ctx.fillStyle = heightColor(heightAt(gx, gz), gx, gz);
        ctx.fillRect(lx * cell, lz * cell, cell, cell);
      }
    }
    tileBaseRef.current = { gx: baseGx, gz: baseGz };
  }

  // ---- per-frame draw ----
  function draw(px: number, pz: number, yaw: number) {
    const canvas = canvasRef.current;
    const tile = tileRef.current;
    const base = tileBaseRef.current;
    if (!canvas || !tile || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const S = sizeRef.current;
    const pgx = px / block + gridOffset;
    const pgz = pz / block + gridOffset;
    const scale = S / SRC_SPAN; // tile px -> css px

    // crop the visible window centred on the (fractional) player position
    const srcCenterX = (pgx - base.gx) * PX_PER_BLOCK;
    const srcCenterZ = (pgz - base.gz) * PX_PER_BLOCK;
    const half = SRC_SPAN / 2;
    const sx = Math.max(0, Math.min(TILE_PX - SRC_SPAN, srcCenterX - half));
    const sz = Math.max(0, Math.min(TILE_PX - SRC_SPAN, srcCenterZ - half));

    ctx.fillStyle = MINIMAP_BG;
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tile, sx, sz, SRC_SPAN, SRC_SPAN, 0, 0, S, S);

    // --- chest markers: world -> screen (player-centred, north-up) ---
    const markers = bridge.current?.getMarkers?.() ?? [];
    const blocksToPx = S / MAP_BLOCKS;
    const now = performance.now();
    for (const m of markers) {
      const dx = (m.x - px) / block;
      const dz = (m.z - pz) / block;
      if (Math.abs(dx) > MAP_BLOCKS / 2 + 1 || Math.abs(dz) > MAP_BLOCKS / 2 + 1) {
        continue;
      }
      const mx = S / 2 + dx * blocksToPx;
      const mz = S / 2 + dz * blocksToPx;
      if (m.rare) {
        const pulse = 2.6 + 1.1 * Math.sin(now / 220);
        ctx.fillStyle = 'rgba(255, 214, 90, 0.35)';
        ctx.beginPath();
        ctx.arc(mx, mz, pulse + 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffd24a';
      } else {
        ctx.fillStyle = '#e8912d';
      }
      ctx.beginPath();
      ctx.arc(mx, mz, m.rare ? 2.8 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- view cone + player arrow (yaw 0 faces +z = screen down) ---
    const angle = Math.atan2(Math.cos(yaw), Math.sin(yaw));
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(angle);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, S * 0.34, -0.5, 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffb020';
    ctx.strokeStyle = 'rgba(20, 20, 20, 0.9)';
    ctx.lineWidth = 1.5;
    const r = Math.max(5, S * 0.075);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.65, r * 0.62);
    ctx.lineTo(-r * 0.3, 0);
    ctx.lineTo(-r * 0.65, -r * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // --- north label (screen up = -z); nudged down a touch to clear the
    // circular bezel ring at the dial's top
    ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    ctx.fillText('N', S / 2, 6);
    ctx.shadowBlur = 0;
  }

  useImperativeHandle(api, () => ({
    update(x, z, yaw) {
      ensureTile(x, z);
      draw(x, z, yaw);
    },
  }));

  // ---- canvas backing store sizing (crisp on HiDPI) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const css = rect.width || 150;
      sizeRef.current = css;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      tileRef.current = null;
      tileBaseRef.current = null;
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none relative overflow-hidden rounded-full border border-amber-400/40 bg-zinc-950/60 shadow-xl backdrop-blur-sm"
      style={{
        // lightly reduced (~13% smaller than the original 112/16vw/172):
        // the curved vitals ring (133% of this box, see HealthBar.tsx)
        // scales down with it and keeps its exact fit
        width: 'clamp(98px, 14vw, 150px)',
        aspectRatio: '1 / 1',
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* circular bezel: dark inner shading painted OVER the canvas so the
          square map crop reads as a recessed round dial */}
      <div
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          boxShadow:
            'inset 0 0 14px rgba(0,0,0,0.62), inset 0 0 3px rgba(0,0,0,0.85)',
        }}
      />
    </div>
  );
});

export default Minimap;
