import { Hr, Text } from "@react-email/components";
import { render } from "@react-email/render";
import { EmailLayout } from "../components/layout.js";
import { formatCents } from "../lib/currency.js";

export interface OrderConfirmationEmailItem {
  productName: string;
  sku: string | null;
  optionsLabel: string | null;
  priceCents: number;
  quantity: number;
}

export interface OrderConfirmationEmailProps {
  customerName: string;
  accountName: string;
  orderId: number;
  items: OrderConfirmationEmailItem[];
  subtotalCents: number;
  shippingCents: number;
  amountTotalCents: number;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingState: string | null;
  shippingPostalCode: string;
  shippingCountry: string;
}

export function OrderConfirmationEmail({
  customerName,
  accountName,
  orderId,
  items,
  subtotalCents,
  shippingCents,
  amountTotalCents,
  shippingLine1,
  shippingLine2,
  shippingCity,
  shippingState,
  shippingPostalCode,
  shippingCountry,
}: OrderConfirmationEmailProps) {
  const addressLines = [
    shippingLine1,
    shippingLine2,
    [shippingCity, shippingState, shippingPostalCode].filter(Boolean).join(", "),
    shippingCountry,
  ].filter(Boolean);

  return (
    <EmailLayout>
      <Text>Hi {customerName},</Text>
      <Text>
        Thanks for your order from {accountName}! Here&apos;s a summary of order #{orderId}.
      </Text>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td style={{ padding: "8px 0" }}>
                {item.productName}
                {item.optionsLabel ? <span style={{ color: "#666" }}> ({item.optionsLabel})</span> : null}
                <br />
                <span style={{ color: "#666", fontSize: "0.9em" }}>Qty {item.quantity}</span>
              </td>
              <td style={{ padding: "8px 0", textAlign: "right" }}>
                {formatCents(item.priceCents * item.quantity)}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ padding: "8px 0", borderTop: "1px solid #ddd" }}>Subtotal</td>
            <td style={{ padding: "8px 0", borderTop: "1px solid #ddd", textAlign: "right" }}>
              {formatCents(subtotalCents)}
            </td>
          </tr>
          <tr>
            <td style={{ padding: "8px 0" }}>Shipping</td>
            <td style={{ padding: "8px 0", textAlign: "right" }}>{formatCents(shippingCents)}</td>
          </tr>
          <tr>
            <td style={{ padding: "8px 0", fontWeight: "bold" }}>Total</td>
            <td style={{ padding: "8px 0", textAlign: "right", fontWeight: "bold" }}>
              {formatCents(amountTotalCents)}
            </td>
          </tr>
        </tbody>
      </table>
      <Hr />
      <Text>
        Shipping to:
        <br />
        {addressLines.map((line, index) => (
          <span key={index}>
            {line}
            <br />
          </span>
        ))}
      </Text>
    </EmailLayout>
  );
}

export default OrderConfirmationEmail;

export function renderOrderConfirmationEmail(props: OrderConfirmationEmailProps): Promise<string> {
  return render(<OrderConfirmationEmail {...props} />);
}
