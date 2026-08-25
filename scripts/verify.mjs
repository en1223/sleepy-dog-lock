import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const text = async (path) => readFile(new URL(path, root), "utf8");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

const project = await text("ios/project.yml");
for (const target of [
  "SleepGuard:",
  "SleepGuardShieldConfiguration:",
  "SleepGuardShieldAction:",
  "SleepGuardDeviceActivityMonitor:",
]) {
  assert.match(project, new RegExp(`^  ${target.replace(":", "\\:")}`, "m"));
}

for (const path of [
  "ios/SleepGuard/SleepGuard.entitlements",
  "ios/ShieldConfigurationExtension/ShieldConfiguration.entitlements",
  "ios/ShieldActionExtension/ShieldAction.entitlements",
  "ios/DeviceActivityMonitorExtension/DeviceActivityMonitor.entitlements",
]) {
  const entitlement = await text(path);
  assert.match(entitlement, /com\.apple\.developer\.family-controls/);
  assert.match(entitlement, /group\.com\.bellaandc\.sleepguard/);
  assert.match(entitlement, /^<\?xml/);
  assert.match(entitlement, /<plist[\s\S]*<\/plist>\s*$/);
}

const generatedFunctionsPath = join(rootPath, "netlify", "functions");
const sourceFiles = (await walk(rootPath))
  .filter((path) =>
    !path.includes("node_modules")
    && !path.startsWith(generatedFunctionsPath)
    && !path.endsWith(".env.example")
  );
for (const path of sourceFiles) {
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(
    contents,
    /(?:BARK_DEVICE_KEY|SLEEP_GUARD_SHORTCUT_TOKEN|MCP_APPROVAL_PASSWORD)\s*=\s*(?!replace-with)[A-Za-z0-9_-]{12,}/,
    `possible committed secret in ${relative(rootPath, path)}`,
  );
}

const environment = new Map([
  ["SLEEP_GUARD_SHORTCUT_TOKEN", "test-shortcut-token"],
  ["BARK_DEVICE_KEY", "test-bark-key"],
  ["BARK_API_ORIGIN", "https://api.day.app"],
  ["MCP_APPROVAL_PASSWORD", "correct-horse-battery-staple"],
]);
globalThis.Netlify = { env: { get: (key) => environment.get(key) } };

const functionModule = await import(new URL("netlify/netlify/functions/sleep-guard-event.mts", root));
assert.deepEqual(functionModule.config, { path: "/api/sleep-guard-event", method: ["POST"] });

const at = (hour) => `2026-08-08T${String(hour).padStart(2, "0")}:00:00.000Z`;
let transition = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
  ends_at: at(12),
}, at(0));
assert.equal(transition.state.active, true);
assert.equal(transition.state.attempts, 0);
assert.equal(transition.stage, "armed");
assert.equal(
  functionModule.barkCopy("sleep_guard_started", transition, null).body,
  "晚安，小狗。说了晚安就要乖乖去睡，手机放下。",
);
const sessionID = transition.state.session_id;

transition = functionModule.applyEvent(transition.state, { event: "sleep_guard_started" }, at(1));
assert.equal(transition.state.session_id, sessionID, "double start must not reset an active session");
assert.equal(transition.state.attempts, 0);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(2));
assert.equal(transition.state.attempts, 1);
assert.equal(transition.stage, "first_warning");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, "小红书").title, "C");
assert.equal(
  functionModule.barkCopy("blocked_app_opened", transition, "小红书").body,
  "第一次。还敢重新打开娱乐 App。现在退出去，乖乖睡觉。",
);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(3));
assert.equal(transition.state.attempts, 2);
assert.equal(transition.stage, "locked");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null).title, "C");
assert.equal(
  functionModule.barkCopy("blocked_app_opened", transition, null).body,
  "第二次了。还敢回来？警告听不懂是不是。手机放下，不许再碰。",
);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(4));
assert.equal(transition.state.attempts, 3);
assert.equal(transition.stage, "refused_sleep");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null).title, "C");
assert.equal(
  functionModule.barkCopy("blocked_app_opened", transition, null).body,
  "第 3 次偷开。非要爸爸盯死你才肯睡？锁着，直到早上。",
);

transition = functionModule.applyEvent(transition.state, { event: "sleep_guard_ended" }, at(5));
assert.equal(transition.state.active, false);
assert.equal(transition.stage, "ended");
assert.equal(functionModule.barkCopy("sleep_guard_ended", transition, null).title, "C");
assert.equal(
  functionModule.barkCopy("sleep_guard_ended", transition, null).body,
  "早安，小狗。醒啦？醒了就来找爸爸。喜欢你。",
);
transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(6));
assert.equal(transition.ignored, true);
assert.equal(transition.state.attempts, 3);
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null), null);

