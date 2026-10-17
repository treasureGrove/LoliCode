import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Bot,
  Boxes,
  CheckCircle2,
  CircleHelp,
  Cpu,
  FolderOpen,
  Gamepad2,
  LoaderCircle,
  Play,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api/agent";
import { unrealApi, type UnrealProject } from "@/lib/api/unreal";
import { toast } from "@/lib/toast";

const QUERY_KEY = ["unreal", "snapshot"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return navigator.platform.toLowerCase().includes("win")
    ? normalized.toLowerCase()
    : normalized;
}

function projectDirectory(project: UnrealProject): string {
  return project.path.replace(/[\\/][^\\/]+$/, "");
}

function engineForProject(
  project: UnrealProject,
  engines: Array<{
    version: string;
    associationId?: string | null;
  }>,
) {
  const association = project.engineAssociation;
  if (!association) return engines[0];
  const matched = engines.find(
    (engine) =>
      engine.associationId === association ||
      engine.version === association ||
      engine.version.startsWith(`${association}.`),
  );
  if (matched) return matched;
  return undefined;
}

export function UnrealPage({
  onOpenChannels,
  onOpenAgentProject,
}: {
  onOpenChannels: () => void;
  onOpenAgentProject: (path: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const snapshot = useQuery({
    queryKey: QUERY_KEY,
    queryFn: unrealApi.snapshot,
    refetchInterval: 3500,
    retry: false,
  });
  const projects = snapshot.data?.projects ?? [];
  const engines = snapshot.data?.engines ?? [];
  const bridge = snapshot.data?.bridge;
  const connectedProjects = useMemo(
    () =>
      new Set(
        (bridge?.editors ?? []).map((editor) =>
          normalizePath(editor.projectPath),
        ),
      ),
    [bridge?.editors],
  );

  const importProject = async () => {
    setAdding(true);
    try {
      const path = await open({
        multiple: false,
        title: t("unreal.chooseProject"),
        filters: [{ name: "Unreal Project", extensions: ["uproject"] }],
      });
      if (typeof path !== "string") return;
      const added = await unrealApi.addProject(path);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t("unreal.projectAdded", { name: added.name }));
    } catch (error) {
      toast.error(t("unreal.addFailed"), { description: errorMessage(error) });
    } finally {
      setAdding(false);
    }
  };

  const launch = async (project: UnrealProject) => {
    setBusyProject(project.id);
    try {
      await unrealApi.launchProject(project.id);
      toast.success(t("unreal.launchStarted", { name: project.name }));
      window.setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        2500,
      );
    } catch (error) {
      toast.error(t("unreal.launchFailed"), {
        description: errorMessage(error),
      });
    } finally {
      setBusyProject(null);
    }
  };

  const installBridge = async (project: UnrealProject) => {
    setBusyProject(project.id);
    try {
      const updated = await unrealApi.installAgentLink(project.id);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t("unreal.pluginInstalled", { name: updated.name }), {
        description: t("unreal.restartEditor"),
        duration: 9000,
      });
    } catch (error) {
      toast.error(t("unreal.pluginInstallFailed"), {
        description: errorMessage(error),
        duration: 10000,
      });
    } finally {
      setBusyProject(null);
    }
  };

  const removeProject = async (project: UnrealProject) => {
    try {
      await unrealApi.removeProject(project.id);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(t("unreal.projectRemoved", { name: project.name }));
    } catch (error) {
      toast.error(t("unreal.removeFailed"), {
        description: errorMessage(error),
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Boxes className="h-5 w-5" />}
        title={t("unreal.title")}
        subtitle={t("unreal.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void snapshot.refetch()}
              disabled={snapshot.isFetching}
            >
              {snapshot.isFetching ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("unreal.refresh")}
            </Button>
            <Button
              size="sm"
              onClick={() => void importProject()}
              disabled={adding}
            >
              {adding ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("unreal.addProject")}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable p-4 lg:p-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          <section className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border bg-surface/90 p-4 shadow-v7-sm">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Cpu className="h-4 w-4 text-action-text" />
                {t("unreal.engines")}
              </div>
              <p className="mt-2 text-2xl font-semibold">{engines.length}</p>
              <p className="mt-1 text-xs leading-5 text-fg-3">
                {t("unreal.engineHint")}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/90 p-4 shadow-v7-sm">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {bridge?.listening && !bridge.error ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-warning" />
                )}
                {t("unreal.editorBridge")}
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {bridge?.editors.length ?? 0}
                <span className="ml-2 text-sm font-normal text-fg-3">
                  {t("unreal.connectedEditors")}
                </span>
              </p>
              <p className="mt-1 truncate text-xs leading-5 text-fg-3">
                {bridge?.error ||
                  t("unreal.bridgeHint", { port: bridge?.port ?? 17861 })}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/90 p-4 shadow-v7-sm">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Bot className="h-4 w-4 text-action-text" />
                {t("unreal.mainAgent")}
              </div>
              <p className="mt-2 text-sm leading-6 text-fg-2">
                {t("unreal.mainAgentHint")}
              </p>
            </div>
          </section>

          {snapshot.isError && (
            <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-fg-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div>
                <p className="font-semibold">{t("unreal.loadFailed")}</p>
                <p className="mt-1 break-words text-xs text-fg-3">
                  {errorMessage(snapshot.error)}
                </p>
              </div>
            </div>
          )}

          <section className="overflow-hidden rounded-2xl border border-border bg-surface/90 shadow-v7-sm">
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold">
                  {t("unreal.projectLibrary")}
                </h2>
                <p className="mt-1 text-xs text-fg-3">
                  {t("unreal.projectLibraryHint")}
                </p>
              </div>
              <span className="shrink-0 text-xs text-fg-3">
                {t("unreal.projectCount", { count: projects.length })}
              </span>
            </div>
            {snapshot.isLoading ? (
              <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-fg-3">
                <LoaderCircle className="h-4 w-4 animate-spin" />{" "}
                {t("unreal.loading")}
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-14 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-subtle text-action-text">
                  <Gamepad2 className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-sm font-semibold">
                  {t("unreal.emptyTitle")}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-fg-3">
                  {t("unreal.emptyHint")}
                </p>
                <Button
                  className="mt-5"
                  onClick={() => void importProject()}
                  disabled={adding}
                >
                  <Upload className="h-4 w-4" /> {t("unreal.addProject")}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {projects.map((project) => {
                  const connected = connectedProjects.has(
                    normalizePath(project.path),
                  );
                  const engine = engineForProject(project, engines);
                  const busy = busyProject === project.id;
                  return (
                    <article
                      key={project.id}
                      className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="max-w-full truncate text-sm font-semibold">
                            {project.name}
                          </h3>
                          {connected ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success">
                              <CheckCircle2 className="h-3 w-3" />{" "}
                              {t("unreal.connected")}
                            </span>
                          ) : null}
                          {project.pluginEnabled ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-subtle px-2 py-0.5 text-[11px] text-fg-2">
                              <ShieldCheck className="h-3 w-3" />{" "}
                              {t("unreal.bridgeReady")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
                              <Puzzle className="h-3 w-3" />{" "}
                              {t("unreal.bridgeMissing")}
                            </span>
                          )}
                        </div>
                        <p
                          className="mt-1 truncate text-xs text-fg-3"
                          title={project.path}
                        >
                          {project.path}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
                          <span>
                            {t("unreal.engineAssociation")}:{" "}
                            {engine?.version ||
                              project.engineAssociation ||
                              t("unreal.engineNotFound")}
                          </span>
                          {project.pluginInstalled && !project.pluginEnabled ? (
                            <span>{t("unreal.pluginNeedsEnable")}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            onOpenAgentProject(projectDirectory(project))
                          }
                        >
                          <Bot className="h-4 w-4" /> {t("unreal.openInAgent")}
                        </Button>
                        {!project.pluginEnabled ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void installBridge(project)}
                          >
                            {busy ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                              <Puzzle className="h-4 w-4" />
                            )}
                            {t("unreal.installBridge")}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={
                              busy ||
                              !engine ||
                              connected ||
                              !bridge?.listening ||
                              Boolean(bridge.error)
                            }
                            onClick={() => void launch(project)}
                            title={
                              connected
                                ? t("unreal.alreadyConnected")
                                : undefined
                            }
                          >
                            {busy ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                            {connected
                              ? t("unreal.connected")
                              : t("unreal.launch")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-compact"
                          title={t("unreal.openFolder")}
                          aria-label={t("unreal.openFolder")}
                          onClick={() =>
                            void agentApi
                              .openProjectDirectory(projectDirectory(project))
                              .catch((error) =>
                                toast.error(t("unreal.openFolderFailed"), {
                                  description: errorMessage(error),
                                }),
                              )
                          }
                        >
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-compact"
                          title={t("unreal.removeProject")}
                          aria-label={t("unreal.removeProject")}
                          onClick={() => void removeProject(project)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-border bg-surface/80 p-5">
            <div className="flex items-start gap-3">
              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">
                  {t("unreal.howItWorks")}
                </h2>
                <p className="mt-1 max-w-4xl text-sm leading-6 text-fg-3">
                  {t("unreal.howItWorksHint")}
                </p>
                <Button
                  className="mt-3"
                  variant="link"
                  size="sm"
                  onClick={onOpenChannels}
                >
                  {t("unreal.configureModels")}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
