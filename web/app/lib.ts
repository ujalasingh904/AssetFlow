import { getApp, getApps, initializeApp } from "@firebase/app";
import { getAuth, type User } from "@firebase/auth";

const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

export function authentication() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  if (Object.values(config).some(value => !value) || !apiBase) {
    throw new Error("Add the Firebase web settings and API URL in web/.env.local, then restart the app.");
  }
  return getAuth(getApps().length ? getApp() : initializeApp(config));
}

export function errorText(error: unknown) {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    "auth/invalid-credential": "Check your email and password, then try again.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Choose a stronger password.",
    "auth/popup-closed-by-user": "The Google sign-in window was closed. You can try again.",
    "auth/popup-blocked": "Allow pop-ups for this site to sign in with Google.",
    "auth/account-exists-with-different-credential": "This email uses another sign-in method. Sign in with your password.",
    "auth/email-already-in-use": "This email already has an account. Sign in or reset your password.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  };
  return (code && messages[code]) || (code?.startsWith("auth/")
    ? "Firebase could not complete the request. Check your connection and sign-in settings."
    : error instanceof Error ? error.message : "Something went wrong.");
}

export async function api<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  if (!apiBase) throw new Error("The API URL is missing.");
  const headers = new Headers(init.headers);
  const token = await user.getIdToken(path === "/me");
  headers.set("Authorization", "Bearer " + token);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(apiBase + path, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.detail;
    const line = Array.isArray(detail) ? detail.map(issue => issue.msg).join(" ") : detail;
    throw new Error(typeof line === "string" ? line : "The API could not complete the request.");
  }
  if (path === "/loans/export") return await response.blob() as T;
  return response.json();
}

export type Role = "borrower" | "staff" | "admin";
export type Member = { uid: string; name: string; email: string; role: Role };
export type Profile = Member & { today: string; ai_enabled: boolean };
export type Photo = { id: number; url: string };
export type Asset = {
  id: number; tag: string; name: string; category: string; location: string;
  description: string; published: boolean; maintenance: boolean; condition: string;
  status: string; photos: Photo[];
};
export type Loan = {
  id: number; asset_name: string; tag: string; starts: string; ends: string; purpose: string;
  status: string; overdue: boolean; decision_note: string | null; return_note: string | null;
  borrower_name: string;
};
export type Activity = {
  id: number; action: string; detail: string; asset_name: string | null; actor: string; created_at: string;
};
export type Stats = {
  total: number; available: number; reserved: number; checked_out: number;
  maintenance: number; pending: number; overdue: number;
};
export type Page<T> = { items: T[]; more: boolean };
export type Draft = { category: string; priority: string; summary: string; next_step: string };

export function title(value: string) {
  return value.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
}

export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(value + "T00:00:00Z"));
}
