import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import path from "path";

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_OAUTH_PORT = 1455;

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthState = {
  status: "idle" | "pending" | "success" | "error";
  error?: string;
};

type PkceCodes = {
  verifier: string;
  challenge: string;
};

type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

type OpenAIAuth = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

type PendingOAuth = {
  pkce: PkceCodes;
  state: string;
  timeout: NodeJS.Timeout;
};

let server: http.Server | undefined;
let pending: PendingOAuth | undefined;
let oauthState: OAuthState = { status: "idle" };

function authPath() {
  return path.join(process.cwd(), ".stackfish", "auth.json");
}

function base64UrlEncode(buffer: ArrayBuffer | Buffer): string {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return data
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
  });
  return `${OPENAI_ISSUER}/oauth/authorize?${params.toString()}`;
}

export type IdTokenClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  return response.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  return response.json();
}

async function readAuth(): Promise<OpenAIAuth | undefined> {
  try {
    const data = await fs.readFile(authPath(), "utf8");
    const parsed = JSON.parse(data);
    if (parsed?.type === "oauth" && parsed.access && parsed.refresh && parsed.expires) {
      return parsed as OpenAIAuth;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeAuth(auth: OpenAIAuth) {
  const dir = path.dirname(authPath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(authPath(), JSON.stringify(auth, null, 2), "utf8");
}

export async function clearOpenAIAuth() {
  try {
    await fs.unlink(authPath());
  } catch {}
  oauthState = { status: "idle" };
}

export async function ensureOpenAIAuth(): Promise<OpenAIAuth | undefined> {
  const auth = await readAuth();
  if (!auth) return undefined;
  if (!auth.access || auth.expires < Date.now()) {
    const tokens = await refreshAccessToken(auth.refresh);
    const accountId = extractAccountId(tokens) || auth.accountId;
    const updated: OpenAIAuth = {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(accountId ? { accountId } : {}),
    };
    await writeAuth(updated);
    return updated;
  }
  return auth;
}

export async function getOpenAIAuthStatus() {
  const auth = await readAuth();
  const status = auth && oauthState.status === "idle" ? "success" : oauthState.status;
  return {
    ...oauthState,
    status,
    connected: Boolean(auth),
    accountId: auth?.accountId,
  };
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Stackfish - Codex Authorization Successful</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Stackfish.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`;

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Stackfish - Codex Authorization Failed</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`;

function clearPending() {
  if (pending) {
    clearTimeout(pending.timeout);
  }
  pending = undefined;
}

function stopOAuthServer() {
  if (!server) return;
  server.close();
  server = undefined;
}

async function handleCallback(url: URL, res: http.ServerResponse) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    const message = errorDescription || error;
    oauthState = { status: "error", error: message };
    clearPending();
    stopOAuthServer();
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(message));
    return;
  }

  if (!code) {
    const message = "Missing authorization code";
    oauthState = { status: "error", error: message };
    clearPending();
    stopOAuthServer();
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(message));
    return;
  }

  if (!pending || state !== pending.state) {
    const message = "Invalid state - potential CSRF attack";
    oauthState = { status: "error", error: message };
    clearPending();
    stopOAuthServer();
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(message));
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code, `http://localhost:${OPENAI_OAUTH_PORT}/auth/callback`, pending.pkce);
    const accountId = extractAccountId(tokens);
    const auth: OpenAIAuth = {
      type: "oauth",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(accountId ? { accountId } : {}),
    };
    await writeAuth(auth);
    oauthState = { status: "success" };
    clearPending();
    stopOAuthServer();
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_SUCCESS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    oauthState = { status: "error", error: message };
    clearPending();
    stopOAuthServer();
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(message));
  }
}

function handleCancel(res: http.ServerResponse) {
  oauthState = { status: "error", error: "Login cancelled" };
  clearPending();
  stopOAuthServer();
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Login cancelled");
}

async function startOAuthServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const url = new URL(req.url, `http://localhost:${OPENAI_OAUTH_PORT}`);
    if (url.pathname === "/auth/callback") {
      void handleCallback(url, res);
      return;
    }
    if (url.pathname === "/cancel") {
      handleCancel(res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(OPENAI_OAUTH_PORT, () => resolve());
  });
}

export async function startOpenAIAuthorize() {
  await startOAuthServer();
  const pkce = await generatePKCE();
  const state = generateState();
  clearPending();
  pending = {
    pkce,
    state,
    timeout: setTimeout(() => {
      oauthState = { status: "error", error: "OAuth callback timeout - authorization took too long" };
      clearPending();
      stopOAuthServer();
    }, OAUTH_TIMEOUT_MS),
  };
  oauthState = { status: "pending" };
  return {
    url: buildAuthorizeUrl(`http://localhost:${OPENAI_OAUTH_PORT}/auth/callback`, pkce, state),
    method: "auto" as const,
    instructions: "Complete authorization in your browser. This window will close automatically.",
  };
}
