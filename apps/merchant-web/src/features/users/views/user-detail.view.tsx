import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { User } from "merchant-sdk";
import { ApiError } from "merchant-sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { toast } from "ui/sonner";
import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import { Can } from "../../../components/can";
import {
  ProfileForm,
  type ProfileFormValues,
} from "../../../components/profile-form";
import { usePermissions } from "../../auth/permission-context";
import { useAuthMe } from "../../auth/permissions.hooks";
import {
  useDeactivateUserMutation,
  useReactivateUserMutation,
  useResendInviteMutation,
  useRevokeInviteMutation,
  useUpdateUserMutation,
  useUserSuspenseQuery,
} from "../users.hooks";
import { EditUserRolesSheet } from "./edit-user-roles-sheet";
import { UserStatusBadge } from "./user-status-badge";

export function UserDetailView({ id }: { id: number }) {
  const navigate = useNavigate();
  const { data: user } = useUserSuspenseQuery(id);
  const me = useAuthMe();
  const perms = usePermissions();

  // isSelf no longer grants edit rights — this page is the administrative view
  // of a user, and your own data is editable at /app/me. It stays because an
  // owner must not be able to deactivate themselves out of their own account.
  const isSelf = me.data?.userId === id;
  const canEditProfile = perms.has("users:write");
  const canDeactivate = perms.has("users:deactivate") && !isSelf;

  const [rolesOpen, setRolesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const deactivate = useDeactivateUserMutation();
  const reactivate = useReactivateUserMutation();
  const resendInvite = useResendInviteMutation();
  const revokeInvite = useRevokeInviteMutation();
  const lifecyclePending = deactivate.isPending || reactivate.isPending;

  const handleResend = () => {
    resendInvite.mutate(id, {
      onSuccess: () =>
        toast.success(`Invite re-sent to ${user.email}. The old link no longer works.`),
    });
  };

  const handleRevoke = async () => {
    setRevokeError(null);
    try {
      await revokeInvite.mutateAsync(id);
      navigate({ to: "/app/users" });
    } catch (err) {
      setRevokeError(
        err instanceof ApiError
          ? err.message
          : "Couldn't revoke the invite — please try again.",
      );
    }
  };

  const runLifecycle = async () => {
    setLifecycleError(null);
    const mutation = user.status === "deactivated" ? reactivate : deactivate;
    try {
      await mutation.mutateAsync(id);
      setConfirmOpen(false);
    } catch (err) {
      setLifecycleError(
        err instanceof ApiError
          ? err.message
          : "Couldn't complete that — please try again.",
      );
    }
  };

  return (
    <div>
      <header className="mb-8 flex items-start gap-3">
        <Link to="/app/users">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to users"
          >
            <ArrowLeftIcon />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            {user.firstName} {user.lastName}
            <UserStatusBadge status={user.status} />
          </h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
          {isSelf && (
            <p className="mt-1 text-sm text-muted-foreground">
              This is you —{" "}
              <Link to="/app/me/profile" className="underline">
                edit your profile
              </Link>
            </p>
          )}
        </div>
        {canDeactivate && (
          <Button
            type="button"
            variant={user.status === "deactivated" ? "outline" : "destructive"}
            onClick={() => {
              setLifecycleError(null);
              setConfirmOpen(true);
            }}
          >
            {user.status === "deactivated" ? "Reactivate" : "Deactivate"}
          </Button>
        )}
      </header>

      <StaffProfileForm
        key={`${user.id}:${user.updatedAt}`}
        user={user}
        canEdit={canEditProfile}
      />

      <section className="mt-10 max-w-lg space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Roles</h2>
          {perms.has("users:manage_roles") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRolesOpen(true)}
            >
              Edit roles
            </Button>
          )}
        </div>
        {user.roles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {user.roles.map((role) => (
              <Badge key={role.id} variant="outline">
                {role.name}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No roles</p>
        )}
      </section>

      {user.status === "invited" && (
        <Can permission="users:write">
          <section className="mt-10 max-w-lg space-y-3">
            <h2 className="text-sm font-medium">Pending invite</h2>
            <p className="text-sm text-muted-foreground">
              {user.firstName} hasn't joined yet. Resend the invite email (this
              invalidates the previous link) or revoke it to remove them.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={resendInvite.isPending}
                onClick={handleResend}
              >
                {resendInvite.isPending ? (
                  <>
                    <LoaderCircleIcon className="animate-spin" /> Sending...
                  </>
                ) : (
                  "Resend invite"
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  setRevokeError(null);
                  setRevokeOpen(true);
                }}
              >
                Revoke invite
              </Button>
            </div>
          </section>
        </Can>
      )}

      <EditUserRolesSheet
        user={rolesOpen ? user : null}
        open={rolesOpen}
        onOpenChange={setRolesOpen}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {user.status === "deactivated"
                ? `Reactivate ${user.firstName}?`
                : `Deactivate ${user.firstName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {user.status === "deactivated"
                ? "They'll be able to sign in again and regain the access their roles grant."
                : "They'll be signed out and blocked from signing in. Their account and history are kept, and you can reactivate them later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {lifecycleError && (
            <p className="text-sm text-destructive">{lifecycleError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={
                user.status === "deactivated" ? "default" : "destructive"
              }
              disabled={lifecyclePending}
              onClick={(e) => {
                e.preventDefault();
                void runLifecycle();
              }}
            >
              {user.status === "deactivated" ? "Reactivate" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {user.firstName}'s invite?</AlertDialogTitle>
            <AlertDialogDescription>
              The invite link stops working and {user.firstName} is removed. You
              can invite them again later. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <p className="text-sm text-destructive">{revokeError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revokeInvite.isPending}
              onClick={(e) => {
                e.preventDefault();
                void handleRevoke();
              }}
            >
              Revoke invite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// The administrative side of the shared profile fields: the same three inputs,
// wired to `PATCH /users/:id` (unconditionally `users:write` since OS-384) and
// gated by the caller's permission. The personal side of the same fields is
// features/me's ProfileView, against `PATCH /auth/me/profile`. Errors stay
// inline here, exactly as they were before the form was extracted.
function StaffProfileForm(props: { user: User; canEdit: boolean }) {
  const update = useUpdateUserMutation();
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async (values: ProfileFormValues) => {
    setSaveError(null);
    try {
      await update.mutateAsync({
        id: props.user.id,
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone.trim() || undefined,
      });
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.message
          : "Couldn't save — please try again.",
      );
      throw err;
    }
  };

  return (
    <ProfileForm
      values={{
        firstName: props.user.firstName,
        lastName: props.user.lastName,
        phone: props.user.phone ?? "",
      }}
      canEdit={props.canEdit}
      isSaving={update.isPending}
      onSave={handleSave}
    >
      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
    </ProfileForm>
  );
}
