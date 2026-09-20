import { useSuspenseQuery } from "@tanstack/react-query";
import { ApiError } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { toast } from "ui/sonner";
import {
  ProfileForm,
  type ProfileFormPayload,
} from "../../../components/profile-form";
import { getAuthMeQueryOptions } from "../../auth/permissions.hooks";
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
  // carries it, and the route primes it alongside the profile. Suspense, not
  // useAuthMe()'s plain useQuery: a cold cache should hold the skeleton
  // rather than paint an empty box under "the address you sign in with".
  //
  // A failed /auth/me never reaches the render below either. me() resolves
  // undefined on a non-2xx, react-query rejects a queryFn that resolves
  // undefined, and a suspense query throws that to the route's error
  // boundary. The type can't express it, hence the `?.` on the value.
  const { data: me } = useSuspenseQuery(getAuthMeQueryOptions());

  const handleSave = async (payload: ProfileFormPayload) => {
    try {
      await update.mutateAsync(payload);
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
          <Input type="email" value={me?.email ?? ""} disabled readOnly />
          <p className="text-sm text-muted-foreground">
            This is the address you sign in with. It can&apos;t be changed here.
          </p>
        </Field>
      </ProfileForm>
    </div>
  );
}
