# LoliCode Security Policy / 安全策略

## Supported versions / 支持版本

Security fixes target the latest published LoliCode release. Historical CC Switch version numbers in archived release notes do not describe LoliCode support.

安全修复面向最新已发布的 LoliCode 版本。历史 CC Switch 发布说明中的版本号不代表 LoliCode 的支持范围。

## Trust boundaries / 信任边界

LoliCode is a local desktop Agent with model-network requests, file and terminal tools, provider configuration, local routing, imported data, previews, and a separate community account. It runs with the permissions of the operating-system user. Model output, project files, imported configuration, remote responses, and preview content must be treated as untrusted inputs.

LoliCode 是本地桌面 Agent，涉及模型网络请求、文件与终端工具、渠道配置、本地路由、导入数据、预览和独立社区账户。程序以当前系统用户的权限运行。模型输出、项目文件、导入配置、远程响应及预览内容属于不可信输入。

Reports are especially relevant when they demonstrate:

- Credentials crossing into logs, public exports, rendered content, or an unintended origin.
- Untrusted inputs bypassing permissions, changing paths, executing commands, or reaching privileged desktop APIs.
- Preview content escaping its intended isolation.
- Unauthorized use of local HTTP services, including listeners configured for non-loopback access.
- Unsafe imports, synchronization, or provider responses.
- Tampering with builds, release signatures, or updates.

尤其欢迎报告凭据泄漏、越权文件或命令操作、预览隔离逃逸、本地接口未授权访问、导入或同步利用链，以及构建、签名、更新链路问题。请说明谁能控制输入，以及从输入到受影响代码的完整路径。

The community account is distinct from provider authorization. Its native service stores a login token in the system credential vault when available and returns public profile data to the interface. Vault failures are surfaced as warnings. This is not a claim that every provider or historical configuration format stores secrets in the same way.

社区账户独立于模型渠道授权。其原生服务在系统凭据库可用时保存登录令牌，向界面返回公开资料；凭据库异常会提示。不同渠道和历史配置格式不一定使用相同的凭据存储方式。

A user knowingly running a command they authored is different from an attacker causing that command to run through hidden or misleading imported content. The latter remains relevant even when the application and attacker have the same filesystem permissions.

## Report privately / 私下报告

Use [LoliCode GitHub Security Advisories](https://github.com/treasureGrove/LoliCode/security/advisories/new) when private reporting is available. If it is unavailable, open an [issue requesting a private contact channel](https://github.com/treasureGrove/LoliCode/issues/new) without including the vulnerability details or personal data.

优先使用 [LoliCode GitHub 私密安全报告](https://github.com/treasureGrove/LoliCode/security/advisories/new)。如果该入口不可用，请先通过 [Issue](https://github.com/treasureGrove/LoliCode/issues/new)请求私下联系方式，不要在公开内容中附漏洞细节、利用代码或个人信息。

Include affected versions, platform, prerequisites, reproduction steps, impact, and a minimal redacted example. Do not attach real API keys, login credentials, or private conversations.

请提供受影响版本、系统、前置条件、复现步骤、影响范围及脱敏的最小示例，不要附真实密钥、登录凭据或私聊数据。

We coordinate disclosure with the reporter after assessing the issue and preparing a fix. Credit can be omitted on request. This policy does not promise a fixed response or resolution time.

## Updates / 更新

Use the [LoliCode download page](https://tools.treasuregrove.art/lolicode/) and [release notes](https://github.com/treasureGrove/LoliCode/releases). The installer updater uses the [LoliCode signed update manifest](https://tools.treasuregrove.art/lolicode/updates/latest.json). Download instructions for the upstream project are not LoliCode update instructions.

请通过 [LoliCode 官网](https://tools.treasuregrove.art/lolicode/)及[发布记录](https://github.com/treasureGrove/LoliCode/releases)获取版本信息。安装版使用 [LoliCode 签名更新源](https://tools.treasuregrove.art/lolicode/updates/latest.json)，不要混用上游项目的安装或更新包。
