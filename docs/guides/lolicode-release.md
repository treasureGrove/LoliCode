# LoliCode 签名发布与应用内更新

本流程是 LoliCode 自己的发布链路，不复用 CCSwitch 的公钥、更新地址、GitHub workflow 或下载站清单。`scripts/lolicode-release.mjs` 仅在本地产生并验证发布目录，不上传文件，不读取私钥或 `.env`。

## 更新文件约定

本项目使用 Tauri v2 Windows x64 NSIS 更新。更新客户端下载完整 NSIS 安装器 `.exe`；对应 `.exe.sig` 为 Tauri 签名。`latest.json` 的 `platforms.windows-x86_64.signature` 必须嵌入 `.sig` 的内容，而不是文件路径或 URL。[Tauri 官方 updater 文档](https://v2.tauri.app/plugin/updater/)

工具通过 Node 的 BLAKE2b 与 Ed25519 验证安装器签名和 trusted comment，并检查 key ID、公钥与应用配置的绑定。格式依据项目已安装的 `minisign-verify 0.2.5`，同时兼容 Tauri 接受的 `ED` 和旧 `Ed` 签名。测试包含公开的官方验签向量。[Minisign 验签实现](https://github.com/jedisct1/rust-minisign-verify/blob/master/src/lib.rs)

更新签名与 Windows Authenticode 是两种独立机制。Tauri updater 签名保护更新包内容；是否购买或配置 Windows 代码签名证书，需要单独安排。[Tauri Windows 签名说明](https://v2.tauri.app/distribute/sign/windows/)

## 一次性准备

维护者在版本库以外生成并备份 **LoliCode 专用**签名密钥。私钥与密码进入本机秘密存储或 CI secrets，不能进入仓库、安装包、交付目录、命令日志或网站。不要使用继承自 CCSwitch 的公钥；发布工具明确拒绝该继承公钥的指纹。

使用安装的 Tauri CLI 操作密钥，运行方式示例：

```powershell
pnpm exec tauri signer generate -w "<仓库外私有目录>\LoliCode.key"
```

不要加入 `--force` 覆盖已经向用户发布的签名密钥。对现有安装来说，公钥是信任链的一部分，不能随意换成另一个密钥。备份丢失的私钥会影响后续更新。[官方签名说明](https://v2.tauri.app/plugin/updater/#signing-updates)

配置负责人需要在 `src-tauri/tauri.conf.json` 设置：

- `bundle.createUpdaterArtifacts: true`，采用 v2 产物。
- `plugins.updater.pubkey` 为本项目 `.pub` 的内容，不能写文件路径。
- `plugins.updater.endpoints` 只包含已确认的 LoliCode HTTPS 清单地址。
- 发布版本与安装器实际编译版本一致。

发布负责人已确定下面的 LoliCode 独立路径。**路径确定不代表已经部署或可用**；实际公开访问与更新演练仍须在发布时确认：

```text
https://tools.treasuregrove.art/lolicode/updates/latest.json
https://tools.treasuregrove.art/lolicode/releases/<version>/<installer>.exe
```

密钥参数通过 Tauri 支持的安全调用方式传入构建环境；`.env` 不会自动完成 updater 签名配置。不要把私钥内容放在命令行参数里。`TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 只在受控构建进程环境中设置，发布后清理。[官方 CLI 参数](https://v2.tauri.app/reference/cli/#signer-sign)

## 每次发布

1. 选取严格递增的 SemVer，同步配置和版本文件，完成测试并构建正式 NSIS 安装器。改变 `+build` 元数据不算版本递增。构建负责人提供 `.exe` 和匹配的 `.exe.sig`，不要用便携主程序代替安装器。
2. 先验证安装器包含正确的应用、agent 引擎、默认技能及许可证。该资源校验与本工具的更新包验签分别进行；本工具不运行安装器，也不声称覆盖安装后的功能。
3. 用以下命令准备一个新版本目录。所有参数都明确指向本轮产物和公钥；`--notes-file` 仅接受 Markdown 文件。

```powershell
node scripts/lolicode-release.mjs prepare `
  --installer "<NSIS安装器绝对路径>.exe" `
  --signature "<NSIS安装器绝对路径>.exe.sig" `
  --public-key-file "<仓库外私有目录>\LoliCode.key.pub" `
  --version "4.0.13" `
  --current-version "4.0.12" `
  --base-url "https://tools.treasuregrove.art/lolicode/releases" `
  --latest-url "https://tools.treasuregrove.art/lolicode/updates/latest.json" `
  --output-dir "<本地发布暂存目录>" `
  --portable "<已完成资源与压缩完整性校验的便携包>.zip" `
  --notes-file "<本轮更新说明>.md"
```

示例版本号必须替换为本轮正式版本。若已有公开清单，先获取并保存它，通过 `--previous-manifest "<已发布latest.json>"` 再次约束版本递增。可传 `--pub-date` 固定 RFC3339 发布时间。构建负责人与站点负责人需要核对公开版本，不能仅依赖手工输入的 `--current-version`。

首个独立签名 bootstrap 计划使用 `4.0.13`。现有 `4.0.12` 构建未启用本项目 updater，不能承诺它能直接应用内升级到 bootstrap；用户需要先手动安装可信的 bootstrap 安装器。安装 bootstrap 后，后续更高版本才能使用内嵌的 LoliCode 公钥与更新地址。首次安装不是一次已完成的自动更新演练。

工具只产生 `<暂存目录>/<version>/`，包括版本文件名的安装器、签名、候选 `latest.json`、`release-manifest.json` 和 `upload-plan.json`。`release-manifest.json` 记录安装器、签名、清单的 SHA256 和字节数及公钥指纹。版本目录已存在时拒绝覆盖；准备失败时不会留下一个可发布的版本目录。

`--portable` 为可选参数；传入时必须指向实际存在的 ZIP，复制后的固定名称为 `LoliCode-Portable.zip`，大小和 SHA256 同时写入发布审计清单和上传计划。`latest.json` 的额外 `downloads.windows-x86_64-portable` 提供实际 URL、名称、大小和哈希，网站应以该项是否存在来显示便携下载按钮。省略参数时不生成便携 URL。便携包不属于 Tauri `platforms` 更新安装器，不能当作已通过 updater 签名验证的文件；它的资源和 `7z t` 压缩完整性需要单独校验。

```powershell
node scripts/lolicode-release.mjs verify `
  --release-dir "<本地发布暂存目录>\4.0.13" `
  --public-key-file "<仓库外私有目录>\LoliCode.key.pub"
```

`--tauri-config` 可以显式指定本轮构建使用的独立 JSON 配置，默认检查仓库的 `src-tauri/tauri.conf.json`。签名失败、继承公钥、版本不匹配、回退到上游 endpoint、HTTP、URL 用户名/密码、query token、路径越界、重复文件以及清单哈希不符都会阻止生成或验证。

## 发布顺序

站点负责人按照 `upload-plan.json` 操作：

1. 上传 `/lolicode/releases/<version>/` 下的安装器、签名及发布审计清单。版本路径不可覆盖，服务器可使用 `Cache-Control: public, max-age=31536000, immutable`。
2. 从实际 HTTPS 下载地址重新取得安装器和签名，核对 SHA256、大小和签名。确认访问稳定，无鉴权 token、HTML 错误页或跳转到其他版本。该步骤由部署工具或维护者完成，本地脚本不会伪造部署成功。
3. **最后**发布 `/lolicode/updates/latest.json`，响应 `Content-Type: application/json`，并避免长时间缓存。站点支持原子替换时使用原子替换，避免客户端读到半个 JSON。不要先宣布新版本再上传安装器。
4. 用上一版已安装的 LoliCode 在测试环境走一次检查、下载、验签与 NSIS 更新；确认项目配置、账号引用、会话和默认资源仍正常，再宣布发布。

已经发布的版本内容不可重写。如果需要修复同版本错误，提升版本号并重新构建、签名、验证和发布。退回旧的 `latest.json` 不会让默认 updater 自动安装低版本；若需回退行为，应另行设计并验证客户端版本比较策略。

## 验证命令与当前交付条件

```powershell
node --test scripts/lolicode-release.test.mjs
node --test scripts/lolicode-publish.test.mjs
```

这些测试是本地签名与发布格式测试，使用公开验签向量和临时测试密钥对象，不读取真实私钥或发网络请求。正式交付仍要求：本项目专用公钥已经嵌入正式构建、真实 NSIS 签名通过验证、站点路径确认与部署成功、上一版应用的更新演练成功。本次工具准备本身不代表更新地址已经上线。

## 部署辅助工具

`scripts/lolicode-publish.mjs` 固定使用已授权的 OpenSSH `tools` 别名，且只能写 `/www/wwwroot/tools.treasuregrove.art/lolicode/`。需要本机 `ssh`／`scp` 和远端 Python 3；脚本不读取 SSH 私钥、不安装服务、不执行 `git pull`／`reset`，不会触及工具站原有的 index、CSS、JS 或其他 git dirty 文件。

先仅验证本地发布计划：

```powershell
node scripts/lolicode-publish.mjs `
  --release-dir "<暂存目录>\4.0.13" `
  --public-key-file "src-tauri/updater.pub" `
  --site-dir "<TAWEBTOOL绝对路径>\lolicode" `
  --dry-run
```

`--dry-run` 不执行 SSH、SCP 或网络请求。`--site-dir` 可省略；传入时只允许独立 `lolicode` 目录的五个文件：`index.html`、`assets/site.css`、`assets/downloads.js`、`assets/logo.svg`、`assets/maid.png`。根目录 `README.md` 作为本地说明忽略，不读取或上传。整个工具站目录、其他额外文件和 symlink 都会被拒绝。正式执行时去掉 `--dry-run`。

正式流程会先重跑发布目录验签，再通过唯一 UUID 暂存目录上传，验证远端 SHA256／字节数后生成不可覆盖的 `releases/<version>/`。随后从真实公开 HTTPS 地址重新下载安装器、签名和可选便携包，完成验签／哈希校验，才原子更新网站指定文件和 `updates/latest.json`。更新清单是最后的公开写入；同版或更高版已存在时拒绝回退。

远端 `.publish-lock` 通过原子建目录持有，包含当前操作 ID，覆盖整个 SCP／公开下载／发布周期。失败保留暂存、已提交的版本文件与本地下载记录，只尝试释放自己拥有的锁，不做递归删除。输出中的 staging ID 可用于同一份准备产物的恢复：

```powershell
node scripts/lolicode-publish.mjs `
  --release-dir "<暂存目录>\4.0.13" `
  --public-key-file "src-tauri/updater.pub" `
  --resume-stage "<失败记录中的UUID>"
```

若原来传了 `--site-dir`，恢复时也必须传入字节完全相同的网站目录。恢复只能核对并使用原操作已提交的同一批内容，不能覆盖版本目录或接受变更后的文件。不要在原进程仍运行时启动恢复。若最后步骤异常，先核对远端／公开的 `latest.json` 是否已完成替换；已经发布的同版不能再次覆盖。遗留锁应由维护者核对操作 ID 与进程状态后处理，本工具不会删除其他操作的锁或暂存。
