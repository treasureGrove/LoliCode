# LoliCode 临时界面资源

`lolicode.svg` 是当前黑白 LC 应用标记；`companion.svg` 是之前的装饰素材，当前工作台没有使用。两者为本项目原创的临时矢量素材，可分别替换。应用安装图标由 `pnpm exec tauri icon src/assets/brand/lolicode.svg` 生成。

界面主题在 `src/styles/lolicode.css`，品牌名称在 `src/lib/branding.ts`。工具和上游 Logo 继续复用原项目图标资源；此轮不重新替换工具 Logo。

存储目录、托管供应商标识和应用 identifier 沿用已有值，让旧版配置能继续读取。
