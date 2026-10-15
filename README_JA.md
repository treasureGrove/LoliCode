# LoliCode

[English](README.md) · [简体中文](README_ZH.md) · [Deutsch](README_DE.md)

LoliCode は、モデル接続の設定、ローカルプロジェクトの作業、ツール実行、生成結果の確認をまとめたデスクトップエージェントワークスペースです。

現在の実装は Tauri 2、React、TypeScript、Rust を使用しています。4.0.15 以降の標準エージェントはアプリ内の Rust コアで動作し、OpenCode や ZCode のアプリ全体を別途起動する必要はありません。

## 現在の機能と開発方針

共有モデルチャネル、アカウント認証、プロバイダー設定、コーディングワークスペース、ツール実行、会話の保存、外部 AI ツールの設定管理を備えています。実行可能な詳細機能はランタイムの状態をご確認ください。

今後は Electron、既存の React UI、自社管理の TypeScript Host とエージェントコア、既存の Rust サービスを組み合わせ、Windows・macOS・Linux 向けに開発します。

アプリセンターから必要なアプリを追加し、推奨設定で使い始め、必要に応じて詳細設定を開く構成を目指しています。Tavern、UE、Electron 移行および新しいアプリセンターのフローは、まだ提供済みの機能ではありません。

## 開発と資料

~~~sh
pnpm install --frozen-lockfile
pnpm dev
~~~

Node.js と pnpm、Rust の要件、検証手順は [English README](README.md) を参照してください。

- [ダウンロード](https://tools.treasuregrove.art/lolicode/)
- [アーキテクチャと移行計画](docs/guides/lolicode-platform-architecture.md)
- [機能・ソース・ライセンス記録](docs/guides/lolicode-platform-capabilities.json)
- [4.0.15 の検証記録](docs/guides/lolicode-4.0.15-delivery.md)

現在の配布検証は Windows パッケージを対象としています。CC Switch の配布物は LoliCode の配布物ではありません。

## 出典とライセンス

本リポジトリは独立して保守されています。設定機能の基盤は CC Switch に由来し、元の [MIT ライセンス](LICENSE) と著作権表示を保持しています。固定した上流リビジョンは [FORK_BASELINE.md](FORK_BASELINE.md) に記録されています。

参考プロジェクトとして名前を挙げることは、そのソースやアプリ全体の組み込みを意味しません。コードを再利用する場合は、各ファイルと依存関係のライセンス条件を確認して記録します。
