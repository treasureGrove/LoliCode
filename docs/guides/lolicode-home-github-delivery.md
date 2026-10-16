# lolicode.com 官网与 GitHub 下载交付

2026-10-16，lolicode.com 首页切换为 LoliCode 软件官网；社区保留在
[lolicode.com/all](https://lolicode.com/all)。既有账户 API、主题、用户、站点地图、
维护模式与备份定时器保留。预览通过后恢复了 test.lolicode.com 原社区首页。

## 下载与更新

安装器、签名与便携包位于公开的
[LoliCode-Releases 4.0.16](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-v4.0.16)。
分发仓库只包含下载说明和原文许可/来源声明；原 LoliCode 源码仓库保持私有。

官网下载按钮直接访问 GitHub Releases；`/downloads/releases/<version>/<file>`
兼容入口也只返回 302，大文件不通过官网服务器代理。
根域的 `/downloads/updates/latest.json` 提供同源小清单，固定访问原有发布服务。
工具站的原清单仍在相同地址，现在也引用 GitHub 附件，因此已安装客户端无需换更新源。
原安装包、签名、版本目录没有覆盖或重打包。

- 安装器：21,746,554 字节，SHA256 `18b9388d68e12e281d465215738a108b84c791984f60a5abe45017e76c284ba0`。
- 便携包：26,186,973 字节，SHA256 `1abc2bf82e9295e270486d200d64408ac102ad7468a8484ed2c1c48b3dec3e45`。
- 官网下载脚本与根域构建测试 43 项、About 更新入口测试 8 项通过。
- 官网、社区 `/all`、账户 `/api`、`/sitemap.xml` 实测 200；Nginx 配置检查通过，预览原配置 SHA256 恢复一致。
- GitHub 附件匿名 API、HEAD 和签名 GET 校验通过；便携包匿名完整下载并重算 SHA256 一致。
- 官方 Tauri updater SDK 从固定 4.0.15 检测到 4.0.16，经根域清单完整下载 GitHub 安装器并成功验签。验证器不读用户配置、不创建窗口、不安装或重启。

证据：[GitHub 分发](../images/lolicode/4.0.16/github-distribution-proof.json)、
[安装器原生验签](../images/lolicode/4.0.16/native-updater-github-proof.json)、
[便携包完整下载](../images/lolicode/4.0.16/github-portable-proof.json)。

## 后续发布顺序

1. 使用原 LoliCode 公钥对应的签名流程准备新版本；不改变现有版本目录。
2. 将同名安装器、`.sig` 与可选便携包上传到公开分发仓库的 `lolicode-v<version>` Release；先验证匿名下载、字节数和 SHA256。
3. 再发布小清单；根域下载网关会将原工具站版本 URL 转为相同版本的 GitHub 附件地址。
4. 使用隔离 updater smoke 验证实际下载与签名，再检查官网按钮。

手动 GitHub Actions 发布步骤已改为公开分发仓库和规范附件名。它仍需显式选择
`publish_github`，并由维护者在 release environment 配置仅对分发仓库有写权限的
`LOLICODE_RELEASES_TOKEN`；本轮没有创建密钥或自动启用 CI 发布。
本轮已发布 4.0.16 二进制不因官网迁移重建，源码中的官网/社区/发布说明链接用于后续应用构建。
