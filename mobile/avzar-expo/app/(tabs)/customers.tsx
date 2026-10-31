import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { api } from '@/api/client';
import { Avatar, Button, Card, Chip, EmptyState, Field, Heading, Loading, Message, Screen, colors, statusTone } from '@/components/ui';

export default function CustomersScreen() {
  const [search, setSearch] = useState('');
  const router = useRouter();
  const queryClient = useQueryClient();
  useFocusEffect(useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  }, [queryClient]));
  const customers = useQuery({ queryKey: ['customers', search], queryFn: () => api.customers(search) });

  return (
    <Screen>
      <Heading subtitle="Customer profiles, garment preferences and measurement records.">Customers</Heading>
      <Field label="Search customers" value={search} onChangeText={setSearch} placeholder="Name, email or phone" returnKeyType="search" />
      <Button title="+  Add customer" onPress={() => router.push('/customers/new')} />
      {customers.isLoading ? <Loading /> : customers.isError ? (
        <Message tone="danger">{customers.error instanceof Error ? customers.error.message : 'Could not load customers.'}</Message>
      ) : (
        <FlatList
          data={customers.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ gap: 10, paddingBottom: 28 }}
          ListEmptyComponent={<EmptyState title={search.trim() ? 'No customers match' : 'No customers yet'} body={search.trim() ? 'Try another name, email or phone number.' : 'Add your first customer to start keeping profiles and measurements.'} action={search.trim() ? undefined : 'Add customer'} onAction={() => router.push('/customers/new')} />}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.fullName}`} onPress={() => router.push({ pathname: '/customers/[id]', params: { id: item.id } })}>
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Avatar name={item.fullName} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{item.fullName}</Text>
                  <Text style={{ color: colors.muted, fontSize: 13 }}>{item.phone || item.email || 'No contact details'}</Text>
                  <Text style={{ color: colors.muted, fontSize: 12 }}>{item.orderCount} order{item.orderCount === 1 ? '' : 's'}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  {item.status ? <Chip label={item.status} tone={statusTone(item.status)} /> : null}
                  <Text style={{ color: colors.brand, fontWeight: '800', fontSize: 18 }}>›</Text>
                </View>
              </Card>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}
