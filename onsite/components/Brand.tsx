export function Brand({ sub }: { sub?: string }) {
  return (
    <div>
      <div className="stripe rounded-full w-16 mb-3" />
      <div className="text-3xl font-extrabold tracking-tight">OnSite</div>
      {sub && <div className="text-steel mt-1">{sub}</div>}
    </div>
  );
}
