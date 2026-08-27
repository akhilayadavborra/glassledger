import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAq_qsTafcVzQ8jDvnYt6aIhzo-iC0hyqQ",
  authDomain: "glaedger-44c89.firebaseapp.com",
  projectId: "glaedger-44c89",
  storageBucket: "glaedger-44c89.firebasestorage.app",
  messagingSenderId: "1095640713879",
  appId: "1:1095640713879:web:0f309e4589de5c8fc077d2"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();