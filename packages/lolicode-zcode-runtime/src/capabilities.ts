import { isAbsolute, relative, resolve } from "node:path";
import { NodeServices, Services, Shared } from "./services.mjs";
import { AutomationOwner, type NativeServiceAccess } from "./automation.js";
import { RemoteOwner, type RemoteOwnerOptions } from "./remote.js";

export interface CapabilityScope {
  remoteId?: string;
}
type Disposable = { dispose(): void };

export interface CapabilityFacadeOptions {
  /** The createLocalServices collection is the only owner of native services. */
  services: NativeServiceAccess;
  privateRoot: string;
  configDirectory?: string;
  remoteOptions?: RemoteOwnerOptions;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
  automationPollIntervalMs?: number;
}

// These are the original browser-facing descriptors. Credential and arbitrary
// object access are deliberately not transport capabilities. Managed account
// secrets remain in the desktop's channel/gateway owner.
const SERVICE_PROPERTIES = {
  IFileService: "fileService",
  IMediaPreviewService: "mediaPreviewService",
  IGitService: "gitService",
  IGitCheckpointService: "gitCheckpointService",
  ISystemService: "systemService",
  ITerminalService: "terminalService",
  ISettingService: "settingService",
  IBroadcastService: "broadcastService",
  IZCodeTaskService: "zcodeTaskService",
  IZCodeAgentService: "zcodeAgentService",
  IZCodeSessionService: "zcodeSessionService",
  IFileWatcherService: "fileWatcherService",
  IProviderSettingsService: "providerSettingsService",
  IModelSelectionService: "modelSelectionService",
  IUsageStatsService: "usageStatsService",
  ISkillsService: "skillsService",
  ISkillSyncService: "skillSyncService",
  IMcpSyncService: "mcpSyncService",
  IPluginSyncService: "pluginSyncService",
  IPluginsService: "pluginsService",
  IPluginManagementService: "pluginManagementService",
  ISubagentsService: "subagentsService",
  ICommandsService: "commandsService",
  IHooksService: "hooksService",
  IMemoryService: "memoryService",
  IOutputStyleService: "outputStyleService",
  ISettingsSyncService: "settingsSyncService",
  IPromptAttachmentTransferService: "promptAttachmentTransferService",
  IOffPeakTaskService: "offPeakTaskService",
  IGenUiService: "genUiService",
  IPluginUiBridgeService: "pluginUiBridgeService",
  IPluginUiSamplingService: "pluginUiSamplingService",
  IPluginUiAppToolsService: "pluginUiAppToolsService",
} as const;

