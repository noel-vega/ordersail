import { createFileRoute } from "@tanstack/react-router";

// Placeholder. The profile form (name + phone, against the self-service
// endpoints) is OS-386; this route exists now so /app/me has somewhere to
// redirect to and the sub-nav's Profile tab type-checks.
export const Route = createFileRoute("/app/me/profile")({
  staticData: { breadcrumb: "Profile" },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      <p className="text-sm text-muted-foreground">
        Editing your name and phone number is coming shortly.
      </p>
    </div>
  );
}
