// Avalor — Main app controller

let currentUser = null;
let currentPlan = 'trial';
let onboardingSteps = { 1: false, 2: false, 3: false };

// ─── AUTH ────────────────────────────────────────────────────────────────────

function showAuth(view) {
  document.getElementById('auth-login').style.display = view === 'login' ? 'block' : 'none';
  document.getElementById('auth-signup').style.display = view === 'signup' ? 'block' : 'none';
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'Please enter your email and password.';
    errEl.style.display = 'block';
    return;
  }

  btn.innerHTML = '<span class="loading-spinner"></span> Signing in…';
  btn.disabled = true;

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    errEl.textContent = 'Incorrect email or password. Please try again.';
    errEl.style.display = 'block';
    btn.innerHTML = 'Sign in';
    btn.disabled = false;
    return;
  }

  currentUser = data.user;
  launchApp();
}

async function handleSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const role = document.getElementById('signup-role').value;
  const errEl = document.getElementById('signup-error');
  const successEl = document.getElementById('signup-success');
  const btn = document.getElementById('signup-btn');

  errEl.style.display = 'none';
  successEl.style.display = 'none';

  if (!name || !email || !password) {
    errEl.textContent = 'Please fill in all fields.';
    errEl.style.display = 'block';
    return;
  }

  if (password.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    errEl.style.display = 'block';
    return;
  }

  btn.innerHTML = '<span class="loading-spinner"></span> Creating account…';
  btn.disabled = true;

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name, role }
    }
  });

  if (error) {
    errEl.textContent = error.message || 'Could not create account. Please try again.';
    errEl.style.display = 'block';
    btn.innerHTML = 'Create account — it\'s free';
    btn.disabled = false;
    return;
  }

  if (data.session) {
    // No email confirmation required — session is live, onAuthStateChange will fire SIGNED_IN
    // and handle profile creation there. Nothing more to do here.
  } else {
    // Email confirmation required — profile will be created in onAuthStateChange after confirmation
    successEl.textContent = 'Account created! Check your email to confirm your address, then sign in.';
    successEl.style.display = 'block';
    btn.innerHTML = 'Create account — it\'s free';
    btn.disabled = false;
  }
}

async function handleLogout() {
  await sb.auth.signOut();
  currentUser = null;
  document.getElementById('app').style.display = 'none';
  showAuth('login');
}

// ─── APP INIT ─────────────────────────────────────────────────────────────────

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  let appLaunched = false;

  if (session?.user) {
    currentUser = session.user;
    appLaunched = true;
    launchApp();
  } else {
    showAuth('login');
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      currentUser = session.user;

      // Ensure profile exists — covers the post-email-confirmation path where the
      // profile insert at signup was blocked by RLS (no session at that point).
      const meta = session.user.user_metadata || {};
      // Insert profile on first sign-in only — never overwrite plan or trial_started_at
      const { data: existingProfile } = await sb.from('profiles').select('id').eq('id', session.user.id).single();
      if (!existingProfile) {
        await sb.from('profiles').insert({
          id: session.user.id,
          full_name: meta.full_name || '',
          email: session.user.email || '',
          role: meta.role || '',
          plan: 'trial',
          trial_started_at: new Date().toISOString()
        });
      } else {
        await sb.from('profiles').update({
          full_name: meta.full_name || '',
          email: session.user.email || '',
          role: meta.role || '',
        }).eq('id', session.user.id);
      }

      if (!appLaunched) {
        appLaunched = true;
        launchApp();
      }
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      document.getElementById('app').style.display = 'none';
      showAuth('login');
    }
  });
}

