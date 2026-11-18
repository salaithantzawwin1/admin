import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './index.css';

// A deploy replaces every hashed chunk, so a tab opened before it asks for a file
// that no longer exists ("Failed to fetch dynamically imported module") and the
// app dies. Reload once to pick up the new build — guarded, because a genuinely
// missing file must not put the tab into a reload loop; after one attempt the
// error boundary explains what happened instead.
const RELOAD_KEY = 'ams_chunk_reload_at';
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < 20_000) return;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>,
);
