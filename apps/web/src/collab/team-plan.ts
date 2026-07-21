import type { WorkspaceBillingSummary, WorkspaceCollabContext } from '@open-design/contracts';

/**
 * Whether a raw vela plan id is a TEAM plan.
 *
 * B namespaces plan ids by workspace kind and tier — `team_basic`, `team_plus`,
 * `team_pro`, `team_max` against `free` / `pro` / `plus` / `max` for personal.
 */
export function isTeamPlanTier(rawTier: string | null | undefined): boolean {
  const normalized = rawTier?.trim().toLowerCase() ?? '';
  if (!normalized) return false;
  return normalized === 'team' || normalized.startsWith('team_') || normalized.startsWith('team-');
}

/**
 * Whether the team-scoped surfaces (the 团队 tab on 扩展 and 设计体系) should be
 * offered.
 *
 * The gate is the PLAN, not the workspace kind: a personal workspace is still a
 * workspace and can still have members, so `workspaceType` is the wrong axis.
 * It hides only for the two cases that genuinely have no team to share into —
 * signed out of AMR, or on a personal/free plan that has not been upgraded to a
 * team one.
 *
 * `planId` on the context is the same raw id billing reports, so it stands in
 * while the billing summary is still loading or reports an empty tier.
 */
export function hasTeamPlan(
  context: WorkspaceCollabContext | null | undefined,
  billing: WorkspaceBillingSummary | null | undefined,
): boolean {
  if (!context) return false;
  return isTeamPlanTier(billing?.membershipTier) || isTeamPlanTier(context.planId);
}
