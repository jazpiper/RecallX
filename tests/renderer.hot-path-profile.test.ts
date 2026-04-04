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
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(16.25);

    const value = profileHotPath('search.results', () => 'ok');

    expect(value).toBe('ok');
    expect(window.__recallxHotPathProfile).toEqual([
      expect.objectContaining({
        label: 'search.results',
        durationMs: 6.25,
      }),
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      'RecallX hot-path search.results',
      expect.objectContaining({
        label: 'search.results',
        durationMs: 6.25,
      }),
    );
  });

  it('profiles async work when enabled', async () => {
    window.localStorage.setItem('recallx.hot-path-profile', '1');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValueOnce(20).mockReturnValueOnce(24.5);

    const value = await profileHotPath('compactContext.graphDetailPreview', async () => 'bundle');

    expect(value).toBe('bundle');
    expect(window.__recallxHotPathProfile).toEqual([
      expect.objectContaining({
        label: 'compactContext.graphDetailPreview',
        durationMs: 4.5,
      }),
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      'RecallX hot-path compactContext.graphDetailPreview',
      expect.objectContaining({
        label: 'compactContext.graphDetailPreview',
        durationMs: 4.5,
      }),
    );
  });

  it('skips console logging for samples below the threshold', () => {
    window.localStorage.setItem('recallx.hot-path-profile', '1');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValueOnce(30).mockReturnValueOnce(30.49);

    const value = profileHotPath('search.filteredResults', () => 'fast');

    expect(value).toBe('fast');
    expect(window.__recallxHotPathProfile).toEqual([
      expect.objectContaining({
        label: 'search.filteredResults',
        durationMs: 0.49,
      }),
    ]);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('keeps only the newest 200 retained samples', () => {
    window.localStorage.setItem('recallx.hot-path-profile', '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    window.__recallxHotPathProfile = Array.from({ length: 200 }, (_, index) => ({
      label: `existing.${index}`,
      durationMs: 1,
      ts: `sample-${index}`,
    }));
    vi.spyOn(performance, 'now').mockReturnValueOnce(40).mockReturnValueOnce(41);

    const value = profileHotPath('palette.routeCommands', () => 'latest');

    expect(value).toBe('latest');
    expect(window.__recallxHotPathProfile).toHaveLength(200);
    expect(window.__recallxHotPathProfile?.[0]).toEqual(
      expect.objectContaining({
        label: 'existing.1',
      }),
    );
    expect(window.__recallxHotPathProfile?.[199]).toEqual(
      expect.objectContaining({
        label: 'palette.routeCommands',
      }),
    );
  });
});
