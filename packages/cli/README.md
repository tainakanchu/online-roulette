# @tainakanchu/roulette-cli

Terminal roulette spinner for quick random selection.

## Install

```bash
npm install -g @tainakanchu/roulette-cli
```

## Usage

```bash
# Pass options as arguments
roulette "Pizza" "Sushi" "Ramen" "Curry"

# Quick mode (shorter animation)
roulette -q Apple Banana Cherry

# Interactive mode (no arguments)
roulette
```

### Interactive mode

When run without arguments, you can enter options one by one. Press Enter on an empty line to spin. Multi-line paste is also supported.

```
> Pizza
> Sushi
> Ramen
> (Enter to spin)
```

### Options

| Flag | Description |
|------|-------------|
| `--quick`, `-q` | Quick mode (shorter animation) |

## npx

You can also use it without installing:

```bash
npx @tainakanchu/roulette-cli "A" "B" "C"
```
