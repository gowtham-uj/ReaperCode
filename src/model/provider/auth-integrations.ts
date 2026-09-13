import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ProviderAuthMethod,
  ProviderIntegration,
  ProviderOAuthAuthMethod,
  ProviderOAuthPollResult,
  ProviderOAuthSuccess,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REAPER_USER_AGENT = "reaper/provider-auth";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz";

export interface ProviderAuthDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  runAzure?: (args: string[]) => Promise<unknown>;
}

export function specializeProviderIntegration(
  integration: ProviderIntegration,
  dependencies: ProviderAuthDependencies = {},
): ProviderIntegration {
  const providerId = integration.descriptor.id;
  const specialized = specializedMethods(providerId, dependencies);
  if (!specialized) return integration;
  return {
    ...integration,
    authMethods: mergeMethods(integration.authMethods, specialized.methods),
    ...(specialized.refreshOAuth ? { refreshOAuth: specialized.refreshOAuth } : {}),
  };
}

interface SpecializedAuth {
  methods: ProviderAuthMethod[];
  refreshOAuth?: (auth: ProviderOAuthSuccess) => Promise<ProviderOAuthSuccess>;
}

function specializedMethods(
  providerId: string,
  dependencies: ProviderAuthDependencies,
): SpecializedAuth | undefined {
  switch (providerId) {
    case "openai":
      return openAiAuth(dependencies);
    case "github-copilot":
      return githubCopilotAuth(dependencies);
    case "xai":
      return xaiAuth(dependencies);
    case "azure":
      return azureAuth(dependencies);
    case "cloudflare-workers-ai":
      return {
        methods: [apiMethod("api-key", "API key", [textPrompt("accountId", "Enter your Cloudflare Account ID", "e.g. 1234567890abcdef")])],
      };
    case "cloudflare-ai-gateway":
      return {
        methods: [apiMethod("api-key", "Gateway API token", [
          textPrompt("accountId", "Enter your Cloudflare Account ID", "e.g. 1234567890abcdef"),
          textPrompt("gatewayId", "Enter your Cloudflare AI Gateway ID", "e.g. my-gateway"),
        ])],
      };
    case "snowflake-cortex":
      return {
        methods: [apiMethod("api-key", "Paste PAT or bearer token manually", [
          textPrompt("account", "Snowflake Account Identifier", "myorg-myaccount"),
          textPrompt("role", "Snowflake Role", "PUBLIC", false),
        ])],
      };
    case "digitalocean":
      return { methods: [apiMethod("api-key", "DigitalOcean access token")] };
    case "gitlab":
      return { methods: [apiMethod("api-key", "GitLab personal access token", [textPrompt("instanceUrl", "GitLab instance URL", "https://gitlab.com", false)])] };
    case "poe":
      return { methods: [apiMethod("api-key", "Poe API key")] };
    case "cerebras":
      return { methods: [apiMethod("api-key", "Cerebras API key")] };
    default:
      return undefined;
  }
}

