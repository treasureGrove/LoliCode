# CLI Alpha 2 官网更新

本批次只更新已有 `/cli/` 静态目录，新增 `0.1.0-alpha.2` 的固定下载跳转；保留旧 Alpha 1 下载和已恢复的官网首页。不要用最初的 Alpha 1 首页插入脚本覆盖当前首页。

先通过精确 npm 安装件的 Windows / Linux 验收及真实终端引导测试，再发布 GitHub 预发行版。从本工作树根目录构建：

```sh
node scripts/build/lolicode-cli-site.mjs release/cli-alpha2/lolicode-cli-0.1.0-alpha.2.tgz release/cli-site-alpha2
```

构建器生成四份 CLI 页面资源、清单及冻结部署脚本。复制至私有 `/root/lolicode-20261120-cli-alpha2-v1/`（0700），按清单 SHA256 依次执行 `prepare`、`preview`、`verify-preview`、`restore-preview` 和 `production`。测试站使用 `/cli/` 路径和 noindex；正式切换前测试配置必须恢复。

部署使用既有维护锁、精确配置比对、不可变目录、Nginx 检查和条件回退，不操作论坛数据。正式验证除 CLI 字节外，还核对官网首页 SHA256 与公共论坛/API/地图。若需要条件回退，使用恢复点脚本 `rollback MANIFEST_SHA`，发现后续配置变化时会拒绝覆盖。
