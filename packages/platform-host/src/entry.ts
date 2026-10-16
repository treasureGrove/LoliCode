import { createPlatformHost, type HostOptions } from "./index.js";

// Bootstrap credentials/config arrive only over the private parent IPC channel.
if (!process.send) throw new Error("Start the platform Host through its supervisor");
process.once("message", async (message: { type?: string; options?: HostOptions }) => {
  if (message.type !== "start" || !message.options) { process.exitCode = 1; process.disconnect(); return; }
  try {
    const host = await createPlatformHost(message.options);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await host.close(); if (process.connected) process.disconnect(); };
    process.on("disconnect", () => { void stop(); });
    process.on("SIGTERM", () => { void stop(); });
    process.on("SIGINT", () => { void stop(); });
    process.on("message", (command: { type?: string }) => {
      if (command.type === "stop") void stop();
      if (command.type === "restart-if-idle") {
        if (host.busy()) process.send?.({ type: "busy" }); else void stop();
      }
    });
    process.send?.({ type: "ready", connection: host.connection });
  } catch { process.send?.({ type: "failed", message: "Platform Host could not start; check its isolated data directory and pinned runtime" }); process.exitCode = 1; process.disconnect(); }
});
