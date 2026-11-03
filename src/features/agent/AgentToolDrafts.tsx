import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Drafts live only for the mounted workspace, without writing a second copy to disk. */
export const AgentToolDraftsContext = createContext<Map<
  string,
  unknown
> | null>(null);

export function useAgentToolDraft<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(AgentToolDraftsContext);
  const local = useRef(new Map<string, unknown>());
  const defaults = useRef(new Map<string, T>());
  if (!defaults.current.has(key)) defaults.current.set(key, initial);
  const source = cache ?? local.current;
  const value = source.has(key)
    ? (source.get(key) as T)
    : defaults.current.get(key)!;
  const [, refresh] = useState(0);
  const active = useRef({ source, key, mounted: true });
  active.current.source = source;
  active.current.key = key;
  useEffect(() => {
    active.current.mounted = true;
    return () => {
      active.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!source.has(key)) source.set(key, value);
  }, [source, key, value]);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (change) => {
      const previous = source.has(key)
        ? (source.get(key) as T)
        : defaults.current.get(key)!;
      const next =
        typeof change === "function"
          ? (change as (old: T) => T)(previous)
          : change;
      if (source.has(key) && Object.is(previous, next)) return;
      // A save can finish after changing tools or projects. Commit to its
      // original cache immediately; a React effect may never run after unmount.
      source.set(key, next);
      if (
        active.current.mounted &&
        active.current.source === source &&
        active.current.key === key
      )
        refresh((revision) => revision + 1);
    },
    [source, key],
  );
  return [value, update];
}
