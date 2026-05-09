import type { Rarity, SlotType } from '../tier-config';

export type SolverMode = 'lagrangian' | 'tilt';

export interface SlotWeights {
  readonly type: SlotType;
  readonly count: number;
  readonly weights: Readonly<Record<Rarity, number>>;
}

export interface SolverInput {
  /** Aspirational (advertised) weights, one entry per slot, in slot order. */
  readonly aspirational: readonly SlotWeights[];
  /** Floor weights, must align 1:1 with aspirational by index, type, count. */
  readonly floor: readonly SlotWeights[];
  readonly priceCents: number;
  readonly rarityMeanCents: Readonly<Record<Rarity, number>>;
  /** Target margin in [0, 1). Solver targets `priceCents * (1 - targetMargin)` as EV. */
  readonly targetMargin: number;
  readonly mode?: SolverMode;
}

export interface SolvedSlot extends SlotWeights {
  /** Tilt parameter in [0, 1]: 0 = floor, 1 = aspirational. */
  readonly tilt: number;
}

export type SolverStatus = 'ok' | 'infeasible';

export interface SolverResult {
  readonly status: SolverStatus;
  readonly reason?: string;
  readonly slots: readonly SolvedSlot[];
  readonly evCents: number;
  readonly mode: SolverMode;
}
