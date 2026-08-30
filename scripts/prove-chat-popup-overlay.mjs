import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const repositoryRoot = process.cwd();
const proofRoot = mkdtempSync(path.join(tmpdir(), "meetless-chat-popup-proof-"));
let browser;
let server;

try {
  execFileSync("npm", ["run", "build", "--workspace=@meetless/meeting-surface"], { cwd: repositoryRoot, stdio: "inherit" });
  prepareFixture();
  execFileSync(path.join(repositoryRoot, "node_modules/.bin/expo"), ["export", "--platform", "web", "--output-dir", "dist", "--clear"], {
    cwd: proofRoot,
    env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
    stdio: "inherit",
  });
  ({ server } = await serve(path.join(proofRoot, "dist")));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("chat popup proof server did not bind a TCP port");
  browser = await chromium.launch({ headless: true });
  const facts = [];
  for (const width of [390, 877, 1440]) {
    facts.push(await proveModern(width, address.port));
    facts.push(await proveLegacy(width, address.port));
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", artifact: "temporary Expo web export from packages/meeting-surface/dist/index.js", facts }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  rmSync(proofRoot, { recursive: true, force: true });
}

function prepareFixture() {
  cpSync(path.join(repositoryRoot, "packages/meeting-surface/dist"), path.join(proofRoot, "meeting-surface-dist"), { recursive: true });
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(proofRoot, "node_modules"), "dir");
  writeFileSync(path.join(proofRoot, "package.json"), JSON.stringify({ private: true, main: "index.js" }));
  writeFileSync(path.join(proofRoot, "app.json"), JSON.stringify({ expo: { name: "Meetless popup proof", slug: "meetless-popup-proof", web: { bundler: "metro" } } }));
  writeFileSync(path.join(proofRoot, "index.js"), fixtureSource());
}

function fixtureSource() {
  return String.raw`
import React from "react";
import { registerRootComponent } from "expo";
import { useWindowDimensions } from "react-native";
import { MeetingListSurface } from "./meeting-surface-dist/index.js";

const meeting = { id: "m-1", title: "Popup proof", status: "ready", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" };
const transcript = {
  id: "t-1", meetingId: "m-1", recordingId: "r-1", status: "ready", plannerVersion: "proof", audioDurationMs: 1000,
  ranges: [{ ordinal: 0, startMs: 0, endMs: 1000, segmentId: "s-1" }],
  segments: [{ range: { ordinal: 0, startMs: 0, endMs: 1000, segmentId: "s-1" }, text: "Deterministic emitted-artifact fixture.", completedAt: "2026-08-30T00:00:00.000Z", detectedLanguages: ["en"] }],
  requestCount: 1, usage: null, detectedLanguages: ["en"], failureReason: null,
};
const models = Array.from({ length: 40 }, (_, index) => ({
  id: "model-" + index, label: "Model " + index, isDefault: index === 0,
  thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultThinkingOptionId: "low",
}));
const catalog = { providers: [{ id: "codex", label: "Codex", status: "ready", error: null, defaultModeId: "worker", modes: [{ id: "worker", label: "Worker" }], models }] };
const selection = { provider: "codex", model: "model-0", modeId: "worker", thinkingOptionId: "low", featureValues: { response_style: "brief" } };
const features = { version: 1, selection, status: "ready", error: null, features: [{ type: "select", id: "response_style", label: "Response style", value: "brief", options: [{ id: "brief", label: "Brief" }, { id: "detailed", label: "Detailed" }] }] };
const legacyProviders = [{ id: "codex", label: "Codex", models: models.map(({ id, label, isDefault }) => ({ id, label, isDefault })) }];

function Fixture() {
  const { width } = useWindowDimensions();
  const layoutTier = width <= 639 ? "phone" : width < 1120 ? "tablet" : "desktop";
  const legacy = new URLSearchParams(location.search).has("legacy");
  return <MeetingListSurface
    connectionLabel="Host online" hostConnectionStatus="online" hostLabel="proof host"
    meetings={[meeting]} onRefresh={async () => {}} selectedMeetingId="m-1" transcript={transcript}
    consentStatus="granted" layoutTier={layoutTier}
    {...(legacy ? { chatProviders: legacyProviders, chatProvider: "codex", chatModel: "model-0", onChatSelection: () => {} } : {
      chatCatalog: catalog, chatProfiles: [], chatSelection: selection, chatFeatures: features, onChatSelectionBundle: async () => {},
    })}
  />;
}
registerRootComponent(Fixture);
`;
}

