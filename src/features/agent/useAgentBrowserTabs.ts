import { useCallback, useEffect, useRef, useState } from "react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  agentFilesApi,
  type AgentBrowserPreviewState,
} from "@/lib/api/agent-files";
import { toast } from "@/lib/toast";
import { externalBrowserAddress } from "./agentBrowserAddress";
import {
  DOCK_BROWSER_STORAGE,
  dockOwnerSession,
  readDockStorage,
  writeDockStorage,
} from "./agentPreviewDock";

type BrowserTab = {
  id: number;
  sessionId: string;
  browserId?: string;
  url?: string;
  title?: string;
  loading?: boolean;
  error?: string;
  restoring?: boolean;
};

type BrowserDeck = {
  tabs: BrowserTab[];
};

type TabLease = {
  owner: string;
  sessionId: string;
  browserId?: string;
  pending: boolean;
  addressRevision?: number;
};

// Limit admitted and pending tabs together, matching the native guest budget.
const MAX_BROWSER_TABS = 12;

function readBrowserDecks(): Record<string, BrowserDeck> {
  const used = new Set<number>();
  const decks: Record<string, BrowserDeck> = {};
  for (const [owner, saved] of Object.entries(
    readDockStorage(DOCK_BROWSER_STORAGE),
  )) {
    const sessionId = dockOwnerSession(owner);
    if (!sessionId || !Array.isArray(saved)) continue;
    const tabs: BrowserTab[] = [];
    for (const value of saved) {
      if (used.size >= MAX_BROWSER_TABS) break;
      if (!value || typeof value !== "object") continue;
      const { id, url, title } = value as Partial<BrowserTab>;
      if (
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        used.has(id)
      )
        continue;
      const address =
        typeof url === "string" ? externalBrowserAddress(url)?.href : undefined;
      used.add(id);
      tabs.push({
        id,
        sessionId,
        url: address,
        title:
          address && typeof title === "string"
            ? title.slice(0, 512)
            : undefined,
        restoring: Boolean(address),
      });
    }
    if (tabs.length) decks[owner] = { tabs };
  }
  return decks;
}

function closeLease(lease: TabLease) {
  return lease.browserId
    ? agentFilesApi.closeBrowser(lease.sessionId, lease.browserId)
    : Promise.resolve();
}

