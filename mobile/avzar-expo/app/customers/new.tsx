import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { api } from '@/api/client';
import { Button, Field, Heading, Message, Screen } from '@/components/ui';

export default function NewCustomerScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [garmentPreferences, setGarmentPreferences] = useState('');
  const [notes, setNotes] = useState('');
  const create = useMutation({ mutationFn: () => api.createCustomer({ fullName: fullName.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined, addressLine: addressLine.trim() || undefined, city: city.trim() || undefined, garmentPreferences: garmentPreferences.trim() || undefined, notes: notes.trim() || undefined }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['customers'] }); Alert.alert('Customer created', 'The customer was saved by Avzar.'); router.back(); } });
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled"><Screen><Heading subtitle="Save the customer profile first. You can add their measurements from the profile.">New customer</Heading><Field label="Full name *" value={fullName} onChangeText={setFullName} placeholder="Customer full name" autoCapitalize="words" /><Field label="Email" value={email} onChangeText={setEmail} placeholder="name@example.com" keyboardType="email-address" autoCapitalize="none" /><Field label="Phone" value={phone} onChangeText={setPhone} placeholder="Phone number" keyboardType="phone-pad" /><Field label="Address" value={addressLine} onChangeText={setAddressLine} placeholder="Street address" /><Field label="City" value={city} onChangeText={setCity} placeholder="City" /><Field label="Garment preferences" value={garmentPreferences} onChangeText={setGarmentPreferences} placeholder="Fabrics, fits, colours…" multiline /><Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Anything the tailor should remember" multiline />{create.isError ? <Message tone="danger">{create.error instanceof Error ? create.error.message : 'Could not create customer. Check your account permissions and try again.'}</Message> : null}<Button title={create.isPending ? 'Saving…' : 'Create customer'} disabled={create.isPending || fullName.trim().length < 2} onPress={() => create.mutate()} /><Button title="Cancel" variant="secondary" onPress={() => router.back()} /></Screen></ScrollView></KeyboardAvoidingView>;
}