async function proveModern(width, port) {
  const height = width === 390 ? 844 : 900;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${port}`);
  if (width < 1120) await page.getByTestId("task-tab-ask").click();
  const initialPageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const consumers = [
    ["model", "chat-model-trigger", "chat-model-picker"],
    ["thinking", "chat-thinking-trigger", "chat-thinking-menu"],
    ["feature", "chat-feature-select-response_style", "chat-feature-menu-response_style"],
  ];
  const boxes = {};
  let modelExpansion = null;
  for (const [consumer, triggerId, popupId] of consumers) {
    await page.getByTestId(triggerId).click();
    const popup = page.getByTestId(popupId);
    await popup.waitFor({ state: "visible" });
    if (consumer === "model") {
      const root = width === 390 ? null : await popupDimensions(popup);
      await page.getByTestId("chat-provider-codex").click();
      if (width !== 390) {
        await page.waitForFunction((testID) => {
          const node = document.querySelector(`[data-testid="${testID}"]`);
          return node && node.getBoundingClientRect().height >= 340;
        }, popupId);
        const drilldown = await popupDimensions(popup);
        assertUsefulModelExpansion(root, drilldown, width);
        modelExpansion = { root, drilldown };
      }
    }
    boxes[consumer] = await assertPopup(page, popup, page.getByTestId(triggerId), width, height, consumer);
    if (width === 390) await assertMinimumTargets(popup, consumer);
    await page.keyboard.press("Escape");
    if (await popup.count()) throw new Error(`${consumer} shared-popup rule: Escape did not dismiss the popup`);
    if (!(await page.getByTestId(triggerId).evaluate((node) => node === document.activeElement || node.contains(document.activeElement)))) {
      throw new Error(`${consumer} shared-popup rule: focus did not return to its trigger`);
    }
  }
  const finalPageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (finalPageHeight !== initialPageHeight || finalPageHeight > height) {
    throw new Error(`modern shared-popup rule: popup changed page scroll height ${initialPageHeight} -> ${finalPageHeight} at ${width}px`);
  }
  const focusSwitching = await proveFocusSwitching(page);
  await page.close();
  return { family: "modern", width, initialPageHeight, finalPageHeight, modelExpansion, focusSwitching, boxes };
}

async function proveLegacy(width, port) {
  const height = width === 390 ? 844 : 900;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${port}/?legacy=1`);
  if (width < 1120) await page.getByTestId("task-tab-ask").click();
  await page.getByTestId("chat-provider-trigger").click();
  const popup = page.getByTestId("chat-provider-options");
  await popup.waitFor({ state: "visible" });
  const box = await assertPopup(page, popup, page.getByTestId("chat-provider-trigger"), width, height, "legacy-provider");
  if (width === 390) await assertMinimumTargets(popup, "legacy-provider");
  await page.keyboard.press("Escape");
  if (await popup.count()) throw new Error("legacy-provider shared-popup rule: Escape did not dismiss the popup");
  await page.close();
  return { family: "legacy-provider", width, box };
}

