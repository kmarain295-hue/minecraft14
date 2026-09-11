'use client';

/**
 * Curved vitals ring HUD — wraps AROUND the 3D globe minimap in the
 * top-left corner of the gameplay view, like a segmented gauge bezel
 * (crescent arc with a gap at the bottom, divided into blocks).
 *
 * Replaces the old dragon-medallion artwork — the /hud/health-bar.png
 * image is gone entirely; the ring is pure SVG. The classic bar styling
 * lives on as concentric arcs over a 270° sweep (gap at 6 o'clock):
 *   - OUTER arc  = HEALTH  (red)   — fall damage, regen after the grace
 *     period, death/respawn.
 *   - INNER arc  = STAMINA (amber) — unlimited sprint keeps it pinned
 *     full, wired all the same so any future drain shows up instantly.
 *   - Dark block separators every 27° echo the segmented dial look.
 *   - The numeric "HP / MAX" readout sits in the bottom gap.
 *
 * Extras kept from the previous UI: white damage flash when health drops,
 * and a pulsing red glow while health is under 25%.
 *
 * Positioning: page.tsx stacks this component directly after <Minimap/>
 * inside one positioned container, so the ring re-expresses the minimap's
 * exact clamp size as a percentage (133% box, centred) and hugs the globe
 * at every viewport width. The game loop pushes values every frame through
 * the imperative {@link HealthBarHandle.update} handle — everything is
 * written straight to the DOM (path `d` + text), so there are no React
 * re-renders per frame. The ring is pointer-events-none, so dragging the
 * globe beneath it still works.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface HealthBarHandle {
  /** Push the current vitals; writes directly to the DOM. */
  update(
    health: number,
    maxHealth: number,
    stamina: number,
    maxStamina: number,
    dead: boolean
  ): void;
}

/** Health fraction under which the ring starts pulsing. */
const HEALTH_LOW_AT = 0.25;

/** Matches MAX_HEALTH in page.tsx (flash-detection initial value). */
const MAX_HEALTH_START = 100;

/* ------------ ring geometry (SVG user units, viewBox 0 0 133 133) ------------ */
const C = 66.5; // ring centre
const HEALTH_R = 60.2; // health arc centreline radius
const STAMINA_R = 53; // stamina arc centreline radius (hugs the globe)
const RIM_R = 64.9; // thin decorative outer rim
const INNER_RIM_R = 56.2; // thin rim between stamina and health arcs
const START_DEG = 135; // bottom-left; the arc sweeps clockwise through top
const SPAN_DEG = 270; // total sweep — the bottom gap holds the HP readout
const BLOCKS = 10; // segmented blocks around the sweep (reference-dial look)

/** Point on a ring, SVG coords (y down; 0° = right, 90° = bottom). */
function polar(r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: C + r * Math.cos(rad), y: C + r * Math.sin(rad) };
}

