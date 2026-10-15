import { join } from "node:path";
import { NodeServices, Services, Shared } from "./services.mjs";

type Automation = Shared.ZCodeAutomation;
type AutomationRun = Shared.ZCodeAutomationRun;
type Scope = { workspacePath: string; workspaceIdentity?: string };
export type NativeServiceAccess = Partial<Services.IServiceAccessor> & {
  get?<T>(descriptor: Services.ServiceDescriptor<T>): T;
  getOptional?<T>(descriptor: Services.ServiceDescriptor<T>): T | undefined;
};
type Disposable = { dispose(): void };

export interface AutomationOwnerOptions {
  /** Must be the same private app config directory used by createLocalServices. */
  configDirectory: string;
  services: NativeServiceAccess;
  resolveServices?: (scope: Scope) => NativeServiceAccess;
  pollIntervalMs?: number;
  now?: () => number;
  onEvent?: (event: {
    type: string;
    runId?: string;
    automationId?: string;
    error?: string;
  }) => void;
}

type Flight = {
  automation: Automation;
  run: AutomationRun;
  subscription?: Disposable;
  heartbeat?: ReturnType<typeof setInterval>;
  terminal?: Promise<void>;
};

/**
 * Node lifecycle owner for ZCode's desktop cron scheduler. The repository,
 * schedule calculations, atomic claims, retry policy and task runtime are the
 * original implementations; Electron parentPort is replaced by direct calls.
 * This owner must exist once per private database, not once per renderer/view.
 */
export class AutomationOwner {
  readonly repo: InstanceType<typeof NodeServices.AutomationRepo>;
  readonly service: InstanceType<typeof NodeServices.AutomationService>;
  private readonly flights = new Map<string, Flight>();
  private readonly operations = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private tickPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private wakeRequested = false;
  private disposed = false;
  private paused = false;
  private readonly now: () => number;

  constructor(private readonly options: AutomationOwnerOptions) {
    this.repo = new NodeServices.AutomationRepo(
      join(options.configDirectory, "tasks-index.sqlite"),
    );
    this.service = new NodeServices.AutomationService(this.repo);
    this.now = options.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Automation scheduler is closed"));
    return (this.startPromise ??= (async () => {
      await this.repo.ensureReady();
      if (this.disposed) return;
      this.timer = setInterval(
        () => this.wake(),
        this.options.pollIntervalMs ?? 20_000,
      );
      this.timer.unref?.();
      this.wake();
    })());
  }

  status() {
    return {
      running: Boolean(this.timer) && !this.disposed,
      paused: this.paused,
      inFlight: this.flights.size,
      pendingDispatches: this.operations.size,
    };
  }

  busy(): boolean {
    return this.flights.size > 0 || this.operations.size > 0;
  }

  /** Synchronously fence new admissions, then stabilize already-started ones.
   * Existing runtime flights continue and remain visible to the host busy gate. */
  async pauseDispatch(): Promise<void> {
    this.assertOpen();
    this.paused = true;
    await this.tickPromise;
    while (this.operations.size) await Promise.allSettled([...this.operations]);
  }

  resumeDispatch(): void {
    this.assertOpen();
    this.paused = false;
    this.wake();
  }

  wake(): void {
    if (this.disposed) return;
    this.wakeRequested = true;
    if (this.paused) return;
    if (this.tickPromise) return;
    this.tickPromise = this.tick().finally(() => {
      this.tickPromise = undefined;
      if (this.wakeRequested && !this.disposed) this.wake();
    });
  }

  /** Await a complete polling pass; useful for host shutdown and deterministic probes. */
  async flush(): Promise<void> {
    await this.start();
    this.wake();
    while (this.tickPromise) await this.tickPromise;
  }

