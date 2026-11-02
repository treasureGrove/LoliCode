import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  BookHeart,
  ArrowUpRight,
  Boxes,
  ChartNoAxesCombined,
  Gift,
  LoaderCircle,
  Check,
  Power,
} from "lucide-react";
import { AppPageHeader } from "@/app/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  builtinAppsApi,
  BUILTIN_APP_IDS,
  builtinAppsKey,
  useBuiltinApps,
  type BuiltinAppId,
  type BuiltinAppState,
} from "@/lib/api/builtin-apps";
import { toast } from "@/lib/toast";
import "./builtin-applications.css";

const APP_ICONS = {
  tavern: BookHeart,
  unreal: Boxes,
  rankings: ChartNoAxesCombined,
  "free-ai": Gift,
};

export function BuiltinApplicationsPage({
  onOpen,
}: {
  onOpen: (id: BuiltinAppId) => void;
}) {
  const { t } = useTranslation();
  const apps = useBuiltinApps();
  const client = useQueryClient();
  const [pending, setPending] = useState<BuiltinAppId | null>(null);
  const mutation = useRef(false);
  const toggle = async (
    id: BuiltinAppId,
    enabled: boolean,
    openAfter = false,
  ) => {
    if (mutation.current) return;
    mutation.current = true;
    setPending(id);
    try {
      await builtinAppsApi.setEnabled(id, enabled);
      await client.cancelQueries({ queryKey: builtinAppsKey });
      client.setQueryData<BuiltinAppState[]>(builtinAppsKey, (current) => {
        const next = current ?? [];
        return next.some((app) => app.id === id)
          ? next.map((app) => (app.id === id ? { ...app, enabled } : app))
          : [...next, { id, enabled }];
      });
      void client.invalidateQueries({ queryKey: builtinAppsKey });
      if (openAfter) onOpen(id);
    } catch (error) {
      toast.error(t("applications.changeFailed"), {
        description: String(error),
      });
    } finally {
      mutation.current = false;
      setPending(null);
    }
  };
  return (
    <>
      <AppPageHeader
        title={t("applications.title")}
        subtitle={t("applications.subtitle")}
      />
      <div
        id="main-content"
        className="builtin-apps-content min-h-0 flex-1 overflow-y-auto"
      >
        {apps.isPending && (
          <LoaderCircle
            className="animate-spin"
            aria-label={t("applications.loading")}
          />
        )}
        {apps.isError && (
          <div role="alert" className="text-danger">
            {t("applications.loadFailed")}{" "}
            <Button variant="link" onClick={() => void apps.refetch()}>
              {t("applications.retry")}
            </Button>
          </div>
        )}
        <div className="builtin-apps-library">
          <div className="builtin-apps-heading">
            <h2>{t("applications.libraryTitle")}</h2>
            <span>
              {t("applications.appCount", { count: BUILTIN_APP_IDS.length })}
            </span>
          </div>
          <div className="builtin-apps-grid">
            {BUILTIN_APP_IDS.map((id) => {
              const enabled =
                apps.data?.find((item) => item.id === id)?.enabled === true;
              const Icon = APP_ICONS[id];
              return (
                <article
                  key={id}
                  className="builtin-app-card"
                  data-app={id}
                  aria-labelledby={`builtin-app-${id}`}
                >
                  <div className="builtin-app-card-top">
                    <span className="builtin-app-icon" aria-hidden="true">
                      <Icon />
                    </span>
                    {apps.data && (
                      <span
                        className="builtin-app-status"
                        data-enabled={enabled}
                      >
                        {enabled && <Check size={12} aria-hidden="true" />}
                        {t(
                          enabled
                            ? "applications.enabled"
                            : "applications.available",
                        )}
                      </span>
                    )}
                  </div>
                  <h3 id={`builtin-app-${id}`}>
                    {t(`applications.${id}.title`)}
                  </h3>
                  <p className="builtin-app-description">
                    {t(`applications.${id}.description`)}
                  </p>
                  <div className="builtin-app-actions">
                    {enabled ? (
                      <>
                        <Button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => onOpen(id)}
                        >
                          {t("applications.open")}
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={pending !== null}
                          onClick={() => void toggle(id, false)}
                        >
                          {t("applications.remove")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!apps.data || pending !== null}
                        onClick={() => void toggle(id, true, true)}
                      >
                        <Power size={14} aria-hidden="true" />
                        {t("applications.enableAndOpen")}
                      </Button>
                    )}
                    {pending === id && (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin"
                        aria-label={t("applications.saving")}
                      />
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="builtin-apps-note">{t("applications.retained")}</p>
        </div>
      </div>
    </>
  );
}
