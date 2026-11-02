# 绿幕视频的本地导入与验收

此目录中的脚本是独立、按需运行的素材工具，不会替换应用内的宠物资源。
真实豆包视频尚未生成。`tmp/pet-video-pipeline-synthetic-*` 仅为本地合成测试：
原始角色静图加 `SYNTHETIC TEST` 标签，1 秒静止 H.264，不能代表豆包动画效果。

## 导入真实视频

在仓库根目录使用 Node.js，并传入本机已有 FFmpeg 的绝对路径：

```powershell
node design/ip/D-pinkdog-video-v1/import-green-video.mjs `
  --input 'D:\path\original-doubao-idle.mp4' `
  --out-dir 'tmp\pet-video-idle-review-01' `
  --ffmpeg 'C:\path\ffmpeg.exe' `
  --fps 24
```

`ffprobe.exe` 默认在 FFmpeg 同目录，也可显式传入 `--ffprobe`。
输出目录必须尚不存在，防止覆盖旧成果。输入视频需为 30 秒内、偶数尺寸且单边不超过 2160 像素。
原视频仅只读处理，并在结束时复核 SHA-256。派生宠物视频不含音频，原视频音轨保留。

产物包括：

- `transparent.webm`：保留原画幅的 VP9 alpha 审阅母版，使用 `yuva420p` 和 `-auto-alt-ref 0`。
- `source-frames/`、`alpha-frames/`：完整抽帧与抠像帧，供逐帧检查；可能占用较多磁盘。
- `contact-sheet.png`：均匀选取最多九帧，每格上方浅色、下方深色棋盘格；时间索引写入报告。
- `decoded-alpha-first.png`：强制使用 `libvpx-vp9` 解码的第一帧，验证实际编码结果存在 alpha。
- `qa-report.json`：源文件散列、尺寸、各帧边界和透明像素、蓝绿色保护检查、编码后首帧检查。

## 抠像策略与边界

以画幅边缘的绿色和高饱和纯绿空隙为种子，仅向相邻绿色优势区域扩展。
青色/蓝绿色的 160–210 度色相不会被抠除，保护眼睛及宝石。
半透明边缘使用近似色差 alpha 与去绿污染；它不是语义分割，细发丝仍可能残边，绿色服饰或道具需人工审阅。
不设水印遮罩，不清空指定矩形，所有非绿色文字、标签或水印都保留。

联系表来自编码前的 alpha PNG。编码后的透明度、蓝绿色和不透明像素检查只覆盖首帧，不能当作全视频逐帧解码验收。
脚本会报告全体帧的内容边界，但不会自动修补角色走样、裁切、首尾跳变或漂移。

192×192 的宠物播放区需要在拿到真实动作后另做统一构图导出：
所有帧共用一个内容边界并集、相同缩放、留白和固定脚底线；不能每帧自动裁切，否则角色会抖动。
当前输出保留原画幅，供审阅使用，尚不是已验收的运行时替换素材。

## 复现合成测试

```powershell
node design/ip/D-pinkdog-video-v1/validate-video-pipeline.mjs `
  --ffmpeg 'C:\path\ffmpeg.exe' `
  --out-dir 'tmp\pet-video-pipeline-synthetic-new'
```

该测试检查真实 alpha、原视频未改变、蓝绿色未误抠、非绿测试标签仍存在，并保存明暗背景联系表。
实际执行记录见 `tmp/pet-video-pipeline-synthetic-20261102-final/synthetic-validation.json`；
该轮有 24 帧，首帧真实解码透明像素约 84.71%，211 个蓝绿色像素无 alpha 损失，
编码前蓝绿色改动为 0，编码后首帧原不透明像素没有变成透明。
