# 缎带星图 · 应用素材

装饰图片由内置 image_gen 根据本项目已选角色稿生成，参考服装的缎带、蓝绿宝石、奶油褶边与金属挂链，不包含人物形体。独立看板娘使用用户选定的 Q 版形象，与界面装饰分开呈现。

- `ribbon-atelier.png`：背景，来自 `design/ip/D-pinkdog-ui-v1/costume-raster-v2/ribbon-atelier.png`。
- `sidebar-frame.png`：精修侧栏，来自 `design/ip/D-pinkdog-ui-v1/costume-raster-v3/ribbon-sidebar-refined.png`。
- `brooch-accent.png`：独立胸针，用于欢迎区与输入区，来自 `design/ip/D-pinkdog-ui-v1/costume-raster-v4/brooch-accent.png`。
- `companion.png`：Q 版看板娘，原样复制自 `design/ip/D-pinkdog-q-v1/standing.png`，保留已选的粉色长发、折耳与服装设计。组件使用 Vite `?inline` 将原图作为 `data:image/png` 内嵌到渲染器中，不单独请求图片路径、不依赖网络或安装目录外的文件；现有 CSP 的 `img-src data:` 即可显示。

选中素材的完整提示词、来源设计路径和 SHA-256 保存在同目录 `provenance.json`；以上 `design/ip` 路径指本地设计过程。CSS 使用本地资源引用，Vite 会把图片打包进应用。侧栏用九宫格切片保持上下角比例，独立胸针保持原比例显示；所有装饰层均不接收鼠标操作。

看板娘位于项目侧栏底部，常规图高 144 px，矮窗口缩为 92 px，正常布局占位，不遮挡对话、输入或文件预览。显隐选择即时保存，与华丽／柔和／简洁装饰模式独立；侧栏折叠或因窗口过窄暂时隐藏时，看板娘随之暂隐，不改变显示偏好。
