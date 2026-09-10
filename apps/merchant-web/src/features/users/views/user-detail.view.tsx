import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
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
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { toast } from "ui/sonner";
import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import { Can } from "../../../components/can";
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

const ProfileFormSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  phone: z.string(),
});

type ProfileForm = z.infer<typeof ProfileFormSchema>;

export function UserDetailView({ id }: { id: number }) {
  const navigate = useNavigate();
  const { data: user } = useUserSuspenseQuery(id);
  const me = useAuthMe();
  const perms = usePermissions();

  const isSelf = me.data?.userId === id;
  const canEditProfile = isSelf || perms.has("users:write");
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

      <ProfileForm
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

function ProfileForm(props: { user: User; canEdit: boolean }) {
  const update = useUpdateUserMutation();
  const [saveError, setSaveError] = useState<string | null>(null);
  const form = useForm<ProfileForm>({
    resolver: zodResolver(ProfileFormSchema),
    defaultValues: {
      firstName: props.user.firstName,
      lastName: props.user.lastName,
      phone: props.user.phone ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      firstName: props.user.firstName,
      lastName: props.user.lastName,
      phone: props.user.phone ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.user]);

  const handleSubmit = form.handleSubmit(async (values) => {
    setSaveError(null);
    try {
      await update.mutateAsync({
        id: props.user.id,
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone.trim() || undefined,
      });
      form.reset(values);
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.message
          : "Couldn't save — please try again.",
      );
    }
  });

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <Controller
        control={form.control}
        name="firstName"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>First name</FieldLabel>
            <Input {...field} disabled={!props.canEdit} />
            {fieldState.error && (
              <p className="text-sm text-destructive">
                {fieldState.error.message}
              </p>
            )}
          </Field>
        )}
      />

      <Controller
        control={form.control}
        name="lastName"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Last name</FieldLabel>
            <Input {...field} disabled={!props.canEdit} />
            {fieldState.error && (
              <p className="text-sm text-destructive">
                {fieldState.error.message}
              </p>
            )}
          </Field>
        )}
      />

      <Controller
        control={form.control}
        name="phone"
        render={({ field }) => (
          <Field>
            <FieldLabel>Phone</FieldLabel>
            <Input type="tel" placeholder="(555) 555-5555" {...field} disabled={!props.canEdit} />
          </Field>
        )}
      />

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      {props.canEdit && (
        <Button
          type="submit"
          disabled={update.isPending || !form.formState.isDirty}
        >
          {update.isPending ? (
            <>
              <LoaderCircleIcon className="animate-spin" /> Saving...
            </>
          ) : (
            "Save"
          )}
        </Button>
      )}
    </form>
  );
}
