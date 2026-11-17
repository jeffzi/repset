// Scenario: give back what a call took, with `teardown`.
//
// A game loop often takes objects from a pool instead of allocating them. A pool drains as calls
// take from it: each call here takes the whole pool, so without `teardown` the first call would
// empty it, and every later call would time allocation instead. Here `setup` hands each call an empty list, `fn` fills it from the
// pool, and `teardown` returns the vectors to the pool after the call, off the clock.
import { bench } from "repset";

const VECTORS_PER_CALL = 100;

interface Vector {
  x: number;
  y: number;
}

class VectorPool {
  readonly #free: Vector[] = [];

  constructor(size: number) {
    for (let index = 0; index < size; index++) this.#free.push({ x: 0, y: 0 });
  }

  /** A vector set to `(x, y)`, taken from the pool, or allocated when the pool is empty. */
  acquire(x: number, y: number): Vector {
    const vector = this.#free.pop() ?? { x: 0, y: 0 };
    vector.x = x;
    vector.y = y;
    return vector;
  }

  release(vector: Vector): void {
    this.#free.push(vector);
  }
}

const pool = new VectorPool(VECTORS_PER_CALL);

bench("vectors/allocate", () => {
  const vectors: Vector[] = [];
  for (let index = 0; index < VECTORS_PER_CALL; index++) vectors.push({ x: index, y: -index });
  return vectors;
});

bench("vectors/pool", {
  setup: (): Vector[] => [],
  fn: (taken) => {
    for (let index = 0; index < VECTORS_PER_CALL; index++) taken.push(pool.acquire(index, -index));
    return taken;
  },
  teardown: (taken) => {
    for (const vector of taken) pool.release(vector);
  },
  setupPerCall: true,
});
