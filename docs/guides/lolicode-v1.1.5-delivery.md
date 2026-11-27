# LoliCode 1.1.5 交付记录

2026-11-27 发布 Windows x64 安装版、便携 ZIP 和 Tauri 签名更新。产品版本和原生更新版本均为 `1.1.5`。[GitHub 发行说明](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v1.1.5)

## 包体

| 文件 | 1.1.4（字节） | 1.1.5（字节） | 缩减 |
| --- | ---: | ---: | ---: |
| Windows x64 安装器 | 148,484,855 | 145,840,344 | 1.78% |
| Windows x64 便携 ZIP | 224,305,342 | 223,005,724 | 0.58% |

安装器采用 32 MiB 的 LZMA 字典，便携包使用标准 Deflate ZIP。Harness 裁掉其他架构的 Office 帧转发二进制，保留 Windows x64 原生组件和许可证。使用包内 Node 核对了目标组件的上游哈希，并将测试 DOCX 转成了一页 PDF。[NSIS 字典设置](https://nsis.sourceforge.io/Reference/SetCompressorDictSize)

## 验收

- 发布源码通过 4,068 项前端测试和 GitHub CI 的全部六个作业。[CI 记录](https://github.com/treasureGrove/LoliCode/actions/runs/45956664212)
- 安装器解出的 27,618 个资源文件与构建输入逐一核对 SHA-256。便携包解出的 27,622 个文件与打包目录逐一核对。两个产物实测通过离线运行时自检。
- 从正式版 1.1.4 和 1.1.1 分别在隔离 Windows 标准账户中覆盖安装。配置的渠道和旧会话在覆盖、重启及重复安装后均可续用。会话验收使用本机模拟模型，测试账户和配置目录已清理。
- 官网与工具站显示 1.1.5，两处正式清单返回同一份数据。四个 GitHub 附件和经官网入口下载的安装器、签名与 ZIP 均通过匿名完整下载的长度和 SHA-256 核验。官网下载由 GitHub 提供，R2 镜像本轮未同步。[官网](https://lolicode.com/) · [工具站](https://tools.treasuregrove.art/lolicode/)
- 官方 Tauri updater SDK 从候选源和正式源下载并验证安装器签名。以 1.1.4 检查可获取 1.1.5，以 1.1.5 检查返回已是最新版。旧版迁移入口继续提供比较版本 4.2.0 和产品 1.1.0 的安装器，清单 SHA-256 与发布前一致。[正式更新源](https://tools.treasuregrove.art/lolicode/updates/stable.json)

## 构建摘要

- 源码提交为 `23b316c8594e6346809586b9d77f4d7e8e7a4469`，冻结树为 `8650a8ffd550d2dbee619c3bb12b341d3a47cb27`，源归档 SHA-256 为 `2e446d56d7dc436a6efc88bb30a6ce62dc8bad18f0384d84d6d06d5c8e28f4fe`。[源码](https://github.com/treasureGrove/LoliCode/tree/23b316c8594e6346809586b9d77f4d7e8e7a4469)
- 正式清单 SHA-256 为 `8c3edd6b8d69a1303e2ceabbaace956a532b58421518eb585a608a3418eae9bd`。安装器、Tauri 签名和便携 ZIP 的长度与 SHA-256 见公开构建记录。[构建记录](https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-v1.1.5/release-build.json)
