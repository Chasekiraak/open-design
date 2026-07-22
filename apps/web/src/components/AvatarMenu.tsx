import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { getResolvedDeviceId } from '../analytics/client';
import { amrHandoffDeviceId, attributedAmrUrl, recordAmrEntry } from '../analytics/amr-attribution';
import { useAnalytics } from '../analytics/provider';
import { useT } from '../i18n';
import { RemixIcon } from './RemixIcon';
import { modelProviderIconSrc } from './modelProviderIcon';
import type { AgentInfo, AppConfig, ExecMode, ProviderModelOption } from '../types';
import { isMacPlatform } from '../utils/platform';
import { amrConsoleUrlForProfile } from '../runtime/amr-guidance';

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

function AvatarAgentMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="avatar-agent-mark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      <path d="M19.5 4.7832V7.6709L22 9.11426V14.8867L19.499 16.3311L19.5 19.2178L14.5 22.1045L12 20.6611L9.5 22.1045L4.5 19.2178V16.3311L2 14.8877L2.00098 9.11328L4.5 7.66992V4.78418L9.5 1.89746L11.999 3.34082L14.501 1.89648L19.5 4.7832ZM13 5.07227L12.999 8.42285L15.9639 10.1338L14.9639 11.8662L11 9.57715V5.07324L9.5 4.20703L6.49902 5.93848V8.8252L4 10.2676V13.7334L6.5 15.1768V18.0635L9.5 19.7959L11 18.9287L11.001 15.5771L8.03613 13.8652L9.03613 12.1338L13.001 14.4229V18.9297L14.5 19.7959L17.5 18.0625V15.1768L20 13.7324V10.2695L17.499 8.8252L17.5 5.9375L14.501 4.20605L13 5.07227Z" />
    </svg>
  );
}

/**
 * Compact runtime control. Click opens a dropdown with current execution mode
 * and the agent picker (when in daemon mode).
 */
