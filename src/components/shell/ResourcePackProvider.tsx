import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  resourcePackKey,
  resourceUpdatesApi,
  type ResourcePack,
} from "@/lib/api/resource-updates";

const ResourceContext = createContext<ResourcePack["assets"]>({});
export const useResourceImage = (
  slot: keyof ResourcePack["assets"],
  fallback: string,
) => useContext(ResourceContext)[slot] ?? fallback;
const cssSlots = {
  scene: "--atelier-scene",
  sidebar: "--atelier-sidebar",
  brooch: "--atelier-brooch",
} as const;

export async function decodeResourceImages(assets: ResourcePack["assets"]) {
  await Promise.all(
    Object.values(assets).map(async (src) => {
      if (!src?.startsWith("data:image/png;base64,"))
        throw new Error("Invalid local resource image");
      const image = new Image();
      image.src = src;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight)
        throw new Error("Empty resource image");
    }),
  );
}

/** Bundled images remain the first paint and the offline fallback. No HTTP here. */
export function ResourcePackProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: resourcePackKey,
    queryFn: resourceUpdatesApi.local,
    retry: false,
    staleTime: Infinity,
  });
  const client = useQueryClient();
  const [assets, setAssets] = useState<ResourcePack["assets"]>({});
  const applying = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let current = true;
    const pack = query.data;
    if (!pack) return;
    const apply = async () => {
      // StrictMode remounts must not race activation receipts or rollback.
      if (applying.current) await applying.current;
      if (!current) return;
      if (!pack.id) {
        setAssets({});
        return;
      }
      try {
        await decodeResourceImages(pack.assets);
        if (!current) return;
        if (pack.pendingConfirmation) await resourceUpdatesApi.confirm(pack.id);
        if (!current) return;
        setAssets(pack.assets);
        if (pack.pendingConfirmation)
          client.setQueryData<ResourcePack>(resourcePackKey, {
            ...pack,
            pendingConfirmation: false,
          });
      } catch {
        if (!current) return;
        // A decode/confirmation failure cannot replace the bundled fallback.
        setAssets({});
        try {
          const previous = await resourceUpdatesApi.rollback(pack.id);
          if (current) client.setQueryData(resourcePackKey, previous);
        } catch {
          /* Already changed or inaccessible; keep the bundled images. */
        }
      }
    };
    const operation = apply();
    applying.current = operation;
    void operation.finally(() => {
      if (applying.current === operation) applying.current = null;
    });
    return () => {
      current = false;
    };
  }, [query.data, client]);

  useEffect(() => {
    for (const [slot, variable] of Object.entries(cssSlots)) {
      const src = assets[slot as keyof typeof cssSlots];
      if (src)
        document.documentElement.style.setProperty(variable, `url("${src}")`);
      else document.documentElement.style.removeProperty(variable);
    }
    return () => {
      for (const variable of Object.values(cssSlots))
        document.documentElement.style.removeProperty(variable);
    };
  }, [assets]);

  return (
    <ResourceContext.Provider value={assets}>
      {children}
    </ResourceContext.Provider>
  );
}
