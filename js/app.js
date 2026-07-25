// Avalor — Main app controller

let currentUser = null;
let currentPlan = 'trial';
let trialExpired = false;
let onboardingSteps = { 1: false, 2: false, 3: false };
let appLaunched = false;

// Single source of truth for trial day-count/expiry — previously duplicated
// (and could drift) between the nav badge/banner and the account page.
function getTrialStatus(trialStart) {
  const trialEndMs = trialStart.getTime() + 14 * 24 * 60 * 60 * 1000;
  const daysLeft = Math.max(0, Math.ceil((trialEndMs - Date.now()) / (24 * 60 * 60 * 1000)));
  return { daysLeft, expired: Date.now() >= trialEndMs };
}

function showTrialExpiredScreen() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('trial-expired').style.display = 'block';
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

function showAuth(view) {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('auth-login').style.display = view === 'login' ? 'block' : 'none';
  document.getElementById('auth-signup').style.display = view === 'signup' ? 'block' : 'none';
}

function showLanding() {
  document.getElementById('auth-login').style.display = 'none';
  document.getElementById('auth-signup').style.display = 'none';
  document.getElementById('landing').style.display = 'block';
}

// ─── SUBSCRIBE NOW (skip trial) ─────────────────────────────────────────────
// Lets a decisive landing-page visitor pay upfront instead of starting a
// trial. There's no way to attach a Stripe subscription to an account that
// doesn't exist yet (the webhook needs a userId to write the plan to), so
// this still goes through account creation — it just records which plan was
// picked and redirects straight to Stripe checkout once the account exists,
// instead of opening the trial app. The pending plan is stashed in
// localStorage (not a plain variable) so it survives the email-confirmation
// round trip, and expires after 30 minutes so an abandoned attempt can never
// hijack an unrelated later login into an unexpected checkout redirect.

const PENDING_CHECKOUT_KEY = 'avalor_pending_checkout_plan';
const PENDING_CHECKOUT_TTL_MS = 30 * 60 * 1000;

function clearPendingCheckoutPlan() {
  localStorage.removeItem(PENDING_CHECKOUT_KEY);
}

function startCheckout(plan) {
  localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({ plan, ts: Date.now() }));
  showAuth('signup');
}

// Entry points for plain (non-checkout) sign-in/sign-up intent — clears any
// stale pending plan from an abandoned "subscribe now" attempt so it can't
// carry over into this unrelated sign-in.
function startTrialSignup() {
  clearPendingCheckoutPlan();
  showAuth('signup');
}

function startSignIn() {
  clearPendingCheckoutPlan();
  showAuth('login');
}

// One-shot read: always clears the stored value, whether or not it was valid,
// so a single pending plan is never applied twice.
function consumePendingCheckoutPlan() {
  const raw = localStorage.getItem(PENDING_CHECKOUT_KEY);
  clearPendingCheckoutPlan();
  if (!raw) return null;

  try {
    const { plan, ts } = JSON.parse(raw);
    if (!plan || !ts || Date.now() - ts > PENDING_CHECKOUT_TTL_MS) return null;
    return plan;
  } catch (_) {
    return null;
  }
}

function hideInitialLoader() {
  const loader = document.getElementById('initial-loader');
  if (loader) loader.style.display = 'none';
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
  // Don't call launchApp() here — the onAuthStateChange SIGNED_IN listener
  // (registered in init()) fires from signInWithPassword() and calls it once
  // the profile row is confirmed to exist. Calling it here too raced it,
  // sometimes launching before the profile insert/update had landed.
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
  trialExpired = false;
  appLaunched = false;
  document.getElementById('app').style.display = 'none';
  document.getElementById('trial-expired').style.display = 'none';
  showLanding();
}

// ─── APP INIT ─────────────────────────────────────────────────────────────────

async function init() {
  const { data: { session } } = await sb.auth.getSession();

  if (session?.user) {
    currentUser = session.user;
    launchApp();
  } else {
    hideInitialLoader();
    showLanding();
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

      // "Subscribe now" from the landing page — skip the trial app entirely
      // and go straight to Stripe checkout for the plan they picked.
      const pendingPlan = consumePendingCheckoutPlan();
      if (pendingPlan) {
        try {
          await redirectToCheckout(pendingPlan, session.user.id, session.user.email);
        } catch (err) {
          toast('Something went wrong starting checkout — please try again from your account page.', 'error');
          launchApp();
        }
        return;
      }

      launchApp();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      trialExpired = false;
      document.getElementById('app').style.display = 'none';
      document.getElementById('trial-expired').style.display = 'none';
      showLanding();
    }
  });
}

