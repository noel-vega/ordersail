import {
  queryOptions,
  useMutation,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { UpdateUserProfileDto } from "merchant-sdk";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

// The signed-in user's own editable attributes. Nested under ["auth", "me"]
// so an auth-wide invalidation reaches it, but a separate request from
// getAuthMeQueryOptions(): that one is cached with a 60s staleTime for the
// permission context, which is the wrong lifecycle for the values behind a
// form. No staleTime here — the form should open on what's stored.
export function getMyProfileQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "me", "profile"],
    queryFn: () => merchantApi.profile(),
  });
}

export function useMyProfileSuspenseQuery() {
  return useSuspenseQuery(getMyProfileQueryOptions());
}

export function useUpdateMyProfileMutation() {
  return useMutation({
    // arrow, not a bare method reference — profile()/updateProfile() are
    // AdminClient methods and need `this`
    mutationFn: (params: UpdateUserProfileDto) =>
      merchantApi.updateProfile(params),
    onSuccess: () => {
      // ["auth", "me"] covers the profile query above and GET /auth/me, whose
      // name the sidebar account menu renders
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      // the staff list and any open staff record show this user's name too
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
