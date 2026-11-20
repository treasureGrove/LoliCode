# LoliCode CLI

把 LoliCode 带进终端。粉色小狗陪你读项目、修改代码、运行命令，也能通过 JSON 接入脚本。

当前版本为 `0.1.0-alpha.3`。运行需要 Node.js **24.9 或更新版本**。CLI 使用桌面端同版本的 DeepSeek Harness 和共享宿主覆盖层，支持独立运行。

## 安装

先安装 [Node.js 24 LTS](https://nodejs.org/en/download)，再安装官网提供的 npm 包。

Windows PowerShell：

```powershell
npm.cmd install --global --ignore-scripts https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v0.1.0-alpha.3/lolicode-cli-0.1.0-alpha.3.tgz
lolicode.cmd --version
```

Linux：

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v0.1.0-alpha.3/lolicode-cli-0.1.0-alpha.3.tgz
export PATH="$HOME/.local/bin:$PATH"
lolicode --version
```

把上面的 PATH 设置加入 shell 配置文件后，新终端也可以直接使用。下载地址、版本与校验值见 [LoliCode CLI 官网](https://lolicode.com/cli/)。

## 配置模型

进入项目目录运行 `lolicode`（Windows 也可用 `lolicode.cmd`），启动后就是持续对话界面。尚未配置模型时会留在 `lolicode ›`，不会退出到 CMD、PowerShell 或 Linux shell。

输入 `/connect`，按引导填写渠道名称、API 基础地址、模型名和保存 API Key 的环境变量名称。已有渠道可以直接选用。没有对应环境变量时，可隐藏输入仅本次进程有效的 API Key；密钥不写入配置或磁盘。重启后需要再次输入，或提前设置环境变量。`/cancel` 返回对话，`/exit` 退出。

`lolicode auth login [渠道]` 可在启动前保存渠道配置，`lolicode auth list` 查看渠道和密钥是否已设置。密钥由环境变量提供。CMD 使用 `set 变量名=值`，PowerShell 使用 `$env:变量名 = '值'`。

也可以直接使用环境变量。Windows PowerShell：

```powershell
$env:LOLICODE_BASE_URL = 'https://api.deepseek.com/v1'
$env:LOLICODE_MODEL = 'deepseek-chat'
$env:LOLICODE_API_KEY = '你的 API Key'
lolicode.cmd
```

Linux：

```sh
export LOLICODE_BASE_URL='https://api.deepseek.com/v1'
export LOLICODE_MODEL='deepseek-chat'
export LOLICODE_API_KEY='你的 API Key'
lolicode
```

使用实际服务提供的地址、模型名与密钥。可接入 LoliCode 渠道网关的兼容 API 地址，也可以直接连接模型服务。协议选项包括 `openai-completions`、`openai-responses` 和 `anthropic-messages`，分别按服务要求设置 `--api` 与 API 基础地址。

Anthropic Messages 使用服务根地址，例如 `https://api.anthropic.com`，运行时会追加 `/v1/messages`。

保存多个模型渠道：

```sh
lolicode models add my-model --base-url https://example.com/v1 --model MODEL --api-key-env MY_API_KEY
lolicode models use my-model
lolicode models
lolicode doctor
```

已有渠道名称会保留。如需使用不同配置，添加新的渠道名称。

## 开始任务

在项目目录执行 `lolicode` 开始对话，也可以传项目路径。Windows 用 `lolicode.cmd` 同样支持下面的参数。

```sh
lolicode "./your-project"
lolicode mini
lolicode --continue
lolicode --session SESSION_ID
lolicode session list --max-count 10
lolicode run --dir "./your-project" -m my-model/MODEL "解释这个项目的结构"
```

`--continue`（`-c`）恢复这个项目的最近会话，`--session`（`-s`）指定 LoliCode 会话 ID。两者也可用于 `run`。`session list` 默认列出所有项目，可用 `--dir` 筛选，`--format json` 输出 JSON 数组。

`lolicode models` 列出已配置的模型。用 `-m 渠道/模型` 从已保存渠道选择模型，渠道名是第一个斜杠之前的部分。用 `--channel NAME -m MODEL` 可以传服务商的原始模型 ID，包括含斜杠的 ID。`resume`、`sessions`、`configure` 和 `--cwd` 也可以继续使用。

在提示符输入 `/` 并回车可查看命令，输入前缀后按 Tab 可补全。常用命令有 `/connect`、`/new`、`/sessions`、`/resume ID`、`/models`、`/model 渠道[/模型]` 与 `/exit`。`Ctrl+C` 停止当前任务。`--plain` 或 `NO_COLOR=1` 关闭颜色，`--no-animation` 关闭等待动效。

权限模式：

- `review` 为默认模式，修改文件和运行命令时逐次询问。
- `workspace` 允许项目目录内的操作，额外权限由 Harness 按次询问。
- `plan` 使用只读工具分析项目。
- `full` 允许无限制的本地工具执行，需要显式指定。

## 脚本与自动化

```sh
lolicode run "检查项目" --json
lolicode run "修复项目测试" --approval workspace --format json
git diff | lolicode run "审阅这些改动" --stdin --json
lolicode run "检查项目" --timeout 120 --json
```

`--json` 输出一个结果对象。`--format json` 与 `--stream-json` 都逐行输出 LoliCode 的文本、工具和结果事件。非交互模式遇到权限或用户问题时，返回 `approval_required` 或 `input_required`，可回到终端恢复会话继续处理。

退出码为 `0` 成功、`1` 错误、`2` 需要输入或权限、`124` 超时、`130` 取消。最终结果包含 `sessionId`、`status`、`text`、`finishReason`、`toolErrors` 和 `usage`。

CLI 数据默认保存在 `~/.lolicode/cli`。`LOLICODE_HOME` 可指定独立目录。会话元数据在 `sessions/`，Harness 原生日志在 `harness/`。会话被其他进程打开时会提示占用，异常退出留下的锁可以在确认原进程已结束后按错误提示移除。

## 源码开发

在仓库根目录执行：

```sh
cd packages/lolicode-cli
npm ci --ignore-scripts
npm run prepare:runtime
npm test
node bin/lolicode.mjs --help
```

`prepare:runtime` 从 `packages/lolicode-harness-runtime` 复制共享宿主覆盖层，并检查依赖版本一致。`npm pack` 会执行这一步并携带固定依赖树的 `npm-shrinkwrap.json`。第三方许可随包提供。