export function AvatarMenu({
  config,
  agents,
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
        setPopoverStyle({
          position: 'fixed',
          top: 'auto',
          bottom: Math.max(margin, window.innerHeight - rect.top + gap),
          left,
          right: 'auto',
          width,
          zIndex: 1000,
        });
        return;
      }

      const top = rect.bottom + gap;
      setPopoverStyle({
        position: 'fixed',
        top,
        bottom: 'auto',
        left,
        right: 'auto',
        width,
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

  const installedAgents = agents.filter((a) => a.available);
  const amrAvailable = installedAgents.some((a) => a.id === 'amr');
  const showAmrAccountShortcut =
    config.mode === 'daemon' && currentAgent?.id === 'amr' && amrAvailable;
  const amrProfile = config.agentCliEnv?.amr?.OPEN_DESIGN_AMR_PROFILE;
  const amrConsoleUrl = amrConsoleUrlForProfile(amrProfile);
  const handleAmrConsoleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const attribution = recordAmrEntry(analytics.track, 'avatar_amr_console', new Date(), {
      metricsConsent: config.telemetry?.metrics === true,
    });
    const deviceId = amrHandoffDeviceId({
      metricsConsent: config.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config.installationId,
    });
    event.currentTarget.href = attributedAmrUrl(
      amrConsoleUrl,
      attribution,
      deviceId,
    );
    setOpen(false);
  };

  // Resolve the user's model + reasoning pick for the active agent. Falls
  // back to the agent's first declared option (`'default'`) when the user
  // hasn't touched the picker yet so the labels don't read as empty.
  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const currentModelId =
    currentChoice.model ?? currentAgent?.models?.[0]?.id ?? null;
  const currentReasoningId =
    currentChoice.reasoning ?? currentAgent?.reasoningOptions?.[0]?.id ?? null;
  const currentModelLabel =
    currentAgent?.models?.find((model) => model.id === currentModelId)?.label ??
    currentModelId;
  const currentReasoningLabel =
    currentAgent?.reasoningOptions?.find((option) => option.id === currentReasoningId)?.label ??
    currentReasoningId;
  const apiModelLabel = config.model?.trim() || null;
  // Selected-model readout shown inside the trigger (left of the Send button).
  // Hidden by default in CSS; composer-row contexts opt it in.
  const triggerModelLabel =
    config.mode === 'api' ? apiModelLabel : config.mode === 'daemon' ? currentModelLabel : null;
  // Model id backing the readout — used to resolve the provider brand mark that
  // replaces the model-name text in the composer trigger.
  const triggerModelId =
    config.mode === 'api'
      ? config.model?.trim() || null
      : config.mode === 'daemon'
        ? currentModelId
        : null;
  const triggerModelIconSrc = modelProviderIconSrc(triggerModelId);
  // Whether the daemon-mode popover can offer a real model radio list. When it
  // can't (agent unavailable, or its model catalog is empty — e.g. the AMR
  // member account before the vela catalog resolves), the popover falls back
  // to a static current-model row so it never opens as an empty shell.
  const hasSelectableModels = Boolean(
    config.mode === 'daemon' &&
      installedAgents.length > 0 &&
      currentAgent &&
      currentAgent.available &&
      ((currentAgent.models && currentAgent.models.length > 0) ||
        (currentAgent.reasoningOptions && currentAgent.reasoningOptions.length > 0)),
  );

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
        <AvatarAgentMark size={20} />
        {triggerModelLabel ? (
          <span className="avatar-agent-trigger__model">
            {triggerModelIconSrc ? (
              <img
                className="avatar-agent-trigger__model-logo"
                src={triggerModelIconSrc}
                alt={triggerModelLabel}
                width={18}
                height={18}
              />
            ) : (
              triggerModelLabel
            )}
          </span>
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
          {showAmrAccountShortcut ? (
            <a
              className="avatar-amr-account-link"
              href={amrConsoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleAmrConsoleClick}
            >
              <span className="avatar-amr-account-link__icon" aria-hidden>
                <RemixIcon name="wallet-3-line" size={15} />
              </span>
              <span className="avatar-amr-account-link__copy">
                <span>{t('avatar.amrConsole')}</span>
                <span>{t('avatar.amrConsoleMeta')}</span>
              </span>
              <RemixIcon name="external-link-line" size={14} />
            </a>
          ) : null}

          {config.mode === 'daemon' ? (
            <>
              {hasSelectableModels && currentAgent ? (
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
                              ...currentAgent.models,
                              {
                                id: currentModelId,
                                label: `${currentModelId}${t('inlineSwitcher.customSuffix')}`,
                              },
                            ]
                          : currentAgent.models
                        ).map((model) => {
                          const active = model.id === currentModelId;
                          return (
                            <button
                              key={model.id}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              className={`avatar-model-option${active ? ' is-active' : ''}`}
                              onClick={() => {
                                onAgentModelChange(currentAgent.id, { model: model.id });
                                // Selection made — dismiss the popover right away.
                                setOpen(false);
                              }}
                            >
                              <span
                                className="avatar-model-option-logo"
                                aria-hidden="true"
                              >
                                {(() => {
                                  const src = modelProviderIconSrc(model.id);
                                  return src ? (
                                    <img
                                      src={src}
                                      alt=""
                                      width={16}
                                      height={16}
                                    />
                                  ) : (
                                    <AvatarAgentMark size={16} />
                                  );
                                })()}
                              </span>
                              <span className="avatar-model-option-label">
                                {model.label}
                              </span>
                              {active ? (
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
              ) : currentModelLabel ? (
                <div className="avatar-model-section">
                  <div className="avatar-select-row">
                    <span className="avatar-select-label">
                      {t('avatar.modelLabel')}
                    </span>
                    <div className="avatar-static-value">{currentModelLabel}</div>
                  </div>
                </div>
              ) : currentAgent ? (
                <div className="avatar-model-section">
                  <div className="avatar-select-row">
                    <span className="avatar-select-label">
                      {t('avatar.codeAgent')}
                    </span>
                    <div className="avatar-static-value">{currentAgent.name}</div>
                  </div>
                </div>
              ) : (
                <div className="avatar-model-section">
                  <div className="avatar-select-row">
                    <div className="avatar-static-value">
                      {t('avatar.noAgentSelected')}
                    </div>
                  </div>
                </div>
              )}
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

          {onOpenSettings ? (
            <button
              type="button"
              className="avatar-item"
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
          ) : null}

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
