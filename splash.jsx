// splash.jsx — Splash + Login screen for Ali.Alhamed97 CRM
const { useState, useEffect, useRef, useCallback } = React;

const CONFIG = {
  titleText: "علي الحامد للإستشارات",
  welcomeText: "أهلاً بك في منصة",
  soundOn: true,
  shardCount: 8
};

// ─────────────────────────────────────────────────────────────
// Audio engine — schedules events on a single AudioContext
// ─────────────────────────────────────────────────────────────
const AudioEngine = {
  ctx: null, master: null,
  init() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 18; comp.ratio.value = 4;
      comp.attack.value = 0.005; comp.release.value = 0.15;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.085;
      this.master.connect(comp);
      return true;
    } catch (e) { return false; }
  },
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  },
  click(delay, freq, vol = 0.022) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.65, t + 0.05);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.1);
  },
  bell(delay, freq, vol = 0.06, dur = 1.4) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 4500;
    o.type = "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  },
  pad(delay, freqs, vol = 0.045, dur = 6.5) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay);
    freqs.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = i === freqs.length - 1 ? "triangle" : "sine";
      o.frequency.value = f;
      const peakVol = vol * (1 - i * 0.18);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peakVol, t + 1.2);
      g.gain.setValueAtTime(peakVol, t + dur - 1.5);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + dur + 0.1);
    });
  },
  whoosh(delay, dur = 0.6, peakVol = 0.05) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay);
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakVol, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  },
  swish(delay) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(5500, t + 0.5);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.022, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.7);
  },
  successChime() {
    // Ascending major triad: C5 → E5 → G5 → C6
    [523.25, 659.25, 783.99].forEach((f, i) => {
      this.bell(i * 0.11, f, 0.07, 1.1);
    });
    this.bell(0.36, 1046.50, 0.055, 1.6);
    // Bass confirmation
    this.bell(0.0, 130.81, 0.04, 1.4);
  },
  errorBuzz() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [220, 165].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1200;
      o.type = "sawtooth";
      o.frequency.value = f;
      const t0 = t + i * 0.08;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.04, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.connect(lp).connect(g).connect(this.master);
      o.start(t0); o.stop(t0 + 0.32);
    });
  },
  engage() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(440, t);
    o.frequency.linearRampToValueAtTime(660, t + 0.15);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.22);
  },
  hoverTick() {
    if (!this.ctx) return;
    this.click(0, 2200, 0.008);
  }
};

// ─────────────────────────────────────────────────────────────
// Intro timeline — every audio event maps to a CSS animation cue.
// `offset` skips events that have already passed in the visual timeline,
// so audio that starts late still lines up with the current visual moment.
// ─────────────────────────────────────────────────────────────
function playIntroTimeline(wedgeCount, offset = 0) {
  const at = (t, fn) => {
    const adj = t - offset;
    if (adj < -0.05) return; // already in the past
    fn(Math.max(0, adj));
  };

  // 1) Ambient pad — sustained foundation
  at(0, t => AudioEngine.pad(t, [55, 82.5, 110, 165], 0.045, Math.max(2.5, 6.8 - t)));

  // 2) Per-wedge ticks
  for (let i = 0; i < wedgeCount; i++) {
    const freq = 1100 + (i % 4) * 220;
    at(i * 0.09 + 1.55, t => AudioEngine.click(t, freq, 0.018));
  }

  // 3) Center glow (E4 + B4)
  at(2.8,  t => AudioEngine.bell(t, 329.63, 0.05, 1.6));
  at(2.85, t => AudioEngine.bell(t, 493.88, 0.04, 1.4));

  // 4) Logo arrival chime (E5 + A5)
  at(3.2,  t => AudioEngine.bell(t, 659.25, 0.07, 1.0));
  at(3.28, t => AudioEngine.bell(t, 880,    0.05, 1.2));

  // 4b) Logo burst halo
  at(3.55, t => AudioEngine.whoosh(t, 0.7, 0.04));

  // 4c) Logo "punch through" overshoot — deep impact
  at(4.0,  t => AudioEngine.bell(t, 196.00,  0.075, 1.2));
  at(4.05, t => AudioEngine.bell(t, 392.00,  0.045, 1.0));
  at(4.1,  t => AudioEngine.bell(t, 1318.51, 0.035, 0.8));

  // 5) Welcome text pre-tick
  at(3.4, t => AudioEngine.click(t, 1800, 0.012));

  // 6) Title reveal finale bell (C6)
  at(3.6, t => AudioEngine.bell(t, 1046.50, 0.045, 1.8));

  // 7) Decorative chart whoosh
  at(3.6, t => AudioEngine.whoosh(t, 1.2, 0.028));

  // 8) Login card landing
  at(4.0,  t => AudioEngine.whoosh(t, 0.55, 0.045));
  at(4.05, t => AudioEngine.bell(t, 146.83, 0.05, 0.9));

  // 9) Sheen sweep
  at(4.8, t => AudioEngine.swish(t));

  // 10) Form field stagger
  [4.6, 4.8, 4.95, 5.1, 5.25, 5.4].forEach((d, i) => {
    at(d, t => AudioEngine.click(t, 1300 + i * 90, 0.011));
  });
}

