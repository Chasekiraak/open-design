// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HomeDemoStatePanel,
  resolveHomeDemoRole,
} from '../../../src/components/home-hero/HomeDemoStatePanel';

afterEach(() => cleanup());

describe('HomeDemoStatePanel', () => {
  it('lets an explicit no-profile mock override an actual designer profile', () => {
    expect(resolveHomeDemoRole({ journey: 'new', role: null }, 'designer')).toBeNull();
    expect(resolveHomeDemoRole(null, 'designer')).toBe('designer');
  });

  it('collapses to a compact Demo launcher and restores the state controls', () => {
    render(<HomeDemoStatePanel actualRole={null} value={null} onChange={vi.fn()} />);

    const panel = screen.getByTestId('home-demo-state-panel');
    const toggle = screen.getByTestId('home-demo-state-toggle');
    expect(panel).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByTestId('home-demo-state-content')).toHaveAttribute('aria-hidden', 'false');

    fireEvent.click(toggle);
    expect(panel).toHaveAttribute('data-collapsed', 'true');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('home-demo-state-content')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Demo')).toBeTruthy();

    fireEvent.click(toggle);
    expect(panel).toHaveAttribute('data-collapsed', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('switches between new and returning demos while preserving the selected profile', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HomeDemoStatePanel actualRole={null} value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '新人' }));
    expect(onChange).toHaveBeenLastCalledWith({ journey: 'new', role: null });

    rerender(<HomeDemoStatePanel actualRole={null} value={{ journey: 'new', role: null }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '营销' }));
    expect(onChange).toHaveBeenLastCalledWith({ journey: 'new', role: 'marketing' });

    rerender(<HomeDemoStatePanel actualRole={null} value={{ journey: 'new', role: 'marketing' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '回访' }));
    expect(onChange).toHaveBeenLastCalledWith({ journey: 'returning', role: 'marketing' });

    fireEvent.click(screen.getByRole('button', { name: '实际数据' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
