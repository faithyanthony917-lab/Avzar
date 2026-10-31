import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { api } from '@/api/client';
import { Card, Heading, Loading, Message, Screen, Button, colors } from '@/components/ui';

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api.customer(id), enabled: Boolean(id) });
  const measurements = useQuery({ queryKey: ['measurements', id], queryFn: () => api.measurements(id), enabled: Boolean(id) });
  if (customer.isLoading) return <Loading />;
  if (customer.isError || !customer.data) return <Screen><Message tone="danger">{customer.error instanceof Error ? customer.error.message : 'Could not load this customer.'}</Message></Screen>;
  const item = customer.data;
  return <Screen><Heading subtitle={`Customer profile · ${item.status}`}>{item.fullName}</Heading><Card><Text style={{ color: colors.text, fontWeight: '800' }}>Contact</Text><Text style={{ color: colors.muted }}>{item.phone || 'No phone number'}</Text><Text style={{ color: colors.muted }}>{item.email || 'No email address'}</Text><Text style={{ color: colors.muted }}>{[item.addressLine, item.city].filter(Boolean).join(', ') || 'No address saved'}</Text></Card><Card><Text style={{ color: colors.text, fontWeight: '800' }}>Garment preferences</Text><Text style={{ color: colors.muted }}>{item.garmentPreferences || 'No preferences saved yet.'}</Text>{item.notes ? <Text style={{ color: colors.muted }}>Notes: {item.notes}</Text> : null}</Card><View style={{ gap: 8 }}><Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>Measurements</Text>{measurements.isLoading ? <Loading /> : measurements.isError ? <Message tone="danger">{measurements.error instanceof Error ? measurements.error.message : 'Could not load measurements.'}</Message> : <Card><Text style={{ color: colors.text, fontWeight: '700' }}>{measurements.data?.length ?? 0} measurement profile(s)</Text><Text style={{ color: colors.muted }}>Measurement profiles and revisions are loaded from the existing API.</Text>{(measurements.data ?? []).slice(0, 3).map((set) => <View key={set.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, gap: 4 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{set.label}</Text><Text style={{ color: colors.muted }}>{set.templateName} · revision {set.currentRevision}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{set.values.length} values · updated {new Date(set.updatedAtUtc).toLocaleDateString()}</Text></View>)}</Card>}</View><Button title="Open measurement history" onPress={() => router.push({ pathname: '/customers/[id]/measurements', params: { id } })} /></Screen>;
}
