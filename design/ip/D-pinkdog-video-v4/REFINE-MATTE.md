# 保守边缘去绿

`refine-matte.mjs` 对已经完成抠像的 PNG alpha 序列做派生处理，不替换原始视频或原抠像帧。

```powershell
node design/ip/D-pinkdog-video-v4/refine-matte.mjs `
  --input-alpha-dir '真实导入目录/alpha-frames' `
  --source-dir '真实导入目录/source-frames' `
  --out-dir '尚不存在的新目录' `
  --shrink 0.35
```

- `--source-dir` 可选；提供时用原始绿幕 RGB 确认绿色污染。帧名和尺寸须与 alpha 帧一致。
- `--shrink` 是基于一像素局部 alpha 梯度的收缩系数，允许 0 到 0.5，默认 0.35；不是对整幅图腐蚀。
- `--frames 000001.png,000061.png,000120.png` 可选，用于先试选定帧；不传则处理全部六位数字命名的 PNG。

处理只覆盖紧邻既有透明区（alpha≤4）的两像素边界带。不透明内部、红蓝通道、画幅尺寸和所有水印保持不变；可信前景参照为青蓝色时跳过。只对确认有绿色污染的像素压低 G 通道，并按指定上限轻缩局部 alpha。不会生成新细节、整图模糊、动态裁切或重绘角色。

输出：

- `alpha-frames/`：保留原帧名、尺寸和透明通道的派生 PNG。
- `refine-report.json`：输入/输出 SHA-256、边界改动数量、保护区变化数与输入未变校验。
- `edge-qa-before-after.png`：抽取首、中、末帧；左侧原抠像，右侧精修，上方浅底、下方深底。居中裁剪仅用于 QA，不影响输出帧。

输出目录必须不存在，文件以 `wx` 写入。两像素之外的宽色雾或原始视频里的压缩损坏不会被强行删除，仍需目视验收；“像素未改”的内部检查不能替代对发丝、眼睛和宝石的视觉确认。

首轮试样：`matte-trial/greeting-fringes-v1/`，使用真实横屏片的第 1、61、120 帧。输入全部未变、内部及内部青蓝色变化数均为 0。绿边有减弱，较宽青色压缩边仍有残留，未将该保守试样直接替换为运行时素材。

## 清理原始抠像中的宽残雾

真实 1792×1792 待机片的中间帧存在宽青灰雾：绿幕压缩偏色使某些像素刚超过旧近背景阈值，旧的全局亮度 alpha 估计留下半透明残影。继续收缩发丝无法稳妥解决这一问题。

`rekey-frames.mjs` 从保存的原始 RGB 帧重新抠像，再把结果交给上面的局部去绿。它调用 `keyFrame(source, { clearStrongConnectedGreen: true })`；原导入器的默认值仍为 `false`，旧结果不改。

```powershell
node design/ip/D-pinkdog-video-v4/rekey-frames.mjs `
  --source-dir '原始导入目录/source-frames' `
  --previous-alpha-dir '原始导入目录/alpha-frames' `
  --out-dir '尚不存在的重新抠像目录'

node design/ip/D-pinkdog-video-v4/refine-matte.mjs `
  --input-alpha-dir '重新抠像目录/alpha-frames' `
  --source-dir '原始导入目录/source-frames' `
  --out-dir '尚不存在的最终精修目录'
```

明确的强绿判据为：位于已识别的连通绿色区域、色相 80–145°、饱和度≥0.45、G≥65 且 G>max(R,B)×1.7。仅这些像素直接设为透明；不做全局侵蚀、模糊或水印处理。连通区域沿用导入器的边界泛洪及发丝孔隙内高饱和绿色种子。

重新抠像会输出透明 PNG 序列、`rekey-report.json`、全身及局部深浅底前后对照。报告核对源与旧 matte 未变，以及全部青蓝色、粉色不透明核心和其他不透明前景的像素变化数。若角色实际穿强绿色衣物，必须另做保护遮罩，不能直接沿用该判据。

三关键帧初验目录：`matte-trial/idle-square-2k-rekey-v1/`。与旧 matte 相比，共清理 223219 个残留 alpha 的强绿像素；青蓝 alpha/RGB、粉色核心和其他不透明前景变化均为 0。首尾与中间帧左发丝局部对照显示宽青雾已明显清除。精细半透明发丝仍应在最终尺寸上检查，像素保护统计不能替代视觉验收。

待机全片（121 帧、1792×1792）已完成：

- `rekeyed/idle-square-2k-v1/`：清理 16852641 个旧残留 alpha 的强绿像素；全部青蓝 alpha/RGB、粉色核心及其他不透明前景变化数均为 0。
- `refined/idle-square-2k-clean-v2/alpha-frames/`：以上结果再做保守边界精修，边界改动 1328778 像素，内部及内部青蓝色变化数均为 0。源与前一级 matte 均哈希未变。
- 最终精修目录中的全身/局部深浅底对照已目视检查，宽青雾清除、粉发环保留。极细轮廓绿线需在最终 640×640 Lanczos 下采样结果上再判断，不继续全局侵蚀发丝。

QA 缩略图采用最近邻采样，复杂细线可能出现点状缩略伪影；这不表示原始透明 PNG 被模糊或损坏。最终播放素材应使用高质量重采样并复核真实 alpha 解码。
