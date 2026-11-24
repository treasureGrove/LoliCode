# LoliCode CLI

把 LoliCode 带进终端。粉色小狗陪你读项目、修改代码、运行命令，也能通过 JSON 接入脚本。

当前版本为 `0.1.0-alpha.5`。运行需要 Node.js **24.9 或更新版本**。CLI 使用桌面端同版本的 DeepSeek Harness 和共享宿主覆盖层，支持独立运行。

## 安装

先安装 [Node.js 24 LTS](https://nodejs.org/en/download)，再安装官网提供的 npm 包。

在 Windows 上打开 CMD 或 PowerShell。

```powershell
npm.cmd install --global --ignore-scripts --prefer-online https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v0.1.0-alpha.5/lolicode-cli-0.1.0-alpha.5.tgz
lolicode.cmd
```

在 Linux 上打开 Bash 或 Zsh。

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts --prefer-online https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v0.1.0-alpha.5/lolicode-cli-0.1.0-alpha.5.tgz
export PATH="$HOME/.local/bin:$PATH"
lolicode
```

把上面的 PATH 设置加入 shell 配置文件后，新终端也可以直接使用。下载地址、版本与校验值见 [LoliCode CLI 官网](https://lolicode.com/cli/)。

## 在对话里连接模型

在项目目录运行 `lolicode.cmd`（Windows）或 `lolicode`（Linux），会直接看到 `you ›` 对话输入行。先输入 `/connect` 打开服务商菜单。可以用方向键和回车选择，也可以用序号选择。按 Esc 返回对话。

- **DeepSeek、OpenAI 或 Anthropic**。从预设里选模型，也可以手填模型 ID。API 地址和协议由预设提供。看到隐藏输入提示后，粘贴服务商的 API Key。
- **已保存的渠道**。选中渠道即可复用配置。缺少环境变量时，只需补输 API Key。
- **自定义渠道**。填写服务商的 API 基础地址，选协议，再填模型 ID。可用于接入兼容网关。

在对话中用 `/models` 选择已保存渠道的模型。连接前输入的任务会留作草稿，连好后输入 `/send` 发送。CLI 渠道独立于桌面版。

临时输入的 Key 仅供本次进程使用。希望新终端也能读取 Key，可以提前设置对应的环境变量。预设分别使用 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`。

`/connect NAME` 可以直接连接指定渠道。也可以在系统终端运行 `lolicode.cmd auth login NAME`（Linux 用 `lolicode auth login NAME`）。缺少密钥时，粘贴临时 Key 即可进入本次聊天，直接回车则只保存渠道。已有对应密钥环境变量时，命令保存渠道后返回系统终端。用 `lolicode auth list` 查看已保存的渠道和密钥状态。

CMD 使用 `set 变量名=值` 设置环境变量，PowerShell 使用 `$env:变量名 = '值'`。

也可以直接用环境变量完成配置。在 Windows PowerShell 中运行以下命令。

```powershell
$env:LOLICODE_BASE_URL = 'https://api.deepseek.com'
$env:LOLICODE_MODEL = 'deepseek-flash'
$env:LOLICODE_API_KEY = '你的 API Key'
lolicode.cmd
```

在 Linux 终端中运行以下命令。

```sh
export LOLICODE_BASE_URL='https://api.deepseek.com'
export LOLICODE_MODEL='deepseek-flash'
export LOLICODE_API_KEY='你的 API Key'
lolicode
```

按模型服务商提供的信息填写 API 基础地址、模型名和密钥，并选择匹配的协议。可以连接 LoliCode 渠道网关提供的兼容 API。协议选项包括 `openai-completions`、`openai-responses` 和 `anthropic-messages`，可通过 `--api` 设置。

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

`lolicode models` 在系统终端列出已配置的模型，可加 `--format json` 供脚本读取。用 `-m 渠道/模型` 从已保存渠道选择模型，渠道名是第一个斜杠之前的部分。用 `--channel NAME -m MODEL` 可以传服务商的原始模型 ID，包括含斜杠的 ID。`resume`、`sessions`、`configure` 和 `--cwd` 也可以继续使用。

在提示符输入 `/` 并回车可查看命令，输入前缀后按 Tab 可补全。常用命令有 `/connect`、`/models`、`/send`、`/new`、`/sessions`、`/resume ID`、`/model 渠道[/模型]` 与 `/exit`。`Ctrl+C` 停止当前任务。`--plain` 或 `NO_COLOR=1` 关闭颜色，`--no-animation` 关闭等待动效。

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
