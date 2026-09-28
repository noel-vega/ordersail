interface ImportMetaEnv {
	/**
	 * Merchant signup URL the marketing-site CTAs point at. Defaults to
	 * https://merchant.ordersail.com/signup; override for preview/staging builds.
	 */
	readonly PUBLIC_MERCHANT_SIGNUP_URL?: string;
	/**
	 * "true" opens signup: CTAs link to the merchant app and "Sign in" shows.
	 * Anything else (including unset) renders "Coming soon" — the pre-launch
	 * default (OS-663).
	 */
	readonly PUBLIC_SIGNUP_OPEN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
