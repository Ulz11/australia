import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Brand } from "@/components/Brand";
import { AWARD_CASUAL_FLOOR, money } from "@/lib/award";
import { demoSite } from "@/lib/flags";
import { privacyContact } from "@/lib/privacy";
import { TERMS_VERSION } from "@/lib/terms";
import { gstRegistered, matchFeeCents, priceWords, subscriptionCents, trialDays } from "@/lib/subscription";

export const metadata: Metadata = { title: "The rules — OnSite" };

/**
 * The rules. Plain words, and only what the code really does — if the app starts doing something else,
 * change this page and TERMS_VERSION (lib/terms.ts) with it. Every figure is read when the page is
 * requested, from the same constants the billing code charges from, so a price can never be stale here.
 * Readable signed out: it is linked from the login screen and from onboarding's consent box.
 */
export default async function Terms() {
  await connection();                                   // prices and the contact come from the environment at request time
  const contact = privacyContact();
  const fee = priceWords(matchFeeCents());
  const subscription = money(subscriptionCents());
  const days = trialDays();
  const gst = gstRegistered();
  const demo = demoSite();

  return (
    <main className="max-w-md mx-auto p-6 pb-16 space-y-6 text-lg leading-snug">
      <Brand sub="The rules" />
      <p>
        These are the rules for using OnSite. They are short because the app is: a boss posts a shift, a worker
        takes it, both keep the same record. You agree to them when you set up your account.
      </p>

      <Section title="What OnSite is">
        <p>OnSite is a place where bosses post casual construction shifts and workers take them.</p>
        <p>
          <b>OnSite is not the employer.</b> We don&apos;t supply labour, we don&apos;t send anyone to a site and we
          don&apos;t hold anybody&apos;s pay. The boss and the worker make the arrangement between themselves, on the
          terms shown on the shift before it is taken.
        </p>
      </Section>

      <Section title="The boss is the employer">
        <p>Every shift is <b>casual employment</b> with the boss who posted it. If you post a shift, you are the employer for it:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>The work is casual. The worker doesn&apos;t need an ABN and is not a contractor.</li>
          <li>The rate is at least the Building and Construction General On-site Award casual floor — <b>{money(AWARD_CASUAL_FLOOR)} an hour</b>, which already includes the 25% casual loading. The app won&apos;t post a shift under it.</li>
          <li><b>Super goes on top</b> of the rate. OnSite shows the figure beside the pay; paying it is yours.</li>
          <li>You keep the record of hours worked, and so does the worker. Same record, both screens.</li>
        </ul>
      </Section>

      <Section title="What workers agree to">
        <ul className="list-disc pl-6 space-y-1">
          <li>Only take a shift you will turn up to.</li>
          <li>Clock in when you get to the site and clock out when you finish, honestly. Those times are the pay record.</li>
          <li>Every card and licence on your profile is real, current, and yours.</li>
          <li>Pulling out of a shift you took, and not turning up, go on your record — and bosses see that record.</li>
        </ul>
      </Section>

      <Section title="What bosses agree to">
        <ul className="list-disc pl-6 space-y-1">
          <li>Approve hours promptly and honestly. You can change the number before you approve it; if you do, the worker sees both numbers and <b>both stay on the record</b>.</li>
          <li>Pay the worker yourself, directly and promptly. OnSite never holds or moves a worker&apos;s pay.</li>
          <li>Only post shifts you mean to fill.</li>
          <li>Cancelling a shift after someone has taken it goes on your record.</li>
        </ul>
      </Section>

      <Section title="Fees">
        <p><b>Workers never pay anything.</b> Bosses pay two things, and neither is charged to a card.</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <b>{fee} for a new worker OnSite found you.</b> It is charged once per worker, when you first approve
            their hours and the hours are above zero. Every shift with that worker afterwards is free.
            <b> A worker you brought yourself is never a worker OnSite found you</b>, so there is no fee for them,
            ever: anyone you added to your crew list or invited by their number, a shift booked straight to one
            person, and <i>same again tomorrow</i>.
          </li>
          <li>
            <b>{subscription} a month for the pay tools</b>, after <b>{days} day{days === 1 ? "" : "s"} free</b> that
            start the moment your account becomes a boss. The subscription starts by itself when the free days run
            out. The free days cover the subscription, not the new workers: a match fee is charged from day one.
          </li>
        </ul>
        <p>Posting shifts, matching, your workers list and approving hours are always free. Approving is what makes a match billable, so charging for it would mean charging you to be charged.</p>
        {gst && <p>Prices include <b>GST</b> — one eleventh of the total is the GST already inside it. It is never added on top.</p>}
        <p>
          Invoices are <b>due 14 days</b> after they are issued. You pay one through <b>QPay</b>, from your Mongolian
          bank app, in tögrög: we convert the Australian dollar total at the exchange rate when you tap Pay, rounded
          up to the next whole tögrög. OnSite never holds a card or any bank details.
        </p>
        <p>
          An invoice past its due date is shown as overdue, and that is all that happens — nothing switches off
          because of it. The pay tools stop only when you cancel the subscription, and then only once the month you
          have already paid for runs out. Posting shifts and approving hours keep working either way.
        </p>
      </Section>

      <Section title="If you disagree about the hours">
        <p>
          OnSite records both numbers: the hours the worker clocked, and the hours the boss approved. Both stay on
          both screens. A worker who disagrees can say so, which tells the boss to call.
        </p>
        <p><b>OnSite does not decide who is right.</b> We don&apos;t lock anyone out, we don&apos;t apply penalties and we hold no money to withhold.</p>
      </Section>

      <Section title="Blocking, leaving a crew, deleting an account">
        <p>
          <b>Blocking.</b> A boss can block a worker. That worker comes off the boss&apos;s shifts that haven&apos;t
          happened yet and is told they were taken off, any open deal request between them is closed, they come off
          the boss&apos;s workers list, and OnSite stops showing them that boss&apos;s shifts. Work already done stays
          on both records. A worker can&apos;t block a boss.
        </p>
        <p>
          <b>Leaving a crew.</b> A boss can take someone off their workers list at any time, and a worker can leave a
          crew themselves in Me, then Settings. Either way it only changes who can book whom directly: shifts still
          reach that worker through matching, it is not a block, and nobody is told.
        </p>
        <p>
          <b>A number on a crew list.</b> A boss can put a mobile number on their crew list before that person has
          an OnSite account. Only that boss ever sees it. If nobody signs up with it, we delete it after 90 days.
        </p>
        <p>
          <b>Deleting an account.</b> There is no delete button yet. Ask us and we will delete it. Deleting an account
          also deletes the shifts, hours and pay records attached to it, so a boss should download their pay records
          first (Pay, then Export).
        </p>
      </Section>

      {demo && (
        <Section title="This is a demo">
          <p>
            Sign-in codes show on screen instead of being texted, so <b>anyone who types your mobile number can open
            your account</b>. Don&apos;t enter anything you wouldn&apos;t want others to see, such as your visa type or
            card numbers. We may reset the demo, which deletes its accounts and the data in them.
          </p>
        </Section>
      )}

      <Section title="Changes, and the law that applies">
        <p>We change these rules as the app changes. The version at the bottom says when they last changed, and the version you agreed to is kept with your account.</p>
        <p>These rules, and every shift agreed through OnSite, are governed by the law of <b>New South Wales</b>.</p>
      </Section>

      {contact && (
        <Section title="Contact">
          <p>{contact.business} — <a className="font-bold underline" href={`mailto:${contact.email}`}>{contact.email}</a></p>
        </Section>
      )}

      <p className="text-steel text-base">Version {TERMS_VERSION}</p>
      <p className="space-x-3">
        <Link href="/privacy" className="font-bold underline">How we handle your information</Link>
        <Link href="/login" className="font-bold underline">Back to OnSite</Link>
      </p>
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
