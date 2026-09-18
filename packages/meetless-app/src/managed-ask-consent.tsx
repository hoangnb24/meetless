import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MANAGED_ASK_DISCLOSURE, MANAGED_ASK_MODEL, MANAGED_ASK_PROVIDER } from "@meetless/meeting-contracts/managed-ask";
import type { ChatControlsWire } from "@meetless/meeting-contracts";

export function hasManagedAskControls(controls: ChatControlsWire | null): boolean {
  return !!controls?.catalog.providers.some((provider) => provider.id === MANAGED_ASK_PROVIDER && provider.models.some((model) => model.id === MANAGED_ASK_MODEL));
}

export function useManagedAskConsent() {
  const [pending, setPending] = useState(false);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(false);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const confirm = useCallback(() => {
    if (resolver.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; setPending(true); });
  }, []);
  const dialog = pending ? <View accessibilityViewIsModal onAccessibilityEscape={() => settle(false)}
    style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 1000, backgroundColor: "#000b", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <View accessibilityRole="alert" style={{ width: "100%", maxWidth: 520, padding: 24, borderRadius: 12, backgroundColor: "#20242b", gap: 18 }}>
      <Text style={{ color: "#fff", fontSize: 20, fontWeight: "600" }}>Send to Managed Ask?</Text>
      <Text style={{ color: "#e3e6eb", fontSize: 15, lineHeight: 22 }}>{MANAGED_ASK_DISCLOSURE}</Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 16 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel Managed Ask" onPress={() => settle(false)} style={{ padding: 12 }}><Text style={{ color: "#fff" }}>Cancel</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Confirm and send to OpenAI" onPress={() => settle(true)} style={{ padding: 12, backgroundColor: "#245bb5", borderRadius: 6 }}><Text style={{ color: "#fff" }}>Confirm and send</Text></Pressable>
      </View>
    </View>
  </View> : null;
  return { confirm, dialog, pending, cancel: useCallback(() => settle(false), [settle]) };
}