async function assertPopup(page, popup, trigger, width, height, consumer) {
  const box = await popup.boundingBox();
  if (!box) throw new Error(`${consumer} shared-popup rule: emitted popup has no bounding box`);
  const position = await popup.evaluate((node) => getComputedStyle(node).position);
  if (position !== "fixed") throw new Error(`${consumer} shared-popup rule: expected fixed emitted position, got ${position}`);
  for (const [edge, actual, limit] of [
    ["left", box.x, 12], ["top", box.y, 12], ["right", width - box.x - box.width, 12], ["bottom", height - box.y - box.height, 12],
  ]) {
    if (actual < limit - 0.5) throw new Error(`${consumer} shared-popup rule: ${edge} margin ${actual}px is below ${limit}px`);
  }
  const presenterScroll = await popup.locator('[data-testid$="-scroll"]').evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflow: getComputedStyle(node).overflowY,
  }));
  if ((consumer === "model" || consumer === "legacy-provider")
    && !(presenterScroll.scrollHeight > presenterScroll.clientHeight && ["auto", "scroll"].includes(presenterScroll.overflow))) {
    throw new Error(`${consumer} shared-popup rule: the presenter is not the constrained internal scroll owner (${JSON.stringify(presenterScroll)})`);
  }
  let triggerGap = null;
  let placement = "sheet";
  if (width !== 390) {
    const triggerBox = await trigger.boundingBox();
    if (!triggerBox) throw new Error(`${consumer} shared-popup rule: trigger has no emitted bounding box`);
    const aboveGap = triggerBox.y - (box.y + box.height);
    const belowGap = box.y - (triggerBox.y + triggerBox.height);
    placement = Math.abs(aboveGap - 8) <= Math.abs(belowGap - 8) ? "above" : "below";
    triggerGap = placement === "above" ? aboveGap : belowGap;
    if (Math.abs(triggerGap - 8) > 0.75) throw new Error(`${consumer} shared-popup rule: ${placement}-trigger gap is ${triggerGap}px instead of 8px`);
  }
  return { x: box.x, y: box.y, width: box.width, height: box.height, position, placement, triggerGap, presenterScroll };
}

async function popupDimensions(popup) {
  const box = await popup.boundingBox();
  if (!box) throw new Error("model expansion proof: popup has no bounding box");
  const presenterScroll = await popup.locator('[data-testid$="-scroll"]').evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  return { popupHeight: box.height, presenterScroll };
}

function assertUsefulModelExpansion(root, drilldown, width) {
  if (!root) throw new Error(`model expansion proof: missing root dimensions at ${width}px`);
  if (drilldown.popupHeight < 340) {
    throw new Error(`model expansion proof: 40-model popup is ${drilldown.popupHeight}px at ${width}px; expected at least the former 340px list cap`);
  }
  if (drilldown.presenterScroll.clientHeight < 320) {
    throw new Error(`model expansion proof: 40-model presenter viewport is ${drilldown.presenterScroll.clientHeight}px at ${width}px; expected at least 320px within the 340/420 caps`);
  }
  if (drilldown.popupHeight < root.popupHeight + 100) {
    throw new Error(`model expansion proof: content growth only changed popup ${root.popupHeight}px -> ${drilldown.popupHeight}px at ${width}px`);
  }
  if (drilldown.presenterScroll.scrollHeight <= drilldown.presenterScroll.clientHeight) {
    throw new Error(`model expansion proof: 40 models are not internally scrollable at ${width}px`);
  }
}

async function proveFocusSwitching(page) {
  const facts = {};
  for (const [replacement, triggerId, popupId] of [
    ["thinking", "chat-thinking-trigger", "chat-thinking-menu"],
    ["feature", "chat-feature-select-response_style", "chat-feature-menu-response_style"],
  ]) {
    await page.getByTestId("chat-model-trigger").click();
    const modelPopup = page.getByTestId("chat-model-picker");
    await modelPopup.waitFor({ state: "visible" });
    await page.getByTestId(triggerId).evaluate((node) => { node.focus(); node.click(); });
    const replacementPopup = page.getByTestId(popupId);
    await replacementPopup.waitFor({ state: "visible" });
    if (await modelPopup.count()) throw new Error(`focus switching proof: model popup remained open after switching to ${replacement}`);
    const active = await replacementPopup.evaluate((node) => node.contains(document.activeElement));
    if (!active) throw new Error(`focus switching proof: focus escaped the replacement ${replacement} popup`);
    facts[replacement] = { popupOpen: true, focusWithinPopup: true };
    await page.keyboard.press("Escape");
  }
  return facts;
}

async function assertMinimumTargets(popup, consumer) {
  const heights = await popup.locator('button,[role="button"]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  if (!heights.length || heights.some((height) => height < 43.5)) {
    throw new Error(`${consumer} shared-popup rule: phone interaction target below 44px (${heights.join(", ")})`);
  }
}

async function serve(root) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const candidate = path.join(root, pathname === "/" ? "index.html" : pathname.slice(1));
    let body;
    try { body = readFileSync(candidate); } catch { body = readFileSync(path.join(root, "index.html")); }
    response.setHeader("content-type", candidate.endsWith(".js") ? "text/javascript" : candidate.endsWith(".css") ? "text/css" : "text/html");
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server };
}
