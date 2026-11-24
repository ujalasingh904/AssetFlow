"use client";

import { ArrowRight, Box, Check, ChevronRight, CircleHelp, PackageCheck, ShieldCheck } from "lucide-react";
import {
  createUserWithEmailAndPassword, GoogleAuthProvider, reload, sendEmailVerification,
  sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut, type Auth, type User,
} from "@firebase/auth";
import { useState, type FormEvent } from "react";
import { errorText } from "./lib";

export function Brand() {
  return <div className="brand"><span><Box size={22} strokeWidth={2.6} /></span>AssetFlow</div>;
}

export function SignIn({ auth, user, onVerified, configError }: {
  auth: Auth | null; user: User | null; onVerified: () => void; configError: string;
}) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem("");
    setMessage("");
    try { await action(); }
    catch (error) { setProblem(errorText(error)); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email")).trim();
    const password = String(data.get("password") ?? "");
    if (!auth) return;
    void run(async () => {
      if (mode === "reset") {
        try { await sendPasswordResetEmail(auth, email); }
        catch (error) { if ((error as { code?: string }).code !== "auth/user-not-found") throw error; }
        setMessage("If an account exists for this address, Firebase will send a reset link.");
      } else if (mode === "signup") {
        const account = await createUserWithEmailAndPassword(auth, email, password);
        await sendEmailVerification(account.user);
        setMessage("Verification email sent.");
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    });
  }

  return <main className="welcome">
    <section className="welcome-panel">
      <Brand />
      <div className="welcome-copy">
        <span className="welcome-icon"><PackageCheck size={31} /></span>
        <h1>Shared equipment.<br /><em>Accounted for.</em></h1>
        <p>Reserve equipment, manage handovers, and keep a clear record of every return.</p>
        <div className="welcome-steps">
          <div><span><Check size={17} /></span>Reserve equipment<ChevronRight size={16} /></div>
          <div><span><Check size={17} /></span>Approve and check out<ChevronRight size={16} /></div>
          <div><span><Check size={17} /></span>Record returns and repairs<ChevronRight size={16} /></div>
        </div>
      </div>
      <span className="welcome-footer"><ShieldCheck size={16} /> Equipment lending workspace</span>
    </section>
    <section className="auth-panel">
      <div className="auth-box">
        <div className="mobile-brand"><Brand /></div>
        <h2>{user ? "Verify your email" : mode === "login" ? "Sign in to AssetFlow" : mode === "signup" ? "Create an account" : "Reset your password"}</h2>
        <p>{user ? `Open the verification link sent to ${user.email}, then return here.`
          : mode === "reset" ? "Enter your account email to receive a reset link."
          : "Access your equipment lending workspace."}</p>
        {(problem || configError) && <div className="notice error" role="alert">{problem || configError}</div>}
        {message && <div className="notice success" role="status">{message}</div>}
        {user ? <div className="stack">
          <button className="primary" disabled={busy} onClick={() => void run(async () => {
            await reload(user);
            if (!user.emailVerified) throw new Error("Verification is still pending. Open the email link first.");
            await user.getIdToken(true);
            onVerified();
          })}>I’ve verified my email <ArrowRight size={17} /></button>
          <button className="secondary" disabled={busy} onClick={() => void run(async () => {
            await sendEmailVerification(user);
            setMessage("Verification email sent.");
          })}>Resend email</button>
          <button className="text-button" disabled={busy || !auth} onClick={() => auth && void run(() => signOut(auth))}>Sign out</button>
        </div> : <>
          {mode !== "reset" && <>
            <button className="secondary google" disabled={busy || !auth} onClick={() => auth && void run(async () => {
              await signInWithPopup(auth, new GoogleAuthProvider());
            })}><span className="google-g" aria-hidden>G</span> Continue with Google</button>
            <div className="divider"><span>or continue with email</span></div>
          </>}
          <form className="stack" onSubmit={submit} key={mode}>
            <label>Email address<input name="email" type="email" placeholder="you@example.com" autoComplete="email" required /></label>
            {mode !== "reset" && <label>Password<input name="password" type="password" minLength={mode === "signup" ? 8 : undefined}
              placeholder={mode === "signup" ? "At least 8 characters" : "Enter your password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"} required /></label>}
            {mode === "login" && <button className="text-button self-end" type="button" onClick={() => { setMode("reset"); setMessage(""); setProblem(""); }}>Forgot password?</button>}
            <button className="primary" disabled={busy || !auth}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"} <ArrowRight size={17} /></button>
          </form>
          <div className="auth-switch">{mode === "login" && "New to AssetFlow? "}
            <button className="text-button" type="button" onClick={() => {
              setMode(mode === "login" ? "signup" : "login"); setMessage(""); setProblem("");
            }}>{mode === "login" ? "Create an account" : "Back to sign in"}</button>
          </div>
        </>}
        <div className="auth-help"><CircleHelp size={15} /> Contact your workspace admin for staff access.</div>
      </div>
    </section>
  </main>;
}
