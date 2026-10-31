import { Alert, Text, View } from 'react-native';
import { useSession } from '@/auth/SessionProvider';
import { Avatar, Button, Card, Heading, Message, Screen, colors } from '@/components/ui';

export default function SettingsScreen() {
  const { user, signOut } = useSession();
  function confirmSignOut() {
    Alert.alert('Sign out?', 'You will need to sign in again to access your business.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); } }]);
  }
  return <Screen><Heading subtitle="Your account and workspace details.">Profile</Heading><Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}><Avatar name={user?.fullName} size={56} /><View style={{ flex: 1, gap: 2 }}><Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{user?.fullName}</Text><Text style={{ color: colors.muted }}>{user?.email}</Text></View></Card><Card><Text style={{ color: colors.muted, fontSize: 12, fontWeight: '800', letterSpacing: 1 }}>WORKSPACE</Text><Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{user?.businessName}</Text><Text style={{ color: colors.muted }}>Currency: {user?.currencyCode || 'Not specified'}</Text></Card><Message>Billing, staff permissions, business settings and subscription upgrades will be added after the first mobile workflows and API migration are verified.</Message><Button title="Sign out" variant="secondary" onPress={confirmSignOut} /></Screen>;
}
