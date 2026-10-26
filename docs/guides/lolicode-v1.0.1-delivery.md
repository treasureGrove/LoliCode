# LoliCode v1.0.1 交付记录

2026-10-20 已正式发布。产品版 **v1.0.1** 对应原生更新版本 **4.1.1**。官网两个正式更新清单、GitHub Latest 和安装版、便携 ZIP 已同步。

- [Windows x64 安装版](https://lolicode.com/downloads/releases/1.0.1/LoliCode-1.0.1-Windows-x64-Setup.exe)
- [便携 ZIP](https://lolicode.com/downloads/releases/1.0.1/LoliCode-Portable.zip)
- [GitHub 发行记录](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.0.1)

## 补丁范围与源码来源

沿用原 App 粉发犬耳人物画，将人物背后的紫色背景统一为酒红色，圆角外的白底改为透明。应用内头像、Windows 多尺寸图标及 macOS ICNS 从同一主图导出。1,170,779 个受保护的人物内部像素 RGBA 与原图完全一致；眼睛、脸部和白衣局部另行逐像素比对通过。

本轮从 v1.0.0 已发布冻结提交 `7612ad2007ce8a778bbda23d38fcec91ebe744fb` 出发，使用独立 Git index 只套用 **18 个图标、5 个版本文件及 `src/whats-new/4.1.1.json`**，没有加入当前工作区其他功能改动。

新冻结提交为 `2e13832ddca2b209c69b3ad0f806b5d49dac71f3`；源码归档 176,629,760 bytes，SHA-256 `d18139eb4584ea12c6f4484cd3e41a187c8cf630aa05d8044f51e401576f971c`。构建目录为 `release/build-v1.0.1-20261020/work/`。原当前分支与用户 index 保持不变；发布后仅将当前工作区版本字段定向同步为 1.0.1 / 4.1.1，并保留其余字段和用户改动。

## 真实产物与本机验证

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 安装器 | 26,073,614 | `0488b653c2823e0236c445fbce5f08e30f086147e146daefa0a9c260129838f8` |
| 安装器签名 | 420 | `56ad02ef041184f5fc44fa80b5510fd5e955008067d51cefdeaadcf16725189f` |
| 便携 ZIP | 30,914,517 | `5a14e50152a2497926c803bd9078844029139c27eb8560d458d56518b08b6fb5` |

沿用既有 updater 公钥，指纹 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`，真实安装器 Tauri 更新签名通过验证。未配置 Windows Authenticode 证书。

冻结源码类型检查、19 项版本与 updater 前端测试、31 项发布工具和打包测试通过，生产 renderer 与 Rust v4.1.1 构建成功。直接读取编译后 EXE 的 16 / 24 / 32 / 48 / 64 / 256 px Windows 图标资源，六个资源均与冻结 ICO 的对应 PNG 帧字节一致，四角 alpha 均为 0；renderer 中的人物 PNG 与冻结主图字节一致。

实际生成的 NSIS payload 包含 115 个文件、5 份许可证，两次提取哈希一致，提取后的真实程序通过离线自检。便携 ZIP 解压后的 120 个文件与暂存逐一匹配，实际便携程序离线自检通过；不附带模型权重、独立 Node 或 llama-server。

实际执行安装器，在隔离目录完成 **4.1.0 → 4.1.1 → 4.1.1** 升级与重复安装，三次退出码均为 0。安装后的完整主程序哈希符合唯一已知的 UNK→NSS 三字节类型标记变化，114 个资源与便携暂存逐文件一致，安装后的主程序通过离线自检。涉及的 6 组安装注册项视图已恢复并复核原值与类型，虚构数据保持不变。没有读取真实用户配置或创建 WebView，本次没有把隔离验证表述为真实账户迁移或界面测试。

## 公开发布与升级验收

GitHub 发行 ID 为 `418251917`，四份公开附件（安装器、签名、ZIP 和脱敏 `release-build.json`）的大小及 digest 与本地一致。本机上传端点返回 404 后，核对草稿无附件，采用既有 SSH 中转上传；token 只通过 stdin 进入进程内存，没有写入参数、日志或磁盘。

官网追加三个 v1.0.1 exact 路由，固定 302 到同版本 GitHub 文件。追加前的首页、论坛、SEO、CSP 和历史下载片段逐字节保留，配置通过 `nginx -t` 后 reload。新片段 SHA-256 为 `f09d645f753efc76bbc1bac2f8445e33f31506d8d5d05b168a82ab182782c68e`。10 月 20 日正式发布时 R2 未同步；10 月 21 日补齐，见下方修复记录。大文件正文不经过官网服务器。

候选清单先由官方 Tauri updater SDK 从模拟原生版本 4.1.0 完整下载 26,073,614 bytes 并验签，再匿名完整下载三份官网文件核对哈希。全部通过后，持发布锁以基线 SHA compare-and-swap 原子提升正式清单。

两个正式清单字节相同，SHA-256 为 `1a57ce7c52d8185c9bb878df311ad158e4144480b2bac6032289ad687409159e`。`lolicode-verify-delivery.mjs` 验证两份 feed、GitHub Latest 和三份完整下载通过。默认源上的 4.1.0 再次完整下载验签通过，4.1.1 自查返回 `up_to_date`。

证据保存在 `release/publish-v1.0.1-20261020/`，包含精选冻结审计、签名准备回执、安装和注册项恢复验证、编译后图标资源证明、候选与默认 SDK 回执、匿名下载记录及 `stable-delivery.json`。私有源码归档、密钥、用户配置和诊断日志未作为公开附件上传。

## 2026-10-21 R2 镜像修复

排查确认 R2 历史版本正常，v1.0.1 四个对象均为 404，原因是新版本没有同步到存储桶。沿用已登录的 Cloudflare 原账户与 `lolicode-releases` 桶，核对公共地址后，通过控制台向新前缀 `lolicode/releases/1.0.1/` 上传与 GitHub 已发布附件完全相同的安装器、签名、ZIP 和公开构建回执，没有重新构建或覆盖历史对象。

匿名完整下载四份 R2 文件，大小和 SHA-256 均与 GitHub 回执一致；安装器和便携 ZIP 分别为 26,073,614 / 30,914,517 bytes，本机本次用时 5.820 / 5.699 秒。已下载的安装器和 `.sig` 通过现有 updater 公钥的签名及 trusted comment 验证，公钥指纹保持 `6e5f32bd5f6dd5c1d6257dd65678288769aec4c729a86b7cf497b29668db0b51`。安装器 Range 返回 `206 bytes 0-65535/26073614`。公开构建回执为 2,253 bytes，SHA-256 `4afedb9c031da990762d2866ad2e8518de79f987f317cab56a6388cb2111e11b`。

用户选择默认下载继续使用 GitHub Release。修复前后，官网三个 v1.0.1 exact 路由均保持 302 到同版本 GitHub，两个正式 feed 的 SHA-256 仍为 `1a57ce7c52d8185c9bb878df311ad158e4144480b2bac6032289ad687409159e`。本轮仅补对象，没有修改官网、路由、正式清单、桶权限或 DNS，也没有创建 API 凭据。R2 当前仍使用原有 `r2.dev` 开发公开地址；正式高流量镜像应另行绑定自定义域名并验收，参见 [Cloudflare 公共存储桶说明](https://developers.cloudflare.com/r2/buckets/public-buckets/)。

独立官网服务器也复核了四文件 HEAD 200、安装器 Range 206、三个默认 GitHub 跳转及双 feed 摘要；本机另验证便携 ZIP Range 206。汇总回执为 `release/publish-v1.0.1-20261020/r2-mirror-repair-20261021.json`。分项证据位于 `tmp/r2-connectivity-20261021/`：`repair-before.json`、`repair-after.json`、`repair-signature.json`、`r2-repair-server-proof.json` 及控制台四文件截图 `r2-four-files-uploaded.png`。这次镜像修复不改变 10 月 20 日冻结产物所包含的代码和功能。
