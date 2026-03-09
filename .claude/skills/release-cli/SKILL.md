---
name: release-cli
description: >
  CLIパッケージのリリース作業を一括実行する。ビルド、コミット、npm publish、GitHub Release作成を行う。
  「リリースして」「publish して」「パッチリリース」「minor リリース」等で発動。
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
---

# Release CLI

CLIパッケージ（`@tainakanchu/roulette-cli`）のリリースワークフロー。

## Arguments

第1引数でバージョンバンプの種類を明示的に指定可能:
- `patch`
- `minor`
- `major`

## Workflow

### 1. Pre-checks

- `git status` で未コミットの変更を確認
- 未コミットの変更がある場合、コミットするか確認

### 2. バージョンバンプの決定

引数で明示的に指定されている場合はそれを使う。
指定がない場合は、前回リリースからの変更内容を `git log` で分析し、以下の基準で提案する:

- **patch**: バグ修正、リファクタリング、ドキュメント更新など
- **minor**: 新機能追加、既存機能の拡張など
- **major**: 破壊的変更（APIの変更、既存の動作が変わるもの）

**提案後、必ずユーザーに確認してから publish を実行すること。**

### 3. Build & Verify

```bash
pnpm -r type-check
pnpm --filter @tainakanchu/roulette-cli build
```

### 4. Publish

```bash
npx lerna publish <patch|minor|major> --yes
```

- lerna がバージョンバンプ、git tag、npm publish を実行する
- publishConfig の `access: public` が設定済み

### 5. GitHub Release

publish 成功後、`gh release create` で GitHub Release を作成する:

- タグ: lerna が作成したタグ（`@tainakanchu/roulette-cli@<version>`）
- タイトル: `@tainakanchu/roulette-cli v<version>`
- 本文: 前回リリースからの変更内容を要約
  - patch: "Bug Fix" セクション
  - minor: "What's New" セクション
  - major: "Breaking Changes" + "What's New" セクション
- Install セクションを末尾に付与

### 6. 完了報告

リリースしたバージョンと GitHub Release URL を報告する。
