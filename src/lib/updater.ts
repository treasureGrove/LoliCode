import { getVersion } from "@tauri-apps/api/app";
import { APP_UPDATES_ENABLED } from "./branding";

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  if (!APP_UPDATES_ENABLED)
    throw new Error("开发版通过本地构建更新，不使用正式更新通道。");
  // 动态引入，避免在未安装插件时导致打包期问题
  const { check } = await import("@tauri-apps/plugin-updater");

  const currentVersion = await getCurrentVersion();
  const update = await check({ timeout: opts.timeout ?? 30000 });

  if (!update) {
    return { status: "up-to-date" };
  }

  try {
    if (!update.version) throw new Error("更新服务没有返回有效版本号，请重试");
    return {
      status: "available",
      info: {
        currentVersion: currentVersion || update.currentVersion,
        availableVersion: update.version,
        notes: update.body,
        pubDate: update.date,
      },
    };
  } finally {
    // Only the backend installs. The JS check resource is not retained.
    await update.close();
  }
}
