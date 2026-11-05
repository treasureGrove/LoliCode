/**
 * Right-sidebar layout adapted from DeepSeek Harness's ui-dockkit
 * focusTab/moveTab/split/resize operations and ui-sidebar-right persistence.
 * Resources are owned by their tab controllers, never by a dock position.
 */
export type DockAuxiliaryTab = "files" | "terminal";
export type DockTab = "preview" | DockAuxiliaryTab | `browser:${number}`;
export type DockPane = { tabs: DockTab[]; active?: DockTab };
export type DockLayout = {
  panes: [DockPane] | [DockPane, DockPane];
  focused: 0 | 1;
  folded: boolean;
  ratio: number;
};

export const DOCK_LAYOUT_STORAGE = "lolicode.agent.rightDock.v1";
export const DOCK_FILE_STORAGE = "lolicode.agent.rightDockFiles.v1";
export const DOCK_BROWSER_STORAGE = "lolicode.agent.rightDockBrowser.v1";
export const DOCK_DIVIDER_WIDTH = 8;
export const DOCK_PANE_MIN_WIDTH = 176;

export const browserDockTab = (id: number): DockTab => `browser:${id}`;

export function dockOwnerSession(owner: string): string | undefined {
  const [project, session, extra] = owner.split("\0");
  return project && session && extra === undefined ? session : undefined;
}

export function readDockStorage(key: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Object.fromEntries(
        Object.entries(data).filter(([owner]) => dockOwnerSession(owner)),
      );
    }
  } catch {
    // The sidebar is still usable when storage is disabled or invalid.
  }
  return {};
}

export function writeDockStorage(key: string, value: object) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Keep the live workspace even when the browser rejects a write.
  }
}

export function emptyDockLayout(): DockLayout {
  return { panes: [{ tabs: [] }], focused: 0, folded: false, ratio: 0.5 };
}

function isDockTab(value: unknown): value is DockTab {
  return (
    typeof value === "string" &&
    (value === "preview" ||
      value === "files" ||
      value === "terminal" ||
      (/^browser:[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value.slice(8)))))
  );
}

function savedLayout(value: unknown): DockLayout | undefined {
  if (!value || typeof value !== "object") return;
  const layout = value as Partial<DockLayout>;
  if (
    !Array.isArray(layout.panes) ||
    ![1, 2].includes(layout.panes.length) ||
    (layout.focused !== 0 && layout.focused !== 1) ||
    layout.focused >= layout.panes.length ||
    typeof layout.folded !== "boolean" ||
    typeof layout.ratio !== "number" ||
    !Number.isFinite(layout.ratio) ||
    layout.ratio < 0.1 ||
    layout.ratio > 0.9
  )
    return;
  const used = new Set<DockTab>();
  for (const pane of layout.panes) {
    if (
      !pane ||
      !Array.isArray(pane.tabs) ||
      pane.tabs.some((tab: unknown) => {
        if (!isDockTab(tab) || used.has(tab)) return true;
        used.add(tab);
        return false;
      }) ||
      (pane.tabs.length
        ? !pane.tabs.includes(pane.active!)
        : pane.active !== undefined)
    )
      return;
  }
  return {
    panes: layout.panes,
    focused: layout.focused,
    folded: layout.folded,
    ratio: layout.ratio,
  };
}

export function readDockLayouts(): Record<string, DockLayout> {
  return Object.fromEntries(
    Object.entries(readDockStorage(DOCK_LAYOUT_STORAGE)).flatMap(
      ([owner, value]) => {
        const layout = savedLayout(value);
        return layout ? [[owner, layout]] : [];
      },
    ),
  );
}

export function activateDockTab(
  layout: DockLayout,
  tab: DockTab,
  pane = layout.focused,
  focus = true,
): DockLayout {
  const existing = layout.panes.findIndex((item) => item.tabs.includes(tab));
  const index = existing === 0 || existing === 1 ? existing : pane;
  const target = layout.panes[index];
  if (
    !target ||
    (existing !== -1 && !focus) ||
    (target.active === tab && layout.focused === index && !layout.folded)
  )
    return layout;
  const panes = [...layout.panes] as DockLayout["panes"];
  panes[index] = {
    tabs: existing === -1 ? [...target.tabs, tab] : target.tabs,
    active: focus ? tab : (target.active ?? tab),
  };
  return {
    ...layout,
    panes,
    focused: focus ? index : layout.focused,
    folded: focus ? false : layout.folded,
  };
}

export function closeDockTab(layout: DockLayout, tab: DockTab): DockLayout {
  const index = layout.panes.findIndex((pane) => pane.tabs.includes(tab));
  if (index !== 0 && index !== 1) return layout;
  const pane = layout.panes[index]!;
  const position = pane.tabs.indexOf(tab);
  const tabs = pane.tabs.filter((item) => item !== tab);
  const panes = [...layout.panes] as DockLayout["panes"];
  panes[index] = {
    tabs,
    active: pane.active === tab ? (tabs[position] ?? tabs.at(-1)) : pane.active,
  };
  return { ...layout, panes };
}

export function moveDockTab(
  layout: DockLayout,
  tab: DockTab,
  to: 0 | 1,
): DockLayout {
  const from = layout.panes.findIndex((pane) => pane.tabs.includes(tab));
  if (layout.panes.length !== 2 || from === -1 || from === to) return layout;
  return activateDockTab(closeDockTab(layout, tab), tab, to);
}

export function splitPreviewDock(layout: DockLayout): DockLayout {
  return layout.panes.length === 1 && layout.panes[0].tabs.length
    ? {
        ...layout,
        panes: [layout.panes[0], { tabs: [] }],
        focused: 1,
        ratio: 0.5,
      }
    : layout;
}

export function mergePreviewDock(layout: DockLayout): DockLayout {
  if (layout.panes.length === 1) return layout;
  const [left, right] = layout.panes;
  return {
    ...layout,
    panes: [
      {
        tabs: [...left.tabs, ...right.tabs],
        active:
          layout.panes[layout.focused].active ?? left.active ?? right.active,
      },
    ],
    focused: 0,
  };
}

/** Expired live-only previews cannot leave a phantom selection after restart. */
export function pruneDockTabs(
  layout: DockLayout,
  available: readonly DockTab[],
): DockLayout {
  let next = layout;
  for (const pane of layout.panes)
    for (const tab of pane.tabs)
      if (!available.includes(tab)) next = closeDockTab(next, tab);
  for (const tab of available) next = activateDockTab(next, tab, 0, false);
  return next;
}

export type DockFile = { path: string; line?: number };

export function readDockFiles(): Record<string, DockFile> {
  return Object.fromEntries(
    Object.entries(readDockStorage(DOCK_FILE_STORAGE)).flatMap(
      ([owner, value]) => {
        if (!value || typeof value !== "object") return [];
        const { path, line } = value as Partial<DockFile>;
        if (typeof path !== "string" || !path.trim() || path.includes("\0"))
          return [];
        return [
          [
            owner,
            {
              path,
              line: Number.isSafeInteger(line) && line! > 0 ? line : undefined,
            },
          ],
        ];
      },
    ),
  );
}
