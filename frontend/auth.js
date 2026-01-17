// Authentication Module
// Password validation via Convex backend with role-based access

const AUTH_SESSION_KEY = 'ieee_presence_authenticated';
const AUTH_ROLE_KEY = 'ieee_presence_role';

// Check if already authenticated on page load
(function checkAuth() {
    if (sessionStorage.getItem(AUTH_SESSION_KEY) === 'true') {
        const role = sessionStorage.getItem(AUTH_ROLE_KEY) || 'user';
        showMainApp(role);
    }
})();

async function handleAuth(event) {
    event.preventDefault();

    const passwordInput = document.getElementById('auth-password');
    const errorDiv = document.getElementById('auth-error');
    const submitBtn = document.querySelector('.auth-submit');
    const password = passwordInput.value;

    if (!password.trim()) {
        errorDiv.textContent = 'Please enter a password';
        passwordInput.focus();
        return false;
    }

    // Disable button and show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';
    errorDiv.textContent = '';
    passwordInput.classList.remove('error');

    try {
        // Validate password via Convex backend
        const result = await window.convexClient.query("auth:validatePassword", { password });

        if (result.success) {
            // Store authentication and role in session
            sessionStorage.setItem(AUTH_SESSION_KEY, 'true');
            sessionStorage.setItem(AUTH_ROLE_KEY, result.role);

            // Animate transition
            const overlay = document.getElementById('auth-overlay');
            overlay.classList.add('fade-out');

            // After animation, hide completely and show app
            setTimeout(() => {
                overlay.classList.add('hidden');
                showMainApp(result.role);
            }, 300);
        } else {
            // Show error
            errorDiv.textContent = result.error || 'Incorrect password';
            passwordInput.classList.add('error');
            passwordInput.value = '';
            passwordInput.focus();

            // Shake animation
            const container = document.querySelector('.auth-container');
            container.classList.add('shake');
            setTimeout(() => {
                container.classList.remove('shake');
            }, 500);

            // Re-enable button
            submitBtn.disabled = false;
            submitBtn.textContent = 'Unlock';
        }
    } catch (err) {
        console.error('Auth error:', err);
        errorDiv.textContent = 'Authentication failed. Please try again.';

        // Re-enable button
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock';
    }

    return false;
}

function showMainApp(role) {
    const overlay = document.getElementById('auth-overlay');
    const mainApp = document.getElementById('main-app');

    // Hide the overlay completely
    overlay.classList.add('fade-out');
    overlay.classList.add('hidden');

    // Show and animate main app
    mainApp.style.display = 'block';
    // Force reflow to trigger animation
    void mainApp.offsetWidth;
    mainApp.classList.add('fade-in');

    // Apply role-based visibility
    applyRolePermissions(role);

    // Initialize the app (start Convex subscription)
    if (typeof window.initializeApp === 'function') {
        window.initializeApp();
    }
}

function applyRolePermissions(role) {
    // Store role globally for other scripts to access
    window.userRole = role;

    // Add role class to body for CSS-based hiding
    document.body.classList.remove('role-user', 'role-admin');
    document.body.classList.add(`role-${role}`);

    // If user role, hide admin-only elements
    if (role !== 'admin') {
        // Hide all elements with admin-only class
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = 'none';
        });
    }
}

// Function to check if current user is admin
window.isAdmin = function () {
    return sessionStorage.getItem(AUTH_ROLE_KEY) === 'admin';
};

// Make handleAuth available globally
window.handleAuth = handleAuth;
