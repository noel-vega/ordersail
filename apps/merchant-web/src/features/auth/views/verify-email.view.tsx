import { useEffect, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { appConfig } from "../../../config";
import { useVerifyEmailMutation } from "../auth.hooks";

export function VerifyEmailView(props: { token: string }) {
  const verify = useVerifyEmailMutation();
  const navigate = useNavigate();
  // the token is single-use (deleted on success) — a second call from a
  // remount would report "expired" right after verifying
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verify.mutate(
      { token: props.token },
      {
        onSuccess: () => {
          navigate({ to: appConfig.homeRoute, replace: true });
        },
      },
    );
  }, [props.token, verify, navigate]);

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-6">
        {verify.isError ? (
          <>
            <Alert variant="destructive">
              <InfoIcon />
              <AlertTitle>Couldn't verify your email</AlertTitle>
              <AlertDescription>
                This link is invalid or has expired. Request a new one and try
                again.
              </AlertDescription>
            </Alert>
            <Link to="/app/verify-email">
              <Button type="button" className="w-full">
                Send a new link
              </Button>
            </Link>
          </>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            Verifying your email...
          </p>
        )}
      </div>
    </div>
  );
}
