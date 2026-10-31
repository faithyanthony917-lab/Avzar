import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { AppState, FlatList, Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, realtimeAccessToken, taskPhotoFileUrl } from '@/api/client';
import { Button, Card, Field, Heading, Loading, Message, Screen, colors } from '@/components/ui';
import { useTaskEvents, type LiveState } from '@/realtime/events';
import { listPending, performTaskAction, syncQueue, type TaskActionName } from '@/offline/queue';

type Task = { id: string; orderId?: string; orderNumber?: string; garmentName?: string; title: string; stageName?: string; status: string; deadlineUtc?: string | null; instructions?: string | null; blockedReason?: string | null };
type IssueType = 'MissingMaterials' | 'Defect' | 'Clarification' | 'Other';
const ISSUE_TYPES: Array<{ label: string; value: IssueType }> = [
  { label: 'Missing materials', value: 'MissingMaterials' }, { label: 'Defect', value: 'Defect' },
  { label: 'Need clarification', value: 'Clarification' }, { label: 'Other', value: 'Other' },
];
type Info = { tone: 'muted' | 'danger' | 'success'; text: string };

const LIVE_LABEL: Record<LiveState, string> = {
  connecting: 'Live updates: connecting…',
  live: 'Live updates: on',
  reconnecting: 'Live updates: reconnecting…',
  offline: 'Live updates: off (use refresh)',
};

const ACTIONS: Array<{ label: string; action: TaskActionName }> = [
  { label: 'Start', action: 'start' },
  { label: 'Pause', action: 'pause' },
  { label: 'Resume', action: 'resume' },
  { label: 'Complete', action: 'complete' },
];

