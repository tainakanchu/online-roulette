import { render } from "ink";
import meow from "meow";
import { App } from "./App.js";

const cli = meow(
  `
  Usage
    $ roulette [options] [items...]

  Options
    --quick, -q              Quick mode (shorter animation)
    --shuffle, -s            Shuffle options before spinning
    --shuffle-count <n>      Number of shuffles (default: 1)

  Examples
    $ roulette "Pizza" "Sushi" "Ramen" "Curry"
    $ roulette -q Apple Banana Cherry
    $ roulette -s --shuffle-count 3 A B C D
`,
  {
    importMeta: import.meta,
    flags: {
      quick: {
        type: "boolean",
        shortFlag: "q",
        default: false,
      },
      shuffle: {
        type: "boolean",
        shortFlag: "s",
        default: false,
      },
      shuffleCount: {
        type: "number",
        default: 1,
      },
    },
  }
);

const options = cli.input;

render(
  <App
    options={options}
    quickMode={cli.flags.quick}
    shuffle={cli.flags.shuffle}
    shuffleCount={Math.max(1, cli.flags.shuffleCount)}
  />
);
