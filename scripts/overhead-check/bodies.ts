/**
 * The two bodies the overhead check times, each about a microsecond per call.
 *
 * `each` calls a small function per element through a helper, the shape the JIT compiles into the
 * loop around it, so a harness that changes what surrounds the body call changes that body's cost
 * first. `inlined` is the same loop written out. Both run against one state of {@link SIZE}
 * moving points.
 */

interface Point {
  x: number;
  readonly vx: number;
}

/** The bodies' shared state: the points every call moves. */
export interface Points {
  readonly points: readonly Point[];
}

/** How many points a state holds. */
const SIZE = 1000;

export const BODY_NAMES = ["each", "inlined"] as const;

export type BodyName = (typeof BODY_NAMES)[number];

/**
 * Builds a state of {@link SIZE} points at rest with small distinct velocities.
 *
 * @returns A fresh state.
 */
export function buildPoints(): Points {
  const points: Point[] = [];
  for (let index = 0; index < SIZE; index++) points.push({ x: 0, vx: (index % 7) * 0.001 });
  return { points };
}

/**
 * Calls `visit` on every point, as an entity library's `each` does.
 *
 * @param points - The points to visit.
 * @param visit - Called once per point, in order.
 */
function each(points: readonly Point[], visit: (point: Point) => void): void {
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point !== undefined) visit(point);
  }
}

/**
 * Moves `point` one step.
 *
 * @param point - The point to move.
 */
function move(point: Point): void {
  point.x += point.vx;
}

export const BODIES: Readonly<Record<BodyName, (state: Points) => void>> = {
  each: ({ points }) => {
    each(points, move);
  },
  inlined: ({ points }) => {
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (point !== undefined) point.x += point.vx;
    }
  },
};

/**
 * Sums every point's position, so no engine can treat the bodies' work as dead.
 *
 * @param state - The points to sum.
 * @returns The sum of their positions.
 */
export function positionSum(state: Points): number {
  let sum = 0;
  for (const point of state.points) sum += point.x;
  return sum;
}
