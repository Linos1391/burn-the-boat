import { getApps, initializeApp } from "firebase/app"

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
}

const hasFirebaseConfig = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.length > 0
)

export const firebaseApp = hasFirebaseConfig
  ? (getApps().find((app) => app.name === "[DEFAULT]") ??
    initializeApp(firebaseConfig))
  : null
