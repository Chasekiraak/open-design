// Community — the shared template gallery.
//
// Community renders the SAME catalogue the packaged client's Community page
// renders: the plugin records the daemon serves from `GET /api/plugins`
// (bundled `plugins/_official/**` + anything the user installed). It is not a
// separate content system, and it must never carry its own template list:
// this view used to ship a hardcoded 24-entry demo array, which is why the
// team build showed 24 cards where the released client showed hundreds.
//
// Layout, facets, counts, search, sort and lazy paging all come from
// `PluginsHomeSection` in its `gallery` layout — the minimal preview-tile
// variant that was built for exactly this surface. Every number on screen
// (each category pill's badge) is derived by `plugins-home/facets.ts` from the
// fetched records, so a badge can only ever advertise what the grid can render.

import { useCallback, useEffect, useState } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { listPlugins } from '../state/projects';
import { PluginsHomeSection } from './PluginsHomeSection';
import { PluginDetailsModal } from './PluginDetailsModal';
import { examplePresetSeedPrompt } from './plugins-home/presetSeedPrompt';
import { localizePluginTitle } from './plugins-home/localization';

interface CommunityViewProps {
  /** Hand the user into Home with a starting prompt derived from the chosen
   *  template. The `templateId` is the plugin's real id, so the destination
   *  knows which catalogue entry was picked. */
  onRemixTemplate?: (remix: { templateId: string; prompt: string }) => void;
}

export function CommunityView({ onRemixTemplate }: CommunityViewProps) {
  const { locale, t } = useI18n();
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsRecord, setDetailsRecord] = useState<InstalledPluginRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Same read path (and same refresh signal) the plugins surface uses, so an
    // install/uninstall elsewhere in the app is reflected here without a reload.
    const refresh = (): void => {
      void listPlugins().then((rows) => {
        if (cancelled) return;
        setPlugins(rows);
        setLoading(false);
      });
    };
    refresh();
    window.addEventListener('open-design:plugins-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('open-design:plugins-changed', refresh);
    };
  }, []);

  // The composer seed for a picked template is the plugin's own curated seed —
  // the single source of truth shared with the Home example cards and the
  // plugin detail modal — not a sentence synthesized from card copy.
  const remixPlugin = useCallback(
    (record: InstalledPluginRecord): void => {
      const seed = examplePresetSeedPrompt(record, locale, () =>
        localizePluginTitle(locale, record),
      );
      onRemixTemplate?.({ templateId: record.id, prompt: seed.text });
    },
    [locale, onRemixTemplate],
  );

  return (
    <section className="entry-section" aria-label={t('community.title')}>
      <PluginsHomeSection
        plugins={plugins}
        loading={loading}
        activePluginId={null}
        pendingApplyId={null}
        onUse={(record) => remixPlugin(record)}
        onOpenDetails={setDetailsRecord}
        preferDefaultFacet
        cardLayout="gallery"
        title={t('community.title')}
      />
      {detailsRecord ? (
        <PluginDetailsModal
          record={detailsRecord}
          onClose={() => setDetailsRecord(null)}
          onUse={(record) => {
            setDetailsRecord(null);
            remixPlugin(record);
          }}
        />
      ) : null}
    </section>
  );
}
