// Seeds registered storefront customers for the demo store, so storefront
// sign-in and per-customer order history don't start empty. Re-runnable:
// customers are looked up by their natural key (accountId, email).
import bcrypt from 'bcryptjs';
import { db, eq, and, customersTable } from 'db';
import { createRng } from './seed-random.js';

export const CUSTOMER_PASSWORD = 'password123';

export interface SeedAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: 'US';
}

// fictional street addresses in real US cities — order history only, never
// sent to a carrier. US-only, like the rest of the platform for now.
export const SHIP_TO_ADDRESSES: readonly SeedAddress[] = [
  { line1: '1428 Elm Street', line2: null, city: 'Portland', state: 'OR', postalCode: '97205', country: 'US' },
  { line1: '742 Evergreen Terrace', line2: null, city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' },
  { line1: '310 Congress Avenue', line2: 'Apt 4B', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
  { line1: '88 Pike Street', line2: 'Unit 12', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' },
  { line1: '2150 Larimer Street', line2: null, city: 'Denver', state: 'CO', postalCode: '80205', country: 'US' },
  { line1: '455 Peachtree Street NE', line2: 'Apt 1907', city: 'Atlanta', state: 'GA', postalCode: '30308', country: 'US' },
  { line1: '19 Bleecker Street', line2: 'Apt 3R', city: 'New York', state: 'NY', postalCode: '10012', country: 'US' },
  { line1: '600 N Michigan Avenue', line2: null, city: 'Chicago', state: 'IL', postalCode: '60611', country: 'US' },
  { line1: '1200 Ocean Drive', line2: 'Unit 805', city: 'Miami Beach', state: 'FL', postalCode: '33139', country: 'US' },
  { line1: '3400 Sunset Boulevard', line2: null, city: 'Los Angeles', state: 'CA', postalCode: '90026', country: 'US' },
  { line1: '77 Newbury Street', line2: 'Apt 2', city: 'Boston', state: 'MA', postalCode: '02116', country: 'US' },
  { line1: '915 Broadway', line2: null, city: 'Nashville', state: 'TN', postalCode: '37203', country: 'US' },
  { line1: '2600 E Camelback Road', line2: 'Apt 210', city: 'Phoenix', state: 'AZ', postalCode: '85016', country: 'US' },
  { line1: '1601 Hennepin Avenue', line2: null, city: 'Minneapolis', state: 'MN', postalCode: '55403', country: 'US' },
  { line1: '420 Frenchmen Street', line2: null, city: 'New Orleans', state: 'LA', postalCode: '70116', country: 'US' },
  { line1: '1350 Valencia Street', line2: 'Apt 6', city: 'San Francisco', state: 'CA', postalCode: '94110', country: 'US' },
  { line1: '230 S Broad Street', line2: 'Unit 1503', city: 'Philadelphia', state: 'PA', postalCode: '19102', country: 'US' },
  { line1: '1010 Main Street', line2: null, city: 'Kansas City', state: 'MO', postalCode: '64105', country: 'US' },
  { line1: '505 Fayetteville Street', line2: 'Apt 1120', city: 'Raleigh', state: 'NC', postalCode: '27601', country: 'US' },
  { line1: '2001 K Street NW', line2: null, city: 'Washington', state: 'DC', postalCode: '20006', country: 'US' },
];

// paired by index — 40 distinct first.last combinations, hence distinct emails
const FIRST_NAMES = [
  'Ava', 'Liam', 'Maya', 'Noah', 'Zoe', 'Ethan', 'Chloe', 'Lucas', 'Priya', 'Mateo',
  'Grace', 'Omar', 'Hana', 'Diego', 'Nora', 'Kai', 'Leah', 'Andre', 'Sofia', 'Jamal',
  'Emma', 'Ravi', 'Isla', 'Marcus', 'Yuki', 'Caleb', 'Amara', 'Tyler', 'Lena', 'Felix',
  'Rosa', 'Owen', 'Mei', 'Darius', 'Ivy', 'Hugo', 'Tessa', 'Elijah', 'Nadia', 'Sam',
] as const;

const LAST_NAMES = [
  'Thompson', 'Nguyen', 'Patel', 'Garcia', 'Kim', 'Johnson', 'Rivera', 'Chen', 'Okafor', 'Lopez',
  'Murphy', 'Haddad', 'Sato', 'Morales', 'Fischer', 'Kahale', 'Cohen', 'Williams', 'Rossi', 'Brooks',
  'Walker', 'Shah', 'Campbell', 'Reed', 'Tanaka', 'Bennett', 'Mensah', 'Hughes', 'Novak', 'Wagner',
  'Ortiz', 'Sullivan', 'Wong', 'Jackson', 'Price', 'Laurent', 'Hayes', 'Coleman', 'Petrova', 'Ellis',
] as const;

const SIGNUP_WINDOW_DAYS = 90;

export interface SeededCustomer {
  id: number;
  firstname: string;
  lastname: string;
  email: string;
  createdAt: Date;
  // where this customer's orders ship to — not stored on the customer row
  // (the schema has no saved addresses); handed to the order generator
  address: SeedAddress;
}

function toSeeded(
  row: typeof customersTable.$inferSelect,
  address: SeedAddress,
): SeededCustomer {
  const { id, firstname, lastname, email, createdAt } = row;
  return { id, firstname, lastname, email, createdAt, address };
}

export async function ensureCustomers(
  accountId: number,
): Promise<{ customers: SeededCustomer[]; created: number }> {
  const rng = createRng(1);
  const now = Date.now();
  const hashedPassword = await bcrypt.hash(CUSTOMER_PASSWORD, 10);

  const customers: SeededCustomer[] = [];
  let created = 0;

  for (let i = 0; i < FIRST_NAMES.length; i++) {
    const firstname = FIRST_NAMES[i];
    const lastname = LAST_NAMES[i];
    const email = `${firstname}.${lastname}@example.com`.toLowerCase();
    const address = SHIP_TO_ADDRESSES[i % SHIP_TO_ADDRESSES.length];
    // drawn before the lookup, so the sequence is the same whether or not the
    // row already exists
    const createdAt = new Date(now - rng.next() * SIGNUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [existing] = await db
      .select()
      .from(customersTable)
      .where(and(eq(customersTable.accountId, accountId), eq(customersTable.email, email)));
    if (existing) {
      customers.push(toSeeded(existing, address));
      continue;
    }

    const [row] = await db
      .insert(customersTable)
      .values({
        accountId,
        firstname,
        lastname,
        email,
        password: hashedPassword,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    customers.push(toSeeded(row, address));
    created++;
  }

  return { customers, created };
}