// ─────────────────────────────────────────────────────────────
// Donut (SVG ring split into wedges)
// ─────────────────────────────────────────────────────────────
function DonutSVG({ count = 8 }) {
  const cx = 50, cy = 50;
  const rOuter = 46;
  const rInner = 18;
  const gapDeg = 5;

  const wedges = [];
  for (let i = 0; i < count; i++) {
    const a0d = i / count * 360 - 90 + gapDeg / 2;
    const a1d = (i + 1) / count * 360 - 90 - gapDeg / 2;
    const a0 = a0d * Math.PI / 180;
    const a1 = a1d * Math.PI / 180;
    const x0o = cx + Math.cos(a0) * rOuter;
    const y0o = cy + Math.sin(a0) * rOuter;
    const x1o = cx + Math.cos(a1) * rOuter;
    const y1o = cy + Math.sin(a1) * rOuter;
    const x0i = cx + Math.cos(a1) * rInner;
    const y0i = cy + Math.sin(a1) * rInner;
    const x1i = cx + Math.cos(a0) * rInner;
    const y1i = cy + Math.sin(a0) * rInner;
    const largeArc = a1d - a0d > 180 ? 1 : 0;
    const d = [
      `M ${x0o.toFixed(3)} ${y0o.toFixed(3)}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x1o.toFixed(3)} ${y1o.toFixed(3)}`,
      `L ${x0i.toFixed(3)} ${y0i.toFixed(3)}`,
      `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i.toFixed(3)} ${y1i.toFixed(3)}`,
      `Z`
    ].join(" ");

    const midDeg = (a0d + a1d) / 2;
    const mid = midDeg * Math.PI / 180;
    const tx = Math.cos(mid) * 120;
    const ty = Math.sin(mid) * 120;
    const bx = Math.cos(mid) * 2.2;
    const by = Math.sin(mid) * 2.2;
    const rot = (i % 2 === 0 ? 1 : -1) * 30;
    const delay = i * 0.09;

    wedges.push({
      d, i,
      style: {
        "--tx": `${tx}px`, "--ty": `${ty}px`,
        "--bx": `${bx}px`, "--by": `${by}px`,
        "--rot": `${rot}deg`,
        "--d": `${delay}s`,
        fill: `url(#wedgeGrad${i % 3})`
      }
    });
  }

  return (
    <svg className="donut-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="wedgeGrad0" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e6d8b4" />
          <stop offset="55%" stopColor="#3aa292" />
          <stop offset="100%" stopColor="#0e4434" />
        </linearGradient>
        <linearGradient id="wedgeGrad1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ddc999" />
          <stop offset="60%" stopColor="#2f8d7e" />
          <stop offset="100%" stopColor="#0a3528" />
        </linearGradient>
        <linearGradient id="wedgeGrad2" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0e4c0" />
          <stop offset="55%" stopColor="#48b09f" />
          <stop offset="100%" stopColor="#0e4434" />
        </linearGradient>
      </defs>
      {wedges.map((w) => (
        <path key={w.i} className="wedge" d={w.d} style={w.style} />
      ))}
    </svg>
  );
}

