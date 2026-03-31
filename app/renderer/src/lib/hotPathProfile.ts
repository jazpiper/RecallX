const HOT_PATH_PROFILE_STORAGE_KEY = 'recallx.hot-path-profile';
const HOT_PATH_PROFILE_QUERY_PARAM = 'rxProfile';
const HOT_PATH_PROFILE_WINDOW_KEY = '__recallxHotPathProfile';
const HOT_PATH_PROFILE_THRESHOLD_MS = 0.5;

type HotPathProfileSample = {
  label: string;
  durationMs: number;
  ts: string;
};

declare global {
  interface Window {
    __recallxHotPathProfile?: HotPathProfileSample[];
  }
}

export function isHotPathProfilingEnabled() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(HOT_PATH_PROFILE_QUERY_PARAM) === '1') {
      return true;
    }

    return window.localStorage.getItem(HOT_PATH_PROFILE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function appendSample(sample: HotPathProfileSample) {
  if (typeof window === 'undefined') {
    return;
  }

  const current = window[HOT_PATH_PROFILE_WINDOW_KEY] ?? [];
  current.push(sample);
  window[HOT_PATH_PROFILE_WINDOW_KEY] = current.slice(-200);
}

export function profileHotPath<T>(label: string, compute: () => T) {
  if (!isHotPathProfilingEnabled()) {
    return compute();
  }

  const startedAt = performance.now();
  const value = compute();
  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const sample = {
    label,
    durationMs,
    ts: new Date().toISOString(),
  };

  appendSample(sample);
  if (durationMs >= HOT_PATH_PROFILE_THRESHOLD_MS) {
    console.info(`RecallX hot-path ${label}`, sample);
  }

  return value;
}
