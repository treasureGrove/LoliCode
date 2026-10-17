import { EyeOff, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
// Keep the selected artwork inside the renderer bundle: it must also display
// offline, without a separate asset request from the desktop WebView.
import companion from "@/assets/atelier/companion.png?inline";
import { useResourceImage } from "@/components/shell/ResourcePackProvider";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";

/** A reserved sidebar slot keeps the companion clear of the transcript and composer. */
export function AgentCompanion() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  const visible = appearance.companionVisible;
  const companionSource = useResourceImage("companion", companion);
  const toggleLabel = t(
    visible
      ? "settings.atelier.hideCompanion"
      : "settings.atelier.showCompanion",
  );
  return (
    <div className="wb-companion" data-visible={visible}>
      {visible && (
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
      )}
      <button
        type="button"
        className={visible ? "wb-companion-hide" : "wb-companion-restore"}
        aria-label={toggleLabel}
        aria-expanded={visible}
        title={toggleLabel}
        onClick={() => setAppearance({ companionVisible: !visible })}
      >
        {visible ? (
          <EyeOff size={14} aria-hidden="true" />
        ) : (
          <>
            <Sparkles size={14} aria-hidden="true" />
            <span>{toggleLabel}</span>
          </>
        )}
      </button>
    </div>
  );
}
