import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertMeetlessAppBoundary } from "../src/app-boundary.js";

const repositoryRoot = process.cwd();

describe("Meetless app coding-product import boundary", () => {
  test("allows Meetless and pinned neutral client imports", () => {
    expect(() =>
      assertMeetlessAppBoundary(
        [
          {
            path: path.join(repositoryRoot, "packages/meetless-app/src/allowed.ts"),
            source:
              'import { connectMeetlessClient } from "@meetless/client";\n' +
              'import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";',
          },
        ],
        repositoryRoot,
      ),
    ).not.toThrow();
  });

  test("rejects an isolated coding-screen import with an actionable diagnostic", () => {
    expect(() =>
      assertMeetlessAppBoundary(
        [
          {
            path: path.join(repositoryRoot, "packages/meetless-app/src/violation.tsx"),
            source:
              'import { WorkspacesScreen } from "../../../vendor/paseo/packages/app/src/screens/workspaces";',
          },
        ],
        repositoryRoot,
      ),
    ).toThrow(
      /violation\.tsx imports forbidden coding-product module.*docs\/plans\/active\/v1-paseo-foundation\.md:272.*Depend on @meetless\/client/s,
    );
  });
});
