import { createProject } from "@/actions/boss";
import { AddressPin } from "@/components/AddressPin";
import { Header, Page } from "@/components/Header";
import { Field } from "@/components/ui";
export default function NewProject() {
  return (
    <>
      <Header title="New site" back="/boss" />
      <Page>
        <form action={createProject} className="space-y-5">
          <Field label="What do you call this job?" hint="Anything you'd say on the phone."><input name="name" className="input" placeholder="e.g. Marrickville Rd duplex" required autoFocus /></Field>
          <Field label="Where is it?" hint="Type the street, press Find. Or tap the map to drop the pin."><AddressPin placeholder="Street address" /></Field>
          <button className="btn-primary text-xl">Save site</button>
        </form>
      </Page>
    </>
  );
}