function openAiAuth(dependencies: ProviderAuthDependencies): SpecializedAuth {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  return {
    methods: [
      {
        id: "chatgpt-headless",
        type: "oauth",
        label: "ChatGPT Pro/Plus (headless)",
        authorize: async () => {
          const response = await request(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
          });
          const device = await parseRequiredJson<{
            device_auth_id: string;
            user_code: string;
            interval?: string;
          }>(response, "OpenAI device authorization");
          let nextPollAt = 0;
          const intervalMs = positiveSeconds(device.interval, 5) * 1_000;
          return {
            url: `${OPENAI_ISSUER}/codex/device`,
            mode: "auto" as const,
            instructions: `Enter code: ${device.user_code}`,
            complete: async (): Promise<ProviderOAuthPollResult> => {
              if (now() < nextPollAt) return { type: "pending" };
              nextPollAt = now() + intervalMs;
              const tokenPoll = await request(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
                method: "POST",
                headers: jsonHeaders(),
                body: JSON.stringify({
                  device_auth_id: device.device_auth_id,
                  user_code: device.user_code,
                }),
              });
              if (tokenPoll.status === 403 || tokenPoll.status === 404) return { type: "pending" };
              const code = await parseRequiredJson<{ authorization_code: string; code_verifier: string }>(
                tokenPoll,
                "OpenAI device token",
              );
              const tokens = await exchangeOpenAiCode(request, code.authorization_code, code.code_verifier);
              return { type: "success", auth: openAiTokenAuth(tokens, now()) };
            },
          };
        },
      },
      apiMethod("api-key", "Manually enter API key"),
    ],
    refreshOAuth: async (auth) => {
      const response = await request(`${OPENAI_ISSUER}/oauth/token`, {
        method: "POST",
        headers: formHeaders(),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: OPENAI_CLIENT_ID,
        }).toString(),
      });
      const tokens = await parseRequiredJson<OpenAiTokens>(response, "OpenAI token refresh");
      return openAiTokenAuth(tokens, now(), auth);
    },
  };
}

function githubCopilotAuth(dependencies: ProviderAuthDependencies): SpecializedAuth {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  return {
    methods: [{
      id: "github-device",
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            { label: "GitHub Enterprise", value: "enterprise", hint: "Enterprise" },
          ],
        },
        {
          ...textPrompt("enterpriseUrl", "Enter your GitHub Enterprise URL or domain", "company.ghe.com"),
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
        },
      ],
      authorize: async (inputs = {}) => {
        const enterprise = inputs.deploymentType === "enterprise";
        const domain = enterprise ? normalizeDomain(inputs.enterpriseUrl ?? "") : "github.com";
        const deviceUrl = `https://${domain}/login/device/code`;
        const tokenUrl = `https://${domain}/login/oauth/access_token`;
        const response = await request(deviceUrl, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
        });
        const device = await parseRequiredJson<{
          verification_uri: string;
          user_code: string;
          device_code: string;
          interval?: number;
          expires_in?: number;
        }>(response, "GitHub device authorization");
        let intervalMs = positiveSeconds(device.interval, 5) * 1_000;
        const deadline = now() + positiveSeconds(device.expires_in, 900) * 1_000;
        let nextPollAt = 0;
        return {
          url: device.verification_uri,
          mode: "auto" as const,
          instructions: `Enter code: ${device.user_code}`,
          complete: async (): Promise<ProviderOAuthPollResult> => {
            if (now() >= deadline) return { type: "failed", message: "GitHub device authorization expired" };
            if (now() < nextPollAt) return { type: "pending" };
            nextPollAt = now() + intervalMs;
            const poll = await request(tokenUrl, {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                device_code: device.device_code,
                grant_type: DEVICE_GRANT,
              }),
            });
            const data = await parseJson<{ access_token?: string; error?: string; interval?: number }>(poll);
            if (data.access_token) {
              return {
                type: "success",
                auth: {
                  type: "oauth",
                  access: data.access_token,
                  refresh: data.access_token,
                  expires: 0,
                  ...(enterprise ? { enterpriseUrl: `https://${domain}` } : {}),
                },
              };
            }
            if (data.error === "authorization_pending") return { type: "pending" };
            if (data.error === "slow_down") {
              intervalMs = positiveSeconds(data.interval, intervalMs / 1_000 + 5) * 1_000;
              return { type: "pending" };
            }
            return { type: "failed", message: githubDeviceError(data.error) };
          },
        };
      },
    }],
  };
}

