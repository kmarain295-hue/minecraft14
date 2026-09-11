import * as THREE from 'three';

/* ============================================================================
 * droneAi.ts — BUZZ's AUTONOMOUS COMBAT BRAIN ("no operator, no chat").
 *
 * The drone is a self-deciding gunship: nobody orders it around. Every frame
 * the page hands it a cheap snapshot of the world (its own position, the
 * player's position, a query view over the live threats) and the brain
 * answers with ONE order object that the page executes through the existing
 * plumbing:
 *
 *   perception  — scans for the nearest live hostile inside sensor range
 *   designation — locks it, tracks it by id, keeps an aimable chest point
 *   maneuver    — flies a GUNSHIP ORBIT: dash to a hover slot on a ring
 *                 around the target (standoff radius + attack altitude),
 *                 pivot on the spot, deliver a burst, strafe to the next
 *                 ring slot, repeat — classic attack-run rhythm
 *   gunnery     — opens fire only once the body has pivoted inside the
 *                 turret's frontal arc; leads moving targets and keeps the
 *                 same imperfect-spread personality as the manual stream
 *   rockets     — drops a wing-pod rocket on its OWN CADENCE while a
 *                 target is in range — no lock ritual, no delay: the
 *                 launch order carries the target id so the page can hand
 *                 the pooled system a live tracker -> HOMING rocket
 *   judgment    — breaks off and returns to the player when the target
 *                 dies (post-kill ceasefire), when the fight drifts past
 *                 the leash range, or when BUZZ's own hull runs low — the
 *                 drone ALWAYS comes home to repair on its own
 *
 * The brain never touches the drone's flight model: it only designates a
 * world hover point (`flightOverride`) which petDrone feeds through the
 * exact same critically-damped spring, banking, heading and terrain-glide
 * code the formation uses — so Tasks 11-13 behavior is preserved bit for
 * bit whenever the brain is idle.
 *
 * Pure functions + state, zero DOM, zero audio, zero allocations in the
 * hot path (one reused order object + a handful of scratch vectors).
 * ==========================================================================*/

/** One perceptible hostile (ground dummy OR flying enemy drone). */
export interface DroneAiTargetInfo {
  id: number;
  /** Feet/center world position. */
  pos: THREE.Vector3;
  /** Chest/center world Y — a good gun aim point. */
  topY: number;
  /** True for flying threats — the orbit slot then hovers at THEIR
   *  altitude band instead of seating near the ground. */
  air: boolean;
}

/** Read-only view over the combined threat range the brain hunts in
 *  (the page fuses the target dummies + the enemy drone manager). */
export interface DroneAiTargetView {
  nearestAlive(from: THREE.Vector3, maxDist: number): DroneAiTargetInfo | null;
  isAlive(id: number): boolean;
  posOf(id: number): { x: number; y: number; z: number } | null;
}

export interface DroneAiTickArgs {
  dt: number;
  /** BUZZ's world position (petDrone.group.position). */
  dronePos: THREE.Vector3;
  /** BUZZ's current body yaw (petDrone.group.rotation.y). */
  droneYaw: number;
  /** Player world position — the home the drone always returns to. */
  playerPos: THREE.Vector3;
  /** Shared clock (performance.now()/1000) for cadence + ceasefire gates. */
  nowS: number;
  /** Page-level stamp of the last kill (the drone holds fire after one). */
  lastKillAt: number;
  /** BUZZ hull integrity 0..100 — below HULL_RETREAT the brain disengages
   *  and flies home to repair instead of fighting on. */
  buzzHull: number;
  /** Terrain height for attack-altitude seating. */
  heightAt: (x: number, z: number) => number;
  /** Combined live-threat range (dummies + enemy drones). */
  dummies: DroneAiTargetView;
}

/** A player-issued VOICE order (voice link, see voiceControl.ts). The
 *  brain obeys it until it completes, times out, or is replaced — live
 *  combat (ENGAGE) always outranks a directive's flight, and ATTACK
 *  forces engagement even through the post-kill ceasefire. Self-clearing
 *  orders (COME/SCOUT/RISE/DESCEND/CEASEFIRE) can be CHAINED: a follow-up
 *  order issued while one is still running waits in a short queue and
 *  takes over the moment the running one completes. */