export function useAgentBrowserTabs() {
  const [decks, setDecks] = useState(readBrowserDecks);
  const leases = useRef(new Map<number, TabLease>());
  const sequence = useRef(0);

  useEffect(() => {
    for (const [owner, deck] of Object.entries(decks)) {
      for (const tab of deck.tabs) {
        leases.current.set(tab.id, {
          owner,
          sessionId: tab.sessionId,
          pending: false,
        });
        sequence.current = Math.max(sequence.current, tab.id);
      }
    }
    const owned = leases.current;
    return () => {
      for (const lease of owned.values())
        void closeLease(lease).catch(() => {});
      owned.clear();
    };
    // Hydrate the stable tab identities on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    writeDockStorage(
      DOCK_BROWSER_STORAGE,
      Object.fromEntries(
        Object.entries(decks).map(([owner, deck]) => [
          owner,
          deck.tabs.map(({ id, url, title }) => ({
            id,
            url: (url && externalBrowserAddress(url)?.href) || undefined,
            title,
          })),
        ]),
      ),
    );
  }, [decks]);

  const updateTab = useCallback(
    (owner: string, id: number, patch: Partial<BrowserTab>) => {
      setDecks((all) => {
        const deck = all[owner];
        const tab = deck?.tabs.find((item) => item.id === id);
        if (
          !tab ||
          Object.entries(patch).every(
            ([key, value]) => tab[key as keyof BrowserTab] === value,
          )
        )
          return all;
        return {
          ...all,
          [owner]: {
            ...deck,
            tabs: deck.tabs.map((tab) =>
              tab.id === id ? { ...tab, ...patch } : tab,
            ),
          },
        };
      });
    },
    [],
  );

  const navigate = useCallback(
    async (id: number, url: string) => {
      const lease = leases.current.get(id);
      if (!lease || lease.pending) return false;
      lease.pending = true;
      updateTab(lease.owner, id, { loading: true, error: undefined });
      try {
        if (lease.browserId) {
          const revision = lease.addressRevision;
          await agentFilesApi.navigateBrowser(
            lease.sessionId,
            lease.browserId,
            { url },
          );
          if (lease.addressRevision === revision)
            updateTab(lease.owner, id, { url });
        } else {
          const page = await agentFilesApi.openBrowser(lease.sessionId, url);
          if (
            leases.current.get(id) !== lease ||
            page.sessionId !== lease.sessionId
          ) {
            await agentFilesApi.closeBrowser(page.sessionId, page.browserId);
            return false;
          }
          lease.browserId = page.browserId;
          updateTab(lease.owner, id, {
            browserId: page.browserId,
            url: page.url,
            restoring: false,
          });
        }
        return true;
      } catch (cause) {
        updateTab(lease.owner, id, { error: agentErrorMessage(cause) });
        return false;
      } finally {
        lease.pending = false;
        updateTab(lease.owner, id, { loading: false });
      }
    },
    [updateTab],
  );

  const open = useCallback(
    (owner: string, sessionId: string, url?: string) => {
      if (leases.current.size >= MAX_BROWSER_TABS) {
        toast.error("已达到浏览器标签上限，请先关闭一个标签。");
        return;
      }
      if (sequence.current >= Number.MAX_SAFE_INTEGER) sequence.current = 0;
      while (leases.current.has(++sequence.current)) {
        // Keep the identifiers distinct even after recovering a maximum saved ID.
      }
      const id = sequence.current;
      leases.current.set(id, { owner, sessionId, pending: false });
      setDecks((all) => ({
        ...all,
        [owner]: {
          tabs: [...(all[owner]?.tabs ?? []), { id, sessionId, url }],
        },
      }));
      if (url) void navigate(id, url);
      return id;
    },
    [navigate],
  );

  const close = useCallback((id: number, released = false) => {
    const lease = leases.current.get(id);
    if (!lease) return;
    leases.current.delete(id);
    setDecks((all) => {
      const deck = all[lease.owner];
      if (!deck) return all;
      const tabs = deck.tabs.filter((tab) => tab.id !== id);
      if (tabs.length) return { ...all, [lease.owner]: { tabs } };
      const next = { ...all };
      delete next[lease.owner];
      return next;
    });
    if (!released)
      void closeLease(lease).catch((cause) =>
        toast.error(agentErrorMessage(cause)),
      );
  }, []);

  const removeOwners = useCallback(
    (matches: (owner: string) => boolean) => {
      for (const [id, lease] of leases.current) {
        if (matches(lease.owner)) close(id);
      }
    },
    [close],
  );

  const onClosed = useCallback(
    (sessionId: string, browserId: string) => {
      for (const [id, lease] of leases.current) {
        if (lease.sessionId === sessionId && lease.browserId === browserId) {
          close(id, true);
          return { id, owner: lease.owner };
        }
      }
    },
    [close],
  );

  useTauriEvent<AgentBrowserPreviewState>(
    "agent-browser-preview-state",
    (state) => {
      for (const [id, lease] of leases.current) {
        if (
          lease.sessionId === state.sessionId &&
          lease.browserId === state.browserId
        ) {
          const url = externalBrowserAddress(state.url)?.href;
          if (url) lease.addressRevision = (lease.addressRevision ?? 0) + 1;
          updateTab(lease.owner, id, {
            ...(url ? { url } : {}),
            title: state.title,
          });
          break;
        }
      }
    },
  );

  return { decks, open, navigate, close, removeOwners, onClosed };
}
