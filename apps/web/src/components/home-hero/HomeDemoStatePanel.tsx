import { Button } from '@open-design/components';

import type { HomeOnboardingRole } from './main-flow';
import styles from './HomeDemoStatePanel.module.css';

export type HomeDemoJourney = 'new' | 'returning';

export interface HomeDemoState {
  journey: HomeDemoJourney;
  role: HomeOnboardingRole;
}

/** A mock with an explicit `null` profile must override actual local data. */
export function resolveHomeDemoRole(
  value: HomeDemoState | null,
  actualRole: HomeOnboardingRole,
): HomeOnboardingRole {
  return value === null ? actualRole : value.role;
}

interface Props {
  actualRole: HomeOnboardingRole;
  value: HomeDemoState | null;
  onChange: (value: HomeDemoState | null) => void;
}

const ROLE_OPTIONS: ReadonlyArray<{ label: string; value: HomeOnboardingRole }> = [
  { label: '无画像', value: null },
  { label: '设计师', value: 'designer' },
  { label: '营销', value: 'marketing' },
];

export function HomeDemoStatePanel({ actualRole, value, onChange }: Props) {
  const selectedRole = resolveHomeDemoRole(value, actualRole);

  function chooseJourney(journey: HomeDemoJourney) {
    onChange({ journey, role: selectedRole });
  }

  function chooseRole(role: HomeOnboardingRole) {
    onChange({ journey: value?.journey ?? 'new', role });
  }

  return (
    <aside className={styles.panel} aria-label="Home demo state" data-testid="home-demo-state-panel">
      <div className={styles.header}>
        <span className={styles.eyebrow}>Demo state</span>
        <Button
          variant="ghost"
          className={styles.reset}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          实际数据
        </Button>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>用户阶段</span>
        <div className={styles.options}>
          <Button
            variant={value?.journey === 'new' ? 'primary-ghost' : 'ghost'}
            className={styles.option}
            aria-pressed={value?.journey === 'new'}
            onClick={() => chooseJourney('new')}
          >
            新人
          </Button>
          <Button
            variant={value?.journey === 'returning' ? 'primary-ghost' : 'ghost'}
            className={styles.option}
            aria-pressed={value?.journey === 'returning'}
            onClick={() => chooseJourney('returning')}
          >
            回访
          </Button>
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>画像</span>
        <div className={styles.options}>
          {ROLE_OPTIONS.map((option) => (
            <Button
              key={option.label}
              variant={selectedRole === option.value ? 'primary-ghost' : 'ghost'}
              className={styles.option}
              aria-pressed={selectedRole === option.value}
              onClick={() => chooseRole(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <p className={styles.note}>
        {value === null
          ? '当前使用实际本地数据。'
          : value.journey === 'new'
            ? '模拟首次访问，展示首推类型。'
            : '模拟回访，注入最近创建类型的推荐。'}
      </p>
    </aside>
  );
}
