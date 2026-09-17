import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ApiError } from "merchant-sdk";
import { InfoIcon, MailIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { appConfig } from "../../../config";
import { useAuthMe } from "../permissions.hooks";
import {
  useLogoutMutation,
  useRecheckEmailVerifiedMutation,
  useResendVerificationMutation,
  useVerifyEmailMutation,
} from "../auth.hooks";

const RESEND_COOLDOWN_SECONDS = 60;

type LinkStatus =
  | { kind: "verifying" }
  | { kind: "invalid" }
  | { kind: "wrong-account"; message: string }
  | { kind: "failed" };

export function VerifyEmailView(props: { token?: string }) {
  const me = useAuthMe();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const verify = useVerifyEmailMutation();
  const logout = useLogoutMutation();
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(
    props.token ? { kind: "verifying" } : null,
  );
  // the token is single-use (deleted on success) — a second call from a
  // remount would report "invalid" right after verifying
  const started = useRef(false);

  function toSignIn(redirect: string) {
    navigate({ to: "/signin", search: { redirect } });
  }

  useEffect(() => {
    if (!props.token || started.current) return;
    started.current = true;
    verify.mutate(
      { token: props.token },
      {
        onSuccess: () => {
          navigate({ to: appConfig.homeRoute, replace: true });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) {
            setLinkStatus({ kind: "failed" });
          } else if (err.status === 401) {
            toSignIn(href);
          } else if (err.status === 403) {
            setLinkStatus({ kind: "wrong-account", message: err.message });
          } else if (err.status === 400) {
            setLinkStatus({ kind: "invalid" });
          } else {
            setLinkStatus({ kind: "failed" });
          }
        },
      },
    );
    // runs once per mount by design (see `started`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSignOut() {
    logout.mutate(undefined, {
      // a wrong-account visitor comes back to the same link as the right user
      onSuccess: () =>
        linkStatus?.kind === "wrong-account"
          ? toSignIn(href)
          : navigate({ to: "/signin" }),
    });
  }

  if (linkStatus?.kind === "verifying") {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Verifying your email...</p>
      </Centered>
    );
  }

  const alreadyVerified = me.data?.emailVerified ?? false;

  return (
    <Centered>
      {linkStatus && (
        <Alert variant="destructive" className="text-left">
          <InfoIcon />
          <AlertTitle>Couldn&apos;t verify your email</AlertTitle>
          <AlertDescription>
            {linkStatus.kind === "wrong-account"
              ? `${linkStatus.message}. You're signed in as ${me.data?.email ?? "another user"} — sign out and sign in with the account the email was sent to.`
              : linkStatus.kind === "invalid"
                ? alreadyVerified
                  ? "This link has already been used — your email is verified."
                  : "This link is invalid or has expired. Send a new one below."
                : "Something went wrong — try the link again."}
          </AlertDescription>
        </Alert>
      )}

      {alreadyVerified ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            onClick={() => navigate({ to: appConfig.homeRoute })}
          >
            Continue to Ordersail
          </Button>
          {linkStatus?.kind === "wrong-account" && (
            <Button
              type="button"
              variant="outline"
              onClick={handleSignOut}
              disabled={logout.isPending}
            >
              Sign out
            </Button>
          )}
        </div>
      ) : (
        <Lobby
          email={me.data?.email}
          onSignedOut={() => toSignIn("/verify-email")}
          onSignOut={handleSignOut}
          signingOut={logout.isPending}
        />
      )}
    </Centered>
  );
}

function Lobby(props: {
  email?: string;
  onSignedOut: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const navigate = useNavigate();
  const resend = useResendVerificationMutation();
  const recheck = useRecheckEmailVerifiedMutation();
  const [cooldown, setCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [recheckMessage, setRecheckMessage] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function handleResend() {
    setResendMessage(null);
    resend.mutate(undefined, {
      onSuccess: () => {
        setCooldown(RESEND_COOLDOWN_SECONDS);
        setResendMessage({ tone: "success", text: "Sent — check your inbox." });
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 401) {
          props.onSignedOut();
          return;
        }
        setResendMessage({
          tone: "error",
          text:
            err instanceof ApiError && err.status === 429
              ? "Too many requests — wait a minute and try again."
              : "Couldn't send the email — try again.",
        });
      },
    });
  }

  function handleRecheck() {
    setRecheckMessage(null);
    recheck.mutate(undefined, {
      onSuccess: (status) => {
        if (status === "verified") navigate({ to: appConfig.homeRoute });
        else if (status === "signed-out") props.onSignedOut();
        else setRecheckMessage("Still not verified — open the link in the email first.");
      },
      onError: () => {
        setRecheckMessage("Couldn't check right now — try again.");
      },
    });
  }

  return (
    <>
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MailIcon />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Verify your email</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          We sent a verification link to{" "}
          <span className="font-medium text-foreground">
            {props.email ?? "your email address"}
          </span>
          . Open it to finish setting up your account.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleResend}
          disabled={resend.isPending || cooldown > 0}
        >
          {resend.isPending
            ? "Sending..."
            : cooldown > 0
              ? `Resend in ${cooldown}s`
              : "Resend email"}
        </Button>
        <Button
          type="button"
          onClick={handleRecheck}
          disabled={recheck.isPending}
        >
          {recheck.isPending ? "Checking..." : "I've verified my email"}
        </Button>
      </div>

      {resendMessage && (
        <p
          className={
            resendMessage.tone === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {resendMessage.text}
        </p>
      )}
      {recheckMessage && (
        <p className="text-sm text-muted-foreground">{recheckMessage}</p>
      )}

      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        onClick={props.onSignOut}
        disabled={props.signingOut}
      >
        Sign out
      </button>
    </>
  );
}

function Centered(props: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        {props.children}
      </div>
    </div>
  );
}
