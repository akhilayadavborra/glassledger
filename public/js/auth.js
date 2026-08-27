import { auth, googleProvider } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const errorBox = document.getElementById("error-box");

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function goToDashboard() {
  window.location.href = "dashboard.html";
}

// Toggle between login and signup views
const loginTab = document.getElementById("login-tab");
const signupTab = document.getElementById("signup-tab");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");

loginTab.addEventListener("click", () => {
  loginTab.classList.add("active");
  signupTab.classList.remove("active");
  loginForm.style.display = "block";
  signupForm.style.display = "none";
  errorBox.style.display = "none";
});

signupTab.addEventListener("click", () => {
  signupTab.classList.add("active");
  loginTab.classList.remove("active");
  signupForm.style.display = "block";
  loginForm.style.display = "none";
  errorBox.style.display = "none";
});

// Signup
document.getElementById("signup-btn").addEventListener("click", async () => {
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;

  if (!email || !password) {
    showError("Please fill in both email and password.");
    return;
  }
  if (password.length < 6) {
    showError("Password must be at least 6 characters.");
    return;
  }

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    goToDashboard();
  } catch (err) {
    showError(err.message);
  }
});

// Login
document.getElementById("login-btn").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  if (!email || !password) {
    showError("Please fill in both email and password.");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    goToDashboard();
  } catch (err) {
    showError(err.message);
  }
});

// Google login (works for both tabs)
document.querySelectorAll(".google-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      goToDashboard();
    } catch (err) {
      showError(err.message);
    }
  });
});