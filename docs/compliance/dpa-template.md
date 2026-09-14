# OrderSail Data Processing Agreement (template)

This is the source content for the public `/dpa` page (`apps/website/src/pages/dpa.astro`).
Keep the two in sync. Draft from a standard controller/processor DPA template —
**needs a lawyer review pass before launch**, in particular the Standard
Contractual Clauses annex and the governing-law/liability terms, which mirror
the placeholder already flagged in `/terms`.

## Parties

- **Controller**: the merchant using OrderSail to run their business ("Merchant," "you").
- **Processor**: OrderSail, processing personal data on the Merchant's behalf ("OrderSail," "we").

## Subject matter & duration

OrderSail processes personal data as necessary to provide the Service described
in the Terms of Service, for the duration of the Merchant's account plus any
period required for legal, accounting, or fraud-prevention purposes afterward.

## Nature, purpose, and categories of processing

- **Nature/purpose**: hosting and operating the Merchant's storefront and
  dashboard; processing orders and payments; arranging shipping; sending
  transactional email; providing support.
- **Categories of data subjects**: the Merchant's customers (buyers) and staff.
- **Categories of personal data**: name, email, shipping address, order
  contents, and payment-transaction records (no cardholder data — that goes
  directly to Stripe).

## Processor obligations

OrderSail will:

1. Process personal data only on the Merchant's documented instructions
   (including via the Merchant's use of the dashboard and API), unless
   required otherwise by law.
2. Ensure personnel who process personal data are bound by confidentiality.
3. Apply appropriate technical and organizational security measures.
4. Not engage a new subprocessor without prior notice to the Merchant via the
   subprocessor list and its change-notification mechanism (see below), giving
   the Merchant an opportunity to object.
5. Assist the Merchant, to the extent reasonably possible, in responding to
   data subject rights requests and in meeting breach-notification and
   data-protection-impact-assessment obligations.
6. Notify the Merchant without undue delay after becoming aware of a personal
   data breach affecting the Merchant's data.
7. At the Merchant's choice, delete or return all personal data at the end of
   the engagement, except where retention is required by law.
8. Make available information reasonably necessary to demonstrate compliance
   with this DPA.

## Subprocessors

Current subprocessors: Stripe (payments), Shippo (shipping labels/rates), and
Amazon Web Services (hosting and transactional email via SES). The
authoritative, kept-current list — with purpose, data categories, and region
for each — is published separately (see the subprocessor list; this doc will
link to it once it ships).

Change notice: Merchants will be notified in advance of any new subprocessor
through the same channel as the published list, with an opportunity to object
on reasonable data-protection grounds before it takes effect.

## International transfers

Where personal data is transferred outside a jurisdiction the Merchant's law
recognizes as offering adequate protection, the transfer is governed by the
Standard Contractual Clauses (SCCs), incorporated by reference.

> **Placeholder** — the SCC module/annex text and governing-law/liability
> terms are pending legal review before launch.

## How to execute this DPA

Using OrderSail as a data processor under applicable data protection law
constitutes acceptance of this DPA. Merchants who need a signed copy for their
own records or vendor-review process can request one at `legal@ordersail.com`.
