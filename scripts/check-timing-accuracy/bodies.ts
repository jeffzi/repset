// The two bodies the timing accuracy check times, each about a microsecond per call.
//
// `each` calls a small function per element through a helper, the shape the JIT compiles into the
// loop around it, so a harness that changes what surrounds the body call changes that body's cost
// first. `inlined` is the same loop written out. Both run against one state of `SIZE` moving
// points.

interface Point {
  x: number;
  readonly vx: number;
}

/** The bodies' shared state: the points every call moves. */
export interface State {
  readonly points: readonly Point[];
}

const SIZE = 1000;

const VELOCITY_LEVELS = 7;

const VELOCITY_STEP = 0.001;

export const BODY_NAMES = ["each", "inlined"] as const;

export type BodyName = (typeof BODY_NAMES)[number];

/**
 * The name the timing accuracy bench registers `body` under.
 *
 * @param body - The body the case times.
 * @returns The bench name, `timing-accuracy/` followed by the body's name.
 */
export function benchName(body: BodyName): string {
  return `timing-accuracy/${body}`;
}

/**
 * Builds a state of {@link SIZE} points at x = 0 whose velocities cycle through
 * {@link VELOCITY_LEVELS} multiples of {@link VELOCITY_STEP}, starting at 0.
 *
 * @returns A fresh state.
 */
export function buildState(): State {
  const points: Point[] = [];
  for (let index = 0; index < SIZE; index++)
    points.push({ x: 0, vx: (index % VELOCITY_LEVELS) * VELOCITY_STEP });
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

function move(point: Point): void {
  point.x += point.vx;
}

export const BODIES: Readonly<Record<BodyName, (state: State) => void>> = {
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
export function positionSum(state: State): number {
  let sum = 0;
  for (const point of state.points) sum += point.x;
  return sum;
}
