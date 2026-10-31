import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '@/components/ui';

const glyph = (symbol: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 20, lineHeight: 24 }}>{symbol}</Text>;

export default function TabLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text, headerShadowVisible: false, headerTitleStyle: { fontWeight: '800' },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.muted, tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarLabel: 'Home', tabBarIcon: glyph('⌂') }} />
      <Tabs.Screen name="customers" options={{ title: 'Customers', tabBarLabel: 'Customers', tabBarIcon: glyph('♙') }} />
      <Tabs.Screen name="orders" options={{ title: 'My orders', tabBarLabel: 'Orders', tabBarIcon: glyph('▤') }} />
      <Tabs.Screen name="tasks" options={{ title: 'My tasks', tabBarLabel: 'Tasks', tabBarIcon: glyph('✓') }} />
      <Tabs.Screen name="settings" options={{ title: 'Profile', tabBarLabel: 'Profile', tabBarIcon: glyph('☺') }} />
    </Tabs>
  );
}
