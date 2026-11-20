import { bench } from "repset";

/** `count` short words, the same in every process, as each process runs `setup` on its own. */
function words(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `word${String(index % 100)}`);
}

bench("concat", {
  setup: () => words(1000),
  fn: {
    loop: (list) => {
      let text = "";
      for (const word of list) text += word;
      return text;
    },
    join: (list) => list.join(""),
  },
});
