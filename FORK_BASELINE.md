# TAI Switch 完整复制基线

用户于 2026-10-13 明确要求：“直接完全 copy，然后我们再改”。本阶段完整复制 CC Switch，保留原有界面与业务逻辑，后续改动建立在此代码上。

- 来源：<https://github.com/farion1231/cc-switch>
- 上游提交：`479964f2ef59e291f563218ac674a1fd82dcdbd3`（main 快照，版本字段为 4.0.10）
- 原始 Git tree：`c4dc1e03edc9a2466c51624d2f8b6d7e98253553`
- 纯复制提交：`b04540d768bedb4ca1de4810df00eedc5189a4ea`，其 tree 与上游完全相同。
- 逐文件校验：1,568 个上游文件的 Git blob 哈希全部一致，文件执行标记亦按原 Git tree 保留。
- 许可证：原 `LICENSE` 完整保留，MIT，Copyright (c) 2025 Jason Young。

以上描述纯复制提交 `b04540d`。该提交的 README、产品名称、图标、数据格式、代理、计费、客户端切换、MCP、Skills 和其他模块均保持上游原样。后续用户授权的测试修复和 TAI 隔离打包在其上单独提交，交付说明见 `TESTING_TAI.md`。

## 目录与保留版本

当前开发目录：`D:\projectGithub\TAI-Switch`。

旧的自研 TAI Switch v0.2.0 保留在 `D:\projectGithub\FreeHub`，提交 `915471db66ade6e1d56b8bcb93cc139c967f2e28`；新仓库历史也保留该提交。其 Astra UI、导航和免费抵扣代码仍可复用。

旧应用数据与 Windows 凭据未迁移、删除或覆盖。测试使用隔离目录，不导入用户的真实 Key，也不切换用户正在使用的客户端配置。

远端 origin：<https://github.com/treasureGrove/TAI-Switch>；当前分支 `TG/freehub-m0`。保留 upstream 原项目远端和 server 备份远端。

## 构建与后续改动

保持原 pnpm、Rust 版本和锁文件。依赖安装使用 `pnpm install --frozen-lockfile`；常规入口仍为上游 README 中的 `pnpm dev` / `pnpm build`。

本地验证使用外部 Tauri 配置覆盖测试应用标识，关闭验证包的更新产物签名，并将测试 deeplink scheme 和 updater endpoints 留空；这些仅用于隔离验证，不写入原始 tauri.conf.json。

完整复制后的验证结果记录在 `FORK_VALIDATION.md`。类型检查或构建通过不代表所有客户端、真实提供商与干净系统均已验收。

后续按用户要求逐项改为 TAI 品牌、Astra UI、网站导航和免费额度功能，并在原项目逻辑上验证；不能再将旧自研网关标为 CC Switch 的完整实现。
