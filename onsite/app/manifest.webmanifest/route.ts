export function GET() {
  return Response.json({
    name: "OnSite", short_name: "OnSite", start_url: "/", display: "standalone",
    background_color: "#F3F4F6", theme_color: "#15171A",
    icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
  });
}
