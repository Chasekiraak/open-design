// @vitest-environment jsdom
//
// Regression for 飞书 recvq4hGF7BJkI "Personal 用户，左侧栏有 2 个设置入口".
//
// EntryShell no longer renders an `entry-settings-chip` in `railFooterActions`.
// A personal/local workspace has no account menu, so EntryNavRail must retain
// the one settings action while still rendering unrelated footer content.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

afterEach(() => {
  cleanup();
});

describe('EntryNavRail settings entry (no cloud identity)', () => {
  it('renders one rail settings entry alongside unrelated footer content', () => {
    const onOpenSettings = vi.fn();
    render(
      <I18nProvider initial="en">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          onClose={() => {}}
          context={null}
          onOpenSettings={onOpenSettings}
          footerExtra={<button type="button" data-testid="fake-footer-extra" />}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('entry-nav-settings'));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('fake-footer-extra')).toBeTruthy();
  });
});
