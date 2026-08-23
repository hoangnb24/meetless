import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type TextInputProps } from "react-native";
import {
  createDirectCompanionProfile,
  createRelayCompanionProfile,
  type CompanionProfile,
} from "@meetless/client";

export function CompanionPairing({
  error,
  onPair,
}: {
  error: string | null;
  onPair(profile: CompanionProfile): Promise<void>;
}) {
  const [method, setMethod] = useState<"relay" | "direct">("relay");
  const [endpoint, setEndpoint] = useState("");
  const [password, setPassword] = useState("");
  const [offer, setOffer] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const pair = async () => {
    setPending(true);
    setLocalError(null);
    try {
      const profile = method === "direct"
        ? createDirectCompanionProfile({ endpoint, password })
        : createRelayCompanionProfile(offer);
      await onPair(profile);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "Pairing failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <View style={styles.screen} testID="companion-pairing">
      <View style={styles.topbar}>
        <View style={styles.brand}><View style={styles.mark} accessibilityElementsHidden /><Text style={styles.brandText}>Meetless</Text></View>
      </View>
      <View style={styles.center}>
        <View style={styles.panel} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.title}>Connect a companion</Text>
          <Text style={styles.help}>Paste the pairing link shown by Meetless on your desktop. The encrypted relay is the recommended path, and meeting data remains on the host.</Text>
          {method === "relay" ? (
            <View style={styles.form} testID="pair-relay-form">
              <Text style={styles.label}>Pairing link</Text>
              <FocusTextInput
                accessibilityLabel="Pairing link"
                autoCapitalize="none"
                onChangeText={setOffer}
                placeholder="Paste the complete pairing link"
                placeholderTextColor={colors.muted}
                style={styles.input}
                testID="pair-relay-offer"
                value={offer}
              />
            </View>
          ) : (
            <View style={styles.form} testID="pair-direct-form">
              <Text style={styles.label}>Direct LAN host</Text>
              <FocusTextInput
                accessibilityLabel="Meetless host and port"
                autoCapitalize="none"
                onChangeText={setEndpoint}
                placeholder="192.168.1.20:6777"
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={endpoint}
              />
              <FocusTextInput
                accessibilityLabel="Meetless direct password"
                autoCapitalize="none"
                onChangeText={setPassword}
                placeholder="Host password"
                placeholderTextColor={colors.muted}
                secureTextEntry
                style={styles.input}
                value={password}
              />
            </View>
          )}
          {localError || error ? <Text style={styles.error} accessibilityLiveRegion="polite" testID="pairing-error">{localError ?? "Pairing could not be saved. Check the link and try again."}</Text> : null}
          <View style={styles.actions}>
            {method === "direct" ? (
              <FocusPressable accessibilityLabel="Back to encrypted relay pairing" accessibilityRole="button" disabled={pending} onPress={() => { setMethod("relay"); setLocalError(null); }} style={styles.ghostButton} testID="pair-relay-back">
                <Text style={styles.ghostText}>Back</Text>
              </FocusPressable>
            ) : null}
            <FocusPressable accessibilityLabel="Pair securely" accessibilityRole="button" accessibilityState={{ disabled: pending || (method === "relay" ? !offer.trim() : !endpoint.trim() || !password.trim()) }} disabled={pending || (method === "relay" ? !offer.trim() : !endpoint.trim() || !password.trim())} onPress={() => void pair()} style={styles.primaryButton} testID="pair-host">
              <Text style={styles.primaryText}>{pending ? "Pairing…" : "Pair securely"}</Text>
            </FocusPressable>
          </View>
          {method === "relay" ? (
            <View style={styles.secondaryPath}>
              <Text style={styles.secondaryHelp}>Prefer a direct connection on your home network?</Text>
              <FocusPressable accessibilityLabel="Set up Direct LAN" accessibilityRole="button" disabled={pending} onPress={() => { setMethod("direct"); setLocalError(null); }} style={styles.secondaryButton} testID="pair-direct-entry">
                <Text style={styles.secondaryText}>Set up Direct LAN</Text>
              </FocusPressable>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function FocusPressable({ style, onFocus, onBlur, ...props }: PressableProps) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...props}
      focusable
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={focused ? [style as never, styles.focusRing] : style}
    />
  );
}

function FocusTextInput({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...props}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={focused ? [style as never, styles.focusRing] : style}
    />
  );
}

const colors = {
  bg: "#08090a",
  surface: "#191a1b",
  foreground: "#f7f8f8",
  secondary: "#d0d6e0",
  muted: "#8a8f98",
  border: "rgba(255,255,255,0.08)",
  borderSoft: "rgba(255,255,255,0.05)",
  accent: "#5e6ad2",
  accentHover: "#828fff",
  dangerText: "#f2a2a0",
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topbar: { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomColor: colors.borderSoft, borderBottomWidth: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  mark: { width: 18, height: 18, borderRadius: 5, backgroundColor: colors.accent },
  brandText: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  panel: { width: "100%", maxWidth: 520, gap: 14, padding: 26, borderColor: colors.border, borderWidth: 1, borderRadius: 12, backgroundColor: colors.surface },
  title: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  help: { color: colors.muted, fontSize: 13.5, lineHeight: 21, maxWidth: 460 },
  form: { gap: 7, marginTop: 4 },
  label: { color: colors.muted, fontSize: 12.5 },
  input: { minHeight: 44, paddingHorizontal: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.035)", color: colors.foreground, fontSize: 14 },
  focusRing: { borderColor: colors.accentHover, borderWidth: 1, shadowColor: colors.accent, shadowOpacity: 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  error: { color: colors.dangerText, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  primaryButton: { minHeight: 42, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, borderRadius: 6, backgroundColor: colors.accent },
  primaryText: { color: "#ffffff", fontSize: 13.5, fontWeight: "500" },
  ghostButton: { minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 },
  ghostText: { color: colors.secondary, fontSize: 13 },
  secondaryPath: { gap: 8, marginTop: 2, paddingTop: 14, borderTopColor: colors.borderSoft, borderTopWidth: 1 },
  secondaryHelp: { color: colors.muted, fontSize: 13 },
  secondaryButton: { alignSelf: "flex-start", minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.04)" },
  secondaryText: { color: colors.secondary, fontSize: 13 },
});
