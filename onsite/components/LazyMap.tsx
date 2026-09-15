"use client";
import dynamic from "next/dynamic";
/** The map library is 300 kB. Only pages that show a map pay for it, and only when it's on screen. */
export const LazyMap = dynamic(() => import("./MapPicker").then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="h-64 rounded-2xl bg-site border border-line animate-pulse" />,
});
