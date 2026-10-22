import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
function contentSecurityPolicy(nonce: string) {
  const dev = process.env.NODE_ENV === "development";
  let supabaseOrigin = "";
  let websocketOrigin = "";
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    supabaseOrigin = url.origin;
    websocketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    // A missing local configuration leaves only same-origin connections enabled.
  }
  const connectSources = ["'self'", supabaseOrigin, websocketOrigin, ...(dev ? ["ws:"] : [])].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSources}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].filter(Boolean).join("; ");
}

/**
 * Sends visitors without a session cookie to /login and refreshes signed-in sessions.
 * This is only an optimistic check: pages and server-side tenant checks do the authorization.
 */
export async function proxy(request: NextRequest) {
  const nonce = globalThis.crypto.randomUUID().replaceAll("-", "");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const nextResponse = () => {
    const next = NextResponse.next({ request: { headers: requestHeaders } });
    next.headers.set("Content-Security-Policy", csp);
    return next;
  };
  const loginRedirect = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  };
  let response = nextResponse();
  const hasSessionCookie = request.cookies.getAll().some((cookie) => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name) && cookie.value.length > 0);
  const path = request.nextUrl.pathname;
  // Avoid initializing Supabase on signed-out visits. Protected pages still verify the JWT
  // in requireUser(), and authenticated requests still refresh cookies below when needed.
  if (!hasSessionCookie) {
    if (path.startsWith("/login")) return response;
    return loginRedirect();
  }
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        requestHeaders.set("cookie", request.cookies.toString());
        response = nextResponse();
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getClaims refreshes the session when needed and verifies the JWT without calling the auth server
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims.sub;
  if (!user && !path.startsWith("/login")) return loginRedirect();
  return response;
}

export const config = {
  // everything except the API (token auth / public health), static files and PWA assets
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|sw.js|.*\\.(?:png|svg|jpg|webp)$).*)"],
};
