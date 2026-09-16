// src/screens/AboutNexusScreen.tsx
// Pushed from the "About Nexus" row on screen 10 — see that row's own
// comment on ProfileScreen.tsx for why it stayed `variant="static"` until
// this screen existed.
//
// NO VERSION NUMBER, DELIBERATELY. That row's comment already decided this:
// there is no version source without adding `expo-constants` as a declared
// dependency, and that is a dependency decision for the team, not this
// screen's to make unilaterally. Drawn without the number rather than with
// an invented one — same call as the row it replaces.
//
// THE PRIVACY & SECURITY LINK IS IN-APP NAVIGATION, NOT A SECOND COPY OF THAT
// SCREEN'S TEXT. Tapping it pushes `PrivacySecurity` on this same stack, so
// that policy's copy lives in exactly one place.
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';

import { SectionHeader } from '@components/SectionHeader';
import type { ProfileStackParamList } from '@navigation/types';
import { color, radius, space, type } from '@theme/tokens';

// The Nexus mark — transparent background, same asset TopAppBar and
// BootSplash use, rather than a generic Ionicon standing in for the brand.
const NEXUS_LOGO = require('../../assets/nexus-3.png');

type Nav = NativeStackNavigationProp<ProfileStackParamList, 'AboutNexus'>;

export default function AboutNexusScreen() {
  const navigation = useNavigation<Nav>();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.mark}>
        <View style={styles.markGlyph}>
          <Image
            source={NEXUS_LOGO}
            style={styles.markLogo}
            resizeMode="contain"
            accessibilityLabel="Nexus"
          />
        </View>
        <Text style={styles.appName}>Nexus</Text>
        <Text style={styles.tagline}>Powered by Taylor & Francis</Text>
      </View>

      <View style={styles.group}>
        <SectionHeader title="About" />
        <Text style={styles.body}>
          Nexus is a reading app for institutional and personal access to Taylor & Francis
          titles — books, journals and audiobooks, online or downloaded for offline reading.
        </Text>
      </View>

      <View style={styles.group}>
        <SectionHeader title="Legal" />
        <Pressable
          style={styles.legalRow}
          onPress={() => navigation.navigate('PrivacySecurity')}
          accessibilityRole="button"
          accessibilityLabel="Privacy & Security"
        >
          <Text style={styles.legalRowLabel}>Privacy & Security</Text>
          <Ionicons name="chevron-forward" size={20} color={color.textSecondary} />
        </Pressable>
        <Text style={styles.legalHeading}>Terms of Service</Text>
        <Text style={styles.body}>
          By using Nexus you agree to access content only as permitted by your institutional or
          personal entitlement, and not to redistribute downloaded titles. Full terms are
          provided by your institution or Taylor & Francis at the point of purchase or
          subscription.
        </Text>
      </View>

      <Text style={styles.copyright}>© Taylor & Francis Group</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.white,
  },
  content: {
    padding: space.md,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  mark: {
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.lg,
  },
  markGlyph: {
    width: space.xl + space.lg,
    height: space.xl + space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.navy,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  // The logo's own transparent-background artwork is sized to sit inside
  // `markGlyph`'s circle with a margin, the same "contain, not cover" rule
  // TopAppBar's own `brandLogo` follows.
  markLogo: {
    width: space.xl,
    height: space.xl,
  },
  appName: {
    fontFamily: type.editorialTitle.fontFamily,
    fontSize: type.editorialTitle.size,
    lineHeight: type.editorialTitle.lineHeight,
    color: color.textPrimary,
  },
  tagline: {
    fontFamily: type.editorialMeta.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textSecondary,
  },
  group: {
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.white,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  body: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
  },
  legalRowLabel: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  legalHeading: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
    marginTop: space.sm,
  },
  copyright: {
    fontWeight: type.smallLabel.weight,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
    color: color.textSecondary,
    textAlign: 'center',
  },
});