  private emit(
    type: string,
    flight?: Pick<Flight, "run" | "automation">,
    error?: unknown,
  ): void {
    this.options.onEvent?.({
      type,
      ...(flight
        ? {
            runId: flight.run.runId,
            automationId: flight.automation.automationId,
          }
        : {}),
      ...(error
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation
      .finally(() => this.operations.delete(operation))
      .catch(() => {});
    return operation;
  }

  private async tick(): Promise<void> {
    do {
      this.wakeRequested = false;
      if (this.disposed || this.paused) return;
      try {
        const now = this.now();
        for (const automation of await this.repo.claimDue(now)) {
          if (this.disposed || this.paused) {
            await this.repo.releaseClaim(automation.automationId);
            continue;
          }
          const scheduledAt = automation.nextRunAt ?? automation.retryAt ?? now;
          const runId = `${automation.automationId}:${scheduledAt}`;
          const missed =
            automation.dispatchAttempts === 0 &&
            automation.nextRunAt != null &&
            automation.nextRunAt <= now - 5 * 60_000;
          if (missed) {
            const finalize = NodeServices.isOneShotAutomation(automation);
            await this.repo.skipAndReschedule({
              automationId: automation.automationId,
              runId,
              workspaceKey: Shared.resolveWorkspaceKey(automation),
              scheduledAt,
              reason: "computer_asleep_or_app_not_running",
              finalize,
              nextRunAt: finalize
                ? null
                : NodeServices.computeAutomationNextRunAt(automation, now),
            });
            this.emit("automation.skipped", {
              automation,
              run: { runId } as AutomationRun,
            });
            continue;
          }
          await this.repo.upsertRunClaimed({
            automationId: automation.automationId,
            runId,
            workspaceKey: Shared.resolveWorkspaceKey(automation),
            scheduledAt,
            trigger: "schedule",
          });
          const run = await this.repo.getRun(runId);
          if (this.paused || this.disposed) {
            await this.repo.releaseClaim(automation.automationId);
            continue;
          }
          if (run)
            await this.dispatchManual({ automation, run }).catch(() => {});
        }
        if (this.paused || this.disposed) continue;
        for (const claimed of await this.repo.claimManualRuns(now)) {
          if (this.disposed || this.paused) {
            await this.repo.releaseManualClaim(
              claimed.automation.automationId,
              claimed.run.workspaceKey,
            );
          } else {
            await this.dispatchManual(claimed).catch(() => {});
          }
        }
      } catch (error) {
        this.emit("automation.scheduler_error", undefined, error);
      }
    } while (this.wakeRequested && !this.disposed && !this.paused);
  }

  runNow(automationId: string, scope?: Scope) {
    this.assertOpen();
    if (this.paused)
      return Promise.reject(
        new Error("正在准备更新，自动任务暂不接收新的运行请求"),
      );
    return this.track(
      (async () => {
        const claimed = await this.service.runNow(automationId, scope);
        if (!claimed) return { status: "duplicate" as const };
        if (this.disposed) {
          await this.repo.markRunDispatch({
            runId: claimed.run.runId,
            dispatchStatus: "failed_to_dispatch",
            error: "Application is closing",
          });
          await this.repo.releaseManualClaim(
            claimed.automation.automationId,
            claimed.run.workspaceKey,
          );
          throw new Error("Automation scheduler is closed");
        }
        // This runNow began before the pause fence and is part of the admission
        // drain. Preserve it; the resulting flight makes the host's busy check fail.
        await this.dispatchClaimed(claimed);
        return { status: "queued" as const };
      })(),
    );
  }

  /** Wire this to createLocalServices.onAutomationManualRunRequested. */
  dispatchManual(claimed: {
    automation: Automation;
    run: AutomationRun;
  }): Promise<void> {
    this.assertOpen();
    if (this.flights.has(claimed.run.runId)) return Promise.resolve();
    if (this.paused)
      return this.track(
        (async () => {
          await this.repo.markRunDispatch({
            runId: claimed.run.runId,
            dispatchStatus: "failed_to_dispatch",
            error: "Automation dispatch paused for application update",
          });
          await this.repo.markRunOutcome(
            claimed.run.runId,
            "failed",
            "Automation dispatch paused for application update",
          );
          if (claimed.run.trigger === "manual")
            await this.repo.releaseManualClaim(
              claimed.automation.automationId,
              claimed.run.workspaceKey,
            );
          else await this.repo.releaseClaim(claimed.automation.automationId);
          throw new Error("正在准备更新，自动任务暂不接收新的运行请求");
        })(),
      );
    return this.dispatchClaimed(claimed);
  }

  private dispatchClaimed(claimed: {
    automation: Automation;
    run: AutomationRun;
  }): Promise<void> {
    const existing = this.flights.get(claimed.run.runId);
    if (existing) return Promise.resolve();
    const flight: Flight = claimed;
    this.flights.set(claimed.run.runId, flight);
    return this.track(this.dispatch(flight));
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Automation scheduler is closed");
  }

  private async dispatch(flight: Flight): Promise<void> {
    const { automation, run } = flight;
    let accepted = false;
    try {
      const services =
        this.options.resolveServices?.(automation) ??
        (!automation.workspaceIdentity ||
        (!automation.workspaceIdentity.startsWith("remote:") &&
          !Shared.isRemoteWorkspaceIdentity(automation.workspaceIdentity))
          ? this.options.services
          : undefined);
      if (!services)
        throw new Error("Automation target remote workspace is not connected");
      const taskService =
        services.get?.(Services.IZCodeTaskService) ?? services.zcodeTaskService;
      const modelService =
        services.get?.(Services.IModelSelectionService) ??
        services.modelSelectionService;
      if (!taskService || !modelService)
        throw new Error("Automation target services are unavailable");
      const fixed = (await this.repo.getRun(run.runId))?.modelSelection;
      const intended =
        fixed ??
        (await this.repo.getModelSelectionForDispatch(
          automation.automationId,
          run.workspaceKey,
        ));
      const view = await modelService.getView(
        intended ? { selection: intended } : undefined,
      );
      const selection =
        fixed ?? (intended ? view.effectiveSelection : view.preferredSelection);
      if (!selection || (!fixed && intended && view.selectionIssue)) {
        throw new Error(
          "Automation model selection is unavailable; select a model again",
        );
      }
      const modelSelection = await this.repo.fixRunModelSelection(
        run.runId,
        selection,
      );
      this.assertOpen();
      const task = automation.targetTaskId
        ? { taskId: automation.targetTaskId }
        : await taskService.createTask({
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity,
            modelSelection,
            mode: automation.mode,
            automationId: automation.automationId,
          });
      if (automation.targetTaskId) {
        await taskService.resumeTask({
          taskId: task.taskId,
          workspacePath: automation.workspacePath,
          workspaceIdentity: automation.workspaceIdentity,
          model: `${modelSelection.providerId}/${modelSelection.modelId}`,
          thoughtLevel: modelSelection.options?.reasoningLevel,
          automationId: automation.automationId,
        });
        await taskService.setAutomationSessionConfig({
          taskId: task.taskId,
          traceId: run.runId as Shared.TraceId,
          modelSelection,
          mode: automation.mode,
        });
      }
      this.assertOpen();
      await this.repo.markRunOutcome(run.runId, "running");
      flight.subscription = taskService.onDynamicTaskTerminalOutcome(
        task.taskId,
      )((result) => {
        if (this.disposed || result.inputId !== run.runId || flight.terminal)
          return;
        flight.terminal = this.track(
          (async () => {
            await this.repo.markRunOutcome(
              run.runId,
              result.outcome,
              result.error,
            );
            if (run.trigger === "manual") {
              await this.repo.releaseManualClaim(
                automation.automationId,
                run.workspaceKey,
              );
            }
            this.releaseFlight(flight);
            this.emit(`automation.${result.outcome}`, flight);
            this.wake();
          })(),
        );
        void flight.terminal.catch((error) =>
          this.emit("automation.settlement_error", flight, error),
        );
      });
      if (run.trigger === "manual") {
        flight.heartbeat = setInterval(() => {
          void this.repo
            .touchManualClaim(automation.automationId, run.workspaceKey)
            .catch((error) =>
              this.emit("automation.claim_error", flight, error),
            );
        }, 60_000);
        flight.heartbeat.unref?.();
      }
      await taskService.sendPrompt({
        taskId: task.taskId,
        traceId: run.runId as Shared.TraceId,
        content: automation.prompt,
        clientMode: "desktop-continuous",
        automationId: automation.automationId,
      });
      accepted = true;
      const now = this.now();
      if (run.trigger === "manual") {
        await this.repo.markManualRunDispatched({
          runId: run.runId,
          sessionId: task.taskId,
          dispatchedAt: now,
        });
      } else {
        await this.repo.markRunDispatch({
          runId: run.runId,
          dispatchStatus: "dispatched",
          sessionId: task.taskId,
        });
        const current = await this.repo.get(automation.automationId);
        await this.repo.markDispatched(automation.automationId, {
          dispatchedAt: now,
          nextRunAt: current
            ? NodeServices.computeAutomationNextRunAt(current, now)
            : null,
        });
      }
      this.emit("automation.dispatched", flight);
    } catch (error) {
      // Once the runtime accepted input, never retry it because bookkeeping failed.
      // The original run id is retained for recovery/idempotent admission.
      if (accepted) {
        this.emit("automation.settlement_error", flight, error);
        return;
      }
      this.releaseFlight(flight);
      await this.repo.markRunDispatch({
        runId: run.runId,
        dispatchStatus: "failed_to_dispatch",
        error: safeError(error),
      });
      await this.repo.markRunOutcome(run.runId, "failed", safeError(error));
      if (run.trigger === "manual") {
        await this.repo.releaseManualClaim(
          automation.automationId,
          run.workspaceKey,
        );
      } else {
        const current = await this.repo.get(automation.automationId);
        await this.repo.markDispatchFailed(automation.automationId, {
          failedAt: this.now(),
          error: safeError(error),
          kind: "transient",
          nextRunAt: current
            ? NodeServices.computeAutomationNextRunAt(current, this.now())
            : null,
        });
      }
      this.emit("automation.dispatch_failed", flight, error);
      throw error;
    }
  }

  private releaseFlight(flight: Flight) {
    flight.subscription?.dispose();
    if (flight.heartbeat) clearInterval(flight.heartbeat);
    this.flights.delete(flight.run.runId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.startPromise?.catch(() => {});
    await this.tickPromise;
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    for (const flight of this.flights.values()) {
      this.releaseFlight(flight);
      await this.repo.markRunOutcome(
        flight.run.runId,
        "stopped",
        "Application stopped before the run completed",
      );
      if (flight.run.trigger === "manual") {
        await this.repo.releaseManualClaim(
          flight.automation.automationId,
          flight.run.workspaceKey,
        );
      } else {
        await this.repo.releaseClaim(flight.automation.automationId);
      }
    }
    this.repo.close();
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
