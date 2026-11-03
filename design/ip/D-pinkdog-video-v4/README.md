# 粉发犬耳桌宠 · v4 视频素材

本轮通过即梦网页实际生成动作，使用同一张全身中立站姿作为首尾帧。角色保持粉色卷发、青蓝眼睛、原有女仆服与棕白软垂犬耳、棕白尾巴。动作按这只小狗的性格重写，没有使用其他桌宠的图片或视频。

画幅改为 1:1，人物高度约占九成，保留耳朵、发梢、尾巴和手部的少量动作余量。运行素材为 640×640、24fps、无音轨的 VP9 alpha WebM，海报与视频共用画布及脚底位置。

五条选用动作：

- `idle`：轻呼吸、眼神变化和眨眼，循环待机。
- `greeting`：注意到主人、开心招手、轻歪头、收回站姿。
- `feed`：取一条细小鱼干、送到嘴边吃完、满足后恢复空手。
- `snack`：拿小圆饼干、啃出缺口、逐渐吃完、眯眼笑。提示词中的舔嘴未明确生成，不把它作为已实现动作。
- `curious`：左右张望、轻歪头、期待地看人。嗅闻感较轻，以实际可见表演为准。

待机采用 Seedance 2.0 mini；其余选用 Seedance 2.0 VIP。待机、招手、喂鱼还使用即梦“智能超清”制作了官方 2K 档母版，文件实际为 1792×1792；饼干与好奇动作采用细节已足够的原生 960×960。没有把常规缩放称为 AI 修复。

## 文件与来源

- 标准站姿源：`../D-pinkdog-video-v3/standard-pose-source.png`，由内置 `image_gen` 依据已选角色生成；精确提示词与原始输出路径在 `../D-pinkdog-video-v3/image-prompts.json`。
- 网页首尾帧：`first-frame-green-square.png`；`prepare-first-frame.mjs` 将原透明站姿等比合成到纯绿背景，内容高度648px、脚底线692px。
- 视频提示词：`prompts/`。选用稿由最终 `runtime-report.json` 对应到每条视频。
- 原始视频：`source-videos/`，保留下载原文件与音轨。旧 mini 招手的尖耳和旧喂鱼的大鱼形点心没有用于最终运行素材。
- `source-videos/feed-2k-loading-preview-not-output.mp4` 是网页生成中的加载占位视频，已明确排除，不能作为角色成片或高清修复结果。
- 原始抠像：`processed/`；强绿背景残雾修正：`rekeyed/`；最终局部边缘精修：`refined/`。
- 最终导出与真实解码检查：`runtime-build-final/runtime-report.json`；实际应用素材位于 `../../../src/assets/atelier/companion-*-video-v4.webm` 与 `companion-video-poster-v4.webp`。

## 透明边缘处理

先从真实视频抽帧，用 HSV 和背景连通性抠除绿幕；保护内部青蓝眼睛、宝石及粉色主体。原抠像会把部分绿幕压缩色差保留成低 alpha 的灰青雾，`rekey-frames.mjs` 对确认与背景连通的强绿像素清零，原导入器该选项默认关闭，旧结果逐像素兼容。

随后 `refine-matte.mjs` 只修透明轮廓附近两像素内的绿色污染，轻微调整局部 alpha，不整图模糊或全局腐蚀。完整统计、输入未变校验及首中末深浅底对照保存在每条 `refined/` 目录。最后按预乘 alpha 做 Lanczos 缩放，避免透明边缘在缩小时混入黑色，并以支持 alpha 的解码器检查导出文件的首、中、末帧。

复现导出，输出目录必须尚不存在：

```powershell
node design/ip/D-pinkdog-video-v4/encode-runtime.mjs 'C:/path/to/ffmpeg.exe' 'tmp/pet-runtime-new'
```

## 应用播放

`AgentCompanion` 保留拖动、鱼干拖放、冷却、养成数据和自定义资源包。内置角色由 `CompanionVideoActor` 播放本地视频，5.2秒父级反应时间覆盖完整动作；结束后回待机，拖动和用户操作优先。空闲35–60秒检查一次小动作，至少20秒未与宠物交互才播放，饼干和好奇动作交替出现。隐藏页面暂停，减少动画时显示同一海报，静态休息与播放失败也使用该海报。

媒体走本地同源资源，海报内联，没有修改 CSP，离线播放无需连接生成服务。旧网格、眼贴和图集保留为历史，没有套在新站姿上。

靠UI休息、趴在对话框上的动作属于下一阶段，当前没有实现。届时需要独立的坐靠/趴卧姿势与进入、保持、离开片段，并标定脚、臀部或前臂的接触点，再与界面元素的可见边缘对齐。

制作工序参考 [DSH 作者](https://github.com/PC2005-cloud/dsh-pet/blob/main/MAKE-YOUR-OWN-PET.md) 与[肆喵作者](https://github.com/sijin14514-sys/simiao-dsh-pet/blob/main/docs/01-%E6%95%B4%E4%BD%93%E6%B5%81%E7%A8%8B.md)。动作分段和安静为主的节奏参考 [VPet](https://github.com/LorisYounger/VPet/blob/main/VPet-Simulator.Core/Graph/GraphInfo.cs) 与 [WildxHV 的桌宠行为](https://github.com/WildxHV/desktop-pet#how-it-behaves)，未复制其角色素材。
