import { createRootRoute, Outlet, redirect } from "@tanstack/react-router";
import { Toaster } from "ui/sonner";
import { merchantApi } from "../lib/merchant-api-client";
import { appConfig } from "../config";
import { safeRedirectPath } from "../features/auth/safe-redirect";

const RootLayout = () => (
  <div className="h-dvh">
    <Outlet />
    <Toaster />
  </div>
);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const accessToken = await merchantApi.refreshAccessToken();

    switch (location.pathname) {
      case "/":
        // "/" is only ever a gateway — send authed users home, everyone else
        // to sign-in (routes/index.tsx never renders as a result)
        throw redirect({ to: accessToken ? appConfig.homeRoute : "/signin" });
      case "/signin":
      case "/signup":
        if (accessToken) {
          const next = (location.search as { redirect?: string }).redirect;
          throw redirect({ href: safeRedirectPath(next) });
        }
        break;
      case "/join":
        // an invite link must work even if this browser already has an
        // unrelated session active (e.g. the account owner testing their
        // own invite) — never bounce this route away
        break;
      default:
        // /app is now homeRoute itself, so it belongs here rather than in
        // the case above — bouncing an authenticated visit at /app to
        // homeRoute (also /app) would just redirect to itself forever
        // remember where they were headed (e.g. an emailed /verify-email
        // link opened on another device) so sign-in can return them there
        if (!accessToken) {
          throw redirect({
            to: "/signin",
            search: { redirect: location.href },
          });
        }
    }
  },

  component: RootLayout,
});
