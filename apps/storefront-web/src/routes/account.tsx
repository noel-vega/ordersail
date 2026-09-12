import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
} from "react-router";
import { ApiError } from "storefront-sdk";
import { storefrontApi } from "../lib/storefront-api-client";
import { Field, FieldLabel, Input, Button, Separator } from "../components/ui";

export async function accountLoader() {
  // customer.get() already retries once via a refresh (in-memory access
  // tokens don't survive a page reload) — a real 401 after that means
  // there's no session at all
  const customer = await storefrontApi.customer.get();
  if (!customer) {
    throw redirect("/signin");
  }
  return customer;
}

export async function accountAction({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "logout") {
    await storefrontApi.logout();
    return redirect("/products");
  }

  const firstName = String(formData.get("firstName") ?? "");
  const lastName = String(formData.get("lastName") ?? "");
  const email = String(formData.get("email") ?? "");

  try {
    await storefrontApi.customer.update({ firstName, lastName, email });
  } catch (error) {
    return {
      error:
        error instanceof ApiError ? error.message : "Unable to save changes.",
    };
  }

  // a successful non-GET submission revalidates the loader automatically,
  // so accountLoader picks up the change — no need to return it here
  return null;
}

export function AccountPage() {
  const customer = useLoaderData<typeof accountLoader>();
  const actionData = useActionData<typeof accountAction>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="mx-auto max-w-sm px-6 py-12">
      <h1 className="text-2xl font-medium">Your account</h1>

      {actionData?.error && (
        <p className="mt-4 text-sm text-destructive">{actionData.error}</p>
      )}

      <Form method="post" className="mt-6 space-y-4">
        <Field>
          <FieldLabel>First name</FieldLabel>
          <Input name="firstName" defaultValue={customer.firstName} required />
        </Field>

        <Field>
          <FieldLabel>Last name</FieldLabel>
          <Input name="lastName" defaultValue={customer.lastName} required />
        </Field>

        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" name="email" defaultValue={customer.email} required />
        </Field>

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : "Save changes"}
        </Button>
      </Form>

      <Separator className="my-6" />

      <Form method="post">
        <input type="hidden" name="intent" value="logout" />
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </Form>
    </div>
  );
}
