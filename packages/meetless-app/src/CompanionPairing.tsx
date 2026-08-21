import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
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
  const [method, setMethod] = useState<"direct" | "relay">("direct");
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
    <View style={styles.root} testID="companion-pairing">
      <Text style={styles.brand}>MEETLESS</Text>
      <Text style={styles.title}>Pair this companion</Text>
      <Text style={styles.help}>Connect to your desktop host. Meeting data stays on that host.</Text>
      <View style={styles.tabs}>
        <Pressable onPress={() => setMethod("direct")} style={styles.tab} testID="pair-direct-tab">
          <Text style={method === "direct" ? styles.selected : styles.text}>Direct LAN</Text>
        </Pressable>
        <Pressable onPress={() => setMethod("relay")} style={styles.tab} testID="pair-relay-tab">
          <Text style={method === "relay" ? styles.selected : styles.text}>Encrypted relay</Text>
        </Pressable>
      </View>
      {method === "direct" ? (
        <View style={styles.form} testID="pair-direct-form">
          <TextInput
            accessibilityLabel="Meetless host and port"
            autoCapitalize="none"
            onChangeText={setEndpoint}
            placeholder="192.168.1.20:6777"
            placeholderTextColor="#777b82"
            style={styles.input}
            value={endpoint}
          />
          <TextInput
            accessibilityLabel="Meetless direct password"
            autoCapitalize="none"
            onChangeText={setPassword}
            placeholder="Host password"
            placeholderTextColor="#777b82"
            secureTextEntry
            style={styles.input}
            value={password}
          />
        </View>
      ) : (
        <TextInput
          accessibilityLabel="Paseo pairing link"
          autoCapitalize="none"
          multiline
          onChangeText={setOffer}
          placeholder="Paste the Paseo #offer= link"
          placeholderTextColor="#777b82"
          style={[styles.input, styles.offer]}
          testID="pair-relay-offer"
          value={offer}
        />
      )}
      {localError || error ? <Text style={styles.error} testID="pairing-error">{localError ?? error}</Text> : null}
      <Pressable disabled={pending} onPress={() => void pair()} style={styles.button} testID="pair-host">
        <Text style={styles.buttonText}>{pending ? "Saving pairing…" : "Pair host"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: "center", backgroundColor: "#191b1f", borderRadius: 14, gap: 16, margin: 24, maxWidth: 520, padding: 24, width: "90%" },
  brand: { color: "#e66b3d", fontSize: 12, fontWeight: "800", letterSpacing: 2.4 },
  title: { color: "#f4f1e8", fontSize: 24, fontWeight: "700" },
  help: { color: "#a9aaad", lineHeight: 20 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { borderColor: "#454a53", borderRadius: 8, borderWidth: 1, padding: 10 },
  text: { color: "#b8bbc0" },
  selected: { color: "#e99a74", fontWeight: "700" },
  form: { gap: 10 },
  input: { backgroundColor: "#202226", borderColor: "#3a3d43", borderRadius: 10, borderWidth: 1, color: "#f4f1e8", minHeight: 46, paddingHorizontal: 14 },
  offer: { minHeight: 100, paddingTop: 12, textAlignVertical: "top" },
  error: { color: "#ff8d82" },
  button: { alignItems: "center", backgroundColor: "#e66b3d", borderRadius: 10, minHeight: 46, justifyContent: "center" },
  buttonText: { color: "#17120f", fontWeight: "700" },
});
