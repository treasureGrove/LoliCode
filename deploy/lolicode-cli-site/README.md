# LoliCode CLI 官网发布

CLI 页面源码位于 `public/cli/`。官网使用现有 `lolicode.com` Nginx 主机，发布工具沿用维护锁和私有恢复点。

本批次 `20261120-cli-alpha1-v1` 新增 `/cli/` 页面、静态资源、版本清单及固定的 GitHub 下载跳转。工具从发布时的正式首页读取原字节，添加 CLI 导航链接，生成新的静态首页与产品地图，并记录每份配置和页面的 SHA-256。

先验证最终 npm 安装件和真实终端交互，再创建 GitHub CLI 预发布。安装包以 `lolicode-cli-v0.1.0-alpha.1` 标签分发。

```sh
node scripts/build/lolicode-cli-site.mjs release/cli-final/lolicode-cli-0.1.0-alpha.1.tgz release/cli-site-alpha1
```

将输出目录放入服务器的 `/root/lolicode-20261120-cli-alpha1-v1/`，权限为 `0700`。使用构建器返回的固定 manifest SHA，依次执行：

```sh
python3 deploy.py prepare MANIFEST_SHA
python3 deploy.py preview MANIFEST_SHA
python3 deploy.py verify-preview MANIFEST_SHA
python3 deploy.py restore-preview MANIFEST_SHA
python3 deploy.py production MANIFEST_SHA
```

工具只接受当前正式配置的精确基线。预览使用 `test.lolicode.com` 并标记 noindex，生产前恢复测试站。`production` 会核对公开下载、静态页面字节和既有网站入口，失败时按条件恢复原配置。

恢复点包含 `baseline.json`、`snippet.before`、`snippet.after`、`test.before`、`site-sha.json` 和阶段验收记录。若需要回退，在核对当前状态后运行 `rollback MANIFEST_SHA`。有后续并发改动时会拒绝覆盖。

独立 CLI 发布的源码与安装说明在 `packages/lolicode-cli/README.md`。Windows 和 Linux 安装件验证由 `scripts/tests/lolicode-cli-installed.mjs`、`lolicode-cli-linux.py` 与 `lolicode-cli-pty.py` 记录。

本次 GitHub CLI 附件上传在本机网络返回 301，已使用现有官网服务器完成上传。`scripts/release/lolicode-cli-publish.mjs upload ARTIFACT_DIRECTORY RELEASE_ID ssh` 将现有 GitHub 凭据通过进程 stdin 交给 `lolicode-cli-upload.py`，检查上传目标、文件清单和 SHA-256。凭据仅在进程内存中使用。`publish` 操作核对全部附件后发布 CLI 预发行版本。运行这批固定工具前，先检查它们声明的版本、目录、Release ID 与实际候选一致。
