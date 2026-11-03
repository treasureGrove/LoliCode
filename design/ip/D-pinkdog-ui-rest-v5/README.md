# 粉发犬耳桌宠 · v5 UI 坐卧

本轮增加真实工作台边缘上的坐靠与趴卧，沿用项目已选的粉发青蓝眼小狗女孩、棕白软垂犬耳、棕白尾巴及原服饰。姿势图由内置 `image_gen` 生成，休息循环通过即梦网页的 Seedance 2.0 VIP 生成，使用同一张姿势图作为首帧和尾帧。画面不绘制椅子、台面或假边框，角色支撑点由应用与真实 UI 上沿对齐。

## 制作文件

- `image-prompts.json`：内置 `image_gen` 的完整提示词、角色参考及原始输出路径。`sit` 是坐靠源稿；`lie-initial` 保留早期构图，标为 `superseded-framing`；`lie` 是补齐两侧发梢并留出透明余量的趴卧源稿。
- `sit-source.png`、`lie-source.png`：实际使用的透明坐靠、趴卧源图；`lie-source-initial.png` 保留早期趴卧构图。
- `first-frame-sit-green-square.png`：实际上传的 720 × 720 坐靠绿幕首尾图；`first-frame-lie-green-3x2.png` 保留首版 960 × 640 趴卧首尾图；`first-frame-lie-green-4x3.png` 是最终趴卧 v2 实际上传的 960 × 720 首尾图。
- `prepare-first-frames.mjs`、`first-frame-report.json`：从透明源图进行预乘 alpha 缩放及纯绿合成的准备脚本，记录源图、首尾图、画布尺寸、缩放和偏移。脚本复现结果与实际上传的 PNG 逐字节一致。
- `prompts/sit-rest-seedance20-5s.txt`：5 秒、1:1 坐靠循环，固定臀部与撑手接触线，保留轻呼吸、眨眼、悬垂小靴子和尾尖的小幅动作。
- `prompts/lie-rest-seedance20-5s.txt`：首版趴卧视频提示词，保留为生成历史。
- `prompts/lie-rest-seedance20-5s-v2.txt`：5 秒、真正 4:3 首尾帧的趴卧循环，固定前臂与身体支撑线，要求完整保留两侧发梢、耳朵、尾巴和小靴子。
- `source-videos/`：网页实际下载的原始视频，保留原文件，不用导出后的 WebM 替代母版。
- `process-rest-video.mjs`：抽帧、去绿幕、轮廓净化、预乘 alpha 缩放、VP9 alpha 导出和静态海报导出；处理目录保存逐帧指标与首、中、末帧解码结果。

透明源图和规范首尾图均保存在本目录。坐靠将透明源画布缩放到 664 × 664，置于 720 × 720 纯绿画布的 `(28, 28)`；趴卧将透明源画布缩放到 960 × 640，置于 960 × 720 纯绿画布的 `(0, 40)`，增加上下余量。原始生成输出路径以 `image-prompts.json` 为准，准备过程与输入、输出记录见 `first-frame-report.json`。

## 原片与构图状态

坐靠已下载 `source-videos/sit-rest-seedance20-square-v1.mp4`，实际视频为 960 × 960、约 5 秒。已处理的运行素材为 `companion-sit-video-v5.webm` 与 `companion-sit-poster-v5.webp`，640 × 640、24 fps，位于 `processed/sit-v1/` 及 `../../../src/assets/atelier/`。`processed/sit-v1/processing-report.json` 保存原片信息、输入与导出 SHA-256、去绿幕指标、保护区域统计和实际解码检查数据。

首版趴卧原片 `source-videos/lie-rest-seedance20-4x3-v1.mp4` 标记为 **`rejected-framing`**：输入首尾图为 3:2，即梦自动转换为 4:3 后裁掉少许两侧头发。这条视频只保留作构图问题记录，没有用于最终运行素材。

最终采用 `source-videos/lie-rest-seedance20-4x3-v2.mp4`，文件为 6,430,513 字节，实际视频尺寸 1112 × 834、约 5 秒。该版本使用 `first-frame-lie-green-4x3.png` 作为真正 4:3 首尾帧，保留完整人物和上下纯绿余量；首、中、末帧已检查完整轮廓，保留发梢、犬耳、尾巴和小靴子。

