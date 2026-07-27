import { randomUUID } from 'node:crypto';

import { requestJson } from './http.ts';

export const AMR_PERSONAL_WORKSPACE_HEADERS = {
  'x-od-workspace-id': 'workspace-personal',
  'x-od-workspace-type': 'personal',
  'x-od-workspace-member-id': 'member-personal',
  'x-od-workspace-role': 'owner',
  'x-od-workspace-member-status': 'active',
  'x-od-workspace-lifecycle-state': 'active',
  'x-od-workspace-can-share-projects': 'true',
  'x-od-workspace-can-write-synced-files': 'true',
};

export async function putAmrAppConfig(
  webUrl: string,
  config: {
    agentId: string;
    onboardingCompleted?: boolean;
    agentModels?: Record<string, { model: string; reasoning: string }>;
    agentCliEnv?: Record<string, Record<string, string>>;
  },
) {
  await requestJson<{ config: Record<string, unknown> }>(webUrl, '/api/app-config', {
    body: {
      agentId: config.agentId,
      agentModels: config.agentModels ?? { [config.agentId]: { model: 'default', reasoning: 'default' } },
      agentCliEnv: config.agentCliEnv ?? {},
      designSystemId: null,
      onboardingCompleted: config.onboardingCompleted ?? true,
      skillId: null,
      telemetry: { artifactManifest: true, content: false, metrics: false },
    },
    method: 'PUT',
  });
}

export async function createAmrProject(webUrl: string, name: string) {
  return await requestJson<{
    conversationId: string;
    project: { id: string; metadata?: { kind?: string }; name: string };
  }>(webUrl, '/api/projects', {
    body: {
      designSystemId: null,
      id: randomUUID(),
      metadata: { kind: 'prototype' },
      name,
      pendingPrompt: null,
      skillId: null,
    },
    headers: AMR_PERSONAL_WORKSPACE_HEADERS,
    method: 'POST',
  });
}