function xaiAuth(dependencies: ProviderAuthDependencies): SpecializedAuth {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  return {
    methods: [
      {
        id: "supergrok-device",
        type: "oauth",
        label: "SuperGrok Subscription",
        authorize: async () => {
          const response = await request(XAI_DEVICE_URL, {
            method: "POST",
            headers: formHeaders(),
            body: new URLSearchParams({
              client_id: XAI_CLIENT_ID,
              scope: "openid profile email offline_access grok-cli:access api:access",
              referrer: "reaper",
            }).toString(),
          });
          const device = await parseRequiredJson<{
            device_code: string;
            user_code: string;
            verification_uri: string;
            verification_uri_complete?: string;
            expires_in?: number;
            interval?: number;
          }>(response, "xAI device authorization");
          let intervalMs = positiveSeconds(device.interval, 5) * 1_000;
          const deadline = now() + positiveSeconds(device.expires_in, 300) * 1_000;
          let nextPollAt = 0;
          return {
            url: device.verification_uri_complete ?? device.verification_uri,
            mode: "auto" as const,
            instructions: `Open ${device.verification_uri} and enter code: ${device.user_code}`,
            complete: async (): Promise<ProviderOAuthPollResult> => {
              if (now() >= deadline) return { type: "failed", message: "xAI device authorization expired" };
              if (now() < nextPollAt) return { type: "pending" };
              nextPollAt = now() + intervalMs;
              const poll = await request(XAI_TOKEN_URL, {
                method: "POST",
                headers: formHeaders(),
                body: new URLSearchParams({
                  grant_type: DEVICE_GRANT,
                  client_id: XAI_CLIENT_ID,
                  device_code: device.device_code,
                }).toString(),
              });
              const data = await parseJson<XaiTokens & { error?: string; error_description?: string }>(poll);
              if (poll.ok && data.access_token && data.refresh_token) {
                return { type: "success", auth: xaiTokenAuth(data, now()) };
              }
              if (data.error === "authorization_pending") return { type: "pending" };
              if (data.error === "slow_down") {
                intervalMs += 5_000;
                return { type: "pending" };
              }
              return { type: "failed", message: xaiDeviceError(data.error, data.error_description) };
            },
          };
        },
      },
      apiMethod("api-key", "Manually enter API key"),
    ],
    refreshOAuth: async (auth) => {
      const response = await request(XAI_TOKEN_URL, {
        method: "POST",
        headers: formHeaders(),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: XAI_CLIENT_ID,
        }).toString(),
      });
      const tokens = await parseRequiredJson<XaiTokens>(response, "xAI token refresh");
      return xaiTokenAuth(tokens, now(), auth);
    },
  };
}

