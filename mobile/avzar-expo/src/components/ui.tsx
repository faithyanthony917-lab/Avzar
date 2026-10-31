import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewProps } from 'react-native';

// Avzar Workshop theme: warm cream surfaces, deep green for structure, burnt orange for the main action.
// Key names that existed before (background, surface, text, muted, primary, primarySoft, border, danger, success) are kept so every screen recolours without edits.
export const colors = {
  background: '#F8F6F1', surface: '#FDFDFC', text: '#1A2E2A', muted: '#637972',
  primary: '#EB5F24', primarySoft: '#FCE9DF', border: '#E2DCD4', danger: '#B42522', success: '#2F6B4F',
  brand: '#223F36', brandSoft: '#DCEAE5', sand: '#EFDDB3', warning: '#8A5A00', warningSoft: '#F7EBC9',
  onBrand: '#F5F2EB', onBrandMuted: '#B9CCC4', dangerSoft: '#F8DDDC', successSoft: '#DCEAE5', neutralSoft: '#EDE9E3',
};
export const radius = { sm: 8, md: 12, lg: 16 };

export function Screen({ children, ...props }: ViewProps) {
  return <View {...props} style={[styles.screen, props.style]}>{children}</View>;
}

export function Heading({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{children}</Text>{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}</View>;
}

export function Button({ title, onPress, disabled, variant = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.button, variant === 'secondary' && styles.buttonSecondary, disabled && styles.disabled, pressed && styles.pressed]}><Text style={[styles.buttonText, variant === 'secondary' && styles.buttonSecondaryText]}>{title}</Text></Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput placeholderTextColor="#9AA9A3" accessibilityLabel={label} {...props} style={[styles.input, props.style]} /></View>;
}

export function Card({ children, ...props }: ViewProps) {
  return <View {...props} style={[styles.card, props.style]}>{children}</View>;
}

export function Loading() {
  return <View style={styles.loading}><ActivityIndicator size="large" color={colors.brand} /></View>;
}

export function Message({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'danger' | 'success' }) {
  return <Text style={[styles.message, tone === 'danger' && { color: colors.danger }, tone === 'success' && { color: colors.success }]}>{children}</Text>;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <View style={styles.sectionRow}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>{action && onAction ? <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}><Text style={styles.sectionAction}>{action}</Text></Pressable> : null}</View>;
}

export function StatTile({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: 'neutral' | 'warning' | 'danger' }) {
  return <View style={[styles.tile, tone === 'warning' && { backgroundColor: colors.warningSoft }, tone === 'danger' && { backgroundColor: colors.dangerSoft }]} accessible accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ''}`}>
    <Text style={styles.tileLabel}>{label}</Text>
    <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
  </View>;
}

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const CHIP: Record<ChipTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.neutralSoft, fg: colors.muted }, info: { bg: colors.brandSoft, fg: colors.brand },
  success: { bg: colors.successSoft, fg: colors.success }, warning: { bg: colors.warningSoft, fg: colors.warning }, danger: { bg: colors.dangerSoft, fg: colors.danger },
};
export function Chip({ label, tone = 'neutral' }: { label: string; tone?: ChipTone }) {
  return <View style={[styles.chip, { backgroundColor: CHIP[tone].bg }]}><Text style={[styles.chipText, { color: CHIP[tone].fg }]}>{label}</Text></View>;
}

// Maps the API's status words to a chip colour; anything unknown stays neutral instead of guessing.
export function statusTone(status: string | null | undefined): ChipTone {
  const value = (status ?? '').toLowerCase();
  if (['completed', 'complete', 'delivered', 'paid', 'active', 'done'].includes(value)) return 'success';
  if (['inprogress', 'in progress', 'started', 'running', 'open', 'ready'].includes(value)) return 'info';
  if (['paused', 'blocked', 'pending', 'waiting', 'onhold', 'on hold'].includes(value)) return 'warning';
  if (['cancelled', 'canceled', 'overdue', 'failed', 'rejected'].includes(value)) return 'danger';
  return 'neutral';
}

export function EmptyState({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text>{body ? <Text style={styles.emptyBody}>{body}</Text> : null}{action && onAction ? <View style={{ alignSelf: 'stretch', marginTop: 6 }}><Button title={action} onPress={onAction} /></View> : null}</View>;
}

export function Avatar({ name, size = 44 }: { name?: string | null; size?: number }) {
  const initials = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?';
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.brand, fontWeight: '800', fontSize: size * 0.38 }}>{initials}</Text></View>;
}

// Stand-in mark until the real logo file is added to assets: a green tile with the letter A and the wordmark.
export function BrandMark({ size = 40, light = false }: { size?: number; light?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: light ? colors.onBrand : colors.brand, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: light ? colors.brand : colors.onBrand, fontWeight: '800', fontSize: size * 0.5 }}>A</Text></View>
    <View><Text style={{ color: light ? colors.onBrand : colors.brand, fontWeight: '800', fontSize: 17, letterSpacing: 0.5 }}>Avzar</Text><Text style={{ color: light ? colors.onBrandMuted : colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 2 }}>WORKSHOP</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: 20, gap: 16 },
  heading: { gap: 5, marginBottom: 4 }, title: { fontSize: 27, lineHeight: 33, fontWeight: '800', color: colors.text },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  button: { minHeight: 50, borderRadius: radius.md, backgroundColor: colors.primary, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' }, buttonSecondary: { backgroundColor: colors.brandSoft }, buttonSecondaryText: { color: colors.brand },
  disabled: { opacity: 0.55 }, pressed: { opacity: 0.85 },
  field: { gap: 7 }, label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 11, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 15, backgroundColor: colors.surface, gap: 8 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, message: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800' }, sectionAction: { color: colors.brand, fontSize: 13, fontWeight: '800' },
  tile: { flexBasis: '47%', flexGrow: 1, borderRadius: radius.lg, backgroundColor: colors.brandSoft, padding: 14, gap: 4, minHeight: 92, justifyContent: 'space-between' },
  tileLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' }, tileValue: { color: colors.brand, fontSize: 24, fontWeight: '800' }, tileHint: { color: colors.muted, fontSize: 12 },
  chip: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }, chipText: { fontSize: 12, fontWeight: '800' },
  empty: { alignItems: 'center', gap: 6, padding: 24, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center' }, emptyBody: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
