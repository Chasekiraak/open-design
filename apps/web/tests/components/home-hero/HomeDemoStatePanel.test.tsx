// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HomeDemoStatePanel } from '../../../src/components/home-hero/HomeDemoStatePanel';

describe('HomeDemoStatePanel', () => {
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
