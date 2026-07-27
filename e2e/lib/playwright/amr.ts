import { createServer } from 'node:http';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { ensureRailOpen } from './rail.js';
import { T } from '@/timeouts';

export const STORAGE_KEY = 'open-design:config';
export const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定|Account & settings/i;

type MockAmrWalletOptions = {
  balanceUsd?: string;
  email?: string;
  loggedIn?: () => boolean;
  plan?: string;
  profile?: string;
};

export const PERSONAL_PROJECT_WORKSPACE_CONTEXT = {
  workspaceId: 'workspace-personal',
  workspaceType: 'personal',
  workspaceMemberId: 'member-personal',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: null,
  providerMode: 'platform_credits',
  seatSummary: {
    seatLimit: 0,
    usedSeats: 0,
    availableSeats: 0,
    isSeatFull: false,
  },
  permissions: {
    canManageMembers: true,
    canManageBilling: true,
    canInviteMembers: true,
    canManageAutoRecharge: true,
    canShareProjects: true,
    canWriteSyncedFiles: true,
    canViewWorkspaceSettings: true,
    canManageSharedResources: true,
  },
} satisfies WorkspaceCollabContext;

export const PERSONAL_PROJECT_WORKSPACE_HEADERS = {
  'x-od-workspace-id': PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceId,
  'x-od-workspace-type': PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceType,
  'x-od-workspace-member-id': PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceMemberId,
  'x-od-workspace-role': PERSONAL_PROJECT_WORKSPACE_CONTEXT.role,
  'x-od-workspace-member-status': PERSONAL_PROJECT_WORKSPACE_CONTEXT.memberStatus,
  'x-od-workspace-lifecycle-state': PERSONAL_PROJECT_WORKSPACE_CONTEXT.lifecycleState,
  'x-od-workspace-can-share-projects': String(
    PERSONAL_PROJECT_WORKSPACE_CONTEXT.permissions.canShareProjects,
  ),
  'x-od-workspace-can-write-synced-files': String(
    PERSONAL_PROJECT_WORKSPACE_CONTEXT.permissions.canWriteSyncedFiles,
  ),
};

export async function providePersonalWorkspaceApi(
  use: () => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/api/v1/workspaces') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        items: [{
          workspaceId: PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceId,
          workspaceName: 'Personal',
          workspaceType: PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceType,
          workspaceMemberId: PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceMemberId,
          role: PERSONAL_PROJECT_WORKSPACE_CONTEXT.role,
          memberStatus: PERSONAL_PROJECT_WORKSPACE_CONTEXT.memberStatus,
          lifecycleState: PERSONAL_PROJECT_WORKSPACE_CONTEXT.lifecycleState,
        }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('fake workspace API did not receive a TCP port');
  }
  const previousControlKey = process.env.VELA_CONTROL_KEY;
  const previousApiUrl = process.env.VELA_API_URL;
  process.env.VELA_CONTROL_KEY = 'fake-control-key';
  process.env.VELA_API_URL = `http://127.0.0.1:${address.port}`;
  try {
    await use();
  } finally {
    if (previousControlKey === undefined) delete process.env.VELA_CONTROL_KEY;
    else process.env.VELA_CONTROL_KEY = previousControlKey;
    if (previousApiUrl === undefined) delete process.env.VELA_API_URL;
    else process.env.VELA_API_URL = previousApiUrl;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export async function stubPersonalWorkspaceContext(page: Page): Promise<void> {
  await page.route('**/api/workspace/context', async (route) => {
    await route.fulfill({
      json: { context: PERSONAL_PROJECT_WORKSPACE_CONTEXT },
    });
  });
}

export async function stubPersonalProjectWorkspaceScope(
  page: Page,
  projectId: string,
): Promise<void> {
  await page.route(`**/api/projects/${projectId}/workspace-scope`, async (route) => {
    await route.fulfill({
      json: {
        scope: {
          kind: 'personal',
          projectId,
          workspaceId: PERSONAL_PROJECT_WORKSPACE_CONTEXT.workspaceId,
          visibility: 'personal',
          context: PERSONAL_PROJECT_WORKSPACE_CONTEXT,
        },
      },
    });
  });
}

export async function waitForLoadingToClear(page: Page) {
  await page.getByText('Loading Open Design…').waitFor({ state: 'hidden', timeout: T.long }).catch(() => {});
}

export async function dismissPrivacyDialog(page: Page) {
  const privacySurface = page
    .getByRole('region', { name: /Help us improve Open Design/i })
    .or(page.locator('.privacy-consent-banner'))
    .first();
  await privacySurface.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
  if (await privacySurface.isVisible().catch(() => false)) {
    await privacySurface
      .getByRole('button', { name: /don['’]?t share|不分享|not now|i get it|got it/i })
      .click();
    await expect(privacySurface).toBeHidden();
  }
}

export async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
}

export async function mockAmrWalletSnapshot(
  page: Page,
  options: MockAmrWalletOptions = {},
) {
  const profile = options.profile ?? 'local';
  const email = options.email ?? 'amr-wallet@example.com';
  const plan = options.plan ?? 'plus';
  const balanceUsd = options.balanceUsd ?? '20.00';
  const fetchedAt = '2026-07-07T00:00:00.000Z';

  await page.route('**/api/integrations/vela/wallet**', async (route) => {
    if (options.loggedIn?.() === false) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'signed_out',
          profile,
          user: null,
          balanceUsd: null,
          updatedAt: null,
          fetchedAt,
          stale: false,
          source: 'unavailable',
          error: { code: 'signed_out', message: 'Sign in to view wallet balance.' },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'available',
        profile,
        user: { id: 'amr-wallet-user', email, plan },
        balanceUsd,
        updatedAt: fetchedAt,
        fetchedAt,
        stale: false,
        source: 'vela_api',
      }),
    });
  });
}

