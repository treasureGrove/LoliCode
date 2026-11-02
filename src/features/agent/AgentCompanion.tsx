import { EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
// Keep the selected artwork inside the renderer bundle: it must also display
// offline, without a separate asset request from the desktop WebView.
import companion from "@/assets/atelier/companion.png?inline";
import { useResourceImage } from "@/app/shell/ResourcePackProvider";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";

/** The optional artwork has no restore control while hidden. */
export function AgentCompanion() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  const visible = appearance.companionVisible;
  const companionSource = useResourceImage("companion", companion);
  const toggleLabel = t("settings.atelier.hideCompanion");
  if (!visible) return null;
  return (
    <div className="wb-companion" data-visible={visible}>
      <div className="wb-companion-stage">
        <span className="wb-companion-aura" aria-hidden="true" />
        <img
          className="wb-companion-image"
          src={companionSource}
          alt={t("settings.atelier.companionAlt")}
          draggable={false}
          decoding="async"
        />
      </div>
      <button
        type="button"
        className="wb-companion-hide"
        aria-label={toggleLabel}
        aria-expanded={visible}
        title={toggleLabel}
        onClick={() => setAppearance({ companionVisible: !visible })}
      >
        <EyeOff size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
