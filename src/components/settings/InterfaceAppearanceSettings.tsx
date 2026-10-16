import { useTranslation } from "react-i18next";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

export function InterfaceAppearanceSettings() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  return (
    <>
      <SettingsRow
        label={t("settings.atelier.decoration")}
        help={{
          title: t("settings.atelier.decoration"),
          body: t("settings.atelier.help"),
        }}
        control={
          <SegmentedControl
            size="sm"
            aria-label={t("settings.atelier.decoration")}
            value={appearance.mode}
            onValueChange={(mode) => setAppearance({ mode })}
            items={[
              { value: "full", label: t("settings.atelier.full") },
              { value: "soft", label: t("settings.atelier.soft") },
              { value: "off", label: t("settings.atelier.off") },
            ]}
          />
        }
      />
      <SettingsRow
        label={t("settings.atelier.intensity")}
        htmlFor="atelier-background-intensity"
        control={
          <div className="atelier-intensity-control">
            <input
              id="atelier-background-intensity"
              type="range"
              min={0}
              max={100}
              step={1}
              value={appearance.intensity}
              disabled={appearance.mode !== "full"}
              aria-valuetext={`${appearance.intensity}%`}
              onChange={(event) =>
                setAppearance({ intensity: Number(event.currentTarget.value) })
              }
            />
            <output htmlFor="atelier-background-intensity">
              {appearance.intensity}%
            </output>
          </div>
        }
      />
      <SettingsSwitchRow
        label={t("settings.atelier.companion")}
        help={{
          title: t("settings.atelier.companion"),
          body: t("settings.atelier.companionHelp"),
        }}
        checked={appearance.companionVisible}
        onCheckedChange={(companionVisible) =>
          setAppearance({ companionVisible })
        }
      />
    </>
  );
}
