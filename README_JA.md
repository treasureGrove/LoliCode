# LoliCode

[English](README.md) · [简体中文](README_ZH.md) · [Deutsch](README_DE.md)

**使いやすく、拡張しやすい、アニメ美少女 Agent。**

LoliCode はデスクトップのコーディング Agent、共通のモデル設定、アニメ調のワークスペースを一つにまとめます。モデルを選び、フォルダーを開けば作業を始められます。高度な設定は必要になったときに利用できます。

[ダウンロード](https://lolicode.com/) · [コミュニティ・アカウント](https://lolicode.com/all) · [ソース](https://github.com/treasureGrove/LoliCode) · [ドキュメント](docs/README.md) · [更新履歴](CHANGELOG.md)

## 現在使える機能

- **一つのメイン Agent**：ストリーミング会話、プロジェクト内のファイル操作、ターミナル、権限確認、質問・選択肢、停止、会話履歴、変更内容の確認。
- **モデルと接続先の共通管理**：API 接続先や対応するアカウント認証、モデル一覧、利用可能なモデル設定を管理。コンテキスト長や推論強度は上流サービスの情報と対応状況に依存します。
- **設定の集約**：対応する外部 AI ツールのプロバイダー、プロンプト、Skills、MCP 設定を管理。設定管理と内蔵 Agent での実行対応は区別して表示します。
- **キャラクターのいるデスクトップ**：アニメ調テーマ、ピンク髪のちびマスコット、コンパクトなツール進捗、ファイルのサイドプレビュー。
- **使用量と更新**：記録された使用量と LoliCode 独自の更新を確認。コミュニティアカウントとモデル提供元のアカウントは別です。

現在は **Tauri 2・React・TypeScript・Rust** を使用しています。標準 Agent はアプリ内の Rust コアで動作し、OpenCode や ZCode の別途インストールは不要です。[現在の Agent の対応範囲](docs/guides/lolicode-inprocess-agent.md)も参照してください。

Windows、macOS、Linux を対象としています。現在の公開パッケージは **Windows x64 の NSIS インストール版とポータブル ZIP** です。macOS と Linux のパッケージはまだ公開していません。検証範囲は各リリースを確認してください。

## インストールと使い始め方

1. [LoliCode ダウンロードページ](https://lolicode.com/)から環境に合うパッケージを取得します。
2. 接続先・モデル管理で接続先を追加し、モデルを選びます。
3. ワークベンチでプロジェクトフォルダーを開き、依頼を入力して権限や変更内容を確認します。

左下のアバターメニューまたは更新ボタンからソフトウェア更新を確認できます。インストール版は [LoliCode の署名付き更新マニフェスト](https://tools.treasuregrove.art/lolicode/updates/latest.json)を使用します。ポータブル版はダウンロードページとリリース手順に従って更新してください。

既存データとの互換性のため、保存先には `~/.tai-switch` の名称が残っています。[インストールガイド](docs/user-manual/ja/1-getting-started/1.2-installation.md)を参照してください。

## 今後の方向性

共通のメイン Agent を中心に、**UE ツール**と**Tavern 形式のキャラクター対話**を独立した業務アプリとして追加する予定です。永続メモリー、音声、マスコットとの豊かな対話、フロントエンド・3D 向け軽量モデル **sillyLoli** も今後の構想です。

これらは開発計画であり、現在すべて利用できるわけではありません。参照元のアプリ全体を取り込むのではなく、必要な機能やコンポーネントを接続します。[製品構想](docs/guides/lolicode-product-vision.md)、[最初のマイルストーン](docs/guides/lolicode-phase-one-plan.md)、[機能と出典](docs/guides/lolicode-platform-capabilities.json)を参照してください。

## ローカル開発

Node.js 22.12+（または Vite が対応するバージョン）、pnpm 10.12.3、`rust-toolchain.toml` の Rust、[Tauri の前提条件](https://v2.tauri.app/start/prerequisites/)を用意します。

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm dev
```

フロントエンドは Vite で更新されます。Rust の変更時は開発プロセスを再ビルド・再起動するため、インストーラーの作成は不要です。Agent crate も監視する場合：

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

検証手順は[貢献ガイド](CONTRIBUTING.md)、パッケージ作成と署名は[リリースガイド](docs/guides/lolicode-release.md)を参照してください。

## サポート・出典・ライセンス

[LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues)、[サポート](SUPPORT.md)、[セキュリティ方針](SECURITY.md)、[行動規範](CODE_OF_CONDUCT.md)を利用してください。

LoliCode は独立して保守しています。設定基盤は CC Switch に由来し、元の [MIT ライセンス](LICENSE)、著作権表示、[ベースライン記録](FORK_BASELINE.md)を保持しています。他の再利用コンポーネントは[第三者通知](THIRD_PARTY_NOTICES.md)に記載しています。参照プロジェクトの全機能やプラグイン互換性を約束するものではありません。
