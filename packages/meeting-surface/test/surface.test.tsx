import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { MeetingListSurface } from "../src/index.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("companion meeting surface", () => {
  test("has no create controls and cannot invoke meeting creation", async () => {
    const onCreate = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[]}
          onCreate={onCreate}
          onRefresh={async () => undefined}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: "desktop-create-controls" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "meeting-create-button" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ testID: "companion-read-only" })).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    renderer!.unmount();
  });
});
