import { useLayoutEffect } from "react";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";
import { applyInterfaceAppearance } from "@/lib/interfaceAppearance";

/** Portal menus and dialogs receive the same palette and decoration preference. */
export function InterfaceAppearanceRoot() {
  const { appearance } = useInterfaceAppearance();
  useLayoutEffect(() => applyInterfaceAppearance(appearance), [appearance]);
  return null;
}
