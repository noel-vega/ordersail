import { ApiError } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { toast } from "ui/sonner";
import {
  ProfileForm,
  type ProfileFormValues,
} from "../../../components/profile-form";
import { useAuthMe } from "../../auth/permissions.hooks";
import {
  useMyProfileSuspenseQuery,
  useUpdateMyProfileMutation,
} from "../me.hooks";

// Your own name and phone, against the caller-scoped endpoints. No permission
// check anywhere on this path, deliberately: a user may hold no roles at all,
// and managing yourself must never be something an Owner has to grant. The
// endpoints take no id, so they can only ever address the signed-in user.
export function ProfileView() {
  const { data: profile } = useMyProfileSuspenseQuery();
  const update = useUpdateMyProfileMutation();
  // GET /auth/me/profile deliberately returns no email — it isn't editable, so
  // it isn't part of the profile write shape. The identity response already
  // carries it, and it's loaded app-wide for the permission context.
  const me = useAuthMe();

  const handleSave = async (values: ProfileFormValues) => {
    try {
      await update.mutateAsync({
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone.trim() || undefined,
      });
      toast.success("Profile saved.");
    } catch (err) {
      // MutationCache.onError has already toasted the ApiError message; this
      // just keeps the form dirty so Save stays available.
      if (!(err instanceof ApiError)) {
        toast.error("Couldn't save — please try again.");
      }
      throw err;
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Profile</h1>

      <ProfileForm
        values={{
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone ?? "",
        }}
        canEdit
        isSaving={update.isPending}
        onSave={handleSave}
      >
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" value={me.data?.email ?? ""} disabled readOnly />
          <p className="text-sm text-muted-foreground">
            This is the address you sign in with. It can't be changed here.
          </p>
        </Field>
      </ProfileForm>
    </div>
  );
}
