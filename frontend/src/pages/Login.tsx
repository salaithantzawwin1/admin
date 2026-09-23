import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession } from '../api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api<{ accessToken: string; user: never; permissions?: string[] }>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      // store the user payload with fresh roles + permissions from the login response
      setSession(res.accessToken, { ...(res.user as object), permissions: res.permissions } as never);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-blue-800 to-blue-600 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-8">
        {/* logo as the hero — large and centred so the mark stays legible */}
        <div className="flex flex-col items-center text-center mb-6">
          <img src="/GLG.png" alt="GLG logo" className="w-32 h-32 object-contain" />
          <h1 className="text-lg font-bold text-gray-900 mt-2">AMS Login</h1>
          <p className="text-xs text-gray-400">Administration Management System</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-600 mb-1">Username</label>
            <input
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Password</label>
            <input
              type="password"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-gold text-gray-900 font-medium hover:bg-gold-light disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
