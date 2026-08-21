import AsyncStorage from "@react-native-async-storage/async-storage";
import { validateCompanionProfile, type CompanionProfile } from "@meetless/client";

export const COMPANION_PROFILE_STORAGE_KEY = "meetless.companion.profile.v1";

export interface CompanionProfileStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const defaultStorage: CompanionProfileStorage = AsyncStorage;

export async function loadCompanionProfile(
  storage: CompanionProfileStorage = defaultStorage,
): Promise<CompanionProfile | null> {
  const serialized = await storage.getItem(COMPANION_PROFILE_STORAGE_KEY);
  if (serialized === null) return null;
  try {
    return validateCompanionProfile(JSON.parse(serialized));
  } catch {
    await storage.removeItem(COMPANION_PROFILE_STORAGE_KEY);
    throw new Error("Saved companion pairing is invalid. Pair this companion again.");
  }
}

export async function saveCompanionProfile(
  profile: CompanionProfile,
  storage: CompanionProfileStorage = defaultStorage,
): Promise<void> {
  const validated = validateCompanionProfile(profile);
  await storage.setItem(COMPANION_PROFILE_STORAGE_KEY, JSON.stringify(validated));
}

export async function clearCompanionProfile(
  storage: CompanionProfileStorage = defaultStorage,
): Promise<void> {
  await storage.removeItem(COMPANION_PROFILE_STORAGE_KEY);
}
