import {
  createContext,
  useContext,
  useEffect,
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
  const restore = () => (cache?.has(key) ? (cache.get(key) as T) : initial);
  const [state, setState] = useState(() => ({ key, value: restore() }));
  const current = state.key === key ? state : { key, value: restore() };
  if (state.key !== key) setState(current);
  useEffect(() => {
    cache?.set(key, current.value);
  }, [cache, key, current.value]);
  return [
    current.value,
    (update) =>
      setState((previous) => ({
        key,
        value:
          typeof update === "function"
            ? (update as (old: T) => T)(
                previous.key === key ? previous.value : restore(),
              )
            : update,
      })),
  ];
}
