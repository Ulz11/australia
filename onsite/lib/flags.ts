/**
 * The two demo switches, read in one place.
 *
 *  - DEMO_CONSOLE=1  turns on the control room (/console), which signs demo accounts in without a code.
 *  - DEV_SHOW_OTP=1  shows a login code on screen when no text went out.
 *
 * Either one in production hands out accounts. So on a Vercel production deployment
 * (VERCEL_ENV=production) both are off whatever the variables say — a copied .env or a stray
 * dashboard setting can't switch them on. Local builds, `next start` and Vercel previews still obey
 * the variables. Read these at request time (they are functions for that reason), never at import.
 *
 * tests/unit/flags.test.ts fails if anything else reads process.env.DEMO_CONSOLE or DEV_SHOW_OTP.
 */
const vercelProduction = () => process.env.VERCEL_ENV === "production";

export const demoConsoleOn = () => !vercelProduction() && process.env.DEMO_CONSOLE === "1";

export const devShowOtpOn = () => !vercelProduction() && process.env.DEV_SHOW_OTP === "1";
