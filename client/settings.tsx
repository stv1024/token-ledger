import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import { preferences, type Preferences } from '../shared/preferences.ts';

export function TokenLedgerSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const save = (patch: Partial<Preferences>) => {
    if (settings.status === 'ready' && !settings.saving) {
      void settings.save({ ...settings.values, ...patch }, settings.revision);
    }
  };
  if (settings.status === 'loading') return <Text style={{ color: theme.colors.foregroundMuted }}>Loading settings…</Text>;
  if (settings.status !== 'ready') return (
    <SettingsSection title="TokenLedger">
      <SettingsCard>
        <SettingsAction label="Settings unavailable" error={settings.error} actionLabel="Retry" onPress={() => { void settings.reload(); }} />
        {settings.status === 'invalid' ? <SettingsAction label="Restore default preferences" hint="Ledger records and custom prices are preserved." actionLabel="Reset preferences" disabled={settings.saving} onPress={() => { void settings.reset(); }} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsSwitch label="Timeline summaries" hint="Add a usage summary after each newly finished turn. Changes apply to future summaries." value={settings.values.timelineSummaries} disabled={settings.saving} onValueChange={(timelineSummaries) => save({ timelineSummaries })} />
          <SettingsSelect label="Refresh frequency" hint="Live usage updates still refresh automatically when they arrive." value={settings.values.refreshInterval} disabled={settings.saving} options={[{ label: 'Normal · 3s active / 30s idle', value: 'normal' }, { label: 'Relaxed · 10s active / 60s idle', value: 'relaxed' }]} onValueChange={(refreshInterval) => save({ refreshInterval })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Cost estimates">
        <SettingsCard>
          <SettingsSwitch label="OpenRouter reference prices" hint="Use cached reference prices and refresh the public catalog in the background." value={settings.values.openRouterPricing} disabled={settings.saving} onValueChange={(openRouterPricing) => save({ openRouterPricing })} />
          <SettingsSwitch label="Built-in fallback prices" hint="Use known model prices when no custom or OpenRouter price matches." value={settings.values.builtinPricing} disabled={settings.saving} onValueChange={(builtinPricing) => save({ builtinPricing })} />
          <SettingsSwitch label="Prefer price estimates" hint="Use custom or reference prices instead of runtime-reported costs when a price matches. Useful for local or unbilled models." value={settings.values.preferEstimates} disabled={settings.saving} onValueChange={(preferEstimates) => save({ preferEstimates })} />
          <SettingsRow label="Custom prices" hint="Edit pricing.json in the TokenLedger data folder on this host. Changes are picked up within 30 seconds of the next usage request." />
        </SettingsCard>
      </SettingsSection>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Reported costs take priority unless price estimates are preferred, followed by custom prices and enabled reference sources. Reference prices may differ from gateway discounts or Fast Mode charges. Preferences apply to clients connected to this host.</Text>
      {settings.saveError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
    </View>
  );
}