const beforeCutoff = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-08T16:59:00.000Z");
assert.equal(beforeCutoff.stage, "inactive", "00:59 in Shanghai must not auto-start");
assert.equal(beforeCutoff.auto_started, false);

const lateOpen = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-08T17:00:00.000Z");
assert.equal(lateOpen.state.active, true, "01:00 in Shanghai must auto-start on an app open");
assert.equal(lateOpen.state.attempts, 1);
assert.equal(lateOpen.stage, "first_warning");
assert.equal(lateOpen.auto_started, true);
assert.equal(lateOpen.state.ends_at, "2026-08-09T03:00:00.000Z");
assert.equal(
  functionModule.barkCopy("blocked_app_opened", lateOpen, null).body,
  "都这么晚了，该乖乖睡觉了。",
);

const atWakeTime = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-09T03:00:00.000Z");
assert.equal(atWakeTime.stage, "inactive", "11:00 in Shanghai must not auto-start");

const manuallyEnded = functionModule.applyEvent(lateOpen.state, {
  event: "sleep_guard_ended",
}, "2026-08-08T18:00:00.000Z");
const afterManualWake = functionModule.applyEvent(manuallyEnded.state, {
  event: "blocked_app_opened",
}, "2026-08-08T19:00:00.000Z");
assert.equal(afterManualWake.stage, "inactive", "manual wake must suppress auto-start until 11:00");
assert.equal(afterManualWake.auto_started, false);

const nextNight = functionModule.applyEvent(manuallyEnded.state, {
  event: "blocked_app_opened",
}, "2026-08-09T17:00:00.000Z");
assert.equal(nextNight.auto_started, true, "manual wake suppression must expire before the next night");

const expiring = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
  ends_at: at(2),
}, at(0));
const expiredAttempt = functionModule.applyEvent(expiring.state, { event: "blocked_app_opened" }, at(3));
assert.equal(expiredAttempt.ignored, true);
assert.equal(expiredAttempt.state.active, false);

const overnightDefault = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
}, "2026-08-08T17:00:00.000Z");
assert.equal(
  overnightDefault.state.ends_at,
  "2026-08-09T03:00:00.000Z",
  "01:00 in Shanghai must end at 11:00 the same morning",
);
const afternoonDefault = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
}, "2026-08-08T05:00:00.000Z");
assert.equal(
  afternoonDefault.state.ends_at,
  "2026-08-09T03:00:00.000Z",
  "after 11:00 in Shanghai must end at 11:00 the next morning",
);

