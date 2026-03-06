import { render } from "ink";
import meow from "meow";
import { App } from "./App.js";

const cli = meow(
  `
  Usage
    $ roulette [options] [items...]

  Options
    --quick, -q   Quick mode (shorter animation)

  Examples
    $ roulette "Pizza" "Sushi" "Ramen" "Curry"
    $ roulette -q Apple Banana Cherry
`,
  {
    importMeta: import.meta,
    flags: {
      quick: {
        type: "boolean",
        shortFlag: "q",
        default: false,
      },
    },
  }
);

const options = cli.input;

render(<App options={options} quickMode={cli.flags.quick} />);
