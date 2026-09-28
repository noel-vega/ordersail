// Merchant app lives on a different subdomain (merchant.ordersail.com).
// PUBLIC_MERCHANT_SIGNUP_URL lets a preview/staging build retarget the funnel.
export const signupUrl =
	import.meta.env.PUBLIC_MERCHANT_SIGNUP_URL ?? 'https://merchant.ordersail.com/signup';

// Existing merchants sign in on the same app, same origin as signup.
export const signinUrl = new URL('/signin', signupUrl).href;

// Pre-launch the public site offers no way into signup or sign-in: every CTA
// renders "Coming soon" instead (OS-663). Closed unless the build sets
// PUBLIC_SIGNUP_OPEN=true — so production stays closed by default.
// LAUNCH: set PUBLIC_SIGNUP_OPEN=true in the website build env of cd.yml's
// deploy-frontends job, and every CTA and "Sign in" link comes back.
export const signupOpen = import.meta.env.PUBLIC_SIGNUP_OPEN === 'true';