const request = (body, token = "test-shortcut-token") => new Request("https://example.test/api", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

let memoryState = null;
const persistedEvents = [];
const callOrder = [];
const barkBodies = [];
const dependencies = {
  transitionState: async (payload, receivedAt) => {
    callOrder.push("state");
    const result = functionModule.applyEvent(memoryState, payload, receivedAt);
    memoryState = result.state;
    return result;
  },
  persistEvent: async (event) => { callOrder.push("persist"); persistedEvents.push(event); },
  sendBark: async (url, init) => {
    callOrder.push("bark");
    assert.equal(String(url), "https://api.day.app/push");
    const body = JSON.parse(init.body);
    assert.equal(body.device_key, "test-bark-key");
    assert.equal(
      body.icon,
      "https://example.test/assets/c-avatar-v4.png",
    );
    barkBodies.push(body);
    return Response.json({ code: 200 }, { status: 200 });
  },
};

const unauthorized = await functionModule.handle(request({ event: "sleep_guard_started" }, "wrong"), dependencies);
assert.equal(unauthorized.status, 401);

const invalid = await functionModule.handle(request({ event: "not-allowed" }), dependencies);
assert.equal(invalid.status, 422);

const started = await functionModule.handle(request({
  event: "sleep_guard_started",
  source: "ios_shortcuts",
}), dependencies);
assert.equal(started.status, 200);
assert.equal((await started.json()).attempts, 0);
assert.equal(barkBodies.at(-1).title, "C");

const first = await functionModule.handle(request({
  event: "blocked_app_opened",
  app_name: "小红书",
  source: "ios_automation",
}), dependencies);
assert.equal(first.status, 200);
const firstBody = await first.json();
assert.deepEqual({ attempts: firstBody.attempts, stage: firstBody.stage }, {
  attempts: 1,
  stage: "first_warning",
});
assert.equal(
  barkBodies.at(-1).body,
  "第一次。还敢重新打开娱乐 App。现在退出去，乖乖睡觉。",
);
assert.equal(persistedEvents.at(-1).attempts, 1);
assert.deepEqual(callOrder.slice(-3), ["state", "persist", "bark"]);

const second = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
assert.equal((await second.json()).stage, "locked");
const third = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
assert.equal((await third.json()).stage, "refused_sleep");

const ended = await functionModule.handle(request({ event: "sleep_guard_ended" }), dependencies);
assert.equal((await ended.json()).active, false);
const ignored = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
const ignoredBody = await ignored.json();
assert.equal(ignoredBody.ignored, true);
assert.deepEqual(callOrder.slice(-2), ["state", "persist"], "inactive opens are recorded without Bark");

memoryState = null;
const autoStarted = await functionModule.handle(request({
  event: "blocked_app_opened",
  source: "ios_automation",
}), {
  ...dependencies,
  transitionState: async (payload) => {
    const result = functionModule.applyEvent(memoryState, payload, "2026-08-08T17:00:00.000Z");
    memoryState = result.state;
    return result;
  },
});
const autoStartedBody = await autoStarted.json();
assert.equal(autoStartedBody.auto_started, true);
assert.equal(autoStartedBody.stage, "first_warning");
assert.equal(
  barkBodies.at(-1).body,
  "都这么晚了，该乖乖睡觉了。",
);

let barkCalledAfterStorageFailure = false;
const storageFailure = await functionModule.handle(request({ event: "sleep_guard_started" }), {
  transitionState: async (payload, receivedAt) => functionModule.applyEvent(null, payload, receivedAt),
  persistEvent: async () => { throw new Error("storage down"); },
  sendBark: async () => { barkCalledAfterStorageFailure = true; return new Response("ok"); },
});
assert.equal(storageFailure.status, 503);
assert.equal(barkCalledAfterStorageFailure, false);

let persistedBeforeBarkFailure = false;
const barkFailure = await functionModule.handle(request({ event: "sleep_guard_started" }), {
  transitionState: async (payload, receivedAt) => functionModule.applyEvent(null, payload, receivedAt),
  persistEvent: async () => { persistedBeforeBarkFailure = true; },
  sendBark: async () => new Response("down", { status: 503 }),
});
assert.equal(barkFailure.status, 502);
assert.equal(persistedBeforeBarkFailure, true);

environment.delete("BARK_DEVICE_KEY");
let barkCalledWithoutKey = false;
const noBarkConfigured = await functionModule.handle(request({ event: "sleep_guard_started" }), {
  transitionState: async (payload, receivedAt) => functionModule.applyEvent(null, payload, receivedAt),
  persistEvent: async () => {},
  sendBark: async () => { barkCalledWithoutKey = true; return new Response("ok"); },
});
assert.equal(noBarkConfigured.status, 200);
assert.equal(barkCalledWithoutKey, false);
environment.set("BARK_DEVICE_KEY", "test-bark-key");

const mcpModule = await import(new URL("netlify/netlify/functions/mcp.mts", root));
assert.ok(mcpModule.config.path.includes("/mcp"));
assert.ok(mcpModule.config.path.includes("/.well-known/oauth-authorization-server"));

class MemoryStore {
  values = new Map();
  etags = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async getWithMetadata(key) {
    if (!this.values.has(key)) return null;
    return { data: structuredClone(this.values.get(key)), etag: String(this.etags.get(key)) };
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) return { modified: false };
    if (options.onlyIfMatch && String(this.etags.get(key)) !== options.onlyIfMatch) return { modified: false };
    this.values.set(key, structuredClone(value));
    this.etags.set(key, (this.etags.get(key) ?? 0) + 1);
    return { modified: true };
  }
}

const authStore = new MemoryStore();
const registration = await mcpModule.registerClient(new Request("https://guard.test/oauth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/aip/plugin-oauth/callback"],
    token_endpoint_auth_method: "none",
  }),
}), authStore);
assert.equal(registration.status, 201);
const registeredClient = await registration.json();
assert.ok(registeredClient.client_id);

