import { createContext } from "react";

/** Portals must share the visibility of their retained page or conversation. */
export const ViewActivityContext = createContext(true);

/** Speculative views defer image loading and companion targets until selected. */
export const ViewPreparationContext = createContext(false);
