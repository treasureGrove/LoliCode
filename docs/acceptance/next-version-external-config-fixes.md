# 下一版：DSH / ZCode 一键配置修复验收

状态：开发分支修复，尚未打包发布。官网现有 4.0.21 安装包不包含本次改动。

## 报告及复现范围

用户在另一台电脑配置 DeepSeek Harness 和 ZCode 时，两项均失败：DSH 报 YAML 无法安全解析，ZCode 报同名条目或用户修改导致的并发冲突。该电脑版本及配置原文尚未取得，不能据本机成功宣称远端问题已完全复现。

已通过隔离 fixture 复现 DSH 的一种故障：已有非空 `config: {...}` 或 `providers: {...}` 时，旧逻辑直接插入块配置，导致生成的 YAML 无效。本机现有分行配置的只读转换未出现同一故障。

## 本次修复

- DSH：支持上述静态行内映射，局部转换后对整棵 YAML 数据树进行校验；保留其它插件原文、脚本、行尾注释和换行格式。不会执行 `!!js`。待转换的行内映射若含标签或锚点引用，则保留原文件并给出具体原因。
- DSH：区分原文件解析、行内转换和生成结果校验的错误；仅输出行列位置，不输出可能包含 Key 的解析器原始内容。
- ZCode：同名提供商或规则无法证明归属、管理记录丢失、托管配置被手工修改时，保留原条目，使用独立托管提供商。桌面 Personal 文件及旧桌面 / CLI 配置均覆盖。
- ZCode：重复应用、切换模型和本地 gateway token 变化会复用仍归属 LoliCode 的条目；JSON 键与模型规则数组的无害排序不再误判为用户修改。兼容旧摘要。被用户修改的独立条目也保留，必要时分配下一编号。
- 维持私有备份、多文件写前检查及失败回滚；不修改外部工具插件配置，不写入真实上游 Key。

## 自动检查

全部适配器用临时目录及合成 token 验证，不向用户真实配置写入。

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --manifest-path src-tauri/Cargo.toml --lib external_agent_config
node scripts/tests/zcode-personal-config-interop.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

ZCode 互操作脚本使用仓内固定上游 reader / resolver / registry，验证正常提供商、同名冲突、手动修改和管理记录丢失后的默认选择可执行，并检查思考强度、输出上限与图像能力的请求映射。

本次执行结果：适配器 17 项通过；ZCode 上游互操作覆盖的 8 项 Rust 用例通过，核对固定上游 325 个源文件；完整 Rust lib 回归 3,858 项通过、12 项跳过。日志位于本地 `release/acceptance/external-config-bugfix-final.log`、`external-config-bugfix-zcode-reader-final.log` 和 `external-config-bugfix-full-rust.log`。

## 下次打包后的人工复验

- [ ] 在原来报错的另一台电脑记录关于页版本，保留 DSH / ZCode 原配置备份。
- [ ] 再次点击“一键配置 2 个工具”，两项均成功；若 DSH 仍失败，记录新的阶段和行列位置，仅提供该位置附近脱敏后的结构。
- [ ] DSH 既有插件、脚本和自定义提供商仍可用，能选择 LoliCode 模型进行一次请求。
- [ ] ZCode 保留原同名 / 自定义条目，新托管模型在新会话中可选并可请求。
- [ ] 重复点击配置不继续堆积提供商；更换模型后再次配置，默认选择随本次操作更新。
- [ ] 修改 ZCode 托管条目的显示名或模型设置后再配置，该修改保留，新增独立条目可用。

这些复选项留给实际安装包验收；源码测试通过不等于已在另一台电脑验证通过。