async function launchApp() {
  document.getElementById('auth-login').style.display = 'none';
  document.getElementById('auth-signup').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Load profile
  if (currentUser) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();

    if (profile) {
      // Trial banner logic
      const trialStart = new Date(profile.trial_started_at || currentUser.created_at);
      const trialEnd = new Date(trialStart.getTime() + 14 * 24 * 60 * 60 * 1000);
      const now = new Date();
      const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (24 * 60 * 60 * 1000)));

      currentPlan = profile.plan || 'trial';

      if (profile.plan === 'trial') {
        document.getElementById('tier-badge').textContent = `Trial — ${daysLeft}d left`;
        document.getElementById('tier-badge').className = 'tier-badge trial';

        if (daysLeft <= 3) {
          const banner = document.getElementById('trial-banner');
          banner.style.display = 'flex';
          document.getElementById('trial-days-left').textContent = `${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
        }
      } else if (profile.plan === 'professional') {
        document.getElementById('tier-badge').textContent = 'Professional';
        document.getElementById('tier-badge').className = 'tier-badge professional';
        document.querySelector('.topbar-right .btn-primary').style.display = 'none';
      } else if (profile.plan === 'essential') {
        document.getElementById('tier-badge').textContent = 'Essential';
        document.getElementById('tier-badge').className = 'tier-badge essential';
      }

      // Account page
      document.getElementById('account-name').value = profile.full_name || '';
      document.getElementById('account-email').value = currentUser.email || '';
      document.getElementById('account-plan-name').textContent =
        profile.plan === 'trial' ? 'Free Trial'
        : profile.plan === 'professional' ? 'Professional'
        : 'Essential';

      if (profile.plan === 'trial') {
        const trialStart = new Date(profile.trial_started_at || currentUser.created_at);
        const trialEnd = new Date(trialStart.getTime() + 14 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.max(0, Math.ceil((trialEnd - new Date()) / (24 * 60 * 60 * 1000)));
        document.getElementById('account-plan-desc').textContent = `${daysLeft} days remaining in your free trial`;
      }

      // Load onboarding progress
      if (profile.onboarding_steps) {
        onboardingSteps = JSON.parse(profile.onboarding_steps);
        updateOnboardingUI();
      }
    }
  }

  window.dispatchEvent(new Event('appReady'));
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function showPage(id, tabEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');

  if (tabEl) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');
  }

  if (id === 'saved') loadSavedDeals();
  if (id === 'compare') loadCompare();
}

// ─── UPGRADE MODAL ───────────────────────────────────────────────────────────

function openUpgrade() {
  document.getElementById('upgrade-modal').classList.add('open');
}

function closeUpgrade() {
  document.getElementById('upgrade-modal').classList.remove('open');
}

function closeUpgradeOutside(e) {
  if (e.target === document.getElementById('upgrade-modal')) closeUpgrade();
}

async function choosePlan(plan) {
  if (!currentUser) return;

  const btn = document.getElementById(`btn-choose-${plan}`);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redirecting…';

  try {
    const res = await fetch('/api/stripe/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, userId: currentUser.id, email: currentUser.email }),
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'No checkout URL returned');
    }
  } catch (err) {
    toast('Something went wrong. Please try again.');
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Handle post-Stripe redirect params on page load
(function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('upgraded')) {
    // Clean URL immediately
    history.replaceState(null, '', '/');
    // Wait for auth to settle, then refresh plan from DB and show confirmation
    const { data: { subscription: upgradeSub } } = sb.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        upgradeSub.unsubscribe();
        const { data: profile } = await sb.from('profiles').select('plan').eq('id', session.user.id).single();
        if (profile && profile.plan !== 'trial') {
          toast(`You're on the ${profile.plan === 'professional' ? 'Professional' : 'Essential'} plan — welcome aboard!`);
        } else {
          // Webhook may not have landed yet — show optimistic message
          toast('Payment complete! Your plan will activate within a few seconds.');
        }
      }
    });
  } else if (params.has('cancelled')) {
    history.replaceState(null, '', '/');
    // Open the upgrade modal once the app has rendered
    window.addEventListener('appReady', () => openUpgrade(), { once: true });
  }
})()

// ─── ONBOARDING ──────────────────────────────────────────────────────────────

function markOnboardingStep(step) {
  onboardingSteps[step] = true;
  updateOnboardingUI();

  // Save to DB
  if (currentUser) {
    sb.from('profiles').update({
      onboarding_steps: JSON.stringify(onboardingSteps)
    }).eq('id', currentUser.id);
  }
}

function updateOnboardingUI() {
  const allDone = onboardingSteps[1] && onboardingSteps[2] && onboardingSteps[3];

  if (allDone) {
    const card = document.getElementById('onboarding-card');
    if (card) card.style.display = 'none';
    return;
  }

  for (let i = 1; i <= 3; i++) {
    const num = document.getElementById(`step${i}-num`);
    if (!num) continue;
    if (onboardingSteps[i]) {
      num.className = 'step-num done';
      num.innerHTML = '<i class="ti ti-check" style="font-size:11px"></i>';
    } else {
      const prevDone = i === 1 || onboardingSteps[i - 1];
      num.className = prevDone ? 'step-num active' : 'step-num';
      num.textContent = i;
    }
  }
}

// ─── ACCOUNT ─────────────────────────────────────────────────────────────────

async function updateProfile() {
  const name = document.getElementById('account-name').value.trim();
  if (!name) return;

  const { error } = await sb.from('profiles').update({ full_name: name }).eq('id', currentUser.id);

  if (error) {
    toast('Could not update profile', 'error');
  } else {
    toast('Profile updated', 'success');
  }
}

async function updatePassword() {
  const password = document.getElementById('new-password').value;

  if (password.length < 8) {
    toast('Password must be at least 8 characters', 'error');
    return;
  }

  const { error } = await sb.auth.updateUser({ password });

  if (error) {
    toast('Could not update password', 'error');
  } else {
    toast('Password updated', 'success');
    document.getElementById('new-password').value = '';
  }
}

// ─── TOAST ───────────────────────────────────────────────────────────────────

function toast(message, type = '') {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── KEYBOARD ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const loginEmail = document.getElementById('login-email');
    const signupBtn = document.getElementById('signup-btn');
    if (document.activeElement === loginEmail || document.activeElement === document.getElementById('login-password')) {
      handleLogin();
    }
  }
  if (e.key === 'Escape') closeUpgrade();
});

// ─── START ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
