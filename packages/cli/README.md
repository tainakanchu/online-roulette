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

# Shuffle before spinning
roulette -s "Pizza" "Sushi" "Ramen" "Curry"

# Shuffle 3 times before spinning
roulette -s --shuffle-count 3 A B C D

# Interactive mode (no arguments)
roulette
```

### Interactive mode

When run without arguments, you can enter options one by one. Press Enter on an empty line to spin. Multi-line paste is also supported.

After entering options, press `S` to shuffle or `Enter` to spin.

```
> Pizza
> Sushi
> Ramen
> (Enter to spin, S to shuffle)
```

### Options

| Flag | Description |
|------|-------------|
| `--quick`, `-q` | Quick mode (shorter animation) |
| `--shuffle`, `-s` | Shuffle options before spinning |
| `--shuffle-count <n>` | Number of shuffles (default: 1) |

## npx

You can also use it without installing:

```bash
npx @tainakanchu/roulette-cli "A" "B" "C"
```
