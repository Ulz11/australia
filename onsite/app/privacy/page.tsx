import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Brand } from "@/components/Brand";
import { PRIVACY_VERSION, privacyContact } from "@/lib/privacy";
import { devShowOtpOn } from "@/lib/flags";
import { betaInviteOnly } from "@/lib/beta";
import { smsProvider } from "@/lib/sms";

const TEXT_SERVICE = { clicksend: "ClickSend (Australian text message service)", twilio: "Twilio (US text message service)" } as const;

export const metadata: Metadata = { title: "Privacy — OnSite" };

/**
 * The privacy notice. Plain words, and only what the code really does — if you change what the app
 * collects, shows or sends somewhere, change this page and PRIVACY_VERSION (lib/privacy.ts) with it.
 * Readable signed out: it is linked from the login screen and from onboarding's consent box.
 */
export default async function Privacy() {
  await connection();                                   // contact details come from the environment at request time
  const contact = privacyContact();
  const texts = smsProvider().provider;                 // null until a text service is configured
  const demo = devShowOtpOn();
  const closedBeta = betaInviteOnly();

  return (
    <main className="max-w-md mx-auto p-6 pb-16 space-y-6 text-lg leading-snug">
      <Brand sub="Privacy notice" />
      <p>
        What {contact ? `${contact.business} collects through OnSite` : "OnSite collects"} when you use it, who can see it,
        where it is kept and who else receives some of it. It covers the app at this address and nothing else.
      </p>

      <Section title="What we collect">
        <h3 className="font-bold">From everyone</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li>Your <b>mobile number</b>. You sign in with it{texts ? ", we text your sign-in codes and shift offers to it," : ""} and the people you work with can call you on it.</li>
          <li>Your <b>name</b>, and whether you are a <b>boss</b> or a <b>worker</b>.</li>
          <li>When you agreed to this notice, and which version you agreed to.</li>
          <li>Sign-in codes — stored scrambled, never as the code itself — and your <b>internet address</b>, which we use to limit how many codes or sign-in tries one connection can ask for. That record is cleared within a day.</li>
          <li>Each <b>phone you are signed in on</b>: what sort of device it is (like &ldquo;iPhone&rdquo;), how you signed in on it, when you signed in and when it was last used. It is on your own Settings screen so you can sign any of them out.</li>
          <li>If you turn on <b>Face ID or fingerprint sign-in</b>: a public key for each device you turn it on for, its label (like &ldquo;iPhone&rdquo;), when you added it and when it was last used. <b>Never your face or fingerprint</b> — they stay on your phone, which only tells us they matched. The key that goes with it (a passkey) is kept by your phone, or by Apple or Google if your phone backs up its passwords; we send them nothing.</li>
          <li>If you turn on <b>phone alerts</b>: the push address your browser gives us, the keys that encrypt alerts to it, and what kind of browser or phone it is.</li>
          <li>The messages OnSite shows you in the app, and a note of when you tap to call someone through the app (who and when — never the call itself).</li>
        </ul>
        <h3 className="font-bold pt-2">If you are a boss</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li>Your <b>company name</b> and, if you give it, your <b>ABN</b>.</li>
          <li>Your <b>sites</b>: name, <b>address and map pin</b>, and how many people each needs.</li>
          <li>The <b>shifts</b> you post (day, start, hours, rate, overtime terms, notes, weather stops), who you book, the hours you approve and whether you have marked them paid, your crew list with their rates, and anyone you block.</li>
          <li>What you are billed: when your free trial ends, whether you are subscribed, which workers OnSite introduced you to and when you first approved their hours, and your <b>invoices</b> — number, dates, the lines on them (including the worker each match fee is for), the total, and whether they are paid. Your company name and ABN appear on them. When you pay one through QPay we also keep the QPay invoice number, the amount in tögrög and the exchange rate we used, QPay's payment number once it is paid, and — only until it is paid or replaced — the QR code and bank-app links QPay gave us. <b>We never hold a card or any bank details</b>; your bank app handles the payment itself.</li>
        </ul>
        <h3 className="font-bold pt-2">If you are a worker</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li><b>Where you live</b> — the place name you choose and a map pin kept to about a kilometre, not your exact spot — and how far you will travel, so we only offer shifts near you.</li>
          <li>The days you mark free or busy.</li>
          <li>Your profile if you fill it in: <b>trades, languages, years of experience, a few words about you, and a photo</b>.</li>
          <li>Your <b>visa type</b>, if you give it.</li>
          <li>Your <b>licence and White Card details</b>: card type, <b>card number</b>, state, expiry date, the name on the card, and the result of any check.</li>
          <li>The shifts you take, deals you ask for, and the times you <b>clock in and out</b>. When you clock in, your phone tells the app where you are (if you let it); we work out <b>how far you are from the site</b> and keep only that distance, not your location.</li>
          <li>Your <b>hours and pay records</b>, and <b>reliability</b> figures worked out from them: shifts turned up to, completed and cancelled.</li>
          <li>When a boss opens your profile, the <b>date</b> they opened it — once a day, however many times they look. It is kept so you can see <b>how many</b> bosses looked at you in the last week. You are never told which ones, and no boss is told you saw the number.</li>
          <li>Your invite code, and who invited you if you joined with someone else's.</li>
        </ul>
      </Section>

      <Section title="Who sees what">
        <p><b>Bosses</b> using OnSite can see a worker's name, mobile number, photo, trades, languages, experience, about text, the place name they chose for where they live, reliability figures, and — on a shift — clock-in times and distance from the site.</p>
        <p>On a worker's profile a boss also sees the same work record the worker sees on their own screen: turning up, clocking in on time, pulling out of shifts, hours disagreed, hours by trade, how many sites they have worked, how many bosses would book them again, and which days they worked over the last year. <b>A boss never sees what a worker has earned</b> — not on their own sites and not on anyone else's — and never sees another boss's name or the name of a site that isn't theirs.</p>
        <p>For licences and White Cards, bosses see only the card type, state, expiry and whether it checks out. <b>Bosses never see your card numbers, and never see your visa type.</b></p>
        <p><b>Workers</b> can see a boss's name and company, the site's name, address and pin for open shifts, how quickly that boss approves and pays, and — once you are on a shift — the boss's mobile number.</p>
        <p>If you gave a mate your invite code, you can see their name and how many shifts they have completed. Nobody else using OnSite can see your information.</p>
      </Section>

      <Section title="Where it is kept">
        <p>Everything is stored in a database in <b>Sydney, Australia</b> (Neon), and the app itself runs in <b>Sydney</b> (Vercel).</p>
        <p>Paying an invoice happens <b>outside Australia</b>: QPay is in Mongolia, and you pay in tögrög from your Mongolian bank app.</p>
      </Section>

      <Section title="Services that receive some of it">
        <ul className="list-disc pl-6 space-y-1">
          {texts
            ? <li><b>{TEXT_SERVICE[texts]}</b>: your mobile number and the text we send you — a sign-in code or a shift offer.</li>
            : <li>No text message service is switched on yet, so nothing is sent to one.</li>}
          <li><b>Apple, Google, Mozilla and Microsoft push services</b> (whichever your browser uses): an encrypted alert for your phone, only if you turned alerts on. They pass it on but cannot read it.</li>
          <li><b>QPay</b> (Mongolian payment service): an invoice number and amount when you choose to pay; your bank app handles the payment itself. The bank logos on that screen come from QPay, so your browser asks QPay for them.</li>
          <li><b>SafeWork NSW</b> (through the NSW Government's API): a NSW White Card number, to check the card is real and current. Nothing else about you is sent.</li>
          <li><b>OpenStreetMap</b>: map pictures, the addresses you type into a search box, and — when you tap <b>Use my location</b> — where you are, to turn it into an address. Your browser asks OpenStreetMap directly; we do not send them anything.</li>
          <li><b>Google Fonts</b>: your browser downloads the app's lettering from Google, which sees your internet address but nothing about your account.</li>
        </ul>
        <p>We do not sell your information or use it for advertising.</p>
      </Section>

      <Section title="How long we keep it, and deleting it">
        <p>We keep your information while you have an account. There is no delete button yet — ask us and we will delete your account. Deleting an account also deletes the shifts, hours and pay records attached to it, so bosses should download their pay records first (Pay → Export).</p>
        <p>You can take your photo or visa type off your profile, and remove a card, yourself at any time.</p>
      </Section>

      <Section title="Seeing or fixing your information">
        <p>Most of it is on your own screens and you can change it there. If you want a copy of what we hold about you, or something you can't change yourself corrected, ask us.</p>
      </Section>

      {demo ? (
        <Section title="This is a demo">
          <p>OnSite is a demo and still changing. Sign-in codes show on screen instead of being texted, so <b>anyone who types your mobile number can open your account</b> and see what is in it. Don&apos;t enter anything you wouldn&apos;t want others to see, such as your visa type or card numbers. We may reset the demo, which deletes its accounts and data.</p>
          <p>If what we collect changes, we will update this notice and its version number below.</p>
        </Section>
      ) : closedBeta ? (
        <Section title="Closed beta">
          <p>OnSite is in a closed beta: only invited numbers can sign up, and the app is still changing. If what we collect changes, we will update this notice and its version number below.</p>
        </Section>
      ) : (
        <Section title="Changes">
          <p>If what we collect changes, we will update this notice and its version number below.</p>
        </Section>
      )}

      {contact && (
        <Section title="Contact">
          <p>{contact.business} — <a className="font-bold underline" href={`mailto:${contact.email}`}>{contact.email}</a></p>
        </Section>
      )}

      <p className="text-steel text-base">Version {PRIVACY_VERSION}</p>
      <p><Link href="/login" className="font-bold underline">Back to OnSite</Link></p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-2xl font-extrabold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
