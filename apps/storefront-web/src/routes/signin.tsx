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

export async function signinAction({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    await storefrontApi.signIn({ email, password });
  } catch {
    return { error: "Incorrect email or password." };
  }

  return redirect("/account");
}

export function SignInPage() {
  const actionData = useActionData<typeof signinAction>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="mx-auto max-w-sm px-6 py-12">
      <h1 className="text-2xl font-medium">Sign in</h1>

      {actionData?.error && (
        <p className="mt-4 text-sm text-destructive">{actionData.error}</p>
      )}

      <Form method="post" className="mt-6 space-y-4">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" name="email" autoFocus required />
        </Field>

        <Field>
          <FieldLabel>Password</FieldLabel>
          <Input type="password" name="password" required />
        </Field>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Sign in"}
        </Button>
      </Form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don't have an account?{" "}
        <Link to="/signup" className="text-foreground underline-offset-4 hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
