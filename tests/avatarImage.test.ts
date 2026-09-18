import { describe, expect, it } from 'vitest';
import { isOversizedAvatar, mergeDeferredAvatar, AVATAR_INLINE_LIMIT_BYTES } from '../lib/avatarImage';

describe('deferred avatar', () => {
  it('flags only avatars above the inline limit', () => {
    expect(isOversizedAvatar('x'.repeat(AVATAR_INLINE_LIMIT_BYTES))).toBe(false);
    expect(isOversizedAvatar('x'.repeat(AVATAR_INLINE_LIMIT_BYTES + 1))).toBe(true);
    expect(isOversizedAvatar(null)).toBe(false);
  });
  it('keeps the known avatar when the dashboard read deferred it', () => {
    const previous = { id: 'u1', name: 'A', avatar: 'data:image/jpeg;base64,abc' };
    const next = { id: 'u1', name: 'B', avatar: null, avatarDeferred: true };
    expect(mergeDeferredAvatar(previous, next)).toEqual({ id: 'u1', name: 'B', avatar: previous.avatar, avatarDeferred: false });
  });
  it('lets a deferred flag through when nothing is cached, so the lazy fetch runs', () => {
    type U = { id: string; avatar?: string | null; avatarDeferred?: boolean };
    const next: U = { id: 'u1', avatar: null, avatarDeferred: true };
    expect(mergeDeferredAvatar<U>({ id: 'u1' }, next)).toBe(next);
    expect(mergeDeferredAvatar<U>({ id: 'other', avatar: 'x' }, next)).toBe(next);
  });
  it('treats a plain null avatar as a real removal and a null row as no change', () => {
    type U = { id: string; avatar?: string | null; avatarDeferred?: boolean };
    const previous: U = { id: 'u1', avatar: 'x' };
    const removed: U = { id: 'u1', avatar: null };
    expect(mergeDeferredAvatar(previous, removed)).toBe(removed);
    expect(mergeDeferredAvatar(previous, null)).toBe(previous);
  });
});
