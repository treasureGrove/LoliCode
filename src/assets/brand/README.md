# LoliCode 女仆主题资源

`lolicode-icon.png` 是通过内置 imagegen 工具绘制的粉发狗耳二次元头像，用于导航、聊天头像、用量页、favicon 和桌面安装图标。应用图标由 `pnpm tauri icon src/assets/brand/lolicode-icon.png --output src-tauri/icons` 生成。

旧 `lolicode.svg`、`lolicode-maid.png` 及已无调用的 `LolicodeMascot` 组件已移除。历史女仆吉祥物的完整生成提示词保存在 `mascot-prompt.txt`，原图可从 Git 历史查阅。

`companion.svg` 是之前的装饰素材，保留但当前工作台没有使用。

界面采用奶油白、莓粉和淡薰衣草色，深色采用茄紫底色与柔粉强调。主题在 `src/styles/lolicode.css` 和工作台的 `lolicode-workbench.css`，品牌名称在 `src/lib/branding.ts`。工具和上游 Logo 继续复用原项目图标资源。

存储目录、托管供应商标识和应用 identifier 沿用已有值，让旧版配置能继续读取。
