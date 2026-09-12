import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  type ActionFunctionArgs,
} from "react-router";
import { storefrontApi } from "../lib/storefront-api-client";
import { Field, FieldLabel, Input, Button } from "../components/ui";

export async function signupAction({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const firstName = String(formData.get("firstName") ?? "");
  const lastName = String(formData.get("lastName") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    await storefrontApi.signUp({ firstName, lastName, email, password });
  } catch {
    return { error: "Unable to create an account. This email may already be in use." };
  }

  return redirect("/account");
}

export function SignUpPage() {
  const actionData = useActionData<typeof signupAction>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="mx-auto max-w-sm px-6 py-12">
      <h1 className="text-2xl font-medium">Create an account</h1>

      {actionData?.error && (
        <p className="mt-4 text-sm text-destructive">{actionData.error}</p>
      )}

      <Form method="post" className="mt-6 space-y-4">
        <Field>
          <FieldLabel>First name</FieldLabel>
          <Input name="firstName" autoFocus required />
        </Field>

        <Field>
          <FieldLabel>Last name</FieldLabel>
          <Input name="lastName" required />
        </Field>

        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" name="email" required />
        </Field>

        <Field>
          <FieldLabel>Password</FieldLabel>
          <Input type="password" name="password" minLength={8} required />
        </Field>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating account..." : "Create account"}
        </Button>
      </Form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/signin" className="text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
