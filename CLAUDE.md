# プロジェクト作業ルール

このリポジトリで作業する際のガイドライン。

## Web UI を追加・変更するときはダークモード対応も同時に行う

`packages/web` に新しいコンポーネント・CSS を追加したり既存の CSS クラスを新設したら、必ず `packages/web/src/styles/themes/dark.css` の `@media (prefers-color-scheme: dark)` ブロック内に対応する上書きを追加すること。

- 背景色（`#fff`, `#f5f5f5`, `#f8f9fa`, `#eceff1` 等）、前景色（`#000`, `#333` 等）、ボーダー色など、ライト前提の色を書いたら必ず dark 側の上書きを用意する
- 既存コンポーネント（RouletteInput / ModeSwitcher / GroupControls 等）はすべて dark.css に個別エントリがあり、同じスタイルに合わせる
- 作業完了前にブラウザで `prefers-color-scheme: dark` の見た目を確認する（DevTools → Rendering → Emulate CSS media feature）

## モノレポ構成

- `packages/core` — 抽選・グループ分けなどのドメインロジック（React 非依存）
- `packages/web` — React + Vite の Web アプリ
- `packages/cli` — React Ink の CLI

共通の型・関数は core に置き、web/cli から `@tainakanchu/roulette-core` として import する。

## i18n

翻訳キーは 5 言語すべて（ja / en / id / zh-HK / zh-TW）に同じ構造で追加する。
ファイル: `packages/web/src/i18n/locales/<lang>/translation.json`

## 動作確認

UI 変更は以下を済ませてから完了とする。

1. `pnpm -r type-check`
2. `pnpm lint`
3. `pnpm -r test`
4. `pnpm dev` でブラウザ起動し、ライト / ダーク両方で見た目と挙動を確認
