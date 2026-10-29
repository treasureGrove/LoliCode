import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  BookHeart,
  Boxes,
  ChartNoAxesCombined,
  Gift,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { AppPageHeader } from "@/app/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  builtinAppsApi,
  BUILTIN_APP_IDS,
  builtinAppsKey,
  useBuiltinApps,
  type BuiltinAppId,
} from "@/lib/api/builtin-apps";
import { toast } from "@/lib/toast";

export function BuiltinApplicationsPage({
  onOpen,
}: {
  onOpen: (id: BuiltinAppId) => void;
}) {
  const { t } = useTranslation();
  const apps = useBuiltinApps();
  const client = useQueryClient();
  const [pending, setPending] = useState<BuiltinAppId | null>(null);
  const toggle = async (id: BuiltinAppId, enabled: boolean) => {
    setPending(id);
    try {
      await builtinAppsApi.setEnabled(id, enabled);
      await client.invalidateQueries({ queryKey: builtinAppsKey });
    } catch (error) {
      toast.error(t("applications.changeFailed"), {
        description: String(error),
      });
    } finally {
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
        className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
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
        <div className="mx-auto grid max-w-4xl gap-5 md:grid-cols-2">
          {BUILTIN_APP_IDS.map((id) => {
            const enabled =
              apps.data?.find((item) => item.id === id)?.enabled === true;
            const Icon = {
              tavern: BookHeart,
              unreal: Boxes,
              rankings: ChartNoAxesCombined,
              "free-ai": Gift,
            }[id];
            return (
              <article
                key={id}
                className="flex flex-col gap-4 rounded-2xl border border-border bg-surface/90 p-6 shadow-sm"
              >
                <Icon className="h-8 w-8 text-action-text" />
                <h2 className="text-lg font-semibold">
                  {t(`applications.${id}.title`)}
                </h2>
                <p className="flex-1 text-sm leading-relaxed text-fg-2">
                  {t(`applications.${id}.description`)}
                </p>
                <div className="flex items-center gap-2">
                  {enabled ? (
                    <>
                      <Button onClick={() => onOpen(id)}>
                        {t("applications.open")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() => void toggle(id, false)}
                      >
                        {t("applications.remove")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={!apps.data || pending !== null}
                      onClick={() => void toggle(id, true)}
                    >
                      <Plus className="h-4 w-4" />
                      {t("applications.add")}
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
        <p className="mx-auto mt-6 max-w-4xl text-sm text-fg-3">
          {t("applications.retained")}
        </p>
      </div>
    </>
  );
}
