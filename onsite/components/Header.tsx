import Link from "next/link";
export function Header({ title, back, right }: { title: string; back?: string; right?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 bg-site/95 backdrop-blur border-b border-line">
      <div className="max-w-md mx-auto flex items-center gap-2 px-4 h-16">
        {back && <Link href={back} className="text-lg font-bold px-2 -ml-2 min-h-[44px] flex items-center" aria-label="Back">‹ Back</Link>}
        <h1 className={`text-2xl font-extrabold truncate flex-1 ${back ? "text-right" : ""}`}>{title}</h1>
        {right}
      </div>
    </header>
  );
}
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="max-w-md mx-auto px-4 py-4 pb-32 space-y-4">{children}</main>;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card text-center text-steel text-lg py-8">{children}</div>;
}
