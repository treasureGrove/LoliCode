# LoliCode

[English](README.md) · [简体中文](README_ZH.md) · [Deutsch](README_DE.md)

**使いやすく、拡張性の高い二次元美少女マルチ機能 Agent。**

仕事、創作、会話を一つの主 Agent で扱い、長期的にはキャラクター表現、永続メモリ、デスクトップ Pet、音声とインタラクションを統合する構想です。これらすべてが実装済みという意味ではありません。

現在の実装は Tauri 2、React、TypeScript、Rust を使用しています。4.0.15 以降の標準エージェントはアプリ内の Rust コアで動作し、OpenCode や ZCode のアプリ全体を別途起動する必要はありません。

## 現在の機能と開発方針

共有モデルチャネル、アカウント認証、プロバイダー設定、コーディングワークスペース、ツール実行、会話の保存、外部 AI ツールの設定管理を備えています。実行可能な詳細機能はランタイムの状態をご確認ください。

今後は Electron、既存の React UI、自社管理の TypeScript Host とエージェントコア、既存の Rust サービスを組み合わせ、Windows・macOS・Linux 向けに開発します。

主 Agent のチャット入口は常に一つです。内蔵業務アプリを必要に応じて追加し、その専用画面やツールを共通の Agent から利用する構成を目指します。まず質問、選択、思考状態、実行と復旧を改善し、その後 UE と Tavern を接続して第1回の受入検証を行います。全体の UI デザイン統一は後続工程です。Pet、音声、長期メモリなどの構想と、現在の実装は区別しています。

## 開発と資料

~~~sh
pnpm install --frozen-lockfile
pnpm dev
~~~

Node.js と pnpm、Rust の要件、検証手順は [English README](README.md) を参照してください。

- [ダウンロード](https://tools.treasuregrove.art/lolicode/)
- [製品ビジョン](docs/guides/lolicode-product-vision.md)
- [アーキテクチャと移行計画](docs/guides/lolicode-platform-architecture.md)
- [機能・ソース・ライセンス記録](docs/guides/lolicode-platform-capabilities.json)
- [4.0.15 の検証記録](docs/guides/lolicode-4.0.15-delivery.md)

現在の配布検証は Windows パッケージを対象としています。CC Switch の配布物は LoliCode の配布物ではありません。

## 出典とライセンス

本リポジトリは独立して保守されています。設定機能の基盤は CC Switch に由来し、元の [MIT ライセンス](LICENSE) と著作権表示を保持しています。固定した上流リビジョンは [FORK_BASELINE.md](FORK_BASELINE.md) に記録されています。

参考プロジェクトとして名前を挙げることは、そのソースやアプリ全体の組み込みを意味しません。コードを再利用する場合は、各ファイルと依存関係のライセンス条件を確認して記録します。
