# UE Box 能力接入记录

更新：2026-10-19。UE 是与工作台、酒馆同级的内置工作区；UE 工程与编辑器操作复用 LoliCode 唯一主 Agent、权限、会话和模型渠道。当前实现是第一段可用链路，尚未完成第一期 UE 全量验收。本次源码修复和隔离 UE 5.8.3 实测见[桥接修复验收](../acceptance/next-version-unreal-bridge.md)，尚未随新安装包发布。

## 已接入

- UE 工作区可以添加和移除 `.uproject` 工程；项目库存在 LoliCode 的应用设置中，不改动项目文件。
- 引擎发现读取 `UE_ROOT`、Epic Launcher 安装清单和常见安装目录。版本关联精确匹配版本或本机 BuildId；指定的关联没有对应引擎时拒绝启动，只有工程没有关联时才使用最新发现版本，避免静默打开错误引擎。
- 可以从工作区启动已匹配的 Editor。Agent 工程仍使用项目目录；含多个 `.uproject` 的目录不会猜测其中一个作为桥接目标。
- 可选安装 UnrealAgentLink 到所选工程的 `Plugins/`，源码固定在 UE Box commit `ec65d7d1ae018944739d28cef18c78b4c53bca8f`。首次使用此工程对应引擎的 AutomationTool 编译插件；只有模块存在且 `UnrealEditor.modules` 的 BuildId 匹配此引擎，才标为就绪并启用。已有源码但无兼容模块的旧安装显示「修复并启用桥」。本地编译需要对应平台的 C++ 工具链；缺失时明确失败，不把复制源码当作安装成功。
- 源码下载会缓存在本机，避免重复下载。编译使用 `Intermediate/LoliCode/` 下的隔离副本，暂存目录不会被 UE 当作第二份插件扫描。已有插件修复只替换派生的 `Binaries`，保留用户源码、资源、描述文件和未知文件；失败回滚，无法回滚的现场保留。保留插件 MIT `LICENSE`，启用前备份 `.uproject.lolicode.bak`，工程文件以临时文件替换。
- Editor bridge 由 LoliCode 托管，仅监听 `127.0.0.1:17861`。从本页启动编辑器时生成一次性配对 token，10 分钟内有效，连接 URL 为 `ws://127.0.0.1:17861/?token=...`；直接双击工程使用上游默认端口，不会自动配对。插件 `project.info` 上报的是工程目录，LoliCode 将其解析为唯一 `.uproject` 后核对，并归一化 Windows 普通路径和 verbatim 前缀，成功后消费 token。没有有效配对、项目路径不一致或工程目录有多个 `.uproject` 时，不向 Agent 暴露 Editor 工具。
- 同一主 Agent 在匹配的 UE 工程且 Editor 已认证连接后才获得 `unreal_editor_command`。方法为 `system.get_project_info`、`system.get_editor_health`、`level.get_current`、`level.list`、`actor.get_info`、`actor.inspect`、`actor.spawn`、`actor.set_transform`、`actor.set_property`、`actor.destroy`、`level.save`、`level.open`、`level.new`、`blueprint.describe` 和 `blueprint.compile`。写操作遵守 Agent 已有权限确认；超出 allowlist 的 Python、控制台命令、退出 Editor 和插件管理不开放。

插件下载和解压设置压缩体积、展开体积、路径穿越、符号链接及文件长度检查。不会覆盖用户的插件源码；安装失败时回滚派生模块并保留原工程备份与必要的恢复现场。编译期间源码发生变化时拒绝安装过期编译结果。

## 来源与许可

UE Box 仓库本身只作产品能力与交互参考，未集成其桌面程序或 Apache-2.0 根目录代码。单独选择了其 `plugin/UnrealAgentLink` 子目录：来源为上述固定 commit，插件许可是 MIT，不同于仓库根许可。用户点安装时，LoliCode 下载固定提交的源码压缩包，只提取该插件目录并保留上游 `LICENSE`；桌面应用没有打包这份插件源码。连接服务、配对认证、项目校验、工具筛选和调用路由由 LoliCode 自己实现，没有将插件代码复制进应用源码。

- [UE Box pinned source](https://github.com/ueboxai/uebox/tree/ec65d7d1ae018944739d28cef18c78b4c53bca8f)
- [UnrealAgentLink setup guide](https://uebox.ai/guide/plugin)
- [UnrealAgentLink MIT license at pinned commit](https://github.com/ueboxai/uebox/blob/ec65d7d1ae018944739d28cef18c78b4c53bca8f/plugin/UnrealAgentLink/LICENSE)

## 尚未验收

Windows UE 5.8.3 的隔离工程已通过真实源码编译、BuildId 校验、工程启用与备份、重复安装不重编译、真实 Editor 配对及 `system.get_project_info` 读取。测试使用独立内存数据库与测试配置目录，不读写桌面用户工程和数据库。仍需覆盖其他引擎版本和平台、卸载、断线与超时，以及每类写命令的权限和回读。蓝图图表编辑、材质、UMG、资源浏览/索引/导入/迁移、构建打包、进程树取消、撤销和 macOS/Linux UE 矩阵均未接入；这些继续在功能清单标为未完成，不能用当前 allowlist 代表完整 UE Box 功能覆盖。
