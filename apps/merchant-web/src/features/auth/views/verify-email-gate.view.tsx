import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ApiError } from "merchant-sdk";
import { MailIcon } from "lucide-react";
import { Button } from "ui/button";
import { queryClient } from "../../../lib/react-query-client";
import { appConfig } from "../../../config";
import {
  getAuthMeQueryOptions,
  useAuthMe,
} from "../permissions.hooks";
import {
  useRecheckEmailVerifiedMutation,
  useResendVerificationMutation,
} from "../auth.hooks";

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyEmailGateView() {
  const me = useAuthMe();
  const navigate = useNavigate();
  const resend = useResendVerificationMutation();
  const recheck = useRecheckEmailVerifiedMutation();
  const [cooldown, setCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [recheckHint, setRecheckHint] = useState(false);

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
    setRecheckHint(false);
    recheck.mutate(undefined, {
      onSuccess: async () => {
        const fresh = await queryClient.fetchQuery(getAuthMeQueryOptions());
        if (fresh?.emailVerified) {
          navigate({ to: appConfig.homeRoute });
        } else {
          setRecheckHint(true);
        }
      },
    });
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MailIcon />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Verify your email</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          We sent a verification link to{" "}
          <span className="font-medium text-foreground">
            {me.data?.email ?? "your email address"}
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
      {recheckHint && (
        <p className="text-sm text-muted-foreground">
          Still not verified — open the link in the email first.
        </p>
      )}
    </div>
  );
}
