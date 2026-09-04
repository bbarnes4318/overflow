document.addEventListener('DOMContentLoaded', () => {
  const authForm = document.getElementById('auth-form');
  const formTitle = document.getElementById('form-title');
  const formSubtitle = document.getElementById('form-subtitle');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const confirmPasswordGroup = document.querySelector('.confirm-password-group');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const btnSubmit = document.getElementById('btn-submit');
  const errorMsg = document.getElementById('error-msg');

  // There is no signup path any more. The platform superadmin is seeded when
  // the server first starts, and every other account is created by a
  // superadmin against a tenant that already exists, so this page only ever
  // signs in. The flag is kept so the submit handler below stays unchanged.
  const isSignupMode = false;

  formTitle.textContent = 'Sign in';
  formSubtitle.textContent = 'Sign in to access your dashboard';
  confirmPasswordGroup.style.display = 'none';
  confirmPasswordInput.required = false;
  btnSubmit.querySelector('span').textContent = 'Sign In';

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (isSignupMode) {
      const confirmPassword = confirmPasswordInput.value;
      if (password !== confirmPassword) {
        showError('Passwords do not match.');
        return;
      }
    }

    // Disable form fields
    btnSubmit.disabled = true;
    btnSubmit.querySelector('span').textContent = isSignupMode ? 'Creating...' : 'Signing In...';

    const url = isSignupMode ? '/api/auth/signup' : '/api/auth/login';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (res.ok) {
        // Successful signup/login: redirect to dashboard
        window.location.href = '/';
      } else {
        const data = await res.json();
        showError(data.error || 'Authentication failed. Please try again.');
        btnSubmit.disabled = false;
        btnSubmit.querySelector('span').textContent = isSignupMode ? 'Create Admin Account' : 'Sign In';
      }
    } catch (err) {
      console.error('Authentication request error:', err);
      showError('Network error. Please verify server connection.');
      btnSubmit.disabled = false;
      btnSubmit.querySelector('span').textContent = isSignupMode ? 'Create Admin Account' : 'Sign In';
    }
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }

  function clearError() {
    errorMsg.textContent = '';
    errorMsg.style.display = 'none';
  }
});
