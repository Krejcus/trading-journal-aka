'use client'
import React, { useState, useEffect, useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { Mail, Lock, Eye, EyeOff, ArrowRight, User, Loader2, CheckCircle2, ChevronLeft } from 'lucide-react';
import { supabase } from '../services/supabase';
import { cn } from "../lib/utils";

interface AuthProps {
  onLogin: (user: any) => void;
  theme: 'dark' | 'light' | 'oled';
}

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-300",
        className
      )}
      {...props}
    />
  )
}

const Auth: React.FC<AuthProps> = ({ onLogin, theme }) => {
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'forgot-password' | 'update-password'>(() => {
    if (window.location.hash.includes('type=recovery')) return 'update-password';
    return 'login';
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCheckEmail, setShowCheckEmail] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // For 3D card effect
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rotateX = useTransform(mouseY, [-300, 300], [10, -10]);
  const rotateY = useTransform(mouseX, [-300, 300], [-10, 10]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left - rect.width / 2);
    mouseY.set(e.clientY - rect.top - rect.height / 2);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  // Canvas chart animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = window.innerHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Generate candles (Version C pattern)
    const numCandles = 70;
    const candles: any[] = [];
    let lastClose = 100;
    let trend = 0;

    for (let i = 0; i < numCandles; i++) {
      if (i < 20) {
        trend = (Math.random() - 0.5) * 4;
      } else if (i < 45) {
        if (i === 22) trend = 1.5;
        if (i === 28) trend = -1.8;
        if (i === 34) trend = 1.2;
        if (i === 40) trend = -1.1;
      } else {
        if (i === 46) trend = -2.0;
        if (i === 52) trend = 2.5;
      }

      const volatility = i < 20 ? 1.5 + Math.random() * 2.5 : 0.8 + Math.random() * 1.5;
      const noise = (Math.random() - 0.5) * (i < 20 ? 2 : 1.2);

      const open = lastClose;
      const close = open + trend + noise;
      const high = Math.max(open, close) + Math.random() * volatility;
      const low = Math.min(open, close) - Math.random() * volatility;

      candles.push({
        open, high, low, close,
        color: close >= open ? '#10b981' : '#ef4444'
      });

      lastClose = close;
    }

    let currentIndex = 0;
    let animationInterval: NodeJS.Timeout;

    const drawCandle = (index: number) => {
      const candle = candles[index];
      const width = window.innerWidth;
      const height = window.innerHeight;

      const candleWidth = Math.max(2, (width - 40) / candles.length);
      const x = 20 + index * candleWidth;

      const allPrices = candles.flatMap(c => [c.high, c.low]);
      const minPrice = Math.min(...allPrices);
      const maxPrice = Math.max(...allPrices);
      const priceRange = maxPrice - minPrice;

      const scaleY = (price: number) => {
        const padding = height * 0.1;
        return height - padding - ((price - minPrice) / priceRange) * (height - padding * 2);
      };

      const openY = scaleY(candle.open);
      const closeY = scaleY(candle.close);
      const highY = scaleY(candle.high);
      const lowY = scaleY(candle.low);

      const bodyTop = Math.min(openY, closeY);
      const bodyBottom = Math.max(openY, closeY);
      const bodyHeight = Math.max(bodyBottom - bodyTop, 1);

      ctx.strokeStyle = candle.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + candleWidth / 2, highY);
      ctx.lineTo(x + candleWidth / 2, lowY);
      ctx.stroke();

      ctx.fillStyle = candle.color;
      const bodyWidth = Math.max(candleWidth * 0.7, 2);
      ctx.fillRect(
        x + (candleWidth - bodyWidth) / 2,
        bodyTop,
        bodyWidth,
        bodyHeight || 1
      );
    };

    const render = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < currentIndex; i++) {
        drawCandle(i);
      }
    };

    const animate = () => {
      animationInterval = setInterval(() => {
        if (currentIndex < candles.length) {
          currentIndex++;
          render();
        } else {
          setTimeout(() => {
            currentIndex = 0;
            render();
          }, 800);
        }
      }, 80); // Slower animation for login
    };

    animate();

    return () => {
      clearInterval(animationInterval);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      // Check for Supabase config
      if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
        throw new Error('Chybí konfigurace Supabase (VITE_SUPABASE_URL). Zkontroluj Environment Variables ve Vercelu pro Preview prostředí.');
      }

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

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (oauthError) throw oauthError;
    } catch (err: any) {
      setError(err.message || 'Chyba při přihlášení přes Google.');
      setLoading(false);
    }
  };

  if (showCheckEmail) {
    return (
      <div className="min-h-screen w-screen bg-black relative overflow-hidden flex items-center justify-center font-sans">
        <div className="absolute inset-0 bg-gradient-to-b from-blue-900/20 via-black to-black" />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 p-8 max-w-md w-full bg-white/5 backdrop-blur-3xl border border-white/10 rounded-3xl text-center shadow-2xl"
        >
          <div className="mx-auto w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mb-6 text-blue-400">
            <Mail size={32} />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Zkontroluj si e-mail</h2>
          <p className="text-white/60 mb-8">
            Poslali jsme ti potvrzovací odkaz na <span className="text-blue-400 font-medium">{email}</span>.
            Klikni na něj a můžeš začít.
          </p>
          <button
            onClick={() => { setShowCheckEmail(false); setAuthMode('login'); }}
            className="w-full h-10 rounded-xl bg-white text-black font-semibold hover:bg-white/90 transition-colors"
          >
            Zpět na přihlášení
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-screen bg-black relative overflow-hidden flex items-center justify-center font-sans select-none">
      {/* Canvas chart animation */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 1.0, zIndex: 1 }}
      />

      {/* Background gradient effect */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-900/20 via-slate-950/40 to-black pointer-events-none" />

      {/* Noise texture overlay */}
      <div className="absolute inset-0 opacity-[0.03] mix-blend-soft-light pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          backgroundSize: '200px 200px'
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm relative z-10 mx-4"
        style={{ perspective: 1500 }}
      >
        <motion.div
          className="relative"
          style={{ rotateX, rotateY }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <div className="relative group">
            {/* Traveling light beam effects */}
            <div className="absolute -inset-[1px] rounded-2xl overflow-hidden pointer-events-none">
              <motion.div
                className="absolute top-0 left-0 h-[2px] w-[60%] bg-gradient-to-r from-transparent via-white/80 to-transparent"
                animate={{ left: ["-60%", "100%"] }}
                transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5 }}
              />
              <motion.div
                className="absolute bottom-0 right-0 h-[2px] w-[60%] bg-gradient-to-r from-transparent via-white/80 to-transparent"
                animate={{ right: ["-60%", "100%"] }}
                transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5 }}
              />
              <motion.div
                className="absolute top-0 right-0 h-[60%] w-[2px] bg-gradient-to-b from-transparent via-white/80 to-transparent"
                animate={{ top: ["-60%", "100%"] }}
                transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5, delay: 1.5 }}
              />
              <motion.div
                className="absolute bottom-0 left-0 h-[60%] w-[2px] bg-gradient-to-b from-transparent via-white/80 to-transparent"
                animate={{ bottom: ["-60%", "100%"] }}
                transition={{ duration: 3, ease: "linear", repeat: Infinity, repeatDelay: 0.5, delay: 1.5 }}
              />
            </div>

            {/* Glass card background - ULTRA TRANSPARENT */}
            <div className="relative bg-[#05050a]/15 backdrop-blur-[28px] rounded-2xl px-6 pt-4 pb-6 sm:px-8 sm:pt-6 sm:pb-8 border border-white/[0.12] shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden transition-all duration-500">
              <div className="text-center space-y-2 mb-8">
                <div className="flex justify-center mb-4">
                  <div className="w-40 h-40 relative">
                    <img
                      src="/logos/at_logo_light_clean.png"
                      alt="Alpha Trade Logo"
                      className="w-full h-full object-contain filter drop-shadow-[0_0_25px_rgba(45,212,191,0.7)]"
                    />
                  </div>
                </div>
                <span className="inline-block px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] uppercase tracking-widest text-white/60 mb-1">AlphaTrade Mentor</span>
                <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60 tracking-tight">
                  {authMode === 'login' ? 'Vítejte zpět' :
                    authMode === 'signup' ? 'Vytvořit účet' :
                      authMode === 'forgot-password' ? 'Obnovit heslo' : 'Aktualizovat heslo'}
                </h1>
                <p className="text-white/40 text-xs">
                  {authMode === 'login' ? 'Přihlašte se do svého obchodního deníku' :
                    authMode === 'signup' ? 'Začněte svou cestu k profitabilitě' :
                      authMode === 'forgot-password' ? 'Zadejte e-mail pro obnovu hesla' : 'Zadejte nové bezpečné heslo'}
                </p>
              </div>

              {error && (
                <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs text-center">
                  {error}
                </motion.div>
              )}

              {message && (
                <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                  {message}
                </motion.div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {authMode === 'signup' && (
                  <div className="space-y-1">
                    <div className="relative group/input">
                      <label htmlFor="name" className="sr-only">Celé jméno</label>
                      <Input
                        id="name"
                        type="text"
                        name="name"
                        autoComplete="name"
                        placeholder="Celé jméno"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="pl-10 bg-black/20"
                        required
                      />
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 group-focus-within/input:text-blue-400 transition-colors" size={16} />
                    </div>
                  </div>
                )}

                {authMode !== 'update-password' && (
                  <div className="space-y-1">
                    <div className="relative group/input">
                      <label htmlFor="email" className="sr-only">E-mail</label>
                      <Input
                        key={`email-${authMode}`}
                        id="email"
                        type="email"
                        name={authMode === 'login' ? 'username' : 'email'}
                        autoComplete={authMode === 'signup' ? 'email' : 'username'}
                        inputMode="email"
                        placeholder="access@alphatrade.cz"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-10 bg-black/20"
                        required
                      />
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 group-focus-within/input:text-blue-400 transition-colors" size={16} />
                    </div>
                  </div>
                )}

                {authMode !== 'forgot-password' && (
                  <div className="space-y-1">
                    <div className="relative group/input">
                      <label htmlFor="password" className="sr-only">Heslo</label>
                      <Input
                        key={`password-${authMode}`}
                        id="password"
                        type={showPassword ? "text" : "password"}
                        name="password"
                        autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-10 pr-10 bg-black/20"
                        required
                      />
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 group-focus-within/input:text-blue-400 transition-colors" size={16} />
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowPassword(!showPassword); }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer hover:text-white transition-colors text-white/50 z-20 p-2"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  type="submit"
                  disabled={loading}
                  className="w-full bg-white text-black font-medium h-10 rounded-xl flex items-center justify-center gap-2 hover:bg-white/90 transition-all disabled:opacity-70 disabled:cursor-not-allowed mt-2"
                >
                  {loading ? <Loader2 className="animate-spin" size={18} /> : (
                    <>
                      {authMode === 'login' ? 'Přihlásit se' :
                        authMode === 'signup' ? 'Vytvořit účet' :
                          authMode === 'forgot-password' ? 'Odeslat instrukce' : 'Aktualizovat heslo'}
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </motion.button>
              </form>

              {authMode === 'login' && (
                <div className="mt-6 space-y-4">
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-white/10"></div>
                    </div>
                    <div className="relative flex justify-center text-[10px] uppercase tracking-widest">
                      <span className="bg-[#05050a] px-2 text-white/30 backdrop-blur-xl">Nebo</span>
                    </div>
                  </div>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="w-full bg-white/5 border border-white/10 text-white font-medium h-10 rounded-xl flex items-center justify-center gap-3 hover:bg-white/10 transition-all disabled:opacity-70"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    Pokračovat přes Google
                  </motion.button>
                </div>
              )}

              <div className="mt-8 flex flex-col items-center gap-3 text-xs text-white/40">
                {authMode === 'login' && (
                  <>
                    <button onClick={() => setAuthMode('forgot-password')} className="hover:text-white transition-colors">
                      Zapomenuté heslo?
                    </button>
                    <div className="flex items-center gap-2">
                      <span>Nemáte účet?</span>
                      <button onClick={() => setAuthMode('signup')} className="text-white hover:underline decoration-white/30 underline-offset-4">Registrovat se</button>
                    </div>
                  </>
                )}
                {authMode === 'signup' && (
                  <div className="flex items-center gap-2">
                    <span>Máte již účet?</span>
                    <button onClick={() => setAuthMode('login')} className="text-white hover:underline decoration-white/30 underline-offset-4">Přihlásit se</button>
                  </div>
                )}
                {(authMode === 'forgot-password' || authMode === 'update-password') && (
                  <button onClick={() => setAuthMode('login')} className="flex items-center gap-1 text-white hover:underline decoration-white/30 underline-offset-4">
                    <ChevronLeft size={12} /> Zpět na přihlášení
                  </button>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
};

export default Auth;
