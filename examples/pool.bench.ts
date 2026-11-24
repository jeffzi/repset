// Scenario: give back what a call took, with `teardown`.
//
// A game loop often takes objects from a pool instead of allocating them. A pool drains as calls
// take from it, so without `teardown` the first calls would empty it, and every later call would
// time allocation instead. Here `setup` hands each call an empty list and reserves its vectors,
// `fn` fills the list from the pool, and `teardown` returns the vectors to the pool after the
// call, off the clock.
//
// repset may set up several calls before it runs any of them, so their states are alive together,
// and it may tear a state down without running `fn` on it. Reserving in `setup` grows the pool, off
// the clock, until it holds a vector for every reservation not yet taken, and `teardown` cancels
// what its call did not take: the pool never assumes one call at a time.
import { bench } from "repset";

const VECTORS_PER_CALL = 100;

interface Vector {
  x: number;
  y: number;
}

class VectorPool {
  readonly #free: Vector[] = [];
  /** Vectors reserved by calls that have not taken them yet. */
  #reserved = 0;

  /** Reserves `count` vectors for a call, growing the pool so every reserved vector is free. */
  reserve(count: number): void {
    this.#reserved += count;
    while (this.#free.length < this.#reserved) this.#free.push({ x: 0, y: 0 });
  }

  /** Gives back `count` reservations a call did not take. */
  cancel(count: number): void {
    this.#reserved -= count;
  }

  /** A reserved vector set to `(x, y)`, taken from the pool, or allocated when the pool is empty. */
  acquire(x: number, y: number): Vector {
    const vector = this.#free.pop() ?? { x: 0, y: 0 };
    this.#reserved -= 1;
    vector.x = x;
    vector.y = y;
    return vector;
  }

  release(vector: Vector): void {
    this.#free.push(vector);
  }
}

const pool = new VectorPool();

bench("vectors/allocate", () => {
  const vectors: Vector[] = [];
  for (let index = 0; index < VECTORS_PER_CALL; index++) vectors.push({ x: index, y: -index });
  return vectors;
});

bench("vectors/pool", {
  setup: (): Vector[] => {
    pool.reserve(VECTORS_PER_CALL);
    return [];
  },
  fn: (taken) => {
    for (let index = 0; index < VECTORS_PER_CALL; index++) taken.push(pool.acquire(index, -index));
    return taken;
  },
  teardown: (taken) => {
    for (const vector of taken) pool.release(vector);
    pool.cancel(VECTORS_PER_CALL - taken.length);
  },
  setupPerCall: true,
});
