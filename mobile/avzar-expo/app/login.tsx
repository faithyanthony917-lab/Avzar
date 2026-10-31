import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { BusinessSelectionRequiredError } from '@/api/client';
import { BrandMark, Button, Card, Field, Heading, Message, colors } from '@/components/ui';
import { useSession } from '@/auth/SessionProvider';
import type { MobileBusinessChoice } from '@/types/api';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<MobileBusinessChoice[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(businessId?: string) {
    setBusy(true); setError('');
    try {
      await signIn(email, password, businessId);
    } catch (err) {
      if (err instanceof BusinessSelectionRequiredError) {
        setChoices(err.choices);
        if (err.choices.length === 1) setSelectedBusinessId(err.choices[0].businessId);
        setError('This account belongs to more than one business. Select the workspace to continue.');
      } else setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
    } finally { setBusy(false); }
  }

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 22 }} keyboardShouldPersistTaps="handled"><View style={{ gap: 22 }}><View style={{ gap: 18 }}><BrandMark size={48} /><Heading subtitle="Your tailoring business, organised in one place.">Welcome back.</Heading></View><Card><Field label="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="you@business.com" editable={!busy} /><Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" placeholder="Enter your password" editable={!busy} />{choices.length > 0 ? <View style={{ gap: 8 }}><Text style={{ fontWeight: '700', color: colors.text }}>Choose your business</Text>{choices.map((choice) => <Button key={choice.businessId} title={`${selectedBusinessId === choice.businessId ? '✓  ' : ''}${choice.businessName}`} variant={selectedBusinessId === choice.businessId ? 'primary' : 'secondary'} onPress={() => setSelectedBusinessId(choice.businessId)} />)}</View> : null}{error ? <Message tone="danger">{error}</Message> : null}<Button title={busy ? 'Signing in…' : choices.length ? 'Continue to workspace' : 'Sign in'} disabled={busy || !email.trim() || !password || (choices.length > 0 && !selectedBusinessId)} onPress={() => submit(selectedBusinessId)} /></Card><Message>Secure sign-in connects to your Avzar API. If sign-in is not configured on the server, the app will show the actual API error.</Message></View></ScrollView></KeyboardAvoidingView>;
}
