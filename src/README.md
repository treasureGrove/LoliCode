# 桌面界面

这里是 React/TypeScript 桌面界面，构建配置在仓库根目录。返回[总架构入口](../ARCHITECTURE.md)。

## 从入口读起

`main.tsx` → `app/bootstrap.tsx` → `app/AppProviders.tsx` → `app/App.tsx`。

- `app/`：启动恢复、Provider 组合、页面装配；`app/shell/` 是侧栏、窗口与全局浮层。
- `features/`：按业务分组的页面与专用组件，例如 `agent/`、`channels/`、`settings/`、`usage/`、`discovery/`、`tavern/`、`unreal/`。
- `components/`：共用编辑器、对话框、图标、主题组件；`ui/` 是基础控件，`common/` 与 `motion/` 提供共用交互。
- `lib/api/`：原生调用接口；`lib/query/`：查询缓存与数据加载；其他 `lib/` 模块提供共享能力。
- `hooks/`、`contexts/`：共享 Hook 与上下文。业务专用状态优先留在对应业务目录。
- `types/`、`types.ts`、`config/`、`utils/`：类型、配置与通用工具。
- `styles/`、`index.css`、`assets/`、`public/`：共享样式、素材与静态资源。
- `i18n/`：语言初始化与翻译；`whats-new/`：应用内更新摘要。

源码引用使用 `@/`，指向本目录。新增功能先放到对应 `features/<业务>/`；跨业务复用成立后，再提取共享组件。入口负责组合，避免直接承载具体业务实现。

在仓库根目录运行 `pnpm dev:renderer`、`pnpm typecheck`、`pnpm test:unit` 和 `pnpm build:renderer`。前端测试位于根目录 `tests/`，其中 `integration/` 覆盖应用装配。
