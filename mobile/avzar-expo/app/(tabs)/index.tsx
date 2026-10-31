import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { ApiError, api } from '@/api/client';
import { useSession } from '@/auth/SessionProvider';
import { Avatar, BrandMark, Card, Chip, EmptyState, Message, SectionHeader, StatTile, colors, radius, statusTone } from '@/components/ui';

const pad = (value: number) => String(value).padStart(2, '0');
function monthRange(now = new Date()) {
  return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
}
function greeting(now = new Date()) {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}
function longDate(now = new Date()) {
  try { return now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase(); } catch { return now.toDateString().toUpperCase(); }
}
function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount); } catch { return `${currency} ${Math.round(amount).toLocaleString()}`; }
}
function dueText(deadline?: string | null) {
  if (!deadline) return 'No deadline';
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return 'No deadline';
  return `Due ${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

export default function HomeScreen() {
  const { user } = useSession();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { from, to } = monthRange();
  // The summary needs the reports.view permission; a 403 simply hides the figures (workers see their own day instead).
  const summary = useQuery({ queryKey: ['home-summary', from, to], queryFn: () => api.reportsSummary(from, to), retry: false });
  const tasks = useQuery({ queryKey: ['my-tasks'], queryFn: () => api.myTasks() });
  const summaryHidden = summary.isError && summary.error instanceof ApiError && (summary.error.status === 403 || summary.error.status === 401);
  const firstName = user?.fullName?.trim().split(/\s+/)[0];
  const nextTasks = [...(tasks.data ?? [])].sort((a, b) => (a.deadlineUtc ?? '9999').localeCompare(b.deadlineUtc ?? '9999')).slice(0, 4);

  async function refresh() {
    setRefreshing(true);
    try { await Promise.all([summary.refetch(), tasks.refetch()]); } finally { setRefreshing(false); }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={colors.brand} />}>
      <View style={{ backgroundColor: colors.brand, borderRadius: radius.lg, padding: 18, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <BrandMark light size={36} />
          <Avatar name={user?.fullName} size={40} />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.onBrandMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 }}>{longDate()}</Text>
          <Text accessibilityRole="header" style={{ color: colors.onBrand, fontSize: 26, lineHeight: 32, fontWeight: '800' }}>{greeting()}{firstName ? `, ${firstName}` : ''}</Text>
          <Text style={{ color: colors.onBrandMuted, fontSize: 14 }}>{user?.businessName ? `Here’s ${user.businessName} today.` : 'Here’s your studio today.'}</Text>
        </View>
      </View>

      {summary.data ? (
        <View style={{ gap: 10 }}>
          <SectionHeader title="This month" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <StatTile label="Revenue received" value={money(summary.data.verifiedRevenue, summary.data.currencyCode || user?.currencyCode || 'NGN')} />
            <StatTile label="Orders created" value={String(summary.data.ordersCreated)} hint={`${summary.data.ordersDelivered} delivered`} />
            <StatTile label="Open tasks" value={String(summary.data.openTasks)} hint={summary.data.overdueTasks > 0 ? `${summary.data.overdueTasks} overdue` : 'None overdue'} tone={summary.data.overdueTasks > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Active customers" value={String(summary.data.activeCustomers)} />
          </View>
        </View>
      ) : summary.isError && !summaryHidden ? <Message tone="danger">Could not load this month’s figures. Pull down to try again.</Message> : null}

      <View style={{ gap: 10 }}>
        <SectionHeader title="Quick actions" />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {[{ label: 'Add customer', symbol: '＋', go: () => router.push('/customers/new') }, { label: 'Customers', symbol: '♙', go: () => router.push('/(tabs)/customers') }, { label: 'My tasks', symbol: '✓', go: () => router.push('/(tabs)/tasks') }].map((action) => (
            <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={action.go} style={({ pressed }) => ({ flex: 1, minHeight: 86, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8, opacity: pressed ? 0.85 : 1 })}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 18, fontWeight: '800' }}>{action.symbol}</Text></View>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800', textAlign: 'center' }}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={{ gap: 10 }}>
        <SectionHeader title="Today in the workroom" action={nextTasks.length > 0 ? 'See all' : undefined} onAction={() => router.push('/(tabs)/tasks')} />
        {tasks.isLoading ? <Message>Loading your tasks…</Message> : tasks.isError ? <Message tone="danger">{tasks.error instanceof Error ? tasks.error.message : 'Could not load your tasks.'}</Message> : nextTasks.length === 0 ? (
          <EmptyState title="Nothing assigned to you" body="Production tasks assigned to your account will appear here." />
        ) : nextTasks.map((task) => (
          <Pressable key={task.id} accessibilityRole="button" onPress={() => router.push('/(tabs)/tasks')}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, flex: 1 }}>{task.title}</Text>
                <Chip label={task.status} tone={statusTone(task.status)} />
              </View>
              <Text style={{ color: colors.muted, fontSize: 13 }}>{[task.orderNumber ? `Order ${task.orderNumber}` : null, task.garmentName, task.stageName].filter(Boolean).join(' · ') || 'Production task'}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{dueText(task.deadlineUtc)}</Text>
            </Card>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
