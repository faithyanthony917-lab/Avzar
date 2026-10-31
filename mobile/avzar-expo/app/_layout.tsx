import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SessionProvider, useSession } from '@/auth/SessionProvider';
import { colors } from '@/components/ui';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

function NavigationGuard() {
  const { user, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === 'login';
    if (!user && !inAuth) router.replace('/login');
    else if (user && inAuth) router.replace('/(tabs)');
  }, [user, loading, segments, router]);

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.brand} size="large" /></View>;
  return <Stack screenOptions={{ headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text, headerShadowVisible: false, headerTitleStyle: { fontWeight: '800' }, contentStyle: { backgroundColor: colors.background } }}><Stack.Screen name="login" options={{ headerShown: false }} /><Stack.Screen name="(tabs)" options={{ headerShown: false }} /><Stack.Screen name="customers/new" options={{ title: 'New customer', presentation: 'modal' }} /><Stack.Screen name="customers/[id]/index" options={{ title: 'Customer' }} /><Stack.Screen name="customers/[id]/measurements" options={{ title: 'Measurements' }} /></Stack>;
}

export default function RootLayout() {
  return <QueryClientProvider client={queryClient}><SessionProvider><StatusBar style="dark" /><NavigationGuard /></SessionProvider></QueryClientProvider>;
}