export type VoiceDirective =
  | { kind: 'COME' } // fly to the player's side right now
  | { kind: 'HOLD' } // freeze at the current hover point
  | { kind: 'PATROL' } // clear any directive — back to normal escort
  | { kind: 'SCOUT'; dirX: number; dirZ: number; dist?: number } // recon dash
  | { kind: 'ORBIT'; rate?: number } // circle the player (fast = trick)
  | { kind: 'RISE' } // climb higher
  | { kind: 'DESCEND' } // come lower
  | { kind: 'ATTACK'; weapon?: 'any' | 'gun' | 'rockets' } // engage
  | { kind: 'CEASEFIRE' } // weapons hold — break off + stop shooting
  | { kind: 'GUARD' }; // tight escort — engage anything near the player

/** One frame's worth of intent — the page executes it verbatim. */
export interface DroneAiOrder {
  /** High-level mode for HUD + debug surfaces. */
  state: 'PATROL' | 'ENGAGE' | 'RTB';
  /** Locked target id (dummy index or enemy-drone id) while ENGAGE. */
  targetId: number | null;
  /** World hover point to hold (orbit slot). Null → normal formation. */
  flightOverride: THREE.Vector3 | null;
  /** Point the parked body should slew its nose onto (target chest). */
  pivotTo: THREE.Vector3 | null;
  /** Non-null → squeeze the chin gun at this point this frame. */
  fireAim: THREE.Vector3 | null;
  /** Non-null → drop one wing-pod rocket at this point THIS frame.
   *  Pair with `missileTargetId`. */
  missileAim: THREE.Vector3 | null;
  /** Live target the homing rocket should chase (null → straight). */
  missileTargetId: number | null;
}

/* ----- tuning (world units; 100 u = 1 m) ----- */
const PERCEPTION = 1500; // sensor slant range from the drone
const LEASH = 2400; // target farther than this from the player → break off
const STANDOFF = 340; // orbit radius around the designated target
const ATTACK_ALT = 175; // hover height above a GROUND target
const AIR_ALT = 60; // hover height above a FLYING target (dogfight band)
const ARRIVE_DIST = 70; // close enough to the slot to start firing
const ALIGN_LIMIT = 1.0; // rad off the nose the turret may still engage
const BURST_MIN = 1.0; // s of continuous fire per pass
const BURST_MAX = 1.9;
const SETTLE = 0.22; // s of hover settle before the first round of a pass
const MISSILE_CADENCE = 4.75; // s between autonomous rocket launches
const MISSILE_RANGE = 900; // no rockets on far targets — save them
const ROCKET_SPEED = 430; // bulletSystem ROCKET_SPEED, for lead prediction
const CEASEFIRE = 2.5; // s of hold-fire after each kill (matches the page)
const RTB_TIME = 3.5; // s of return-to-base mode after a fight ends
const HULL_RETREAT = 30; // hull below this → disengage + fly home to repair
const REPOSITION_MIN = 0.5; // rad walked around the ring between bursts
const REPOSITION_MAX = 0.95;
const GUN_LEAD = 0.22; // s of target velocity fed into the gun aim
const ROCKET_LEAD = 0.85; // fraction of perfect lead for the rocket
const LEAD_CLAMP = 110; // never lead farther than this (patrol walkers)
/* ----- voice-directive tuning ----- */
const COME_ALT = 55; // hover height over the player's feet for COME
const COME_ARRIVE = 85; // horizontal dist that counts as "came"
const COME_TTL = 20; // s before a COME order gives up
const SCOUT_DIST = 620; // how far a scout dash flies from the player
const SCOUT_TTL = 8; // s on station before returning
const SHORT_TTL = 4; // s a RISE/DESCEND hop lasts
const ORBIT_R = 280; // ORBIT circle radius around the player
const ORBIT_ALT = 85; // ORBIT height over the player's feet
const ORBIT_RATE = 1.05; // rad/s swept around the player
const ORBIT_FAST = 2.35; // rad/s for the voice "spin/dance" trick lap
const CEASEFIRE_TTL = 12; // s a voice hold-fire order lasts
const GUARD_R = 560; // GUARD mode engages threats this close to the player
const GUARD_ALT = 110; // GUARD hover height over the player's feet

