import { describe, it, expect, vi, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * Course files linked from HTML (a lecture table's /content/enforced/... PDF)
 * are served to browser sessions only: the Bearer token gets a 302 to the
 * login page, the session cookie gets the file.
 */

const SESSION_COOKIE = "d2lSessionVal=abc; d2lSecureSessionVal=def";
const BASE = "https://brightspace.nyu.edu";
const FILE = "/content/enforced/617117-FA26_CSCI-UA_480_1_051_crse/introduction.pdf";

const token = (overrides: Partial<TokenData> = {}): TokenData => ({
  accessToken: "eyJ.jwt.sig",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  cookieHeader: SESSION_COOKIE,
  ...overrides,
});

function makeClient(t: TokenData) {
  const fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  const tokenManager = { getToken: vi.fn(async () => t) } as unknown as TokenManager;
  const onAuthExpired = vi.fn(async () => true);
  return { client: new D2LApiClient({ baseUrl: BASE, tokenManager, onAuthExpired }), fetchMock, onAuthExpired };
}

const pdf = () => new Response(Buffer.from("%PDF-1.4 body"), { status: 200, headers: { "content-type": "application/pdf" } });

describe("D2LApiClient.getCourseFile", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches a course file with the session cookie and no Bearer token", async () => {
    const { client, fetchMock } = makeClient(token());
    fetchMock.mockResolvedValue(pdf());

    const response = await client.getCourseFile(FILE);

    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-1.4 body");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}${FILE}`);
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("accepts the absolute URL of the same Brightspace", async () => {
    const { client, fetchMock } = makeClient(token());
    fetchMock.mockResolvedValue(pdf());

    await client.getCourseFile(`${BASE}${FILE}`);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}${FILE}`);
  });

  it.each([
    "https://evil.example/content/enforced/x.pdf",
    "//evil.example/content/enforced/x.pdf",
    "/d2l/api/lp/1.0/users/whoami",
    "/content/../d2l/api/lp/1.0/users/whoami",
    "content/enforced/x.pdf",
  ])("refuses %s without sending the cookie", async (path) => {
    const { client, fetchMock } = makeClient(token());

    await expect(client.getCourseFile(path)).rejects.toThrow(/course file path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains that a stored browser session is needed when there is no cookie", async () => {
    const { client, fetchMock } = makeClient(token({ cookieHeader: undefined }));

    await expect(client.getCourseFile(FILE)).rejects.toThrow(/browser sign-in session/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a redirect to the login page as an expired session, without starting a login", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(token());
    const login = new Response("<html><form id=login></form></html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(login, "redirected", { value: true });
    Object.defineProperty(login, "url", { value: `${BASE}/d2l/login?target=%2fcontent%2fenforced` });
    fetchMock.mockResolvedValue(login);

    const error = await client.getCourseFile(FILE).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});
