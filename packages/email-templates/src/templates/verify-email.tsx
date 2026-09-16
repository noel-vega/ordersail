import { Link, Text } from "@react-email/components";
import { render } from "@react-email/render";
import { EmailLayout } from "../components/layout.js";

export interface VerifyEmailEmailProps {
  firstName: string;
  verifyUrl: string;
}

export function VerifyEmailEmail({ firstName, verifyUrl }: VerifyEmailEmailProps) {
  return (
    <EmailLayout>
      <Text>Hi {firstName},</Text>
      <Text>Welcome to Ordersail! Click below to verify your email address.</Text>
      <Text>
        <Link href={verifyUrl}>Verify your email</Link>
      </Text>
    </EmailLayout>
  );
}

export default VerifyEmailEmail;

export function renderVerifyEmailEmail(props: VerifyEmailEmailProps): Promise<string> {
  return render(<VerifyEmailEmail {...props} />);
}