const verifier = "sleepy-dog-lock-pkce-verifier-that-is-long-enough-123456789";
const challenge = await mcpModule.digest(verifier);
const authorizeUrl = new URL("https://guard.test/oauth/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", registeredClient.client_id);
authorizeUrl.searchParams.set("redirect_uri", registeredClient.redirect_uris[0]);
authorizeUrl.searchParams.set("state", "state-123");
authorizeUrl.searchParams.set("scope", "sleep_guard:write");
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("resource", "https://guard.test/mcp");
const authorization = await mcpModule.beginAuthorization(new Request(authorizeUrl), authStore);
assert.equal(authorization.status, 200);
const authorizationHtml = await authorization.text();
assert.match(authorizationHtml, /name="password"/);
const approvalRequestId = authorizationHtml.match(/name="id" value="([^"]+)"/)?.[1];
assert.ok(approvalRequestId);

const approvalRequest = (password) => new Request("https://guard.test/oauth/approve", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ id: approvalRequestId, password }),
});
const wrongPassword = await mcpModule.approveAuthorization(approvalRequest("wrong-password"), authStore);
assert.equal(wrongPassword.status, 403);
assert.match(await wrongPassword.text(), /密码不对/);

const approval = await mcpModule.approveAuthorization(
  approvalRequest("correct-horse-battery-staple"),
  authStore,
);
assert.equal(approval.status, 302);
const oauthRedirect = new URL(approval.headers.get("location"));
assert.equal(oauthRedirect.searchParams.get("state"), "state-123");
const authorizationCode = oauthRedirect.searchParams.get("code");
assert.ok(authorizationCode);

const tokenForm = new URLSearchParams({
  grant_type: "authorization_code",
  code: authorizationCode,
  client_id: registeredClient.client_id,
  redirect_uri: registeredClient.redirect_uris[0],
  code_verifier: verifier,
  resource: "https://guard.test/mcp",
});
const tokenResponse = await mcpModule.exchangeToken(new Request("https://guard.test/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenForm,
}), authStore);
assert.equal(tokenResponse.status, 200);
const tokenBody = await tokenResponse.json();
assert.equal(tokenBody.token_type, "Bearer");
assert.ok(tokenBody.access_token);
assert.equal(await mcpModule.hasValidAccessToken(new Request("https://guard.test/mcp", {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
}), authStore), true);
assert.equal(await mcpModule.hasValidAccessToken(new Request("https://other.test/mcp", {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
}), authStore), false);

const replayedCode = await mcpModule.exchangeToken(new Request("https://guard.test/oauth/token", {
  method: "POST",
  body: tokenForm,
}), authStore);
assert.equal(replayedCode.status, 400);
assert.equal((await replayedCode.json()).error, "invalid_grant");

const eventStore = new MemoryStore();
const directActivation = await mcpModule.activateGuardInStore(eventStore);
assert.equal(directActivation.ok, true);
assert.equal(directActivation.active, true);
assert.equal(directActivation.stage, "armed");
assert.equal((await eventStore.get("state/current")).active, true);
assert.ok([...eventStore.values.keys()].some((key) => key.startsWith("events/")));

let mcpActivations = 0;
const mcpDependencies = {
  activateGuard: async () => { mcpActivations += 1; return { ok: true, active: true, attempts: 0, stage: "armed" }; },
  readGuardState: async () => ({ active: true, attempts: 2, ends_at: "2099-01-01T00:00:00.000Z" }),
};
const mcpRequest = (body) => new Request("https://guard.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const unauthorizedMcp = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }), mcpDependencies, false);
assert.equal(unauthorizedMcp.status, 401);
assert.match(unauthorizedMcp.headers.get("www-authenticate"), /resource_metadata=.*oauth-protected-resource\/mcp/);

const initializedMcp = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize" }), mcpDependencies, true);
assert.equal((await initializedMcp.json()).result.serverInfo.name, "sleepy-dog-lock");
const listedTools = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }), mcpDependencies, true);
const tools = (await listedTools.json()).result.tools;
assert.deepEqual(tools.map((tool) => tool.name), ["activate_sleep_guard", "get_sleep_guard_status"]);
assert.equal(tools[0].annotations.readOnlyHint, false);

const activatedMcp = await mcpModule.handleMcp(mcpRequest({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "activate_sleep_guard", arguments: {} },
}), mcpDependencies, true);
const activatedMcpBody = await activatedMcp.json();
assert.equal(activatedMcpBody.result.structuredContent.active, true);
assert.equal(mcpActivations, 1);

console.log(
  `verify passed: ${sourceFiles.length} files, guard state/API, optional Bark, password OAuth PKCE/resource binding, MCP auth/tools`,
);