导出时先转为 RGBA，再使用 `format=rgba,crop=1110:740:1:47` 裁掉上下各 47 px 和左右各 1 px 的纯绿余量，得到 1110 × 740 的 3:2 画布，完整保留人物。最终运行素材 `companion-lie-video-v5.webm` 与 `companion-lie-poster-v5.webp` 为 768 × 512、24 fps 视频及同画布静态海报，已导出至 `processed/lie-v1/` 和 `../../../src/assets/atelier/`。`processed/lie-v1/processing-report.json` 的 `source` 明确为趴卧原片 v2；目录后缀 `-v1` 是透明处理流水线版本，不代表采用了构图被拒绝的原片 v1。最终接触点和 SHA-256 以该处理报告、`../../../src/assets/atelier/provenance.json` 及运行代码为准。

本轮 v5 未使用即梦官方高清修复。生成界面的档位、原文件实际尺寸和运行缩放尺寸分别记录，不把本地缩放称为官方高清或 AI 修复，也不沿用 v4 三段主动作的 2K 母版说明。

## 透明视频处理

可先将规范首尾图复现到一个尚不存在的输出目录。脚本输出的 `sit-green.png` 对应归档的 `first-frame-sit-green-square.png`，`lie-green.png` 对应 `first-frame-lie-green-4x3.png`：

```powershell
node design/ip/D-pinkdog-ui-rest-v5/prepare-first-frames.mjs 'C:/path/to/ffmpeg.exe' 'tmp/ui-rest-first-frames-new'
```

保留原始 MP4 后，使用 `process-rest-video.mjs` 按 24 fps 抽帧。去绿幕复用 v4 已有的背景连通性抠像和轮廓附近两像素精修，保护角色内部青蓝眼睛、宝石及粉色主体；不通过整片区域擦除去掉服饰或头发。缩放按预乘 alpha 进行，再导出无音轨 VP9 alpha WebM，并从同一画布首帧导出无损 WebP 海报。

脚本会检查受保护的内部像素是否改变，保留深浅底轮廓对照图，并用支持 alpha 的解码器读取导出视频的首、中、末帧。原片、逐帧指标和输出文件各自保留 SHA-256；已有 `processed/<kind>-v1/` 时脚本会拒绝覆盖。重跑前须先显式版本化脚本的输出目录，并保留前次结果。

本次采用的导出参数如下。默认处理目录已经存在，复现前须按上面的规则使用新输出版本；趴卧裁切值只适用于本次 v2 原片：

```powershell
node design/ip/D-pinkdog-ui-rest-v5/process-rest-video.mjs sit 'C:/path/to/ffmpeg.exe' 'design/ip/D-pinkdog-ui-rest-v5/source-videos/sit-rest-seedance20-square-v1.mp4'
node design/ip/D-pinkdog-ui-rest-v5/process-rest-video.mjs lie 'C:/path/to/ffmpeg.exe' 'design/ip/D-pinkdog-ui-rest-v5/source-videos/lie-rest-seedance20-4x3-v2.mp4' 'format=rgba,crop=1110:740:1:47'
```

## 工作台操作

1. 打开有消息的会话或空会话欢迎页，拖动角色靠近一条水平上沿。脚底距离有效上沿不超过 52 px 时，边缘显示轻高亮，并提示坐下或趴下；松手后进入对应休息循环。
2. 可见且足够宽的普通消息气泡、欢迎任务卡使用坐靠，输入框外壳使用趴卧。代码消息、执行过程、系统消息、过窄或头顶空间不足的区域不提供停靠。
3. 滚动聊天、调整窗口、折叠项目侧栏或拖动项目／预览分栏时，停靠点跟随同一个元素的相对位置。元素隐藏、被面板遮住、移除或切换到其他会话后解除停靠，恢复安全站姿。
4. 再次拖走、摸头、投喂或使用方向键移动会先起身。接触线上方的身体可拖动，边缘下方的双腿、发梢和透明区域让鼠标操作穿透，仍可输入、点击与选中文字。
5. 系统开启减少动态效果时显示对应坐卧静态海报，保持 UI 接触位置。自定义角色资源包沿用自己的图片与原有交互，不启用本项目内置角色的坐卧素材。

停靠只在当前页面保存元素引用、会话隔离 ID 和接触位置，不把 DOM 锚点写入本地养成存储。重新打开应用时沿用安全站姿位置；既有饱食、心情、好感、鱼干冷却与显隐设置仍按原流程保存。

`AgentPage`、`AgentMessageFrame` 和 `AgentTranscript` 在实际可用外壳上标记停靠表面，`companionDocking.ts` 按实时几何、可见性和遮挡检查上沿，`useCompanionDocking.ts` 跟随滚动与布局变化。`AgentCompanion` 负责拖放、姿势切换和操作命中区，`CompanionVideoActor` 继续负责本地视频播放、解码前海报和减少动态效果。
