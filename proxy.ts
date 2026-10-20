import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends visitors without a session cookie to /login and refreshes signed-in sessions.
 * This is only an optimistic check: pages and server-side tenant checks do the authorization.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const hasSessionCookie = request.cookies.getAll().some((cookie) => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name) && cookie.value.length > 0);
  const path = request.nextUrl.pathname;
  // Avoid initializing Supabase on signed-out visits. Protected pages still verify the JWT
  // in requireUser(), and authenticated requests still refresh cookies below when needed.
  if (!hasSessionCookie) {
    if (path.startsWith("/login")) return response;
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getClaims refreshes the session when needed and verifies the JWT without calling the auth server
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims.sub;
  if (!user && !path.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // everything except the API (token auth / public health), static files and PWA assets
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|.*\\.(?:png|svg|jpg|webp)$).*)"],
};