function DecoChart() {
  const pts = [
    [10, 70], [22, 55], [34, 75], [46, 40],
    [58, 60], [70, 30], [82, 50], [94, 35]
  ];
  const path = pts.map((p, i) => i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`).join(" ");
  const area = `${path} L 94 100 L 10 100 Z`;

  return (
    <div className="deco-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e6d8b4" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#0e4434" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path className="area-path" d={area} />
        {pts.map((p, i) => (
          <circle
            key={i} className="dot"
            cx={p[0]} cy={p[1]} r="1.4"
            style={{ animationDelay: `${4.0 + i * 0.15}s`, transformOrigin: `${p[0]}px ${p[1]}px` }}
          />
        ))}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Login Card — real auth + success/error feedback with sound
// ─────────────────────────────────────────────────────────────
function LoginCard({ onSuccess }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      const last = localStorage.getItem('ah97_last_user');
      if (last) setUser(last);
    } catch (_) {}
  }, []);

  const handle = async (e) => {
    e.preventDefault();
    if (!user || !pass || busy || success) return;
    setError("");
    setBusy(true);
    AudioEngine.engage();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setBusy(false);
        setError(data.error || 'بيانات الدخول غير صحيحة');
        AudioEngine.errorBuzz();
        return;
      }
      try {
        sessionStorage.setItem('ah97_authed', '1');
        if (remember) localStorage.setItem('ah97_last_user', user);
        else localStorage.removeItem('ah97_last_user');
      } catch (_) {}
      setBusy(false);
      setSuccess(true);
      AudioEngine.successChime();
      setTimeout(() => { onSuccess && onSuccess(); }, 750);
    } catch (err) {
      setBusy(false);
      setError('تعذّر الاتصال بالخادم');
      AudioEngine.errorBuzz();
    }
  };

  return (
    <form className="login-card" onSubmit={handle} autoComplete="off">
      <div className="login-glow" />
      <div className="login-head">
        <span className="login-line" />
        <span className="login-title">تسجيل الدخول</span>
        <span className="login-line" />
      </div>

      <label className="login-field">
        <span className="login-label">اسم المستخدم</span>
        <div className="login-input-wrap">
          <svg className="login-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onFocus={() => AudioEngine.hoverTick()}
            placeholder="admin"
            dir="ltr"
            className="login-input"
            autoFocus
          />
        </div>
      </label>

      <label className="login-field">
        <span className="login-label">كلمة المرور</span>
        <div className="login-input-wrap">
          <svg className="login-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <input
            type={showPass ? "text" : "password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onFocus={() => AudioEngine.hoverTick()}
            placeholder="••••••••••"
            dir="ltr"
            className="login-input"
          />
          <button type="button" className="login-eye" onClick={() => setShowPass(s => !s)} tabIndex={-1} title={showPass ? "إخفاء" : "إظهار"}>
            {showPass ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            )}
          </button>
        </div>
      </label>

      <div className="login-row">
        <label className="login-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="login-check-box" />
          <span>تذكّرني</span>
        </label>
        <a href="#" className="login-forgot" onClick={(e) => e.preventDefault()}>نسيت كلمة المرور؟</a>
      </div>

      {error && <div className="login-error">{error}</div>}

      <button
        type="submit"
        className={"login-submit " + (busy ? "busy " : "") + (success ? "ok" : "")}
        disabled={busy || success}
      >
        {success ? (
          <svg className="login-check-svg" viewBox="0 0 24 24">
            <polyline points="5 12 10 17 19 7" />
          </svg>
        ) : busy ? (
          <span className="login-spinner" />
        ) : (
          <>
            <span>دخول النظام</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
          </>
        )}
      </button>

      <div className="login-foot">
        <span className="login-dot" />
        <span>اتصال مشفّر · TLS 1.3</span>
        <span className="login-dot" />
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Splash component
// ─────────────────────────────────────────────────────────────
function Splash() {
  const [exiting, setExiting] = useState(false);
  const mountTimeRef = useRef(0);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    mountTimeRef.current = performance.now() / 1000;
    if (!CONFIG.soundOn) return;

    const launch = () => {
      if (hasStartedRef.current) return;
      hasStartedRef.current = true;
      const offset = (performance.now() / 1000) - mountTimeRef.current;
      playIntroTimeline(CONFIG.shardCount, offset);
    };

    const tryStart = () => {
      if (hasStartedRef.current) return;
      const ok = AudioEngine.init();
      if (!ok) return;
      AudioEngine.resume();
      setTimeout(() => {
        if (hasStartedRef.current) return;
        if (AudioEngine.ctx && AudioEngine.ctx.state === 'running') launch();
      }, 35);
    };

    // Try immediately — works if browser autoplay policy permits
    tryStart();

    // Fallback: any user gesture unlocks AudioContext
    const gestureEvents = ['pointerdown', 'keydown', 'touchstart', 'click'];
    gestureEvents.forEach(ev =>
      window.addEventListener(ev, tryStart, { passive: true, capture: true })
    );
    return () => {
      gestureEvents.forEach(ev =>
        window.removeEventListener(ev, tryStart, { capture: true })
      );
    };
  }, []);

  const handleLoginSuccess = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      window.location.replace('/');
    }, 1000);
  }, []);

  return (
    <div className={`stage v-donutcine ${exiting ? "exiting" : ""}`}>
      <div className="beams">
        <div className="beam b1" />
        <div className="beam b2" />
        <div className="beam b3" />
        <div className="beam b4" />
      </div>

      <div className="logo-stage">
        <DonutSVG count={CONFIG.shardCount} />
        <div className="donut-center" />
        <div className="donut-logo" />
      </div>

      <DecoChart />

      <div className="textblock">
        <div className="ornament">
          <span className="line" />
          <span className="diamond" />
          <span className="line" />
        </div>
        <div className="welcome">{CONFIG.welcomeText}</div>
        <h1 className="title">
          <span className="title-wrap">{CONFIG.titleText}</span>
        </h1>
      </div>

      <LoginCard onSuccess={handleLoginSuccess} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Splash />);
