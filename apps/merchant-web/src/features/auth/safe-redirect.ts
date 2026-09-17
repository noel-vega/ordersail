import { appConfig } from "../../config";

// only same-origin paths — "//evil.com" and "/\evil.com" are protocol-relative
// in browsers and would turn ?redirect= into an open redirect
export function safeRedirectPath(redirect: string | undefined): string {
  if (
    redirect &&
    redirect.startsWith("/") &&
    !redirect.startsWith("//") &&
    !redirect.startsWith("/\\")
  ) {
    return redirect;
  }
  return appConfig.homeRoute;
}
