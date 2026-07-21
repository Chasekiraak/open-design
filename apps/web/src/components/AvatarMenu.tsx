import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AmrWalletSnapshot } from '@open-design/contracts';
import { getResolvedDeviceId } from '../analytics/client';
import { amrHandoffDeviceId, attributedAmrUrl, recordAmrEntry } from '../analytics/amr-attribution';
import { useAnalytics } from '../analytics/provider';
import { useT } from '../i18n';
import { AgentIcon } from './AgentIcon';
import { PlanBadge } from './PlanBadge';
import { RemixIcon } from './RemixIcon';
import { defaultAgentModelId, effectiveAgentModelChoice } from './agentModelSelection';
import { orderModelOptionsByAvailability } from './modelOptions';
import type { AgentInfo, AppConfig, ExecMode, ProviderModelOption } from '../types';
import {
  canUpgradeVelaPlan,
  fetchAmrWalletSnapshot,
  fetchVelaLoginStatus,
  formatVelaBalanceUsd,
  type VelaLoginStatus,
} from '../providers/daemon';
import { amrPlansUrlForProfile } from '../runtime/amr-guidance';
import { isMacPlatform } from '../utils/platform';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onApiModelChange?: (model: string) => void;
  providerModelsCache?: Record<string, ProviderModelOption[]>;
  onOpenSettings: (section?: 'execution') => void;
  onRefreshAgents: () => void;
  onBack?: () => void;
  placement?: 'down' | 'up';
  /** Fired when the dropdown transitions from closed to open. */
  onOpen?: () => void;
}

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'Open Design' : agent.name;
}

/**
 * Compact runtime control. Click opens a dropdown with the Open Design account
 * and the model picker for the active agent. Execution wiring that is not a
 * per-message choice (execution mode, which CLI agent, PATH rescan, reasoning
 * effort, BYOK model) lives in Settings → Execution; this popover stays a
 * one-decision surface.
 */
