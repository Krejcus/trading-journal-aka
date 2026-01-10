
import React, { useState } from 'react';
import { Shield, Zap, TrendingUp, Mail, Lock, User, ArrowRight, BarChart2, Loader2 } from 'lucide-react';
import { supabase } from '../services/supabase';

interface AuthProps {
  onLogin: (user: any) => void;
  theme: 'dark' | 'light';
}

const Auth: React.FC<AuthProps> = ({ onLogin, theme }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCheckEmail, setShowCheckEmail] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'forgot-password' | 'update-password'>(() => {
    // Check if URL contains recovery token
    if (window.location.hash.includes('type=recovery')) return 'update-password';
    return 'login';
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (authMode === 'login') {
        const { data, error: loginError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (loginError) {
          if (loginError.message.includes('Email not confirmed')) {
            throw new Error('Tvůj e-mail ještě nebyl potvrzen. Zkontroluj si prosím e-mailovou schránku.');
          }
          throw loginError;
        }
        if (data.user) onLogin(data.user);
      } else if (authMode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name } },
        });
        if (signUpError) throw signUpError;
        if (data.user) setShowCheckEmail(true);
      } else if (authMode === 'forgot-password') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (resetError) throw resetError;
        setMessage('Odkaz pro obnovu hesla byl odeslán na tvůj e-mail.');
      } else if (authMode === 'update-password') {
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) throw updateError;
        setMessage('Heslo bylo úspěšně změněno. Nyní se můžeš přihlásit.');
        setAuthMode('login');
      }
    } catch (err: any) {
      setError(err.message || 'Něco se nepovedlo. Zkuste to znovu.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = `w-full pl-10 pr-4 py-3 rounded-xl border transition-all outline-none focus:ring-2 focus:ring-blue-500/40 ${theme === 'dark' ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'
    }`;

  if (showCheckEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#0F172A] relative overflow-hidden text-center">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-[120px] animate-pulse"></div>
        </div>

        <div className="w-full max-w-md relative z-10 p-8 rounded-[40px] border shadow-2xl bg-slate-900/40 backdrop-blur-xl border-white/5">
          <div className="inline-flex items-center justify-center p-6 bg-blue-600/20 text-blue-500 rounded-3xl mb-6">
            <Mail size={48} className="animate-bounce" />
          </div>
          <h2 className="text-3xl font-black text-white tracking-tighter mb-4 uppercase italic">Zkontroluj si e-mail!</h2>
          <p className="text-slate-400 font-medium mb-8 leading-relaxed">
            Poslali jsme ti potvrzovací odkaz na <span className="text-blue-400 font-bold">{email}</span>.
            Klikni na něj a tvůj terminál bude připraven k použití.
          </p>
          <button
            onClick={() => {
              setShowCheckEmail(false);
              setIsLogin(true);
            }}
            className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black shadow-xl shadow-blue-600/20 transition-all active:scale-95"
          >
            Zpět na přihlášení
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#0F172A] relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-[120px] animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }}></div>
      </div>

      <div className="w-full max-w-md relative z-10">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-blue-600 rounded-2xl shadow-2xl shadow-blue-500/40 mb-4 transform hover:scale-110 transition-transform">
            <BarChart2 className="text-white w-8 h-8" />
          </div>
          <h1 className="text-4xl font-black text-white tracking-tighter mb-2 italic uppercase">ALPHATRADE</h1>
          <p className="text-slate-400 font-medium">
            {authMode === 'forgot-password' ? 'Obnova přístupu k terminálu' :
              authMode === 'update-password' ? 'Nastavení nového hesla' :
                'Mentor, který tě dovede k profitabilitě. 📈'}
          </p>
        </div>

        <div className={`p-8 rounded-[40px] border shadow-2xl bg-slate-900/40 backdrop-blur-xl border-white/5`}>
          {(authMode === 'login' || authMode === 'signup') && (
            <div className="flex gap-4 mb-8 p-1 bg-slate-950/50 rounded-2xl border border-white/5">
              <button
                onClick={() => setAuthMode('login')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${authMode === 'login' ? 'bg-blue-600 text-white' : 'text-slate-50'}`}
                type="button"
              >
                Přihlášení
              </button>
              <button
                onClick={() => setAuthMode('signup')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${authMode === 'signup' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}
                type="button"
              >
                Registrace
              </button>
            </div>
          )}

          {error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold text-center italic">
              {error}
            </div>
          )}

          {message && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold text-center italic">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {authMode === 'signup' && (
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Jméno</label>
                <div className="relative group">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-500 transition-colors" size={18} />
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Tvé jméno"
                    className={inputClass}
                    required={authMode === 'signup'}
                  />
                </div>
              </div>
            )}

            {authMode !== 'update-password' && (
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Email</label>
                <div className="relative group">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-500 transition-colors" size={18} />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="email@alphatrade.cz"
                    className={inputClass}
                    required
                  />
                </div>
              </div>
            )}

            {authMode !== 'forgot-password' && (
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-slate-500 ml-1">
                  {authMode === 'update-password' ? 'Nové heslo' : 'Heslo'}
                </label>
                <div className="relative group">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-500 transition-colors" size={18} />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                    required
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl font-black shadow-xl shadow-blue-600/20 flex items-center justify-center gap-2 group transition-all active:scale-95"
            >
              {loading ? (
                <Loader2 className="animate-spin" size={20} />
              ) : (
                <>
                  {authMode === 'login' ? 'Vstoupit do Terminálu' :
                    authMode === 'signup' ? 'Vytvořit účet' :
                      authMode === 'forgot-password' ? 'Odeslat instrukce' :
                        'Aktualizovat heslo'}
                  <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>

            {authMode === 'forgot-password' && (
              <button
                type="button"
                onClick={() => setAuthMode('login')}
                className="w-full text-xs text-slate-500 hover:text-white font-bold transition-colors"
              >
                Zpět na přihlášení
              </button>
            )}
          </form>

          {authMode === 'login' && (
            <div className="mt-6 text-center">
              <button
                onClick={() => setAuthMode('forgot-password')}
                className="text-xs text-slate-500 hover:text-blue-400 font-bold transition-colors"
                type="button"
              >
                Zapomenuté heslo?
              </button>
            </div>
          )}
        </div>

        {/* Footer features icons */}
        <div className="mt-10 grid grid-cols-3 gap-4">
          {[
            { icon: Shield, label: 'Bezpečné' },
            { icon: Zap, label: 'Rychlé' },
            { icon: TrendingUp, label: 'Profitabilní' }
          ].map((item, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className="p-2 rounded-lg bg-slate-800 text-slate-400">
                <item.icon size={16} />
              </div>
              <span className="text-[8px] font-bold text-slate-500 uppercase">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Auth;
