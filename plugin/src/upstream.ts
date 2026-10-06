// Purpose: where the engine forwards Codex's requests. The default is the ChatGPT backend, the plugin's original
// behavior. CAM_UPSTREAM_URL or --upstream redirects the engine to any HTTP or HTTPS origin, for example a local
// provider switcher listening on 127.0.0.1:15721. The request path is kept, so a Codex base_url of
// http://localhost:17891/v1 reaches http://127.0.0.1:15721/v1/... unchanged.
// Input: a URL string, the environment and the argument list. Output: the parsed upstream and its wire forms.

export type Upstream = {
  url: URL;
  host: string;
  port: number;
  secure: boolean;
  // The URL's own path ("" for a bare origin), joined ahead of the request path.
  base: string;
};

export const DEFAULT_UPSTREAM_URL = "https://chatgpt.com";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

export function parseUpstream(value?: string | null): Upstream {
  const raw = value?.trim() || DEFAULT_UPSTREAM_URL;
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported upstream protocol: ${url.protocol}`);
  const secure = url.protocol === "https:";
  return {
    url,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || (secure ? 443 : 80)),
    secure,
    base: url.pathname.replace(/\/+$/, ""),
  };
}

// --upstream wins over CAM_UPSTREAM_URL, so a launcher or a test can override the environment for one process.
export function upstreamSetting(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): string | null {
  const index = argv.indexOf("--upstream");
  const fromArgs = index >= 0 ? argv[index + 1]?.trim() : "";
  return fromArgs || env.CAM_UPSTREAM_URL?.trim() || null;
}

export const resolveUpstream = (env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): Upstream => parseUpstream(upstreamSetting(env, argv));

export const isLoopback = (upstream: Upstream): boolean => LOOPBACK_HOSTS.includes(upstream.host.toLowerCase());

// The host header and the reported label keep a non-default port; IPv6 hosts get their brackets back.
export function upstreamHostHeader(upstream: Upstream): string {
  const shown = upstream.host.includes(":") ? `[${upstream.host}]` : upstream.host;
  return upstream.port === (upstream.secure ? 443 : 80) ? shown : `${shown}:${upstream.port}`;
}

export const upstreamLabel = (upstream: Upstream): string => `${upstream.secure ? "https" : "http"}://${upstreamHostHeader(upstream)}${upstream.base}`;

// Merge the upstream's own path prefix with the request path, never duplicating a prefix the request already carries.
export function upstreamPath(upstream: Upstream, requestPath: string): string {
  const path = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  if (!upstream.base || path === upstream.base || path.startsWith(`${upstream.base}/`)) return path;
  return `${upstream.base}${path}`;
}
