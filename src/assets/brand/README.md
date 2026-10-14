# LoliCode 女仆主题资源

`lolicode.svg` 是本项目原创的女仆头像矢量标记，配色与吉祥物一致，供导航、聊天头像、favicon 和桌面安装图标使用。应用图标由 `pnpm tauri icon src/assets/brand/lolicode.svg --output src-tauri/icons` 生成。

`lolicode-maid.png` 是通过内置 imagegen 工具生成的透明二次元女仆吉祥物（1024 × 1536，RGBA），放在欢迎页。完整生成提示词保存在 `mascot-prompt.txt`。原始生成文件保留在 Codex 的 generated_images 目录，项目使用本目录内的副本，不依赖外部路径或网络。

`LolicodeMascot` 组件的 `portrait` 使用清晰的小尺寸 SVG 头像，`full` 使用完整 PNG；两者默认作为装饰图片，不占用屏幕阅读器的额外导航。`companion.svg` 是之前的装饰素材，保留但当前工作台没有使用。

界面采用奶油白、莓粉和淡薰衣草色，深色采用茄紫底色与柔粉强调。主题在 `src/styles/lolicode.css` 和工作台的 `lolicode-workbench.css`，品牌名称在 `src/lib/branding.ts`。工具和上游 Logo 继续复用原项目图标资源。

存储目录、托管供应商标识和应用 identifier 沿用已有值，让旧版配置能继续读取。