export function createDroneAi(): {
  tick(args: DroneAiTickArgs): DroneAiOrder;
  snapshot(): {
    state: DroneAiOrder['state'];
    targetId: number | null;
    phase: 'move' | 'fire';
    burstLeft: number;
    nextMissileIn: number;
    targetDist: number;
    directive: string | null;
  };
  /** Issue a player voice order (voice link). Captures the anchors it
   *  needs at issue time; pass PATROL to clear any active directive. */
  setDirective(
    d: VoiceDirective,
    nowS: number,
    playerPos: THREE.Vector3,
    dronePos: THREE.Vector3
  ): void;
} {
  let state: DroneAiOrder['state'] = 'PATROL';
  let targetId: number | null = null;
  let targetAir = false;
  let phase: 'move' | 'fire' = 'move';
  let orbitAngle = 0;
  let burstLeft = 0;
  let settle = 0;
  let rtbLeft = 0;
  let lastMissileAt = -10;
  let chestOff = 90; // chest height above the target's feet (recaptured on lock)
  let haveLastPos = false;
  let targetDist = 0;

  /* ----- voice-directive state (player orders via the voice link) ----- */
  let directive: VoiceDirective | null = null;
  let directiveAt = -10; // nowS stamp when the directive was issued
  let orbitAng = 0; // ORBIT sweep angle around the player
  let orbitRate = ORBIT_RATE; // ORBIT sweep speed (voice can spin it fast)
  const dirPoint = new THREE.Vector3(); // directive hover anchor
  /** Chained voice orders: a follow-up issued while a self-clearing order
   *  is still running waits here and takes over on completion (max 2). */
  const queue: VoiceDirective[] = [];

  const targetPos = new THREE.Vector3();
  const lastTargetPos = new THREE.Vector3();
  const targetVel = new THREE.Vector3();
  const firePoint = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const order: DroneAiOrder = {
    state: 'PATROL',
    targetId: null,
    flightOverride: null,
    pivotTo: null,
    fireAim: null,
    missileAim: null,
    missileTargetId: null,
  };

  /** Lock a freshly detected target and start the approach from our side. */
  function engage(t: DroneAiTargetInfo, from: THREE.Vector3): void {
    state = 'ENGAGE';
    targetId = t.id;
    targetAir = t.air;
    phase = 'move';
    chestOff = t.topY - t.pos.y;
    // begin the orbit on the ring edge we are already nearest to — the
    // approach reads as a swoop-in, not a teleport to a scripted side
    orbitAngle = Math.atan2(from.x - t.pos.x, from.z - t.pos.z);
    haveLastPos = false;
    targetVel.set(0, 0, 0);
    lastTargetPos.copy(t.pos);
    targetPos.copy(t.pos);
  }

  /** Break off the engagement and fly home. */
  function breakOff(): void {
    state = 'RTB';
    rtbLeft = RTB_TIME;
    targetId = null;
    haveLastPos = false;
  }

  /** Issue a player voice order; anchors captured at issue time. A
   *  follow-up while a self-clearing order runs is QUEUED ("come here
   *  then scout ahead"); a mode order (ATTACK/HOLD/ORBIT/GUARD) or
   *  PATROL replaces everything instantly. */
  function setDirective(
    d: VoiceDirective,
    nowS: number,
    playerPos: THREE.Vector3,
    dronePos: THREE.Vector3
  ): void {
    directiveAt = nowS;
    if (d.kind === 'PATROL') {
      directive = null;
      queue.length = 0;
      return;
    }
    const persistent =
      d.kind === 'ATTACK' ||
      d.kind === 'HOLD' ||
      d.kind === 'ORBIT' ||
      d.kind === 'GUARD';
    const activePersistent =
      directive !== null &&
      (directive.kind === 'ATTACK' ||
        directive.kind === 'HOLD' ||
        directive.kind === 'ORBIT' ||
        directive.kind === 'GUARD');
    if (directive && !persistent && !activePersistent && queue.length < 2) {
      queue.push(d); // waits politely behind the running order
      return;
    }
    queue.length = 0;
    directive = d;
    switch (d.kind) {
      case 'COME':
        dirPoint.set(playerPos.x, playerPos.y + COME_ALT, playerPos.z);
        break;
      case 'HOLD':
        dirPoint.copy(dronePos);
        break;
      case 'SCOUT': {
        const dist =
          typeof d.dist === 'number' && d.dist > 60
            ? Math.min(d.dist, 2600)
            : SCOUT_DIST;
        dirPoint.set(
          playerPos.x + d.dirX * dist,
          Math.max(playerPos.y + 120, dronePos.y),
          playerPos.z + d.dirZ * dist
        );
        break;
      }
      case 'RISE':
        dirPoint.copy(dronePos);
        dirPoint.y += 170;
        break;
      case 'DESCEND':
        dirPoint.copy(dronePos);
        dirPoint.y -= 150;
        break;
      case 'ORBIT':
        orbitRate = d.rate ?? ORBIT_RATE;
        break;
      case 'CEASEFIRE':
        // weapons hold breaks off any live engagement immediately
        if (state === 'ENGAGE') breakOff();
        break;
      default:
        break; // GUARD/ATTACK compute live each tick
    }
  }

  /** Clear the running directive and start the next queued one, if any. */
  function clearDirective(
    nowS: number,
    playerPos: THREE.Vector3,
    dronePos: THREE.Vector3
  ): void {
    directive = null;
    const nx = queue.shift();
    if (nx) setDirective(nx, nowS, playerPos, dronePos);
  }

  /** Ordnance preference while an ATTACK directive is active. */
  const weaponPref = (): 'any' | 'gun' | 'rockets' =>
    directive && directive.kind === 'ATTACK'
      ? (directive.weapon ?? 'any')
      : 'any';

  /** Voice hold-fire order: every trigger (gun, rockets, auto-scan)
   *  stays cold while it runs. */
  const holdFire = (): boolean => directive?.kind === 'CEASEFIRE';

  /** Serve the active voice directive (flight overrides) while on
   *  PATROL. Timed orders self-clear (pulling the next queued one);
   *  ENGAGE always outranks flight. */
  function applyDirective(
    order: DroneAiOrder,
    nowS: number,
    dt: number,
    playerPos: THREE.Vector3,
    dronePos: THREE.Vector3
  ): void {
    if (!directive) return;
    const age = nowS - directiveAt;
    switch (directive.kind) {
      case 'COME':
        if (
          age > COME_TTL ||
          Math.hypot(dronePos.x - dirPoint.x, dronePos.z - dirPoint.z) <
            COME_ARRIVE
        ) {
          clearDirective(nowS, playerPos, dronePos);
          return;
        }
        order.flightOverride = dirPoint;
        return;
      case 'HOLD':
        order.flightOverride = dirPoint;
        return;
      case 'SCOUT':
        if (age > SCOUT_TTL) {
          clearDirective(nowS, playerPos, dronePos);
          return;
        }
        order.flightOverride = dirPoint;
        return;
      case 'ORBIT':
        orbitAng = (orbitAng + orbitRate * dt) % (Math.PI * 2);
        dirPoint.set(
          playerPos.x + Math.sin(orbitAng) * ORBIT_R,
          playerPos.y + ORBIT_ALT,
          playerPos.z + Math.cos(orbitAng) * ORBIT_R
        );
        order.flightOverride = dirPoint;
        return;
      case 'RISE':
      case 'DESCEND':
        if (age > SHORT_TTL) {
          clearDirective(nowS, playerPos, dronePos);
          return;
        }
        order.flightOverride = dirPoint;
        return;
      case 'CEASEFIRE':
        // pure fire-discipline mode: no flight override of its own, it
        // just suppresses every trigger until the TTL runs out
        if (age > CEASEFIRE_TTL) clearDirective(nowS, playerPos, dronePos);
        return;
      case 'GUARD':
        // tight escort: hover close over the player's shoulder, then the
        // tick's scan engages anything that comes near them
        dirPoint.set(
          playerPos.x + 90,
          playerPos.y + GUARD_ALT,
          playerPos.z + 60
        );
        order.flightOverride = dirPoint;
        return;
      default:
        return; // ATTACK has no flight of its own — the scan engages
    }
  }

  /** Live state read — defeats TS control-flow narrowing after the
   *  setter calls above (they mutate the captured variable). */
  const stateNow = (): DroneAiOrder['state'] => state;

  /** Shared aim builder: chest + velocity lead, clamped. */
  function buildAim(leadFrac: number, out: THREE.Vector3): void {
    out.copy(chest).addScaledVector(targetVel, leadFrac);
    const lead = tmp.copy(targetVel).multiplyScalar(leadFrac).length();
    if (lead > LEAD_CLAMP) {
      out.copy(chest).addScaledVector(targetVel, leadFrac * (LEAD_CLAMP / lead));
    }
  }

  /** One frame of brain: perceive, judge, and answer with an order. */
  function tick(a: DroneAiTickArgs): DroneAiOrder {
    const { dt, dronePos, droneYaw, playerPos, nowS, lastKillAt, heightAt, dummies } = a;
    order.state = state;
    order.targetId = targetId;
    order.flightOverride = null;
    order.pivotTo = null;
    order.fireAim = null;
    order.missileAim = null;
    order.missileTargetId = null;

    const ceasefire = nowS - lastKillAt < CEASEFIRE;
    const hullCritical = a.buzzHull < HULL_RETREAT;

    /* ----- validate the designated target every frame ----- */
    if (state === 'ENGAGE' && targetId !== null) {
      const p = dummies.posOf(targetId);
      if (!dummies.isAlive(targetId) || !p) {
        // takedown confirmed (the page's onKill already stamped the
        // ceasefire) — break off, RTB, then re-scan for what's left
        breakOff();
        order.state = state;
        order.targetId = null;
      } else {
        targetPos.set(p.x, p.y, p.z);
      }
    }

    /* ----- self-preservation: a battered drone goes home to repair ----- */
    if (state === 'ENGAGE' && hullCritical) {
      breakOff();
      order.state = state;
      order.targetId = null;
    }

    /* ----- RTB: fly home; once the ceasefire lifts we may re-engage
       mid-flight if something else is still alive ----- */
    if (state === 'RTB') {
      rtbLeft -= dt;
      if (rtbLeft <= 0) state = 'PATROL';
      if (!ceasefire && !hullCritical) {
        const t = dummies.nearestAlive(dronePos, PERCEPTION);
        if (t) engage(t, dronePos);
      }
      order.state = stateNow();
      order.targetId = targetId;
      if (stateNow() !== 'ENGAGE') return order; // no override → spring pulls home
    }

    /* ----- PATROL: formation flight + sensor scan (+ voice orders) ---- */
    if (state === 'PATROL') {
      // ATTACK voice order cuts through the post-kill ceasefire; hull
      // criticality is still respected (survival outranks everything)
      const forceAttack = directive?.kind === 'ATTACK';
      if (
        ((!ceasefire && !hullCritical && !holdFire()) ||
          (forceAttack && !hullCritical)) &&
        !ceasefire // a fresh post-kill pause always wins over a re-scan
      ) {
        // GUARD mode hunts around the PLAYER (defensive ring), normal
        // patrol hunts around the drone (full sensor sweep)
        const guarding = directive?.kind === 'GUARD';
        const scanFrom = guarding ? playerPos : dronePos;
        const t = dummies.nearestAlive(
          scanFrom,
          guarding ? GUARD_R : PERCEPTION
        );
        if (t) engage(t, dronePos);
      }
      if (stateNow() !== 'ENGAGE') {
        applyDirective(order, nowS, dt, playerPos, dronePos);
        return order;
      }
      order.state = stateNow();
      order.targetId = targetId;
    }

    /* ----- ENGAGE ----- */
    // leash judgment: never chase a fight away from the player
    const droneFromPlayer = Math.hypot(
      dronePos.x - playerPos.x,
      dronePos.z - playerPos.z
    );
    const targetFromPlayer = Math.hypot(
      targetPos.x - playerPos.x,
      targetPos.z - playerPos.z
    );
    if (droneFromPlayer > LEASH + 600 || targetFromPlayer > LEASH) {
      breakOff();
      order.state = state;
      order.targetId = null;
      return order;
    }

    // target velocity estimate (feeds gun + rocket lead)
    if (haveLastPos) {
      tmp.copy(targetPos).sub(lastTargetPos).divideScalar(Math.max(dt, 1e-4));
      targetVel.lerp(tmp, 1 - Math.exp(-6 * dt));
    }
    lastTargetPos.copy(targetPos);
    haveLastPos = true;
    targetDist = dronePos.distanceTo(targetPos);

    chest.set(targetPos.x, targetPos.y + chestOff, targetPos.z);

    // --- missile pass: the brain drops a homing rocket on its OWN cadence
    // while a target is in range — no lock ritual, no reticle, no delay.
    // The order carries the target id so the page hands the pooled system
    // a live tracker and the rocket chases it (proportional navigation).
    if (
      !ceasefire &&
      !holdFire() &&
      weaponPref() !== 'gun' && // ATTACK voice order: rockets-only mode
      nowS - lastMissileAt > MISSILE_CADENCE &&
      targetDist < MISSILE_RANGE
    ) {
      buildAim((targetDist / ROCKET_SPEED) * ROCKET_LEAD, aim);
      order.missileAim = aim;
      order.missileTargetId = targetId;
      lastMissileAt = nowS;
    }

    // orbit slot around the designated target (petDrone adds terrain
    // clearance on top of this, exactly like the formation slot). Ground
    // targets get the attack altitude; FLYING targets are fought in their
    // own altitude band so the dogfight reads as a duel, not a bombing run.
    const ringAlt = targetAir ? AIR_ALT : ATTACK_ALT;
    firePoint.set(
      targetPos.x + Math.sin(orbitAngle) * STANDOFF,
      targetPos.y + ringAlt,
      targetPos.z + Math.cos(orbitAngle) * STANDOFF
    );
    if (!targetAir) {
      const slotGround = heightAt(firePoint.x, firePoint.z);
      if (firePoint.y < slotGround + ATTACK_ALT * 0.55) {
        firePoint.y = slotGround + ATTACK_ALT * 0.55;
      }
    }
    order.flightOverride = firePoint;
    order.pivotTo = chest; // parked body slews its nose onto the mark

    const distToSlot = Math.hypot(
      firePoint.x - dronePos.x,
      firePoint.z - dronePos.z
    );

    if (phase === 'move') {
      // AIR DOGFIGHT: a hostile drone never sits still — its pursuit ring
      // keeps sliding, so waiting to "arrive" at the slot would spin the
      // duel forever. Engage ROLLING-style: fire on every pass the nose
      // swings onto the mark.
      if (targetAir) {
        const ang =
          Math.atan2(targetPos.x - dronePos.x, targetPos.z - dronePos.z) -
          droneYaw;
        const wrapped = Math.atan2(Math.sin(ang), Math.cos(ang));
        if (
          !ceasefire &&
          !holdFire() &&
          weaponPref() !== 'rockets' && // ATTACK: gun-suppressed mode
          targetDist < 520 &&
          Math.abs(wrapped) < 1.0
        ) {
          buildAim(GUN_LEAD, aim);
          aim.x += (Math.random() - 0.5) * 26;
          aim.z += (Math.random() - 0.5) * 26;
          aim.y += (Math.random() - 0.5) * 18;
          order.fireAim = aim;
        }
        if (distToSlot < ARRIVE_DIST) {
          phase = 'fire';
          burstLeft = BURST_MIN + Math.random() * (BURST_MAX - BURST_MIN);
          settle = SETTLE;
        }
      } else if (distToSlot < ARRIVE_DIST) {
        // GROUND attack: dash to the slot, settle, then deliver a burst
        phase = 'fire';
        burstLeft = BURST_MIN + Math.random() * (BURST_MAX - BURST_MIN);
        settle = SETTLE;
      }
    } else {
      // hold the slot, wait for the body pivot to swing inside the
      // turret's arc, then deliver the burst
      if (settle > 0) {
        settle -= dt;
      } else {
        const ang =
          Math.atan2(targetPos.x - dronePos.x, targetPos.z - dronePos.z) -
          droneYaw;
        const wrapped = Math.atan2(Math.sin(ang), Math.cos(ang));
        if (
          Math.abs(wrapped) < ALIGN_LIMIT &&
          !ceasefire &&
          !holdFire() &&
          weaponPref() !== 'rockets' // ATTACK: gun-suppressed mode
        ) {
          buildAim(GUN_LEAD, aim);
          // imperfect bursts: most rounds connect, some chew the dirt
          // right next to the target (visible near-miss sparks)
          aim.x += (Math.random() - 0.5) * 26;
          aim.z += (Math.random() - 0.5) * 26;
          aim.y += (Math.random() - 0.5) * 18;
          order.fireAim = aim;
        }
        burstLeft -= dt;
        if (burstLeft <= 0) {
          // burst delivered → strafe to a fresh ring slot (attack-run
          // rhythm: dash, pivot, burst, dash)
          phase = 'move';
          orbitAngle +=
            REPOSITION_MIN + Math.random() * (REPOSITION_MAX - REPOSITION_MIN);
        }
      }
    }
    order.state = state;
    order.targetId = targetId;
    return order;
  }

  function snapshot(): {
    state: DroneAiOrder['state'];
    targetId: number | null;
    phase: 'move' | 'fire';
    burstLeft: number;
    nextMissileIn: number;
    targetDist: number;
    directive: string | null;
    queued: number;
  } {
    return {
      state,
      targetId,
      phase,
      burstLeft: Math.max(0, Math.round(burstLeft * 100) / 100),
      nextMissileIn: Math.max(
        0,
        Math.round(
          (MISSILE_CADENCE - (performance.now() / 1000 - lastMissileAt)) * 100
        ) / 100
      ),
      targetDist: Math.round(targetDist),
      directive: directive?.kind ?? null,
      queued: queue.length,
    };
  }

  return { tick, snapshot, setDirective };
}
