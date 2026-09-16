/**
 * The two demo switches, read in one place.
 *
 *  - DEMO_CONSOLE=1  turns on the control room (/console), which signs demo accounts in without a code.
 *  - DEV_SHOW_OTP=1  shows a login code on screen when no text went out.
 *
 * Either one hands out accounts: anyone who types a number can sign in as it. So on a Vercel production
 * deployment (VERCEL_ENV=production) both are off whatever the variables say — unless that deployment is
 * declared a demo with DEMO_SITE=1. A copied .env or a stray dashboard setting alone can't switch them on;
 * it takes two deliberate variables. Local builds, `next start` and Vercel previews obey the variables.
 * Read these at request time (they are functions for that reason), never at import.
 *
 * When OnSite goes to real production with texts, remove DEMO_SITE and DEV_SHOW_OTP there.
 *
 * tests/unit/flags.test.ts fails if anything else reads process.env.DEMO_CONSOLE or DEV_SHOW_OTP.
 */
const vercelProduction = () => process.env.VERCEL_ENV === "production";

/** This public deployment is a demo, not real production (DEMO_SITE=1). */
export const demoSite = () => process.env.DEMO_SITE === "1";

const switchesAllowed = () => !vercelProduction() || demoSite();

export const demoConsoleOn = () => switchesAllowed() && process.env.DEMO_CONSOLE === "1";

export const devShowOtpOn = () => switchesAllowed() && process.env.DEV_SHOW_OTP === "1";
