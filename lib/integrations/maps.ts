// Google Routes API — live, traffic-aware drive time for "leave now" reminders.

export function mapsConnected(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

export async function driveTime(
  origin: string,
  destination: string
): Promise<{ ok: boolean; minutes?: number; distance_km?: number; detail: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { ok: false, detail: "GOOGLE_MAPS_API_KEY not set" };
  if (!origin || !destination) return { ok: false, detail: "need both origin and destination" };

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, detail: `maps error: ${data?.error?.message || res.status}` };
  const route = data.routes?.[0];
  if (!route) return { ok: false, detail: "no route found" };
  const durSec = parseInt(String(route.duration || "0").replace("s", "")) || 0;
  const minutes = Math.round(durSec / 60);
  const km = Math.round(((route.distanceMeters || 0) / 1000) * 10) / 10;
  return { ok: true, minutes, distance_km: km, detail: `${minutes} min drive (${km} km) with current traffic` };
}