export default function TasksScreen() {
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ['my-tasks'], queryFn: () => api.myTasks() });
  const pending = useQuery({ queryKey: ['pending-actions'], queryFn: listPending });
  const [note, setNote] = useState('');
  const [issueTaskId, setIssueTaskId] = useState<string | null>(null);
  const [issueType, setIssueType] = useState<IssueType>('Other');
  const [issueDescription, setIssueDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [photosByTask, setPhotosByTask] = useState<Record<string, Array<{ id: string; caption: string | null; uploadedAtUtc: string; fileName: string }>>>({});
  const [photoTokens, setPhotoTokens] = useState<Record<string, string>>({});
  const [photoCaption, setPhotoCaption] = useState('');
  const [photoBusyTask, setPhotoBusyTask] = useState<string | null>(null);
  const live = useTaskEvents(useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['my-tasks'] });
  }, [queryClient]));

  const refreshAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['my-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] }),
    ]);
  }, [queryClient]);

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      const result = await syncQueue();
      if (result.rejected.length > 0) setInfo({ tone: 'danger', text: `Some saved actions were refused by the server: ${result.rejected.join('; ')}` });
      else if (result.sent > 0) setInfo({ tone: 'success', text: `Sent ${result.sent} saved action${result.sent === 1 ? '' : 's'}.` });
      await refreshAll();
    } catch {
      // Nothing to do: the actions stay saved and the next sync tries again.
    } finally {
      setBusy(false);
    }
  }, [refreshAll]);

  // Send anything saved when the screen opens and every time the app returns to the foreground.
  useEffect(() => {
    void sync();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });
    return () => subscription.remove();
  }, [sync]);

  const act = async (taskId: string, action: TaskActionName) => {
    setBusy(true);
    setInfo(null);
    try {
      const outcome = await performTaskAction(taskId, action, note.trim() || undefined);
      if (action === 'pause' || action === 'complete') setNote('');
      setInfo(outcome === 'sent'
        ? { tone: 'success', text: 'Done.' }
        : { tone: 'muted', text: 'No connection. Saved on this phone and it will be sent automatically.' });
      await refreshAll();
    } catch (error) {
      setInfo({ tone: 'danger', text: error instanceof Error ? error.message : 'Could not complete that action.' });
    } finally {
      setBusy(false);
    }
  };

  const reportIssue = async (taskId: string) => {
    if (issueDescription.trim().length < 3) {
      setInfo({ tone: 'danger', text: 'Describe the issue in at least 3 characters.' });
      return;
    }
    setBusy(true);
    setInfo(null);
    try {
      await api.reportTaskIssue(taskId, issueType, issueDescription);
      setIssueTaskId(null);
      setIssueDescription('');
      setInfo({ tone: 'success', text: 'Issue reported. The task is now blocked and the workshop manager has been notified.' });
      await refreshAll();
    } catch (error) {
      setInfo({ tone: 'danger', text: error instanceof Error ? error.message : 'Could not report this issue.' });
    } finally {
      setBusy(false);
    }
  };

  const refreshPhotos = async (taskId: string) => {
    const [photos, token] = await Promise.all([api.taskPhotos(taskId), realtimeAccessToken()]);
    setPhotosByTask((current) => ({ ...current, [taskId]: photos }));
    setPhotoTokens((current) => ({ ...current, [taskId]: token }));
  };

  const addPhoto = async (taskId: string) => {
    setPhotoBusyTask(taskId); setInfo(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error('Allow photo-library access to attach a progress photo.');
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      await api.uploadTaskPhoto(taskId, asset.uri, asset.fileName ?? `progress-${Date.now()}.jpg`, asset.mimeType ?? 'image/jpeg', photoCaption);
      setPhotoCaption('');
      await refreshPhotos(taskId);
      setInfo({ tone: 'success', text: 'Progress photo uploaded.' });
    } catch (error) {
      setInfo({ tone: 'danger', text: error instanceof Error ? error.message : 'Could not upload the progress photo.' });
    } finally { setPhotoBusyTask(null); }
  };

  const queued = pending.data ?? [];
  const queuedFor = (taskId: string) => queued.filter((item) => item.taskId === taskId).map((item) => item.action);

  return (
    <Screen>
      <Heading subtitle="Tasks assigned to you by the workshop manager.">My tasks</Heading>
      {queued.length > 0 ? <Message>{queued.length} action{queued.length === 1 ? '' : 's'} waiting to be sent.</Message> : null}
      <Message>{LIVE_LABEL[live]}</Message>
      {info ? <Message tone={info.tone}>{info.text}</Message> : null}
      <Field label="Note (used when you pause or complete)" value={note} onChangeText={setNote} placeholder="Optional" />
      <Button title={busy ? 'Working…' : 'Refresh / send saved actions'} variant="secondary" disabled={busy} onPress={() => void sync()} />
      {tasks.isLoading ? <Loading /> : tasks.isError ? <Message tone="danger">{tasks.error instanceof Error ? tasks.error.message : 'Could not load tasks.'}</Message> : (
        <FlatList
          data={(tasks.data ?? []) as Task[]}
          keyExtractor={(task) => task.id}
          contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
          ListEmptyComponent={<Message>No assigned tasks were returned by the API.</Message>}
          renderItem={({ item }) => {
            const waiting = queuedFor(item.id);
            return (
              <Card>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{item.title}</Text>
                <Text style={{ color: colors.muted }}>{item.stageName ?? 'Production'} · {item.status}</Text>
                {item.orderNumber ? <Text style={{ color: colors.muted, fontSize: 12 }}>Order {item.orderNumber}{item.garmentName ? ` · ${item.garmentName}` : ''}</Text> : null}
                {item.blockedReason ? <Message tone="danger">Blocked: {item.blockedReason}</Message> : null}
                {item.deadlineUtc ? <Text style={{ color: colors.muted, fontSize: 12 }}>Due {new Date(item.deadlineUtc).toLocaleString()}</Text> : null}
                {item.instructions ? <Text style={{ color: colors.muted }}>{item.instructions}</Text> : null}
                <View style={{ gap: 8, marginTop: 6 }}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>Progress photos</Text>
                  <Field label="Photo caption (optional)" value={photoCaption} onChangeText={setPhotoCaption} maxLength={500} placeholder="Describe the progress" />
                  <Button title={photoBusyTask === item.id ? 'Uploading…' : 'Add progress photo'} variant="secondary" disabled={busy || photoBusyTask !== null} onPress={() => void addPhoto(item.id)} />
                  <Button title="Load photos" variant="secondary" disabled={busy || photoBusyTask !== null} onPress={() => void refreshPhotos(item.id).catch((error) => setInfo({ tone: 'danger', text: error instanceof Error ? error.message : 'Could not load photos.' }))} />
                  {(photosByTask[item.id] ?? []).map((photo) => <View key={photo.id} style={{ gap: 4 }}>
                    <Image source={{ uri: taskPhotoFileUrl(item.id, photo.id), headers: { Authorization: `Bearer ${photoTokens[item.id] ?? ''}` } }} style={{ width: '100%', height: 180, borderRadius: 8, backgroundColor: '#e5e7eb' }} resizeMode="cover" />
                    <Text style={{ color: colors.muted, fontSize: 12 }}>{photo.caption || photo.fileName} · {new Date(photo.uploadedAtUtc).toLocaleString()}</Text>
                  </View>)}
                </View>
                {waiting.length > 0 ? <Text style={{ color: colors.primary, fontSize: 12 }}>Waiting to send: {waiting.join(', ')}</Text> : null}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {ACTIONS.map(({ label, action }) => (
                    <Button key={action} title={label} variant="secondary" disabled={busy} onPress={() => void act(item.id, action)} />
                  ))}
                </View>
                {!['Completed', 'Cancelled', 'Blocked'].includes(item.status) ? (
                  issueTaskId === item.id ? (
                    <View style={{ gap: 8, marginTop: 8 }}>
                      <Text style={{ color: colors.text, fontWeight: '800' }}>Report a blocker</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {ISSUE_TYPES.map((option) => (
                          <Button key={option.value} title={option.label} variant={issueType === option.value ? 'primary' : 'secondary'} disabled={busy} onPress={() => setIssueType(option.value)} />
                        ))}
                      </View>
                      <Field label="What is stopping this task?" value={issueDescription} onChangeText={setIssueDescription} multiline maxLength={2000} placeholder="Describe the missing item, defect, or question" />
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Button title={busy ? 'Sending…' : 'Submit issue'} disabled={busy} onPress={() => void reportIssue(item.id)} />
                        <Button title="Cancel" variant="secondary" disabled={busy} onPress={() => { setIssueTaskId(null); setIssueDescription(''); }} />
                      </View>
                    </View>
                  ) : <Button title="Report a blocker" variant="secondary" disabled={busy} onPress={() => { setIssueTaskId(item.id); setIssueType('Other'); setIssueDescription(''); }} />
                ) : null}
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
