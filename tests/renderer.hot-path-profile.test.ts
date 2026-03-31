import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isHotPathProfilingEnabled, profileHotPath } from '../app/renderer/src/lib/hotPathProfile.js';

describe('hot path profiling helpers', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    const location = { search: '' };
    vi.stubGlobal('window', {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          const queryIndex = url.indexOf('?');
          location.search = queryIndex >= 0 ? url.slice(queryIndex) : '';
        },
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  afterEach(() => {
    delete window.__recallxHotPathProfile;
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stays disabled by default', () => {
    expect(isHotPathProfilingEnabled()).toBe(false);
  });

  it('enables profiling from the query flag', () => {
    window.history.replaceState({}, '', '/?rxProfile=1');
    expect(isHotPathProfilingEnabled()).toBe(true);
  });

  it('records a sample when enabled', () => {
    window.localStorage.setItem('recallx.hot-path-profile', '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(16.25);

    const value = profileHotPath('search.results', () => 'ok');

    expect(value).toBe('ok');
    expect(window.__recallxHotPathProfile).toEqual([
      expect.objectContaining({
        label: 'search.results',
        durationMs: 6.25,
      }),
    ]);
  });
});
