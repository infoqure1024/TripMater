/**
 * Rendering tests for UploadStatusBar — verifies conditional display logic.
 */

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { UploadStatusBar } from '../src/components/UploadStatusBar';

const defaultProps = {
  uploadEnabled: false,
  isOnline: false,
  pendingCount: 0,
  lastSentAt: null,
  authError: null,
  onToggle: jest.fn(),
  onOpenSettings: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

describe('UploadStatusBar – online/offline label', () => {
  test('shows OFFLINE when isOnline is false', async () => {
    await render(<UploadStatusBar {...defaultProps} isOnline={false} />);
    expect(screen.getByText('OFFLINE')).toBeTruthy();
  });

  test('shows ONLINE when isOnline is true', async () => {
    await render(<UploadStatusBar {...defaultProps} isOnline={true} />);
    expect(screen.getByText('ONLINE')).toBeTruthy();
  });
});

describe('UploadStatusBar – pending count', () => {
  test('shows 0 when no pending items', async () => {
    await render(<UploadStatusBar {...defaultProps} pendingCount={0} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  test('shows correct pending count', async () => {
    await render(<UploadStatusBar {...defaultProps} pendingCount={42} />);
    expect(screen.getByText('42')).toBeTruthy();
  });
});

describe('UploadStatusBar – last sent time', () => {
  test('shows — when lastSentAt is null', async () => {
    await render(<UploadStatusBar {...defaultProps} lastSentAt={null} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  test('does not show — when lastSentAt is provided', async () => {
    const d = new Date('2026-06-21T10:30:45');
    await render(<UploadStatusBar {...defaultProps} lastSentAt={d} />);
    expect(screen.queryByText('—')).toBeNull();
  });
});

describe('UploadStatusBar – auth error', () => {
  test('does not render error element when authError is null', async () => {
    await render(<UploadStatusBar {...defaultProps} authError={null} />);
    expect(screen.queryByTestId('auth-error')).toBeNull();
  });

  test('shows 401 error message', async () => {
    await render(<UploadStatusBar {...defaultProps} authError={401} />);
    const err = screen.getByTestId('auth-error');
    expect(err).toBeTruthy();
    expect(err.props.children).toContain('401');
  });

  test('shows 403 error message', async () => {
    await render(<UploadStatusBar {...defaultProps} authError={403} />);
    expect(screen.getByTestId('auth-error').props.children).toContain('403');
  });

  test('shows generic error message for non-auth server error', async () => {
    await render(<UploadStatusBar {...defaultProps} authError={500} />);
    expect(screen.getByTestId('auth-error').props.children).toContain('500');
  });
});

describe('UploadStatusBar – toggle', () => {
  test('switch is off when uploadEnabled is false', async () => {
    await render(<UploadStatusBar {...defaultProps} uploadEnabled={false} />);
    expect(screen.getByTestId('upload-toggle').props.value).toBe(false);
  });

  test('switch is on when uploadEnabled is true', async () => {
    await render(<UploadStatusBar {...defaultProps} uploadEnabled={true} />);
    expect(screen.getByTestId('upload-toggle').props.value).toBe(true);
  });

  test('calls onToggle when switch value changes', async () => {
    const onToggle = jest.fn();
    await render(<UploadStatusBar {...defaultProps} onToggle={onToggle} />);
    fireEvent(screen.getByTestId('upload-toggle'), 'valueChange', true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
