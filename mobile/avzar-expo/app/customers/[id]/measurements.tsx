import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { FlatList, Text, View } from 'react-native';
import { api } from '@/api/client';
import { Card, Heading, Loading, Message, Screen, colors } from '@/components/ui';

export default function MeasurementsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const query = useQuery({ queryKey: ['measurements', id], queryFn: () => api.measurements(id), enabled: Boolean(id) });

  return (
    <Screen>
      <Heading subtitle="Saved measurement profiles from this customer's record.">Measurements</Heading>
      {query.isLoading ? <Loading /> : query.isError ? (
        <Message tone="danger">{query.error instanceof Error ? query.error.message : 'Could not load measurements.'}</Message>
      ) : (
        <FlatList
          data={query.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
          ListEmptyComponent={
            <Card>
              <Text style={{ color: colors.text, fontWeight: '800' }}>No measurements recorded yet</Text>
              <Text style={{ color: colors.muted }}>This customer has no measurement profile in the API. Creating a measurement set requires choosing a template and entering the required values; the next pass will add that form.</Text>
            </Card>
          }
          renderItem={({ item }) => (
            <Card>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>{item.label}</Text>
              <Text style={{ color: colors.muted }}>{item.templateName} · revision {item.currentRevision}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>Updated {new Date(item.updatedAtUtc).toLocaleString()}</Text>
              <View style={{ gap: 7, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
                {item.values.map((value) => (
                  <View key={value.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={{ color: colors.muted, flex: 1 }}>{value.label}</Text>
                    <Text style={{ color: colors.text, fontWeight: '700' }}>{value.value} {value.unit}</Text>
                  </View>
                ))}
              </View>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
