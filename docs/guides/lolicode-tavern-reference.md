# 酒馆主参考：SillyTavern

核查日期：2026-10-15。

决定：以 **SillyTavern 作为酒馆应用的主要功能标杆和源码研究对象**，RisuAI 补充参考角色表现与长对话记忆。这是针对 LoliCode 需求的工程选择，不是对所有酒馆产品的绝对排名，也不表示已集成这些功能或采用其源码。

实施顺序仍为主 Agent 与交互 → UE、酒馆两个内置应用 → 第一期验收。酒馆按需添加，有自己的角色库、剧情数据与业务页面，并向唯一主 Agent 提供领域工具。

## 为什么选它

SillyTavern 的角色、Persona、世界书、提示编排、群聊、采样与扩展能力适合做完整功能清单。我们需要把这些可组合的能力放入自己的 Agent 产品，长期逐项补齐，而不只做一个角色提示词加聊天框。[官方使用指南](https://docs.sillytavern.app/usage/)

世界书已有丰富的触发、优先级、预算与递归规则；提示管理器和群聊又分别提供提示位置与发言策略。这些可观察规则比单纯复制聊天外观更适合作为回归基准。[世界书](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)、[提示管理器](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[群聊](https://docs.sillytavern.app/usage/core-concepts/groupchats/)

源码核查也发现，`world-info.js`、`PromptManager.js` 和 `group-chats.js` 直接依赖上游界面、全局状态与其他脚本。选中主参考不等于它已经是可直接插入我们项目的独立 SDK。实际复用时按领域行为、数据和依赖边界拆解，避免把整套 UI 和服务搬进来。

默认体验继续追求简单：复用已配置模型，选择角色即可开始。世界书策略、提示顺序、采样、规则与诊断按需展开；高级能力逐步实现并验收，不因首次界面简化而从路线图删除。

## 比较过的候选

- **SillyTavern：主参考。** 固定为 `SillyTavern/SillyTavern@06bde939fb1e9c4c8d8641d810f0a916b5bce127`，观察到根许可 AGPL-3.0。角色扮演、上下文控制与扩展功能覆盖符合本项目需求。[固定版本说明](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/.github/readme.md)、[许可](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/LICENSE)
- **RisuAI：补充参考。** 固定为 `kwaroran/RisuAI@454e5e207747399f43a4788f5f08ecd5aa291550`，观察到根许可 GPL-3.0。官方列出表情图、聊天素材、提示策略和 HypaMemory/SupaMemory；后续研究其体验与记忆质量，不预先认定比共享记忆服务更合适。[功能说明](https://github.com/kwaroran/RisuAI/blob/454e5e207747399f43a4788f5f08ecd5aa291550/README.md)、[许可](https://github.com/kwaroran/RisuAI/blob/454e5e207747399f43a4788f5f08ecd5aa291550/LICENSE)
- **Agnaistic：本轮不选为主参考。** 核查 `agnaistic/agnai@fccee00f5f7628d150760c787c4be87e6b1a652c`，观察到根许可 AGPL-3.0。其多人、多机器人和多租户能力适合协作服务；这些不是当前本机单主 Agent 的优先需求。MongoDB、Redis 是可选项，不能以“必须部署数据库”作为排除理由。[功能说明](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/README.md)、[许可](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/LICENSE.md)

## 源码研究入口与接入边界

以下路径均相对于上述固定的 SillyTavern 提交，是研究入口，不是已纳入本项目的文件清单。

1. **角色卡与 Persona。** `src/character-card-parser.js`、`src/endpoints/characters.js`、`public/scripts/personas.js`。先明确 JSON、PNG 元数据及选定卡片版本的字段与迁移；保留导入原件、未知字段和扩展字段。素材与脚本只作为数据导入，不能把卡片内容自动当成可执行程序。
2. **世界书。** `public/scripts/world-info.js`、`src/endpoints/worldinfo.js`。建立条目与作用域、触发条件、排序、预算和插入位置的领域模型；上下文预览应能说明哪些条目被加入、哪些被排除及原因。
3. **提示与模型参数。** `public/scripts/PromptManager.js`、`public/scripts/openai.js`、`public/scripts/textgen-settings.js`。角色、用户身份、世界信息、历史与本轮输入通过酒馆策略组装；共享模型服务拥有渠道与凭据，保持选定协议的原生参数与内容块。
4. **对话、群聊与分支。** `public/scripts/chats.js`、`public/scripts/group-chats.js`。酒馆拥有剧情消息、发言者、轮次、重生成候选和分支；流式生成、取消、保存、重启恢复必须成套验证。群聊角色不成为额外的通用主 Agent。
5. **规则与自动化。** `public/scripts/extensions/regex/engine.js`、`public/scripts/slash-commands/SlashCommandParser.js`。先列出所需的输入、输出转换及自动化行为，再提供本项目的规则或工具接口。不能从支持正则推断支持任意 STscript、扩展或 DOM 插件。[上游扩展接口](https://docs.sillytavern.app/for-contributors/writing-extensions/)
6. **检索与长对话。** `public/scripts/extensions/vectors/index.js`，补充研究 RisuAI 的 `src/ts/process/memory/hypav3.ts`。保留原始剧情与摘要来源，角色、故事分支和项目记忆分别隔离；不把虚构设定写成全局用户事实。
7. **多媒体与表现。** `public/scripts/extensions/tts/index.js`、`public/scripts/extensions/stable-diffusion/index.js`。后续复用自己的声音、图像与角色表现服务，核查素材、模型和音色许可；酒馆能力与未来 Pet、语音协同，避免各自重复管理模型账户。[扩展说明](https://docs.sillytavern.app/extensions/)

文件之间的传递依赖、嵌套许可、实际格式和错误语义仍需随具体实现继续核查；根仓库许可不能替代逐文件记录。

## 第一条可验收链路

先完成一个可保存与恢复的角色故事，不等待全部扩展功能到齐：

1. 在“我的应用”添加内置酒馆，沿用已有模型渠道，检查所需模型能力。
2. 导入选定版本的角色卡，展示可识别字段、未支持能力及保留的扩展信息；损坏文件不覆盖已有角色。
3. 按明确支持的世界书规则组装上下文，预览角色、用户身份、世界条目与历史的顺序和预算。
4. 发起真实模型生成，支持取消和明确失败；保存故事、角色版本、有效配置与生成状态。
5. 重启后恢复故事；重新生成保留已有候选，切换分支不污染其他分支的数据。
6. 主 Agent 可以通过酒馆工具查询角色、创建或定位故事、编辑已支持设定、打开业务产物；工具执行仍进入统一权限、状态和取消流程。

当前未实现上述闭环。卡片版本、PNG/JSON 变体、世界书规则、采样字段和重生成语义须以实际实现清单声明；不能用“兼容酒馆”代替具体兼容范围。之后继续补齐群聊、复杂触发、脚本业务能力、检索、长对话记忆和多媒体，不把本轮最小闭环宣称为功能对等。

## 代码与许可记录

产品许可仍按用户此前选择保持未定。当前决定的是主参考与功能范围，没有把 SillyTavern、RisuAI 源码作为新代码合入产品。

直接复制、抽取或改编选定源码时，必须记录仓库、固定提交、文件、改动、依赖、许可和发布影响；涉及 AGPL/GPL 的源码组合与分发应结合具体边界评估对应源码等义务。换名字、改语言、加适配层或单独开进程，都不能自动推出原许可不再适用。需要影响产品许可路线的直接源码采用时，再对齐具体方案，而不是反复询问一般研究操作。

功能、公开格式与行为的自主实现，以及明确满足许可条件的组件复用，都是候选实施路径。角色卡、预设、图片、声音和第三方扩展另有来源与许可，不能因主仓库开源就一并默认采用。

本决定同步到[架构](lolicode-platform-architecture.md)、[第一期计划](lolicode-phase-one-plan.md)及[能力与来源清单](lolicode-platform-capabilities.json)。所有功能仍按真实数据往返、执行与恢复证据验收。
