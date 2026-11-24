"use client";

import { onIdTokenChanged, type Auth, type User } from "@firebase/auth";
import { useEffect, useState } from "react";
import { Workspace } from "./workspace";
import { authentication, errorText } from "./lib";
import { Brand, SignIn } from "./sign-in";

export default function Page() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [verified, setVerified] = useState(false);
  const [ready, setReady] = useState(false);
  const [configError, setConfigError] = useState("");
  useEffect(() => {
    try {
      const instance = authentication();
      setAuth(instance);
      return onIdTokenChanged(instance, session => {
        setUser(session);
        setVerified(Boolean(session?.emailVerified));
        setReady(true);
      }, error => { setConfigError(errorText(error)); setReady(true); });
    } catch (error) {
      setConfigError(errorText(error));
      setReady(true);
    }
  }, []);
  if (!ready) return <main className="boot"><Brand /><p role="status">Loading workspace…</p></main>;
  if (!auth || !user || !verified) {
    return <SignIn auth={auth} user={user} onVerified={() => setVerified(true)} configError={configError} />;
  }
  return <Workspace key={user.uid} auth={auth} user={user} />;
}
