import { auth, googleProvider } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const errorBox = document.getElementById("error-box");
const infoBox = document.getElementById("info-box");

function showError(message) {
  infoBox.style.display = "none";
  errorBox.textContent = message;
  errorBox.style.display = "block";
}
function showInfo(message) {
  errorBox.style.display = "none";
  infoBox.textContent = message;
  infoBox.style.display = "block";
}
function clearMessages() {
  errorBox.style.display = "none";
  infoBox.style.display = "none";
}
function goToDashboard() {
  window.location.href = "dashboard.html";
}

// ---- switch between login and signup ----
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const heading = document.getElementById("heading");
const subtitle = document.getElementById("subtitle");
const switchRow = document.getElementById("switch-row");
let isLogin = true;

function renderSwitchRow() {
  switchRow.innerHTML = isLogin
    ? `Don't have an account? <a id="switch-link">Sign up free</a>`
    : `Already have an account? <a id="switch-link">Log in</a>`;
  document.getElementById("switch-link").addEventListener("click", toggleMode);
}
function toggleMode() {
  isLogin = !isLogin;
  loginForm.style.display = isLogin ? "block" : "none";
  signupForm.style.display = isLogin ? "none" : "block";
  heading.textContent = isLogin ? "Welcome back" : "Create your account";
  subtitle.textContent = isLogin
    ? "Log in to your procurement dashboard"
    : "Start automating procurement in minutes";
  clearMessages();
  renderSwitchRow();
}
renderSwitchRow();

// ---- password show/hide toggle ----
document.querySelectorAll(".toggle-eye").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  });
});

// ---- signup ----
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMessages();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;

  if (!email || !password) return showError("Please fill in both email and password.");
  if (password.length < 6) return showError("Password must be at least 6 characters.");

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    goToDashboard();
  } catch (err) {
    showError(err.message);
  }
});

// ---- login (with remember-me persistence) ----
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMessages();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const remember = document.getElementById("remember-me").checked;

  if (!email || !password) return showError("Please fill in both email and password.");

  try {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    goToDashboard();
  } catch (err) {
    showError(err.message);
  }
});

// ---- forgot password ----
document.getElementById("forgot-link").addEventListener("click", async (e) => {
  e.preventDefault();
  clearMessages();
  const email = document.getElementById("login-email").value.trim();
  if (!email) return showError("Enter your email above first, then click Forgot password.");

  try {
    await sendPasswordResetEmail(auth, email);
    showInfo("Password reset email sent — check your inbox.");
  } catch (err) {
    showError(err.message);
  }
});

// ---- Google login ----
document.getElementById("google-btn").addEventListener("click", async () => {
  clearMessages();
  try {
    await signInWithPopup(auth, googleProvider);
    goToDashboard();
  } catch (err) {
    showError(err.message);
  }
});