import type { CommunicationPurpose } from './index.ts';

/**
 * Design spec §4.2 / BEMP v2.0 §0.5 — the two-plane principle.
 *
 * "A campaign must never delay an OTP."
 *
 * Any design in which a 400,000-recipient send and a password reset contend
 * for the same workers, the same connection pool, or the same provider rate
 * budget is rejected (BEMP C14).
 *
 * The planes share adapters, templates, suppression and analytics.
 * They never share capacity.
 */

export type CommunicationPlane = 'TRANSACTIONAL' | 'BULK';

export interface PlaneCharacteristics {
  readonly plane: CommunicationPlane;
  readonly preempts: boolean;
  readonly quietHoursApply: boolean;
  readonly frequencyCapApply: boolean;
  readonly warmupCapped: boolean;
}

const CHARACTERISTICS: Readonly<Record<CommunicationPlane, PlaneCharacteristics>> = {
  TRANSACTIONAL: {
    plane: 'TRANSACTIONAL',
    preempts: true,
    quietHoursApply: false,
    frequencyCapApply: false,
    warmupCapped: false,
  },
  BULK: {
    plane: 'BULK',
    preempts: false,
    quietHoursApply: true,
    frequencyCapApply: true,
    warmupCapped: true,
  },
};

/**
 * BEMP invariant K7: `plane` is derived from `purpose` and is never accepted
 * from a consumer. A consumer cannot elect a plane, which is what stops plane
 * selection becoming the new purpose-misclassification loophole.
 *
 * OPERATIONAL ('system') runs on the transactional plane but is subject to
 * quiet hours and frequency caps — see `planeCharacteristics` overrides below.
 */
export function derivePlane(purpose: CommunicationPurpose): CommunicationPlane {
  switch (purpose) {
    case 'transactional':
      return 'TRANSACTIONAL';
    case 'marketing':
      return 'BULK';
    case 'system':
      return 'TRANSACTIONAL';
  }
}

export function planeCharacteristics(purpose: CommunicationPurpose): PlaneCharacteristics {
  const plane = derivePlane(purpose);
  const base = CHARACTERISTICS[plane];
  if (purpose === 'system') {
    // Operational: transactional plane, but quiet hours and caps still apply.
    return { ...base, quietHoursApply: true, frequencyCapApply: true };
  }
  return base;
}

/**
 * B16 — the transactional floor is never borrowable.
 *
 * Given a connector's total per-minute capacity, returns how much each plane
 * may consume. Bulk may use the headroom above the floor; it may never use
 * the floor itself, even when transactional traffic is zero.
 */
export interface PlaneAllocation {
  readonly transactionalPerMinute: number;
  readonly bulkPerMinute: number;
  readonly floorReserved: number;
}

export function allocatePlaneCapacity(input: {
  readonly totalPerMinute: number;
  readonly transactionalFloorPct: number;
  /** §2.7 — a FAILING credential halves bulk and leaves transactional intact. */
  readonly bulkMultiplier?: number;
}): PlaneAllocation {
  if (input.totalPerMinute < 0) throw new Error('totalPerMinute must not be negative');
  if (input.transactionalFloorPct < 0 || input.transactionalFloorPct > 100) {
    throw new Error('transactionalFloorPct must be between 0 and 100');
  }

  const floor = Math.floor((input.totalPerMinute * input.transactionalFloorPct) / 100);
  const headroom = input.totalPerMinute - floor;
  const multiplier = input.bulkMultiplier ?? 1;

  return {
    // Transactional may use the whole connector when it needs to.
    transactionalPerMinute: input.totalPerMinute,
    // Bulk may only ever use the headroom, scaled by the health multiplier.
    bulkPerMinute: Math.floor(headroom * multiplier),
    floorReserved: floor,
  };
}
