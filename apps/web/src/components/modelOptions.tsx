import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AgentModelOption } from '../types';

export function renderModelOptions(models: AgentModelOption[]) {
  const groups = new Map<string, AgentModelOption[]>();
  const flat: AgentModelOption[] = [];
  for (const m of models) {
    const slash = m.id.indexOf('/');
    if (m.id === 'default' || slash <= 0) {
      flat.push(m);
      continue;
    }
    const provider = m.id.slice(0, slash);
    const arr = groups.get(provider) ?? [];
    arr.push(m);
    groups.set(provider, arr);
  }
  flat.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : 0));
  if (groups.size === 0) {
    return (
      <>
        {flat.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {flat.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {Array.from(groups.entries()).map(([provider, items]) => (
        <optgroup key={provider} label={provider}>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label.startsWith(`${provider}/`)
                ? m.label.slice(provider.length + 1)
                : m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

function matchesModelSearch(model: AgentModelOption, query: string): boolean {
  const haystack = `${model.id}\n${model.label}`.toLowerCase();
  return haystack.includes(query);
}

// Canonical company/provider display names for the two-level model picker.
// Keyed by the model id's leading token (before the first `-`, or before a
// BYOK `provider/model` slash).
const MODEL_COMPANY_NAMES: Record<string, string> = {
  claude: 'Claude',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  glm: 'GLM',
  kimi: 'Kimi',
  qwen: 'Qwen',
  openai: 'OpenAI',
  gpt: 'OpenAI',
  o1: 'OpenAI',
  o3: 'OpenAI',
  grok: 'Grok',
  llama: 'Llama',
  mistral: 'Mistral',
  doubao: 'Doubao',
  minimax: 'MiniMax',
  moonshot: 'Moonshot',
};

/** Company key + display name for a model id (deepseek-v4-flash → deepseek /
 *  "DeepSeek"; openai/gpt-5 → openai / "OpenAI"). */
export function modelCompany(id: string): { key: string; name: string } {
  const slash = id.indexOf('/');
  const key = (slash > 0 ? id.slice(0, slash) : id.split('-')[0] ?? id).toLowerCase();
  const name = MODEL_COMPANY_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : id);
  return { key, name };
}

interface ModelCompanyGroup {
  key: string;
  name: string;
  options: AgentModelOption[];
}

/** Group model options by company, preserving first-seen order. */
export function groupModelsByCompany(options: AgentModelOption[]): ModelCompanyGroup[] {
  const groups: ModelCompanyGroup[] = [];
  const byKey = new Map<string, ModelCompanyGroup>();
  for (const option of options) {
    const { key, name } = modelCompany(option.id);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name, options: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

interface SearchableModelSelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  models: AgentModelOption[];
  value: string;
  onChange: (value: string) => void;
  searchPlaceholder: string;
  searchInputTestId?: string;
  popoverTestId?: string;
  popoverClassName?: string;
  additionalOptions?: Array<{ value: string; label: string }>;
  minSearchableOptions?: number;
  popoverMinWidth?: number;
}

export const SearchableModelSelect = forwardRef<
  HTMLButtonElement,
  SearchableModelSelectProps
>(function SearchableModelSelect(
  {
    models,
    value,
    onChange,
    searchPlaceholder,
    searchInputTestId,
    popoverTestId,
    popoverClassName,
    additionalOptions,
    minSearchableOptions = 8,
    popoverMinWidth,
    className,
    ...buttonProps
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [popoverStyle, setPopoverStyle] = useState<({ left: number; width: number; maxHeight: number } & ({ top: number; bottom?: never } | { bottom: number; top?: never })) | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useMemo(
    () => `model-picker-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );
  const allOptions = useMemo(() => {
    const merged = new Map<string, AgentModelOption>();
    for (const option of models) merged.set(option.id, option);
    for (const option of additionalOptions ?? []) {
      if (!merged.has(option.value)) {
        merged.set(option.value, { id: option.value, label: option.label });
      }
    }
    return Array.from(merged.values());
  }, [additionalOptions, models]);
  const selectedOption =
    allOptions.find((option) => option.id === value) ??
    (value ? { id: value, label: value } : allOptions[0] ?? null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return allOptions;
    return allOptions.filter(
      (option) =>
        option.id === value ||
        option.id === CUSTOM_MODEL_SENTINEL ||
        matchesModelSearch(option, normalizedQuery),
    );
  }, [allOptions, normalizedQuery, value]);
  const shouldShowSearch = allOptions.length >= minSearchableOptions;
  // Two-level browse (companies left, models right) only pays off for a long
  // cross-company list — the case worth "distinguishing companies". Small
  // pickers (a couple of models, or a single provider) stay a flat list.
  const allCompanyCount = useMemo(() => groupModelsByCompany(allOptions).length, [allOptions]);
  const useTwoLevel = allOptions.length >= minSearchableOptions && allCompanyCount >= 2;
  // Grouped from the (search-)filtered options.
  const companyGroups = useMemo(() => groupModelsByCompany(filteredOptions), [filteredOptions]);
  const selectedCompanyKey = value ? modelCompany(value).key : companyGroups[0]?.key ?? null;
  const [hoverCompany, setHoverCompany] = useState<string | null>(null);
  // Default the open flyout to the selected model's company (or the first),
  // and keep it valid as the filtered group set changes.
  const activeCompanyKey =
    hoverCompany && companyGroups.some((g) => g.key === hoverCompany)
      ? hoverCompany
      : companyGroups.some((g) => g.key === selectedCompanyKey)
        ? selectedCompanyKey
        : companyGroups[0]?.key ?? null;
  const activeCompany = companyGroups.find((g) => g.key === activeCompanyKey) ?? null;
  useEffect(() => {
    if (!open) setHoverCompany(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect =
        buttonRef.current?.getBoundingClientRect() ??
        wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = typeof window === 'undefined' ? rect.width : window.innerWidth;
      const viewportHeight = typeof window === 'undefined' ? rect.height : window.innerHeight;
      const desiredWidth = Math.max(rect.width, popoverMinWidth ?? 0);
      const maxWidth = Math.max(160, viewportWidth - 16);
      const width = Math.min(desiredWidth, maxWidth);
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, viewportWidth - width - 8),
      );
      const availableBelow = Math.max(140, viewportHeight - rect.bottom - 12);
      const availableAbove = Math.max(140, rect.top - 12);
      const shouldOpenUpward = availableBelow < 260 && availableAbove > availableBelow;
      const maxHeight = Math.min(360, shouldOpenUpward ? availableAbove : availableBelow);
      if (shouldOpenUpward) {
        setPopoverStyle({
          bottom: Math.max(8, viewportHeight - rect.top + 6),
          left,
          width,
          maxHeight,
        });
        return;
      }
      setPopoverStyle({
        top: rect.bottom + 6,
        left,
        width,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !shouldShowSearch) return;
    searchRef.current?.focus();
  }, [open, shouldShowSearch]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <div className={`model-select-searchable${open ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        {...buttonProps}
        ref={(node) => {
          buttonRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        className={className}
        onClick={(event) => {
          buttonProps.onClick?.(event);
          if (!event.defaultPrevented) setOpen((prev) => !prev);
        }}
      >
        {selectedOption?.label ?? ''}
      </button>
      {open && popoverStyle
        ? createPortal(
            <div
              ref={popoverRef}
              className={`model-select-searchable__popover${popoverClassName ? ` ${popoverClassName}` : ''}`}
              role="presentation"
              data-testid={popoverTestId}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={handlePopoverKeyDown}
              style={{
                position: 'fixed',
                top: popoverStyle.top != null ? `${popoverStyle.top}px` : 'auto',
                bottom: popoverStyle.bottom != null ? `${popoverStyle.bottom}px` : 'auto',
                left: `${popoverStyle.left}px`,
                width: `${popoverStyle.width}px`,
                maxHeight: `${popoverStyle.maxHeight}px`,
              }}
            >
              {shouldShowSearch ? (
                <div className="model-select-searchable__search-row">
                  <input
                    ref={searchRef}
                    type="search"
                    className="ds-picker-search model-select-searchable__input"
                    value={query}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    data-testid={searchInputTestId}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              ) : null}
              {useTwoLevel ? (
                /* Two-level browse: companies on the left, the hovered/selected
                   company's models on the right. */
                <div
                  className="model-select-searchable__body"
                  id={listboxId}
                  role="listbox"
                  style={{
                    maxHeight: `${Math.max(96, popoverStyle.maxHeight - (shouldShowSearch ? 52 : 12))}px`,
                  }}
                >
                  {companyGroups.length === 0 ? (
                    <div className="model-select-searchable__empty">No matching models</div>
                  ) : (
                    <>
                      <div className="model-select-searchable__companies">
                        {companyGroups.map((group) => {
                          const isActive = group.key === activeCompanyKey;
                          const hasSelected = group.options.some((o) => o.id === value);
                          return (
                            <button
                              key={group.key}
                              type="button"
                              className={`model-select-searchable__company${isActive ? ' is-active' : ''}${hasSelected ? ' has-selected' : ''}`}
                              data-testid={`model-company-${group.key}`}
                              onMouseEnter={() => setHoverCompany(group.key)}
                              onFocus={() => setHoverCompany(group.key)}
                              onClick={() => setHoverCompany(group.key)}
                            >
                              <span className="model-select-searchable__company-name">{group.name}</span>
                              <span className="model-select-searchable__company-count" aria-hidden>{group.options.length}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="model-select-searchable__models" role="group">
                        {(activeCompany?.options ?? []).map((option) => {
                          const active = option.id === value;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={`model-select-searchable__option${active ? ' is-active' : ''}`}
                              data-selected={active ? 'true' : undefined}
                              onClick={() => {
                                onChange(option.id);
                                setOpen(false);
                              }}
                            >
                              <span className="model-select-searchable__option-label">{option.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div
                  className="model-select-searchable__list"
                  id={listboxId}
                  role="listbox"
                  style={{
                    maxHeight: `${Math.max(96, popoverStyle.maxHeight - (shouldShowSearch ? 52 : 12))}px`,
                  }}
                >
                  {filteredOptions.map((option) => {
                    const active = option.id === value;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`model-select-searchable__option${active ? ' is-active' : ''}`}
                        data-selected={active ? 'true' : undefined}
                        onClick={() => {
                          onChange(option.id);
                          setOpen(false);
                        }}
                      >
                        <span className="model-select-searchable__option-label">{option.label}</span>
                      </button>
                    );
                  })}
                  {filteredOptions.length === 0 ? (
                    <div className="model-select-searchable__empty">No matching models</div>
                  ) : null}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

export function isCustomModel(
  modelId: string | null | undefined,
  models: AgentModelOption[],
): boolean {
  if (!modelId) return false;
  return !models.some((m) => m.id === modelId);
}

export const CUSTOM_MODEL_SENTINEL = '__custom__';
