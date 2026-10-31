import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, hasStoredSession } from '@/api/client';
import type { MobileUser } from '@/types/api';

type SessionContextValue = {
  user: MobileUser | null;
  loading: boolean;
  signIn: (email: string, password: string, businessId?: string) => Promise<MobileUser>;
  signOut: () => Promise<void>;
  reloadUser: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: React.PropsWithChildren) {
  const [user, setUser] = useState<MobileUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reloadUser = useCallback(async () => {
    if (!(await hasStoredSession())) {
      setUser(null);
      return;
    }
    try {
      setUser(await api.currentUser());
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    reloadUser().finally(() => setLoading(false));
  }, [reloadUser]);

  const signIn = useCallback(async (email: string, password: string, businessId?: string) => {
    const tokens = await api.signIn(email, password, businessId);
    setUser(tokens.user);
    return tokens.user;
  }, []);

  const signOut = useCallback(async () => {
    await api.signOut();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, signIn, signOut, reloadUser }), [user, loading, signIn, signOut, reloadUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider.');
  return context;
}
