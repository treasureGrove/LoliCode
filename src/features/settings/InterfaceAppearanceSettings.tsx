import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DEFAULT_INTERFACE_APPEARANCE,
  DEFAULT_INTERFACE_BACKGROUND_OPACITY,
  readInterfaceBackgroundOpacity,
  saveInterfaceBackgroundOpacity,
} from "@/lib/interfaceAppearance";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

export function InterfaceAppearanceSettings() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  const [backgroundOpacity, setBackgroundOpacity] = useState(
    readInterfaceBackgroundOpacity,
  );
  const updateBackgroundOpacity = (value: number) => {
    setBackgroundOpacity(value);
    saveInterfaceBackgroundOpacity(value);
  };
  return (
    <>
      <SettingsRow
        label={t("settings.atelier.fontSize")}
        help={{
          title: t("settings.atelier.fontSize"),
          body: t("settings.atelier.fontSizeHelp"),
        }}
        htmlFor="interface-font-size"
        control={
          <div className="atelier-intensity-control">
            <input
              id="interface-font-size"
              type="range"
              min={85}
              max={125}
              step={5}
              value={appearance.fontSize}
              aria-valuetext={`${appearance.fontSize}%`}
              onChange={(event) =>
                setAppearance({ fontSize: Number(event.currentTarget.value) })
              }
            />
            <output htmlFor="interface-font-size">
              {appearance.fontSize}%
            </output>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                appearance.fontSize === DEFAULT_INTERFACE_APPEARANCE.fontSize
              }
              onClick={() =>
                setAppearance({
                  fontSize: DEFAULT_INTERFACE_APPEARANCE.fontSize,
                })
              }
            >
              {t("settings.atelier.reset")}
            </Button>
          </div>
        }
      />
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
      <SettingsRow
        label={t("settings.atelier.backgroundOpacity")}
        help={{
          title: t("settings.atelier.backgroundOpacity"),
          body: t("settings.atelier.backgroundOpacityHelp"),
        }}
        htmlFor="atelier-background-opacity"
        control={
          <div className="atelier-intensity-control">
            <input
              id="atelier-background-opacity"
              type="range"
              min={20}
              max={95}
              step={1}
              value={backgroundOpacity}
              disabled={appearance.mode !== "full"}
              aria-valuetext={`${backgroundOpacity}%`}
              onChange={(event) =>
                updateBackgroundOpacity(Number(event.currentTarget.value))
              }
            />
            <output htmlFor="atelier-background-opacity">
              {backgroundOpacity}%
            </output>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                appearance.mode !== "full" ||
                backgroundOpacity === DEFAULT_INTERFACE_BACKGROUND_OPACITY
              }
              onClick={() =>
                updateBackgroundOpacity(DEFAULT_INTERFACE_BACKGROUND_OPACITY)
              }
            >
              {t("settings.atelier.reset")}
            </Button>
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
