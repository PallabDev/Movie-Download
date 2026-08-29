/**
 * CineGrab / TeleMedia - Authentication Form Handler
 */

async function handleAuthLogin(event) {
    event.preventDefault();
    const errorEl = document.getElementById('authError');
    const submitBtn = document.getElementById('btnAuthSubmit');
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (errorEl) errorEl.style.display = 'none';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in...';
    }

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        if (data.success) {
            window.location.href = '/';
        } else {
            if (errorEl) {
                errorEl.textContent = data.error || 'Invalid email or password';
                errorEl.style.display = 'block';
            }
        }
    } catch (err) {
        if (errorEl) {
            errorEl.textContent = 'Connection error. Please try again.';
            errorEl.style.display = 'block';
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
        }
    }
}

async function handleAuthRegister(event) {
    event.preventDefault();
    const errorEl = document.getElementById('authError');
    const submitBtn = document.getElementById('btnAuthSubmit');
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (errorEl) errorEl.style.display = 'none';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating account...';
    }

    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        const data = await response.json();
        if (data.success) {
            window.location.href = '/';
        } else {
            if (errorEl) {
                errorEl.textContent = data.error || 'Registration failed';
                errorEl.style.display = 'block';
            }
        }
    } catch (err) {
        if (errorEl) {
            errorEl.textContent = 'Connection error. Please try again.';
            errorEl.style.display = 'block';
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    }
}
