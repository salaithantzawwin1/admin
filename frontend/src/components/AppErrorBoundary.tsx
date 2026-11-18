import { Component, ErrorInfo, ReactNode } from 'react';

/**
 * A deploy replaces every hashed chunk. A tab that was open before it still runs
 * the old index bundle and asks for a file that no longer exists, which React
 * surfaces as a rejected lazy import — without a boundary that is a blank screen.
 *
 * Chrome, Firefox and Safari word the failure differently, and Vite has its own
 * variant, so all of them count as "the build moved under you".
 */
const isChunkError = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \d+ failed|Failed to fetch/i.test(
    message,
  );
};

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // keep the trail for support; the screen itself stays calm
    console.error('AMS render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkError(error);
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <div className="text-3xl" aria-hidden>
            {chunk ? '🔄' : '⚠️'}
          </div>
          <h1 className="mt-3 text-base font-semibold text-gray-900">
            {chunk ? 'A new version was deployed' : 'Something went wrong'}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {chunk
              ? 'This tab is still running the build from before the deploy, and the file it needs was replaced. Reload to load the current version. If you were typing in a form, copy it first — a reload discards unsaved input.'
              : error.message}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
            >
              Reload
            </button>
            {!chunk && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = '/';
                }}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Back to dashboard
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
