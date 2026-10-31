import { useQuery } from '@tanstack/react-query';
import { FlatList, Text, View } from 'react-native';
import { api } from '@/api/client';
import { Card, Chip, EmptyState, Heading, Loading, Message, Screen, colors, statusTone } from '@/components/ui';

type WorkerTask = {
  id: string;
  orderId?: string;
  orderNumber?: string;
  garmentName?: string;
  title: string;
  stageName?: string;
  status: string;
  deadlineUtc?: string | null;
};

type WorkerOrder = { id: string; orderNumber: string; garments: string[]; tasks: WorkerTask[] };

export default function WorkerOrdersScreen() {
  const tasks = useQuery({ queryKey: ['my-tasks'], queryFn: () => api.myTasks() });
  const orders = new Map<string, WorkerOrder>();
  for (const task of (tasks.data ?? []) as WorkerTask[]) {
    const id = task.orderId ?? task.orderNumber ?? task.id;
    const order = orders.get(id) ?? { id, orderNumber: task.orderNumber ?? 'Order number unavailable', garments: [], tasks: [] };
    order.tasks.push(task);
    if (task.garmentName && !order.garments.includes(task.garmentName)) order.garments.push(task.garmentName);
    orders.set(id, order);
  }
  const data = [...orders.values()];

  return (
    <Screen>
      <Heading subtitle="Orders represented by the production tasks assigned to you. Customer and payment details are not exposed here.">My orders</Heading>
      {tasks.isLoading ? <Loading /> : tasks.isError ? <Message tone="danger">{tasks.error instanceof Error ? tasks.error.message : 'Could not load your orders.'}</Message> : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
          ListEmptyComponent={<EmptyState title="No orders to show yet" body="Orders appear here when production tasks are assigned to your account." />}
          renderItem={({ item }) => (
            <Card>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>{item.orderNumber}</Text>
              {item.garments.length > 0 ? <Text style={{ color: colors.muted }}>Garments: {item.garments.join(', ')}</Text> : null}
              <Text style={{ color: colors.muted }}>{item.tasks.length} assigned task{item.tasks.length === 1 ? '' : 's'}</Text>
              {item.tasks.map((task) => (
                <View key={task.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <Text style={{ color: colors.text, lineHeight: 20, flex: 1 }}>{task.title}{task.stageName ? ` · ${task.stageName}` : ''}</Text>
                  <Chip label={task.status} tone={statusTone(task.status)} />
                </View>
              ))}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