export function createCapabilityFacade(options: CapabilityFacadeOptions) {
  const privateRoot = resolve(options.privateRoot);
  if (!isAbsolute(options.privateRoot))
    throw new Error("A private absolute runtime root is required");
  const configDirectory = resolve(
    options.configDirectory ?? NodeServices.getAppConfigDir(),
  );
  const suffix = relative(privateRoot, configDirectory);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(suffix)
  ) {
    throw new Error(
      "Native services must use the LoliCode private runtime directory",
    );
  }
  let disposed = false;
  let pendingCalls = 0;
  const subscriptions = new Set<Disposable>();
  const remote = options.remoteOptions
    ? new RemoteOwner({
        ...options.remoteOptions,
        onEvent: (event) => {
          options.remoteOptions?.onEvent?.(event);
          options.onEvent?.(event);
        },
      })
    : undefined;
  const automation = new AutomationOwner({
    configDirectory,
    services: options.services,
    pollIntervalMs: options.automationPollIntervalMs,
    resolveServices: (scope) => {
      if (
        scope.workspaceIdentity &&
        (scope.workspaceIdentity.startsWith("remote:") ||
          Shared.isRemoteWorkspaceIdentity(scope.workspaceIdentity))
      ) {
        if (!remote) throw new Error("Remote automation target is unavailable");
        return remote.resolveWorkspace(scope.workspaceIdentity);
      }
      return options.services;
    },
    onEvent: (event) => options.onEvent?.(event),
  });

  const descriptors = new Map<
    string,
    {
      descriptor: Services.ServiceDescriptor<unknown>;
      property: string;
      name: string;
    }
  >();
  for (const [name, property] of Object.entries(SERVICE_PROPERTIES)) {
    const descriptor = (Services as unknown as Record<string, unknown>)[
      name
    ] as Services.ServiceDescriptor<unknown> | undefined;
    if (!descriptor || typeof descriptor.channelName !== "string") continue;
    const item = { descriptor, property, name };
    descriptors.set(name, item);
    descriptors.set(descriptor.channelName, item);
    descriptors.set(property, item);
  }

  function assertOpen() {
    if (disposed) throw new Error("Runtime capabilities are closed");
  }

  function getServices(remoteId?: string): NativeServiceAccess {
    assertOpen();
    if (!remoteId) return options.services;
    if (!remote) throw new Error("Remote connections are not configured");
    return remote.getServices(remoteId);
  }

  function resolveService(
    name: string,
    scope?: CapabilityScope,
  ): Record<string, unknown> {
    const entry = descriptors.get(name);
    if (!entry)
      throw new Error(`Service is not an exposed capability: ${name}`);
    const accessor = getServices(scope?.remoteId);
    const service =
      accessor.get?.(entry.descriptor) ??
      (accessor as Record<string, unknown>)[entry.property];
    if (!service) throw new Error(`Service is unavailable: ${entry.name}`);
    return service as Record<string, unknown>;
  }

  function validateMember(method: string) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9]*$/.test(method) ||
      [
        "constructor",
        "prototype",
        "toString",
        "valueOf",
        "hasOwnProperty",
      ].includes(method)
    ) {
      throw new Error("Invalid capability method");
    }
  }

  async function dispatch(
    service: string,
    method: string,
    args: unknown[] = [],
    scope?: CapabilityScope,
  ): Promise<unknown> {
    assertOpen();
    pendingCalls++;
    try {
      return await dispatchCall(service, method, args, scope);
    } finally {
      pendingCalls--;
    }
  }

  async function dispatchCall(
    service: string,
    method: string,
    args: unknown[],
    scope?: CapabilityScope,
  ): Promise<unknown> {
    assertOpen();
    validateMember(method);
    if (!Array.isArray(args))
      throw new Error("Capability arguments must be an array");
    if (service === "automation") return dispatchAutomation(method, args);
    if (service === "remote") {
      if (!remote) throw new Error("Remote connections are not configured");
      switch (method) {
        case "list":
          return remote.list();
        case "listWSL":
          return remote.listWSL();
        case "connect":
          return remote.connect(
            args[0] as Parameters<RemoteOwner["connect"]>[0],
          );
        case "disconnect":
          return remote.disconnect(String(args[0]));
        case "bindWorkspace":
          return remote.bindWorkspace(String(args[0]), String(args[1]));
        default:
          throw new Error("Unknown remote capability method");
      }
    }
    if (/^on[A-Z]/.test(method))
      throw new Error("Use a subscription for capability events");
    const target = resolveService(service, scope);
    const member = target[method];
    if (typeof member !== "function" || method in Object.prototype)
      throw new Error("Unknown capability method");
    // All state and validation stay in the original implementation; no shadow
    // session, workflow, plugin or permission registry is created here.
    return Reflect.apply(member, target, args);
  }

  async function dispatchAutomation(method: string, args: unknown[]) {
    if (method === "status") return automation.status();
    if (method === "start") return automation.start();
    if (method === "wake") return automation.wake();
    if (method === "runNow")
      return automation.runNow(
        ...(args as Parameters<AutomationOwner["runNow"]>),
      );
    const methods = [
      "list",
      "create",
      "get",
      "update",
      "delete",
      "setEnabled",
      "restart",
      "listRuns",
      "deleteRun",
    ];
    if (!methods.includes(method))
      throw new Error("Unknown automation capability method");
    const target = automation.service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const result = await Reflect.apply(
      target[method],
      automation.service,
      args,
    );
    automation.wake();
    return result;
  }

  function subscribe(
    service: string,
    event: string,
    args: unknown[],
    listener: (value: unknown) => void,
    scope?: CapabilityScope,
  ): Disposable {
    assertOpen();
    validateMember(event);
    if (!/^on[A-Z]/.test(event) || !Array.isArray(args))
      throw new Error("Invalid capability event");
    const target = resolveService(service, scope);
    const member = target[event];
    if (typeof member !== "function")
      throw new Error("Capability event is unavailable");
    // Native RPC convention: onDynamic* is an event factory; onDid* is Event.
    const nativeEvent = event.startsWith("onDynamic")
      ? Reflect.apply(member, target, args)
      : member.bind(target);
    if (typeof nativeEvent !== "function")
      throw new Error("Capability event is unavailable");
    let active = true;
    const native = nativeEvent((value: unknown) => {
      if (active && !disposed) listener(value);
    }) as Disposable;
    const subscription = {
      dispose() {
        if (!active) return;
        active = false;
        native.dispose();
        subscriptions.delete(subscription);
      },
    };
    subscriptions.add(subscription);
    return subscription;
  }

  return {
    automation,
    remote,
    getServices,
    dispatch,
    subscribe,
    busy: () =>
      pendingCalls > 0 || automation.busy() || Boolean(remote?.busy()),
    activity: () => ({
      pendingCalls,
      automation: automation.status(),
      remote: remote?.list() ?? [],
    }),
    beginUpdate: () => {
      assertOpen();
      return automation.pauseDispatch();
    },
    endUpdate: () => {
      assertOpen();
      automation.resumeDispatch();
    },
    start: () => {
      assertOpen();
      return automation.start();
    },
    list: () => {
      assertOpen();
      return [...new Set([...descriptors.values()])].map(
        ({ name, descriptor }) => ({ name, channel: descriptor.channelName }),
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of [...subscriptions]) subscription.dispose();
      await automation.dispose();
      await remote?.dispose();
      // The caller owns createLocalServices and its native process teardown.
    },
  };
}

export type CapabilityFacade = ReturnType<typeof createCapabilityFacade>;