async function launchApp() {
  if (appLaunched) return;
  appLaunched = true;

  document.getElementById('landing').style.display = 'none';
  document.getElementById('auth-login').style.display = 'none';
  document.getElementById('auth-signup').style.display = 'none';

  // Load profile
  if (currentUser) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();

    if (profile) {
      // Normalize once — a plan value that isn't an exact 'trial'/'essential'/'professional'
      // match (stray whitespace, wrong case from a manual DB edit, etc.) used to make the
      // badge's strict if/else-if chain silently no-op, leaving the hardcoded "Trial" markup
      // from the HTML in place, while this same normalization on the account page masked it.
      const plan = ['trial', 'essential', 'professional'].includes(String(profile.plan || '').trim().toLowerCase())
        ? String(profile.plan).trim().toLowerCase()
        : 'trial';

      const trialStart = new Date(profile.trial_started_at || currentUser.created_at);
      const { daysLeft, expired } = getTrialStatus(trialStart);

      currentPlan = plan;
      trialExpired = plan === 'trial' && expired;

      // Hard stop: an expired trial never sees the app itself, just the
      // paywall — enforced for real server-side (requireActiveAccess in
      // serve.js gates the paid data proxies), this is just the matching UI.
      if (trialExpired) {
        hideInitialLoader();
        showTrialExpiredScreen();
        window.dispatchEvent(new Event('appReady'));
        return;
      }

      document.getElementById('app').style.display = 'block';

      const badge = document.getElementById('tier-badge');
      if (plan === 'trial') {
        badge.textContent = `Trial — ${daysLeft}d left`;
        badge.className = 'tier-badge trial';

        if (daysLeft <= 3) {
          const banner = document.getElementById('trial-banner');
          banner.style.display = 'flex';
          document.getElementById('trial-days-left').textContent = `${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
        }
      } else if (plan === 'professional') {
        badge.textContent = 'Professional';
        badge.className = 'tier-badge professional';
        document.querySelector('.topbar-right .btn-primary').style.display = 'none';
      } else if (plan === 'essential') {
        badge.textContent = 'Essential';
        badge.className = 'tier-badge essential';
      }

      // Account page
      document.getElementById('account-name').value = profile.full_name || '';
      document.getElementById('account-email').value = currentUser.email || '';
      document.getElementById('account-plan-name').textContent =
        plan === 'trial' ? 'Free Trial'
        : plan === 'professional' ? 'Professional'
        : 'Essential';
      document.getElementById('account-manage-sub-btn').style.display =
        (plan === 'essential' || plan === 'professional') ? '' : 'none';

      document.getElementById('account-plan-desc').textContent =
        plan === 'trial' ? `${daysLeft} days remaining in your free trial` : 'Renews monthly — manage or cancel below';

      // Load onboarding progress
      if (profile.onboarding_steps) {
        onboardingSteps = JSON.parse(profile.onboarding_steps);
        updateOnboardingUI();
      }
    } else {
      document.getElementById('app').style.display = 'block';
    }
  } else {
    document.getElementById('app').style.display = 'block';
  }

  hideInitialLoader();

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

// Shared by choosePlan (existing-user upgrade modal / trial-expired screen)
// and the post-signup "subscribe now" redirect below — neither depends on a
// specific button element existing in the DOM.
async function redirectToCheckout(plan, userId, email) {
  const res = await fetch('/api/stripe/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, userId, email }),
  });
  const data = await res.json();
  if (data.url) {
    window.location.href = data.url;
  } else {
    throw new Error(data.error || 'No checkout URL returned');
  }
}

async function choosePlan(plan, btnEl) {
  if (!currentUser) return;

  const btn = btnEl || document.getElementById(`btn-choose-${plan}`);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redirecting…';

  try {
    await redirectToCheckout(plan, currentUser.id, currentUser.email);
  } catch (err) {
    toast('Something went wrong. Please try again.');
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function manageSubscription() {
  if (!currentUser) return;

  const btn = document.getElementById('account-manage-sub-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redirecting…';

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch('/api/stripe/create-portal-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'No portal URL returned');
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
  } else if (params.has('portal_return')) {
    history.replaceState(null, '', '/');
    // Billing portal changes (cancellation, payment method, etc.) are applied
    // via webhook and may not have landed yet — this is an optimistic message,
    // not a confirmation that anything actually changed.
    toast('Welcome back — any billing changes may take a few seconds to reflect.');
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