export async function expectWorkspaceReady(page: Page) {
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
}

/**
 * #5517 moved the entry settings chip into the nav rail footer. The rail is
 * collapsed by default and carries `inert` while collapsed, so the chip is
 * present but neither focusable nor clickable — even a programmatic
 * `element.click()` is a no-op — and `getByRole` cannot see it at all because
 * the collapsed rail is `aria-hidden`. Expand the rail first whenever we are on
 * an entry view; inside a project workspace there is no rail to expand.
 */
async function ensureEntryRailOpenIfPresent(page: Page) {
  if ((await page.locator('.entry').count()) === 0) return;
  await ensureRailOpen(page).catch(() => {});
}

/**
 * The settings surface. Opened over a project it is still a modal
 * (`role="dialog"`), but from the entry #5517 routes to `/settings` and
 * `SettingsDialog` renders in `presentation="page"` mode — same markup, but
 * `role="region"` and no `aria-modal`. `.modal-settings` is the class both
 * presentations share. Keep this selector specific: the account/model popover
 * also uses `role="dialog"` but is not the full settings surface.
 */
export function settingsSurface(page: Page) {
  return page.locator('.modal-settings').first();
}

export async function openSettingsDialog(page: Page) {
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await ensureEntryRailOpenIfPresent(page);
  const dialog = settingsSurface(page);
  const settingsTrigger = page
    .getByTestId('entry-nav-settings')
    .or(page.getByTestId('entry-settings-menu-trigger'))
    .or(page.getByRole('button', { name: OPEN_SETTINGS_LABEL }))
    .first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dialog.isVisible().catch(() => false)) return dialog;

    await dismissPrivacyDialog(page);
    if (await settingsTrigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await settingsTrigger.evaluate((element: HTMLElement) => element.click());
    } else {
      const fallback = page.getByRole('button', { name: OPEN_SETTINGS_LABEL }).first();
      await expect(fallback).toBeVisible({ timeout: T.medium });
      await fallback.evaluate((element: HTMLElement) => element.click());
    }

    const detailsTrigger = page.getByTestId('entry-settings-open-details').first();
    if (await detailsTrigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await detailsTrigger.click();
    }
    const executionSettingsTrigger = page.getByTestId('avatar-open-execution-settings').first();
    if (await executionSettingsTrigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await executionSettingsTrigger.click();
    }

    await expect
      .poll(
        async () => {
          if (await dialog.isVisible().catch(() => false)) return 'dialog';
          return 'pending';
        },
        { timeout: T.medium },
      )
      .not.toBe('pending')
      .catch(() => {});

    if (await dialog.isVisible().catch(() => false)) return dialog;
  }

  await expect(dialog).toBeVisible({ timeout: T.medium });
  return dialog;
}

export async function sendPrompt(page: Page, prompt: string) {
  const input = page.getByTestId('chat-composer-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.click();
  await input.fill(prompt);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await input.press('Enter');
}

export async function createProjectViaApi(
  page: Page,
  projectId: string,
  name: string,
  options: { headers?: Record<string, string> } = {},
) {
  const response = await page.request.post('/api/projects', {
    ...(options.headers ? { headers: options.headers } : {}),
    data: {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { conversationId: string };
}

export async function gotoProject(page: Page, projectId: string) {
  try {
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ERR_ABORTED|frame was detached/i.test(message)) throw error;
  }
  await dismissPrivacyDialog(page);
  await expectWorkspaceReady(page);
}

export async function putAppConfig(page: Page, config: Record<string, unknown>) {
  const response = await page.request.put('/api/app-config', { data: config });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function readAppConfig(page: Page) {
  const response = await page.request.get('/api/app-config');
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { config?: Record<string, unknown> };
}

export async function seedBrowserConfig(page: Page, value: Record<string, unknown>) {
  const payload = { key: STORAGE_KEY, config: value };
  await page.addInitScript(
    ({ key, config }) => {
      window.localStorage.setItem(key, JSON.stringify(config));
    },
    payload,
  );
  await page.evaluate(({ key, config }) => {
    window.localStorage.setItem(key, JSON.stringify(config));
  }, payload).catch(() => {
    // Some pre-navigation pages do not expose localStorage yet; the init script above covers the next load.
  });
}