export function AvatarMenu({
  config,
  agents,
  onAgentChange,
  onAgentModelChange,
  onOpenSettings,
  onBack,
  placement = 'down',
  onOpen,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const [open, setOpen] = useState(false);
  // Toggle that reports the closed→open transition (for analytics) without
  // firing on close.
  function toggleOpen() {
    setOpen((v) => {
      if (!v) onOpen?.();
      return !v;
    });
  }
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const margin = 16;
      const gap = 8;
      const width = Math.min(208, window.innerWidth - margin * 2);
      const left = Math.min(
        Math.max(rect.left, margin),
        window.innerWidth - width - margin,
      );

      if (placement === 'up') {
        // The model list is unbounded (an agent can expose 30+ models), so the
        // popover has to stay inside the viewport or the active row scrolls off
        // the top of the screen and becomes unreachable.
        const available = Math.max(160, rect.top - margin - gap);
        setPopoverStyle({
          position: 'fixed',
          top: 'auto',
          bottom: Math.max(margin, window.innerHeight - rect.top + gap),
          left,
          right: 'auto',
          width,
          maxHeight: Math.min(520, available),
          overflowY: 'auto',
          zIndex: 1000,
        });
        return;
      }

      const top = rect.bottom + gap;
      const available = Math.max(160, window.innerHeight - top - margin);
      setPopoverStyle({
        position: 'fixed',
        top,
        bottom: 'auto',
        left,
        right: 'auto',
        width,
        maxHeight: Math.min(520, available),
        overflowY: 'auto',
        zIndex: 1000,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, placement]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  const currentAgentModelOptions = useMemo(() => {
    const models = currentAgent?.models ?? [];
    if (currentAgent?.id !== 'amr') return models;
    return orderModelOptionsByAvailability(models);
  }, [currentAgent]);

  const amrAgent = useMemo(
    () => agents.find((a) => a.id === 'amr' && a.available) ?? null,
    [agents],
  );
  const amrAvailable = amrAgent !== null;
  // Only when Open Design IS the active agent. It used to show whenever AMR was
  // merely installed, which was fine while the popover listed every agent — the
  // row was one entry among many. Once #5517's shape dropped that list it became
  // a lone header card, so selecting Codex still showed AMR's plan and balance.
  const showAmrAccountRow =
    config.mode === 'daemon' && amrAvailable && config.agentId === 'amr';
  const amrProfile = config.agentCliEnv?.amr?.OPEN_DESIGN_AMR_PROFILE;

  // Fetch the live account (plan tier + wallet balance) when the popover opens,
  // whenever the Open Design runtime is installed — so the Open Design account
  // row can show the real plan/balance even when another agent is currently
  // active.
  const [amrAccount, setAmrAccount] = useState<VelaLoginStatus | null>(null);
  const [amrWalletSnapshot, setAmrWalletSnapshot] =
    useState<AmrWalletSnapshot | null>(null);
  useEffect(() => {
    if (!open || !amrAvailable) {
      setAmrAccount(null);
      setAmrWalletSnapshot(null);
      return;
    }
    let cancelled = false;
    setAmrAccount(null);
    setAmrWalletSnapshot(null);
    void fetchVelaLoginStatus()
      .then(async (status) => {
        if (cancelled) return;
        setAmrAccount(status);
        if (status?.loggedIn && !formatVelaBalanceUsd(status.account?.balanceUsd)) {
          const wallet = await fetchAmrWalletSnapshot();
          if (!cancelled) setAmrWalletSnapshot(wallet);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAmrAccount(null);
          setAmrWalletSnapshot(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, amrAvailable]);
  const amrPlanTrimmed = amrAccount?.loggedIn
    ? amrAccount.account?.plan?.trim() || ''
    : '';
  const amrPlanDisplay = amrPlanTrimmed
    ? amrPlanTrimmed.charAt(0).toUpperCase() + amrPlanTrimmed.slice(1)
    : null;
  const amrBalanceLabel = amrAccount?.loggedIn
    ? formatVelaBalanceUsd(amrAccount.account?.balanceUsd) ??
      (amrWalletSnapshot?.status === 'available'
        ? formatVelaBalanceUsd(amrWalletSnapshot.balanceUsd)
        : null)
    : null;
  const amrResolvedProfile = amrAccount?.profile ?? amrProfile;
  const amrCanUpgrade =
    !!amrAccount?.loggedIn && canUpgradeVelaPlan(amrAccount.account?.plan);
  const amrPlansUrl = amrPlansUrlForProfile(amrResolvedProfile);
  const handleAmrUpgradeClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const attribution = recordAmrEntry(analytics.track, 'avatar_amr_upgrade', new Date(), {
      metricsConsent: config.telemetry?.metrics === true,
    });
    const deviceId = amrHandoffDeviceId({
      metricsConsent: config.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config.installationId,
    });
    event.currentTarget.href = attributedAmrUrl(amrPlansUrl, attribution, deviceId);
    setOpen(false);
  };
  // Plan-gated models stay visible but are not selectable; clicking one routes
  // to the plans page instead of silently choosing a model the run would reject.
  const openAmrUpgrade = () => {
    const attribution = recordAmrEntry(
      analytics.track,
      'avatar_amr_upgrade',
      new Date(),
      { metricsConsent: config.telemetry?.metrics === true },
    );
    const deviceId = amrHandoffDeviceId({
      metricsConsent: config.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config.installationId,
    });
    window.open(
      attributedAmrUrl(amrPlansUrl, attribution, deviceId),
      '_blank',
      'noopener,noreferrer',
    );
  };

  // Resolve the user's model + reasoning pick for the active agent. Falls
  // back to the agent's first declared option (`'default'`) when the user
  // hasn't touched the picker yet so the labels don't read as empty.
  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const normalizedCurrentChoice = effectiveAgentModelChoice(currentAgent, currentChoice) ?? currentChoice;
  const currentModelId =
    normalizedCurrentChoice.model ?? defaultAgentModelId(currentAgent);
  const currentReasoningId =
    currentChoice.reasoning ?? currentAgent?.reasoningOptions?.[0]?.id ?? null;
  const currentModelLabel = currentAgent?.models?.find(
    (m) => m.id === currentModelId,
  )?.label;
  const currentReasoningLabel =
    currentAgent?.reasoningOptions?.find((option) => option.id === currentReasoningId)?.label ??
    currentReasoningId;
  const apiModelLabel = config.model?.trim() || null;
  // Selected-model readout shown inside the trigger (left of the Send button).
  // Hidden by default in CSS; composer-row contexts opt it in.
  const triggerModelLabel =
    config.mode === 'api'
      ? apiModelLabel
      : config.mode === 'daemon'
        ? currentModelLabel ?? currentModelId
        : null;

  return (
    <div className={`avatar-menu avatar-menu--${placement}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="avatar-agent-trigger"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={t('avatar.title')}
        title={t('avatar.title')}
        aria-label={t('avatar.title')}
      >
        {currentAgent ? (
          <AgentIcon id={currentAgent.id} size={20} />
        ) : (
          <RemixIcon name="link" size={20} />
        )}
        {triggerModelLabel ? (
          <span className="avatar-agent-trigger__model">{triggerModelLabel}</span>
        ) : null}
        <RemixIcon name="arrow-down-s-line" size={14} />
      </button>
      {open && popoverStyle ? createPortal(
        <div
          ref={popoverRef}
          className="avatar-popover"
          role="dialog"
          aria-label={t('avatar.title')}
          style={popoverStyle}
        >
          {showAmrAccountRow && amrAgent ? (
            <div
              className={`avatar-item avatar-amr-row${
                config.agentId === 'amr' ? ' active' : ''
              }`}
              data-testid="avatar-agent-option-amr"
            >
              <button
                type="button"
                className="avatar-amr-row__select"
                aria-current={config.agentId === 'amr' ? 'true' : undefined}
                onClick={() => {
                  recordAmrEntry(
                    analytics.track,
                    'avatar_amr_agent_card',
                    new Date(),
                    { metricsConsent: config.telemetry?.metrics === true },
                  );
                  onAgentChange('amr');
                }}
              >
                <AgentIcon id="amr" size={24} />
                <span className="avatar-amr-row__text">
                  <span className="avatar-amr-row__name-row">
                    <span className="avatar-amr-row__name">
                      {displayAgentName(amrAgent)}
                    </span>
                    <PlanBadge plan={amrPlanDisplay} size="md" />
                  </span>
                  {amrBalanceLabel ? (
                    <span className="avatar-amr-row__subtitle">
                      <span className="avatar-amr-row__stat">
                        <span className="avatar-amr-row__stat-label">
                          {t('settings.amrBalance')}
                        </span>
                        <span className="avatar-amr-row__stat-value">
                          {amrBalanceLabel}
                        </span>
                      </span>
                    </span>
                  ) : null}
                </span>
              </button>
              {amrCanUpgrade ? (
                <a
                  className="avatar-amr-row__upgrade"
                  href={amrPlansUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleAmrUpgradeClick}
                >
                  {t('settings.amrUpgrade')}
                </a>
              ) : null}
            </div>
          ) : null}

          {config.mode === 'daemon' ? (
            <>
              {currentAgent &&
              currentAgent.available &&
              ((currentAgent.models && currentAgent.models.length > 0) ||
                (currentAgent.reasoningOptions &&
                  currentAgent.reasoningOptions.length > 0)) ? (
                <div className="avatar-model-section">
                  {currentAgent.models && currentAgent.models.length > 0 ? (
                    <div className="avatar-select-row">
                      <span className="avatar-select-label">
                        {t('avatar.modelLabel')}
                      </span>
                      <div
                        className="avatar-model-list"
                        role="radiogroup"
                        aria-label={t('avatar.modelLabel')}
                        data-testid="avatar-model-list"
                      >
                        {(currentModelId &&
                        !currentAgent.models.some((m) => m.id === currentModelId)
                          ? [
                              ...currentAgentModelOptions,
                              {
                                id: currentModelId,
                                label: `${currentModelId} ${t('avatar.customSuffix')}`,
                              },
                            ]
                          : currentAgentModelOptions
                        ).map((model) => {
                          const active = model.id === currentModelId;
                          const locked =
                            currentAgent.id === 'amr' && model.enabled === false;
                          return (
                            <button
                              key={model.id}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-disabled={locked ? 'true' : undefined}
                              title={
                                locked
                                  ? t('settings.amrModelUpgradeHint')
                                  : undefined
                              }
                              className={`avatar-model-option${active ? ' is-active' : ''}${
                                locked ? ' is-locked' : ''
                              }`}
                              data-testid={`avatar-model-option-${model.id}`}
                              onClick={() => {
                                if (locked) {
                                  openAmrUpgrade();
                                  return;
                                }
                                onAgentModelChange(currentAgent.id, { model: model.id });
                                // Selection made — dismiss the popover right away.
                                setOpen(false);
                              }}
                            >
                              <span className="avatar-model-option-label">
                                {model.label}
                              </span>
                              {locked ? (
                                <RemixIcon
                                  name="lock-line"
                                  size={14}
                                  className="avatar-model-option-check"
                                />
                              ) : active ? (
                                <RemixIcon
                                  name="check-line"
                                  size={14}
                                  className="avatar-model-option-check"
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {currentAgent.reasoningOptions &&
                  currentAgent.reasoningOptions.length > 0 &&
                  currentReasoningLabel ? (
                    <div className="avatar-select-row">
                      <span className="avatar-select-label">
                        {t('avatar.reasoningLabel')}
                      </span>
                      <div className="avatar-static-value">{currentReasoningLabel}</div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {config.mode === 'api' && apiModelLabel ? (
            <div className="avatar-model-section">
              <div className="avatar-select-row">
                <span className="avatar-select-label">
                  {t('avatar.modelLabel')}
                </span>
                <div className="avatar-static-value">{apiModelLabel}</div>
              </div>
            </div>
          ) : null}

          {/* The one link out to 设置 → 执行. #5517's popover has no such entry,
              but #5517 also never moved CLI switching out of this popover — we
              did (2026-07-21), so without this the place that switching moved TO
              is unreachable from here. Pinned to the bottom of the scroll port
              like the home switcher's, so a long model list cannot scroll it
              away. */}
          <button
            type="button"
            className="avatar-item avatar-item--pinned"
            data-testid="avatar-open-execution-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings('execution');
            }}
          >
            <span className="avatar-item-icon" aria-hidden>
              <RemixIcon name="settings-3-line" size={15} />
            </span>
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>

          {onBack ? (
            <>
              <button
                type="button"
                className="avatar-item"
                onClick={() => {
                  setOpen(false);
                  onBack();
                }}
              >
                <span className="avatar-item-icon" aria-hidden>
                  <RemixIcon name="arrow-left-line" size={15} />
                </span>
                <span>{t('avatar.backToProjects')}</span>
              </button>
            </>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
