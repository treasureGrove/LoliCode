import { useMemo, useSyncExternalStore } from "react";
import {
  parseInterfaceAppearance,
  readInterfaceAppearanceSnapshot,
  saveInterfaceAppearance,
  subscribeInterfaceAppearance,
} from "@/lib/interfaceAppearance";

export function useInterfaceAppearance() {
  const raw = useSyncExternalStore(
    subscribeInterfaceAppearance,
    readInterfaceAppearanceSnapshot,
    () => "",
  );
  const appearance = useMemo(() => parseInterfaceAppearance(raw), [raw]);
  return { appearance, setAppearance: saveInterfaceAppearance };
}