/** Clockwise arc path along radius r from startDeg sweeping sweepDeg. */
function arcPath(r: number, startDeg: number, sweepDeg: number): string {
  const a = polar(r, startDeg);
  const b = polar(r, startDeg + sweepDeg);
  const large = sweepDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

const TRACK_HEALTH_D = arcPath(HEALTH_R, START_DEG, SPAN_DEG);
const TRACK_STAMINA_D = arcPath(STAMINA_R, START_DEG, SPAN_DEG);

/** Interior block separators drawn OVER the health fill. */
const TICKS = Array.from({ length: BLOCKS - 1 }, (_, i) => {
  const deg = START_DEG + (SPAN_DEG / BLOCKS) * (i + 1);
  const a = polar(HEALTH_R - 3.3, deg);
  const b = polar(HEALTH_R + 3.3, deg);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
});

const HealthBar = forwardRef<HealthBarHandle>(function HealthBar(_props, api) {
  const root = useRef<HTMLDivElement | null>(null);
  const healthFill = useRef<SVGPathElement | null>(null);
  const staminaFill = useRef<SVGPathElement | null>(null);
  const flash = useRef<SVGPathElement | null>(null);
  const healthText = useRef<SVGTextElement | null>(null);
  const lastHealth = useRef(MAX_HEALTH_START);
  const lowActive = useRef(false);

  useImperativeHandle(api, () => ({
    update(health, maxHealth, stamina, maxStamina, dead) {
      const hp =
        maxHealth > 0 ? Math.min(1, Math.max(0, health / maxHealth)) : 0;
      const sp =
        maxStamina > 0 ? Math.min(1, Math.max(0, stamina / maxStamina)) : 0;

      const hpSweep = hp * SPAN_DEG;
      const spSweep = sp * SPAN_DEG;
      const hpD = hpSweep < 0.5 ? '' : arcPath(HEALTH_R, START_DEG, hpSweep);
      const spD = spSweep < 0.5 ? '' : arcPath(STAMINA_R, START_DEG, spSweep);
      if (healthFill.current) {
        healthFill.current.setAttribute('d', hpD);
      }
      if (staminaFill.current) {
        staminaFill.current.setAttribute('d', spD);
      }
      if (healthText.current) {
        healthText.current.textContent = `${Math.max(0, Math.ceil(health))} / ${maxHealth}`;
      }

      // white flash sweeping the health arc whenever damage lands
      if (flash.current) {
        flash.current.setAttribute('d', hpD);
        if (health < lastHealth.current - 0.01) {
          const el = flash.current;
          el.style.transition = 'none';
          el.style.opacity = '0.85';
          requestAnimationFrame(() => {
            el.style.transition = 'opacity 0.45s ease-out';
            el.style.opacity = '0';
          });
        }
      }
      lastHealth.current = health;

      // pulsing red glow while badly hurt (toggled on threshold crossing)
      const low = !dead && hp > 0 && hp < HEALTH_LOW_AT;
      if (low !== lowActive.current) {
        lowActive.current = low;
        root.current?.classList.toggle('rf-hud-low', low);
      }
    },
  }));

  return (
    <div
      ref={root}
      aria-hidden
      className="pointer-events-none absolute select-none"
      style={{
        // 1.33x the minimap globe, centred on it — the container reuses the
        // same clamp the Minimap uses, so the ring hugs the globe exactly
        width: '133%',
        maxWidth: 'none',
        aspectRatio: '1 / 1',
        left: '-16.5%',
        top: '-16.5%',
      }}
    >
      <style>{`
        @keyframes rfHudPulse {
          0%, 100% { filter: drop-shadow(0 0 3px rgba(255, 40, 20, 0.25)); }
          50% { filter: drop-shadow(0 0 14px rgba(255, 60, 30, 0.85)); }
        }
        .rf-hud-low { animation: rfHudPulse 0.9s ease-in-out infinite; }
      `}</style>

      <svg
        viewBox="0 0 133 133"
        className="absolute inset-0 h-full w-full"
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* same gradients the classic bars used */}
          <linearGradient
            id="rfRingHealth"
            gradientUnits="userSpaceOnUse"
            x1={C}
            y1={3}
            x2={C}
            y2={130}
          >
            <stop offset="0%" stopColor="#ff8a64" />
            <stop offset="22%" stopColor="#e02323" />
            <stop offset="58%" stopColor="#b01010" />
            <stop offset="100%" stopColor="#6f0707" />
          </linearGradient>
          <linearGradient
            id="rfRingStamina"
            gradientUnits="userSpaceOnUse"
            x1={C}
            y1={10}
            x2={C}
            y2={123}
          >
            <stop offset="0%" stopColor="#ffe08a" />
            <stop offset="32%" stopColor="#f6b83c" />
            <stop offset="68%" stopColor="#c07f0d" />
            <stop offset="100%" stopColor="#7a4a05" />
          </linearGradient>
          <linearGradient
            id="rfRingFlash"
            gradientUnits="userSpaceOnUse"
            x1={C}
            y1={3}
            x2={C}
            y2={130}
          >
            <stop offset="0%" stopColor="rgba(255,255,255,0.95)" />
            <stop offset="100%" stopColor="rgba(255,170,150,0.5)" />
          </linearGradient>
        </defs>

        {/* decorative rims framing the gauge */}
        <circle
          cx={C}
          cy={C}
          r={RIM_R}
          fill="none"
          stroke="rgba(214, 164, 86, 0.35)"
          strokeWidth={0.8}
        />
        <circle
          cx={C}
          cy={C}
          r={INNER_RIM_R}
          fill="none"
          stroke="rgba(214, 164, 86, 0.22)"
          strokeWidth={0.7}
        />

        {/* dark tracks under both arcs (readable over any terrain) */}
        <path
          d={TRACK_HEALTH_D}
          fill="none"
          stroke="rgba(24, 14, 10, 0.78)"
          strokeWidth={6.6}
          strokeLinecap="round"
        />
        <path
          d={TRACK_STAMINA_D}
          fill="none"
          stroke="rgba(24, 14, 10, 0.6)"
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* STAMINA — inner amber arc (drawn first, sits under the ticks) */}
        <path
          ref={staminaFill}
          d=""
          fill="none"
          stroke="url(#rfRingStamina)"
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* HEALTH — outer red arc */}
        <path
          ref={healthFill}
          d=""
          fill="none"
          stroke="url(#rfRingHealth)"
          strokeWidth={6.6}
          strokeLinecap="round"
        />

        {/* block separators over the fill (segmented dial look) */}
        {TICKS.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke="rgba(30, 8, 5, 0.8)"
            strokeWidth={1.1}
            strokeLinecap="round"
          />
        ))}

        {/* damage flash sweep along the health arc */}
        <path
          ref={flash}
          d=""
          fill="none"
          stroke="url(#rfRingFlash)"
          strokeWidth={6.6}
          strokeLinecap="round"
          style={{ opacity: 0 }}
        />

        {/* numeric readout in the bottom gap */}
        <text
          ref={healthText}
          x={C}
          y={110.5}
          textAnchor="middle"
          fontSize={8.4}
          fontWeight={900}
          letterSpacing={0.6}
          fill="#ffe4de"
          stroke="#2d0906"
          strokeWidth={2}
          paintOrder="stroke"
          style={{
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            textShadow: '0 0 7px rgba(255, 70, 40, 0.55)',
          }}
        >
          100 / 100
        </text>
      </svg>
    </div>
  );
});

export default HealthBar;
