import { describe, expect, test, vi } from "vitest";
import { createDirectCompanionProfile } from "@meetless/client";
import {
  COMPANION_PROFILE_STORAGE_KEY,
  clearCompanionProfile,
  loadCompanionProfile,
  saveCompanionProfile,
  type CompanionProfileStorage,
} from "../src/companion-storage.js";

function memoryStorage(initial: string | null = null): CompanionProfileStorage & { value: string | null } {
  const storage = {
    value: initial,
    getItem: vi.fn(async () => storage.value),
    setItem: vi.fn(async (_key: string, value: string) => { storage.value = value; }),
    removeItem: vi.fn(async () => { storage.value = null; }),
  };
  return storage;
}

describe("companion pairing persistence", () => {
  test("stores only the validated connection profile", async () => {
    const storage = memoryStorage();
    const profile = createDirectCompanionProfile({ endpoint: "192.168.1.4:6777", password: "private-password" });
    await saveCompanionProfile(profile, storage);

    expect(storage.setItem).toHaveBeenCalledWith(COMPANION_PROFILE_STORAGE_KEY, expect.any(String));
    expect(JSON.parse(storage.value!)).toEqual(profile);
    expect(storage.value).not.toContain("meetings");
    expect(await loadCompanionProfile(storage)).toEqual(profile);
  });

  test("rejects and removes a profile that contains meeting product data", async () => {
    const storage = memoryStorage(JSON.stringify({
      ...createDirectCompanionProfile({ endpoint: "192.168.1.4:6777", password: "private-password" }),
      meetings: [{ id: "m-1", transcript: "private transcript" }],
    }));
    await expect(loadCompanionProfile(storage)).rejects.toThrow("pairing is invalid");
    expect(storage.removeItem).toHaveBeenCalledWith(COMPANION_PROFILE_STORAGE_KEY);
    expect(storage.value).toBeNull();
  });

  test("change host removes only the stored connection profile", async () => {
    const storage = memoryStorage(JSON.stringify(
      createDirectCompanionProfile({ endpoint: "192.168.1.4:6777", password: "private-password" }),
    ));
    await clearCompanionProfile(storage);
    expect(storage.removeItem).toHaveBeenCalledWith(COMPANION_PROFILE_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value).toBeNull();
  });
});
