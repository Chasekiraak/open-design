// @vitest-environment jsdom
//
// Regression for 飞书 recvq4hGF7BJkI "Personal 用户，左侧栏有 2 个设置入口".
//
// EntryShell.tsx's `railFooterActions` renders its own `entry-settings-chip`
// exactly when `workspaceContext` is falsy, on the documented premise that
// "the settings chip stays in the footer as the ONLY settings entry for
// local/BYOK use" (no cloud identity means no account menu, so something has
// to open the settings modal). EntryNavRail used to ALSO render its own
// `entry-nav-settings` list item on that identical falsy-context condition —
// so any personal/local workspace with no cloud identity showed two visible
// settings entries for the same `onOpenSettings` action: this rail's own list
// item, and the caller-supplied footer chip passed in via `footerExtra`.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

afterEach(() => {
  cleanup();
});

describe('EntryNavRail settings entry (no cloud identity)', () => {
  it('does not render its own settings entry when there is no workspace context', () => {
    render(
      <I18nProvider initial="en">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          onClose={() => {}}
          context={null}
          onOpenSettings={vi.fn()}
          footerExtra={<button type="button" data-testid="fake-footer-settings-chip" />}
        />
      </I18nProvider>,
    );

    // The rail must defer to the caller's footer chip (EntryShell's
    // `entry-settings-chip`, stood in for here) instead of also offering its
    // own settings list item — otherwise there are two entries for one action.
    expect(screen.queryByTestId('entry-nav-settings')).toBeNull();
    expect(screen.queryByTestId('fake-footer-settings-chip')).toBeTruthy();
  });
});