function azureAuth(dependencies: ProviderAuthDependencies): SpecializedAuth {
  const now = dependencies.now ?? Date.now;
  const runAzure = dependencies.runAzure ?? (async (args: string[]) => {
    const result = await execFileAsync("az", args, { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(result.stdout) as unknown;
  });
  const prompts = [textPrompt("resourceName", "Enter Azure Resource Name", "e.g. my-models")];
  const fetchAzureToken = async (): Promise<ProviderOAuthSuccess> => {
    const raw = await runAzure([
      "account", "get-access-token", "--scope",
      "https://cognitiveservices.azure.com/.default", "--output", "json",
    ]) as { accessToken?: string; expires_on?: number; expiresOn?: string };
    if (!raw.accessToken) throw new Error("Azure CLI did not return an access token");
    const expires = raw.expires_on ? raw.expires_on * 1_000 : Date.parse(raw.expiresOn ?? "");
    if (!Number.isFinite(expires)) throw new Error("Azure CLI returned an invalid expiration");
    return { type: "oauth", access: raw.accessToken, refresh: "azure-cli", expires };
  };
  return {
    methods: [
      apiMethod("api-key", "API key", prompts),
      {
        id: "azure-cli",
        type: "oauth",
        label: "Microsoft Entra ID (Azure CLI)",
        prompts,
        authorize: async (inputs = {}) => ({
          url: "",
          mode: "auto" as const,
          instructions: "Sign in with `az login` before continuing.",
          complete: async () => {
            try {
              const auth = await fetchAzureToken();
              return {
                type: "success" as const,
                auth: { ...auth, ...(inputs.resourceName ? { accountId: inputs.resourceName } : {}) },
              };
            } catch (error) {
              return { type: "failed" as const, message: safeError(error, "Azure CLI authentication failed") };
            }
          },
        }),
      },
    ],
    refreshOAuth: async (auth) => ({
      ...(await fetchAzureToken()),
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
    }),
  };
}

interface OpenAiTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface XaiTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchangeOpenAiCode(
  request: typeof fetch,
  authorizationCode: string,
  codeVerifier: string,
): Promise<OpenAiTokens> {
  const response = await request(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: formHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  return await parseRequiredJson<OpenAiTokens>(response, "OpenAI token exchange");
}

function openAiTokenAuth(
  tokens: OpenAiTokens,
  now: number,
  previous?: ProviderOAuthSuccess,
): ProviderOAuthSuccess {
  const accountId = extractJwtClaim(tokens.id_token ?? tokens.access_token, "https://api.openai.com/auth", "chatgpt_account_id")
    ?? extractJwtClaim(tokens.id_token ?? tokens.access_token, undefined, "chatgpt_account_id")
    ?? previous?.accountId;
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token || previous?.refresh || "",
    expires: now + positiveSeconds(tokens.expires_in, 3_600) * 1_000,
    ...(accountId ? { accountId } : {}),
  };
}

function xaiTokenAuth(
  tokens: XaiTokens,
  now: number,
  previous?: ProviderOAuthSuccess,
): ProviderOAuthSuccess {
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token || previous?.refresh || "",
    expires: now + positiveSeconds(tokens.expires_in, 3_600) * 1_000,
  };
}

function mergeMethods(base: ProviderAuthMethod[], specialized: ProviderAuthMethod[]): ProviderAuthMethod[] {
  const result = [...specialized];
  for (const method of base) {
    if (!result.some((candidate) => candidate.id === method.id)) result.push(method);
  }
  return result;
}

function apiMethod(
  id: string,
  label: string,
  prompts?: Extract<ProviderAuthMethod, { type: "api" }>["prompts"],
): Extract<ProviderAuthMethod, { type: "api" }> {
  return { id, type: "api", label, ...(prompts?.length ? { prompts } : {}) };
}

function textPrompt(key: string, message: string, placeholder: string, required = true) {
  return {
    type: "text" as const,
    key,
    message,
    placeholder,
    ...(required ? {} : { optional: true as const }),
  };
}

function normalizeDomain(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("GitHub Enterprise URL is required");
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || !url.hostname) throw new Error("GitHub Enterprise must use a valid HTTPS URL");
  return url.hostname;
}

function positiveSeconds(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonHeaders(): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json", "User-Agent": REAPER_USER_AGENT };
}

function formHeaders(): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": REAPER_USER_AGENT };
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}

async function parseRequiredJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
  const data = await parseJson<T>(response);
  if (!data || typeof data !== "object") throw new Error(`${operation} returned an invalid response`);
  return data;
}

function extractJwtClaim(
  token: string | undefined,
  namespace: string | undefined,
  key: string,
): string | undefined {
  if (!token) return undefined;
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
    const source = namespace && payload[namespace] && typeof payload[namespace] === "object"
      ? payload[namespace] as Record<string, unknown>
      : payload;
    return typeof source[key] === "string" ? source[key] : undefined;
  } catch {
    return undefined;
  }
}

function githubDeviceError(error: string | undefined): string {
  if (error === "access_denied") return "GitHub device authorization was denied";
  if (error === "expired_token") return "GitHub device authorization expired";
  return "GitHub device authorization failed";
}

function xaiDeviceError(error: string | undefined, description: string | undefined): string {
  if (error === "access_denied" || error === "authorization_denied") return "xAI device authorization was denied";
  if (error === "expired_token") return "xAI device authorization expired";
  return description || "xAI device authorization failed";
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
