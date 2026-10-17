import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourcePackProvider,
  useResourceImage,
} from "@/components/shell/ResourcePackProvider";
import { ResourceUpdatesSection } from "@/components/settings/ResourceUpdatesSection";
import {
  resourcePackKey,
  resourceUpdatesApi,
  type ResourcePack,
} from "@/lib/api/resource-updates";

vi.mock("@/lib/api/resource-updates", () => ({
  resourcePackKey: ["presentation-resource-pack"],
  resourceUpdatesApi: {
    local: vi.fn(),
    check: vi.fn(),
    install: vi.fn(),
    confirm: vi.fn(),
    rollback: vi.fn(),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const bundled: ResourcePack = {
  id: null,
  version: null,
  canRollback: false,
  pendingConfirmation: false,
  assets: {},
  warning: null,
};
const updated: ResourcePack = {
  id: "verified-id",
  version: 2,
  canRollback: true,
  pendingConfirmation: true,
  assets: {
    companion: "data:image/png;base64,YQ==",
    scene: "data:image/png;base64,Yg==",
  },
  warning: null,
};
const decode = vi.fn();
function Companion() {
  return (
    <img alt="companion" src={useResourceImage("companion", "bundled.png")} />
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ResourcePackProvider>
          <Companion />
          <ResourceUpdatesSection />
        </ResourcePackProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { client, ...view };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resourceUpdatesApi.local).mockResolvedValue(bundled);
  vi.mocked(resourceUpdatesApi.check).mockResolvedValue(2);
  vi.mocked(resourceUpdatesApi.install).mockResolvedValue(updated);
  vi.mocked(resourceUpdatesApi.confirm).mockResolvedValue(undefined);
  vi.mocked(resourceUpdatesApi.rollback).mockResolvedValue(bundled);
  decode.mockResolvedValue(undefined);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = 1;
      naturalHeight = 1;
      decode = decode;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("local-first signed resource activation", () => {
  it("starts with bundled assets without checking or downloading from the network", async () => {
    const view = mount();
    expect(screen.getByAltText("companion")).toHaveAttribute(
      "src",
      "bundled.png",
    );
    await waitFor(() =>
      expect(resourceUpdatesApi.local).toHaveBeenCalledTimes(1),
    );
    expect(resourceUpdatesApi.check).not.toHaveBeenCalled();
    expect(resourceUpdatesApi.install).not.toHaveBeenCalled();
    view.unmount();
  });

  it("applies validated images without restarting and can restore bundled images", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.click(
      screen.getByRole("button", { name: "resourceUpdates.check" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "resourceUpdates.install" }),
    );
    await waitFor(() =>
      expect(screen.getByAltText("companion")).toHaveAttribute(
        "src",
        updated.assets.companion,
      ),
    );
    expect(decode).toHaveBeenCalled();
    expect(resourceUpdatesApi.confirm).toHaveBeenCalledWith(updated.id);
    expect(
      document.documentElement.style.getPropertyValue("--atelier-scene"),
    ).toContain(updated.assets.scene);
    await user.click(
      screen.getByRole("button", { name: "resourceUpdates.rollback" }),
    );
    await waitFor(() =>
      expect(screen.getByAltText("companion")).toHaveAttribute(
        "src",
        "bundled.png",
      ),
    );
    expect(
      document.documentElement.style.getPropertyValue("--atelier-scene"),
    ).toBe("");
    view.unmount();
  });

  it("rolls back failed display validation and never confirms invalid images", async () => {
    const view = mount();
    await waitFor(() => expect(resourceUpdatesApi.local).toHaveBeenCalled());
    decode.mockRejectedValue(new Error("WebView decode failed"));
    await act(async () => {
      view.client.setQueryData(resourcePackKey, updated);
    });
    await waitFor(() =>
      expect(resourceUpdatesApi.rollback).toHaveBeenCalledWith(updated.id),
    );
    expect(resourceUpdatesApi.confirm).not.toHaveBeenCalled();
    expect(screen.getByAltText("companion")).toHaveAttribute(
      "src",
      "bundled.png",
    );
    view.unmount();
  });

  it("retains bundled assets when the local resource cache cannot be read", async () => {
    vi.mocked(resourceUpdatesApi.local).mockRejectedValue(
      new Error("cache unavailable"),
    );
    const view = mount();
    await waitFor(() =>
      expect(view.client.getQueryState(resourcePackKey)?.status).toBe("error"),
    );
    expect(screen.getByAltText("companion")).toHaveAttribute(
      "src",
      "bundled.png",
    );
    view.unmount();
  });
});
