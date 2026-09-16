import { Link, Text } from "@react-email/components";
import { render } from "@react-email/render";
import { EmailLayout } from "../components/layout.js";

export interface PasswordResetEmailProps {
  firstName: string;
  resetUrl: string;
}

export function PasswordResetEmail({ firstName, resetUrl }: PasswordResetEmailProps) {
  return (
    <EmailLayout>
      <Text>Hi {firstName},</Text>
      <Text>We received a request to reset your Ordersail password. Click below to choose a new one.</Text>
      <Text>
        <Link href={resetUrl}>Reset your password</Link>
      </Text>
      <Text>If you didn&apos;t request this, you can safely ignore this email.</Text>
    </EmailLayout>
  );
}

export default PasswordResetEmail;

export function renderPasswordResetEmail(props: PasswordResetEmailProps): Promise<string> {
  return render(<PasswordResetEmail {...props} />);
}
